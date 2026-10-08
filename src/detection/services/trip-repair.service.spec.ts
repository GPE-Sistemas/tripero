import { TripRepairService } from './trip-repair.service';
import { Trip } from '../../database/entities/trip.entity';

/**
 * Reparador de trips huérfanos. Lo que se cubre acá:
 * - repara con los odómetros de las paradas que rodean al trip;
 * - marca SIEMPRE el resultado, para no volver a revisar el mismo trip;
 * - no escribe distancias imposibles;
 * - nunca toca el punto de llegada.
 */
describe('TripRepairService', () => {
  const inicio = new Date('2026-10-05T18:24:29Z');
  const fin = new Date('2026-10-05T19:39:52Z');

  const tripBase = (o: Partial<Trip> = {}): Trip =>
    ({
      id: 'trip_6a2805781d5cba506daeafe4_1791224875507_6zwljiwce',
      id_activo: '6a2805781d5cba506daeafe4',
      start_time: inicio,
      end_time: fin,
      updated_at: fin,
      duration: 4523,
      distance: 0,
      end_lat: -34.84494,
      end_lon: -58.40242,
      metadata: { closedBy: 'orphan_cleanup' },
      ...o,
    }) as Trip;

  let tripRepository: { update: jest.Mock; findTripsParaReparar: jest.Mock };
  let stopRepository: {
    findUltimaAntesDe: jest.Mock;
    findEmpezadasEntre: jest.Mock;
  };
  let trackerState: { getState: jest.Mock };
  let service: TripRepairService;

  beforeEach(() => {
    tripRepository = {
      update: jest.fn().mockResolvedValue(null),
      findTripsParaReparar: jest.fn().mockResolvedValue([]),
    };
    stopRepository = {
      findUltimaAntesDe: jest.fn().mockResolvedValue(null),
      findEmpezadasEntre: jest.fn().mockResolvedValue([]),
    };
    trackerState = { getState: jest.fn().mockResolvedValue(null) };
    service = new TripRepairService(
      tripRepository as any,
      stopRepository as any,
      trackerState as any,
    );
  });

  it('repara con los odómetros de las paradas y calcula el promedio', async () => {
    stopRepository.findUltimaAntesDe.mockResolvedValue({
      start_odometer: 5_371_000,
      end_odometer: 5_371_439,
    });
    stopRepository.findEmpezadasEntre.mockResolvedValue([
      { start_odometer: 5_376_000 },
      { start_odometer: 5_380_439 },
    ]);

    const r = await service.repararTrip(tripBase());

    expect(r).toMatchObject({
      estado: 'reparado',
      fuente: 'paradas',
      distancia: 9000,
    });
    const datos = tripRepository.update.mock.calls[0][1];
    expect(datos.distance).toBe(9000);
    expect(datos.avg_speed).toBe(Math.round((9000 / 4523) * 3.6));
    expect(datos.metadata.reparacion.estado).toBe('reparado');
    expect(datos.metadata.closedBy).toBe('orphan_cleanup');
    // Nunca pisa el punto de llegada
    expect(datos.end_lat).toBeUndefined();
    expect(datos.end_lon).toBeUndefined();
  });

  it('usa el TrackerState si todavía apunta al trip', async () => {
    trackerState.getState.mockResolvedValue({
      currentTripId: tripBase().id,
      tripOdometerStart: 1000,
      totalOdometer: 3500,
    });

    const r = await service.repararTrip(tripBase());

    expect(r).toMatchObject({
      estado: 'reparado',
      fuente: 'tracker_state',
      distancia: 2500,
    });
    expect(stopRepository.findUltimaAntesDe).not.toHaveBeenCalled();
  });

  it('marca irreparable (y no toca la distancia) si no hay paradas', async () => {
    const r = await service.repararTrip(tripBase());

    expect(r).toMatchObject({
      estado: 'irreparable',
      motivo: 'sin_parada_anterior',
    });
    const datos = tripRepository.update.mock.calls[0][1];
    expect(datos.distance).toBeUndefined();
    expect(datos.metadata.reparacion.estado).toBe('irreparable');
  });

  it('descarta distancias imposibles (salto de offset del odómetro)', async () => {
    stopRepository.findUltimaAntesDe.mockResolvedValue({
      end_odometer: 1_000,
    });
    // 900 km en 75 minutos
    stopRepository.findEmpezadasEntre.mockResolvedValue([
      { start_odometer: 901_000 },
    ]);

    const r = await service.repararTrip(tripBase());

    expect(r).toMatchObject({
      estado: 'irreparable',
      motivo: 'distancia_implausible',
    });
    expect(tripRepository.update.mock.calls[0][1].distance).toBeUndefined();
  });

  it('no arranca un lote si el anterior sigue en curso', async () => {
    let liberar!: () => void;
    tripRepository.findTripsParaReparar.mockReturnValue(
      new Promise((r) => (liberar = () => r([]))),
    );

    const primero = service.procesarLote();
    await service.procesarLote();
    liberar();
    await primero;

    expect(tripRepository.findTripsParaReparar).toHaveBeenCalledTimes(1);
  });

  it('onModuleInit no espera trabajo: vuelve en el acto', () => {
    jest.useFakeTimers();
    try {
      service.onModuleInit();
      expect(tripRepository.findTripsParaReparar).not.toHaveBeenCalled();
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });
});
