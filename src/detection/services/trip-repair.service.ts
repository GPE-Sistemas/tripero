import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TripRepository } from '../../database/repositories/trip.repository';
import { StopRepository } from '../../database/repositories/stop.repository';
import { TrackerStateService } from './tracker-state.service';
import { Trip } from '../../database/entities/trip.entity';
import {
  ORPHAN_CLEANUP_ENABLED,
  TRIP_REPAIR_BATCH,
  TRIP_REPAIR_DELAY_MS,
  TRIP_REPAIR_ENABLED,
  TRIP_REPAIR_INTERVAL_MS,
  TRIP_REPAIR_WINDOW_DAYS,
} from '../../env';

/** Velocidad por encima de la cual una distancia reparada se descarta. */
const VELOCIDAD_MAXIMA_PLAUSIBLE_KMH = 200;
/** Holgura para asociar paradas al final de un trip huérfano. */
const MARGEN_FIN_MS = 10 * 60 * 1000;

export type EstadoReparacion = 'reparado' | 'irreparable';

export interface IResultadoReparacion {
  estado: EstadoReparacion;
  fuente?: 'tracker_state' | 'paradas';
  motivo?: string;
  distancia?: number;
  odometroInicio?: number;
  odometroFin?: number;
}

/**
 * Repara trips huérfanos que quedaron cerrados sin distancia.
 * - corre en segundo plano, por lotes chicos y con intervalo, después de que
 *   la app ya atiende; nunca bloquea el arranque;
 * - cada trip se intenta UNA vez y queda marcado en `metadata.reparacion`;
 * - además del TrackerState usa los odómetros de las paradas que rodean al
 *   trip, que sí quedan guardados en la base y sirven para trips viejos;
 * - nunca toca lo que no puede calcular (en particular, el punto de llegada:
 *   la posición actual del vehículo no es la de llegada de un trip viejo).
 */
