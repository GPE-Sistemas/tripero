import { Test, TestingModule } from '@nestjs/testing';
import { PositionProcessorService } from './position-processor.service';
import { StateMachineService } from './state-machine.service';
import { DeviceStateService } from './device-state.service';
import { EventPublisherService } from './event-publisher.service';
import { TrackerStateService } from './tracker-state.service';
import { TripRepository } from '../../database/repositories/trip.repository';
import { StopRepository } from '../../database/repositories/stop.repository';
import { IPositionEvent } from '../../interfaces';

/**
 * El heartbeat del trip en curso guarda también su avance. Si después el
 * estado de Redis se pierde (reinicio, reset de estado viejo), el trip ya tiene
 * en la base sus últimos valores y el cierre por huérfano no lo deja en 0, que
 * es lo que pasó con los viajes del incidente del 05/10/2026.
 */
describe('PositionProcessorService — avance del trip en curso', () => {
  let service: PositionProcessorService;
  let tripRepository: { touchTrip: jest.Mock };
  let stateMachine: { processPosition: jest.Mock };
  let trackerState: { updateWithPosition: jest.Mock; getState: jest.Mock };

  const baseActions = {
    startTrip: false,
    endTrip: false,
    discardTrip: false,
    updateTrip: false,
    startStop: false,
    endStop: false,
  };

  const inicioTrip = 1_791_224_669_000; // 18:24:29Z
  const pos = (o: Partial<IPositionEvent> = {}): IPositionEvent => ({
    deviceId: '6a2805781d5cba506daeafe4',
    timestamp: inicioTrip + 1800 * 1000, // media hora después
    latitude: -34.82,
    longitude: -58.36,
    speed: 24,
    ignition: true,
    ...o,
  });

  const conTripEnCurso = (estado: Record<string, unknown> = {}) =>
    stateMachine.processPosition.mockReturnValue({
      previousState: 'MOVING',
      newState: 'MOVING',
      transitionOccurred: false,
      reason: 'moving',
      actions: { ...baseActions },
      updatedState: {
        deviceId: '6a2805781d5cba506daeafe4',
        currentTripId: 'trip_x',
        tripStartTime: inicioTrip,
        lastTimestamp: inicioTrip + 1800 * 1000,
        ...estado,
      },
    });

  beforeEach(async () => {
    tripRepository = { touchTrip: jest.fn().mockResolvedValue(undefined) };
    stateMachine = { processPosition: jest.fn() };
    trackerState = {
      updateWithPosition: jest.fn().mockResolvedValue(undefined),
      getState: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PositionProcessorService,
        { provide: StateMachineService, useValue: stateMachine },
        {
          provide: DeviceStateService,
          useValue: {
            isPositionThrottled: jest.fn().mockResolvedValue(false),
            getDeviceState: jest.fn().mockResolvedValue(null),
            saveDeviceState: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: EventPublisherService,
          useValue: {
            publishTripStarted: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: TrackerStateService, useValue: trackerState },
        { provide: TripRepository, useValue: tripRepository },
        {
          provide: StopRepository,
          useValue: { touchStop: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(PositionProcessorService);
  });

  it('guarda distancia, máxima, promedio y última posición desde el odómetro', async () => {
    trackerState.getState.mockResolvedValue({
      currentTripId: 'trip_x',
      tripOdometerStart: 5_371_439,
      totalOdometer: 5_376_039, // 4,6 km
      tripMaxSpeed: 24,
      odometerOffset: 0,
    });
    conTripEnCurso();

    await service.processPosition(pos());

    expect(tripRepository.touchTrip).toHaveBeenCalledWith('trip_x', {
      distance: 4600,
      max_speed: 24,
      avg_speed: Math.round((4600 / 1800) * 3.6),
      duration: 1800,
      end_lat: -34.82,
      end_lon: -58.36,
    });
  });

  it('si el TrackerState es de otro trip usa lo acumulado por la máquina de estados', async () => {
    trackerState.getState.mockResolvedValue({
      currentTripId: 'otro',
      tripOdometerStart: 0,
      totalOdometer: 999_999,
    });
    conTripEnCurso({ tripDistance: 3200, tripMaxSpeed: 30 });

    await service.processPosition(pos());

    expect(tripRepository.touchTrip.mock.calls[0][1]).toMatchObject({
      distance: 3200,
      max_speed: 30,
    });
  });

  it('sin ninguna fuente no guarda avance (no escribe 0)', async () => {
    trackerState.getState.mockResolvedValue(null);
    conTripEnCurso();

    await service.processPosition(pos());

    expect(tripRepository.touchTrip).toHaveBeenCalledWith('trip_x', undefined);
  });
});