@Injectable()
export class TripRepairService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TripRepairService.name);
  private arranque: NodeJS.Timeout | null = null;
  private intervalo: NodeJS.Timeout | null = null;
  private enCurso = false;

  constructor(
    private readonly tripRepository: TripRepository,
    private readonly stopRepository: StopRepository,
    private readonly trackerStateService: TrackerStateService,
  ) {}

  onModuleInit(): void {
    if (!ORPHAN_CLEANUP_ENABLED || !TRIP_REPAIR_ENABLED) {
      this.logger.warn('Reparación de trips huérfanos desactivada');
      return;
    }

    // NO se espera nada acá: cualquier await en onModuleInit retrasa el
    // app.listen() y, con eso, la startupProbe.
    this.arranque = setTimeout(() => {
      void this.procesarLote();
      this.intervalo = setInterval(
        () => void this.procesarLote(),
        TRIP_REPAIR_INTERVAL_MS,
      );
    }, TRIP_REPAIR_DELAY_MS);

    this.logger.log(
      `Reparación de trips programada: lotes de ${TRIP_REPAIR_BATCH} cada ${TRIP_REPAIR_INTERVAL_MS / 1000}s, ventana ${TRIP_REPAIR_WINDOW_DAYS} días, primer lote en ${TRIP_REPAIR_DELAY_MS / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.arranque) clearTimeout(this.arranque);
    if (this.intervalo) clearInterval(this.intervalo);
    this.arranque = null;
    this.intervalo = null;
  }

  /**
   * Procesa un lote. Si el anterior todavía no terminó, no arranca otro: dos
   * lotes en paralelo leerían los mismos trips sin marcar.
   */
  async procesarLote(): Promise<void> {
    if (this.enCurso) return;
    this.enCurso = true;
    const inicio = Date.now();

    try {
      const desde = new Date(
        Date.now() - TRIP_REPAIR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
      );
      const trips = await this.tripRepository.findTripsParaReparar(
        desde,
        TRIP_REPAIR_BATCH,
      );
      if (trips.length === 0) return;

      let reparados = 0;
      let irreparables = 0;
      for (const trip of trips) {
        try {
          const resultado = await this.repararTrip(trip);
          if (resultado.estado === 'reparado') reparados++;
          else irreparables++;
        } catch (error) {
          // Sin marcar: se reintenta en el próximo lote.
          this.logger.error(
            `Error reparando trip ${trip.id}: ${(error as Error).message}`,
          );
        }
      }

      this.logger.log(
        `Reparación de trips: ${trips.length} revisados (${reparados} reparados, ${irreparables} irreparables) en ${Date.now() - inicio}ms`,
      );
    } catch (error) {
      this.logger.error(
        'Error en lote de reparación de trips',
        (error as Error).stack,
      );
    } finally {
      this.enCurso = false;
    }
  }

  /**
   * Intenta reparar un trip y deja el resultado marcado en su metadata, sea
   * cual sea, para no volver a revisarlo.
   */
  async repararTrip(trip: Trip): Promise<IResultadoReparacion> {
    const duracion = this.duracionDe(trip);
    const resultado = await this.calcular(trip, duracion);

    const reparacion = {
      ...resultado,
      fecha: new Date().toISOString(),
    };

    if (resultado.estado === 'reparado' && resultado.distancia !== undefined) {
      await this.tripRepository.update(trip.id, {
        distance: resultado.distancia,
        avg_speed:
          duracion > 0 ? Math.round((resultado.distancia / duracion) * 3.6) : 0,
        ...(trip.duration ? {} : { duration: duracion }),
        metadata: { ...(trip.metadata || {}), reparacion },
      });
    } else {
      await this.tripRepository.update(trip.id, {
        metadata: { ...(trip.metadata || {}), reparacion },
      });
    }

    return resultado;
  }

  private async calcular(
    trip: Trip,
    duracion: number,
  ): Promise<IResultadoReparacion> {
    // 1. TrackerState: sólo sirve si todavía apunta a este trip (cierre
    //    reciente, el vehículo no volvió a arrancar).
    const tracker = await this.trackerStateService.getState(trip.id_activo);
    if (
      tracker &&
      tracker.currentTripId === trip.id &&
      tracker.tripOdometerStart !== undefined
    ) {
      return this.validar(
        'tracker_state',
        tracker.tripOdometerStart,
        tracker.totalOdometer,
        duracion,
      );
    }

    // 2. Paradas: la parada anterior guarda el odómetro con el que arrancó el
    //    trip (end_odometer) y las que empiezan durante el trip o al terminar
    //    guardan el odómetro de ese momento (start_odometer). Ambos incluyen el
    //    mismo offset, así que la diferencia es la distancia recorrida.
    const fin = trip.end_time ?? trip.updated_at;
    const anterior = await this.stopRepository.findUltimaAntesDe(
      trip.id_activo,
      trip.start_time,
    );
    const odometroInicio = anterior?.end_odometer ?? anterior?.start_odometer;
    if (odometroInicio == null) {
      return { estado: 'irreparable', motivo: 'sin_parada_anterior' };
    }

    const posteriores = await this.stopRepository.findEmpezadasEntre(
      trip.id_activo,
      trip.start_time,
      new Date(fin.getTime() + MARGEN_FIN_MS),
    );
    const odometros = posteriores
      .map((s) => s.start_odometer)
      .filter((o): o is number => o != null);
    if (odometros.length === 0) {
      return { estado: 'irreparable', motivo: 'sin_parada_al_final' };
    }

    return this.validar(
      'paradas',
      odometroInicio,
      Math.max(...odometros),
      duracion,
    );
  }

  /**
   * Acepta la distancia sólo si es físicamente posible. Un cambio manual de
   * offset del odómetro entre las dos paradas, por ejemplo, daría un salto
   * imposible o negativo: en ese caso se marca irreparable en lugar de
   * escribir un número inventado.
   */
  private validar(
    fuente: 'tracker_state' | 'paradas',
    odometroInicio: number,
    odometroFin: number,
    duracion: number,
  ): IResultadoReparacion {
    const distancia = Math.round(odometroFin - odometroInicio);
    const maxima =
      (VELOCIDAD_MAXIMA_PLAUSIBLE_KMH / 3.6) * Math.max(duracion, 60);

    if (distancia < 0 || distancia > maxima) {
      return {
        estado: 'irreparable',
        fuente,
        motivo: 'distancia_implausible',
        odometroInicio,
        odometroFin,
      };
    }
    return {
      estado: 'reparado',
      fuente,
      distancia,
      odometroInicio,
      odometroFin,
    };
  }

  private duracionDe(trip: Trip): number {
    if (trip.duration && trip.duration > 0) return trip.duration;
    const fin = trip.end_time ?? trip.updated_at;
    return Math.max(
      0,
      Math.floor((fin.getTime() - trip.start_time.getTime()) / 1000),
    );
  }
}
