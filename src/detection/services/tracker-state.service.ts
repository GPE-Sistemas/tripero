import { Injectable, Logger } from '@nestjs/common';
import { TrackerStateRepository } from '../../database/repositories';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { IPositionEvent } from '../../interfaces';
import { ITrackerState, ITrackerStatus, IResetOdometer } from '../../models';
import { TRACKER_STATE_TTL } from '../../env';

/**
 * Servicio de gestión de estado de trackers
 *
 * Responsabilidades:
 * - Calcular y mantener odómetro acumulativo
 * - Actualizar última posición conocida
 * - Sincronizar estado entre Redis (rápido) y PostgreSQL (persistente)
 * - Proveer estado actual de trackers
 */
@Injectable()
export class TrackerStateService {
  private readonly logger = new Logger(TrackerStateService.name);
  private readonly REDIS_KEY_PREFIX = 'tracker:state:';
  private readonly STATE_TTL = TRACKER_STATE_TTL; // Configurable via env

  constructor(
    private readonly trackerStateRepository: TrackerStateRepository,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Actualiza el estado del tracker con una nueva posición
   * Calcula odómetro automáticamente
   */
  async updateWithPosition(position: IPositionEvent): Promise<void> {
    try {
      // 1. Obtener estado actual desde Redis
      let state = await this.getStateFromRedis(position.deviceId);

      // 2. Si no existe en Redis, cargar desde PostgreSQL o crear nuevo
      if (!state) {
        const dbState = await this.trackerStateRepository.findByTrackerId(
          position.deviceId,
        );

        if (dbState) {
          state = this.mapEntityToInterface(dbState);
        } else {
          // Crear nuevo estado
          state = this.createInitialState(position.deviceId);
        }
      }

      // 3. Calcular distancia desde última posición
      let distanceDelta = 0;
      if (state.lastLatitude && state.lastLongitude) {
        distanceDelta = this.calculateDistance(
          state.lastLatitude,
          state.lastLongitude,
          position.latitude,
          position.longitude,
        );

        // Validación: ignorar saltos imposibles
        const timeDelta =
          (position.timestamp - (state.lastPositionTime?.getTime() || 0)) /
          1000;
        const maxPossibleDistance = (200 / 3.6) * timeDelta; // 200 km/h máximo

        if (distanceDelta > maxPossibleDistance && timeDelta > 0) {
          this.logger.warn(
            `Impossible distance jump detected for ${position.deviceId}: ` +
              `${distanceDelta}m in ${timeDelta}s (ignoring)`,
          );
          distanceDelta = 0;
        }
      }

      // 4. Actualizar odómetro
      state.totalOdometer += distanceDelta;

      // 5. Actualizar última posición
      state.lastPositionTime = new Date(position.timestamp);
      state.lastLatitude = position.latitude;
      state.lastLongitude = position.longitude;
      state.lastSpeed = position.speed;
      state.lastIgnition = position.ignition;
      state.lastHeading = position.heading;
      state.lastAltitude = position.altitude;
      state.lastSeenAt = new Date();
      state.updatedAt = new Date();

      // 6. Guardar en Redis (siempre)
      await this.saveStateToRedis(position.deviceId, state);

      // 7. Guardar en PostgreSQL (cada 100 posiciones o cada hora)
      const shouldPersist = await this.shouldPersistToDb(position.deviceId);
      if (shouldPersist) {
        await this.persistToDb(state);
      }
    } catch (error) {
      this.logger.error(
        `Error updating tracker state for ${position.deviceId}`,
        error.stack,
      );
    }
  }

  /**
   * Notifica inicio de trip (para actualizar contador)
   */
  async onTripStarted(
    deviceId: string,
    tripId: string,
    startLat?: number,
    startLon?: number,
  ): Promise<void> {
    const state = await this.getState(deviceId);
    if (!state) return;

    state.currentTripId = tripId;
    state.tripStartTime = new Date();
    state.tripOdometerStart = state.totalOdometer;
    state.tripStartLat = startLat;
    state.tripStartLon = startLon;

    await this.saveStateToRedis(deviceId, state);
  }

  /**
   * Notifica fin de trip (para actualizar estadísticas)
   */
  async onTripCompleted(
    deviceId: string,
    drivingTime: number,
    idleTime: number,
    stopsCount: number,
  ): Promise<void> {
    const state = await this.getState(deviceId);
    if (!state) return;

    state.currentTripId = undefined;
    state.tripStartTime = undefined;
    state.tripOdometerStart = undefined;
    state.tripStartLat = undefined;
    state.tripStartLon = undefined;
    state.totalTripsCount++;
    state.totalDrivingTime += drivingTime;
    state.totalIdleTime += idleTime;
    state.totalStopsCount += stopsCount;

    await this.saveStateToRedis(deviceId, state);
    await this.persistToDb(state); // Persistir al completar trip
  }

  /**
   * Registra un overnight gap detectado
   * Incrementa contador y actualiza diagnóstico de alimentación
   */
  async onOvernightGapDetected(deviceId: string, gapDurationSeconds: number): Promise<void> {
    const state = await this.getState(deviceId);
    if (!state) return;

    // Incrementar contador de overnight gaps
    state.overnightGapCount = (state.overnightGapCount || 0) + 1;
    state.lastOvernightGapAt = new Date();

    // Inferir tipo de conexión eléctrica basado en cantidad de gaps
    // powerType indica cómo está conectado el tracker al vehículo:
    // - 'permanent': Conectado a BAT+ (batería directa), siempre tiene energía
    // - 'switched': Conectado a ACC/contacto, pierde energía cuando se apaga el vehículo
    // - 'unknown': Sin datos suficientes para determinar
    //
    // Lógica de inferencia:
    // - 0 gaps: unknown (no tenemos suficiente data, pero probablemente permanent)
    // - 1-2 gaps: podría ser algo puntual, mantener unknown
    // - 3+ gaps: patrón consistente → switched (conectado a contacto)
    if (state.overnightGapCount >= 3) {
      state.powerType = 'switched';
    }

    this.logger.warn(
      `Overnight gap detected for ${deviceId}: ${Math.round(gapDurationSeconds / 3600)}h gap, ` +
        `total overnight gaps: ${state.overnightGapCount}, power type: ${state.powerType}`,
    );

    await this.saveStateToRedis(deviceId, state);
    await this.persistToDb(state); // Persistir inmediatamente (evento importante)
  }

  /**
   * Obtiene el estado completo de un tracker
   */
  async getTrackerStatus(trackerId: string): Promise<ITrackerStatus | null> {
    const state = await this.getState(trackerId);
    if (!state) return null;

    const now = Date.now();
    const lastSeenAgo = state.lastSeenAt
      ? Math.floor((now - state.lastSeenAt.getTime()) / 1000)
      : 999999;

    // Determinar health status
    let healthStatus: 'online' | 'offline' | 'stale';
    if (lastSeenAgo < 5 * 60) {
      // 5 minutos
      healthStatus = 'online';
    } else if (lastSeenAgo < 24 * 60 * 60) {
      // 24 horas
      healthStatus = 'stale';
    } else {
      healthStatus = 'offline';
    }

    // Determinar estado de movimiento
    let currentStateEnum:
      | 'STOPPED'
      | 'MOVING'
      | 'PAUSED'
      | 'UNKNOWN'
      | 'OFFLINE' = state.currentState || 'UNKNOWN';
    if (healthStatus === 'offline') {
      currentStateEnum = 'OFFLINE';
    }

    const stateDuration = state.stateSince
      ? Math.floor((now - state.stateSince.getTime()) / 1000)
      : 0;

    // Calcular días activos
    const daysActive = state.firstSeenAt
      ? Math.floor((now - state.firstSeenAt.getTime()) / (1000 * 60 * 60 * 24))
      : 0;

    // Trip actual
    let currentTrip:
      | {
          tripId: string;
          startTime: Date;
          duration: number;
          distance: number;
          avgSpeed: number;
          maxSpeed: number;
          odometerAtStart: number;
          startLat?: number;
          startLon?: number;
        }
      | undefined = undefined;

    if (state.currentTripId && state.tripStartTime && state.tripOdometerStart !== undefined) {
      const tripDuration = Math.floor(
        (now - state.tripStartTime.getTime()) / 1000,
      );
      const tripDistance = state.totalOdometer - state.tripOdometerStart;

      currentTrip = {
        tripId: state.currentTripId,
        startTime: state.tripStartTime,
        duration: tripDuration,
        distance: Math.round(tripDistance),
        avgSpeed: tripDuration > 0 ? Math.round((tripDistance / tripDuration) * 3.6) : 0,
        maxSpeed: state.lastSpeed || 0, // TODO: Rastrear max speed del trip
        odometerAtStart: state.tripOdometerStart,
        startLat: state.tripStartLat,
        startLon: state.tripStartLon,
      };
    }

    // Calcular odómetro con offset (GPS + offset = odómetro real)
    const displayOdometer = state.totalOdometer + (state.odometerOffset || 0);

    // Determinar si hay problema de energía y recomendación
    // hasPowerIssue = true cuando se detecta conexión switched (ACC/contacto)
    // Esto indica que el tracker pierde energía cuando el vehículo está apagado
    const hasPowerIssue = (state.overnightGapCount || 0) >= 3;
    let powerRecommendation: string | undefined;
    if (hasPowerIssue) {
      powerRecommendation =
        'Tracker conectado a ACC/contacto (pierde energía al apagar). ' +
        'Reconectar a BAT+ (12V directo) para tracking continuo, ' +
        'o usar tracker con batería interna.';
    } else if ((state.overnightGapCount || 0) >= 1) {
      powerRecommendation =
        'Se detectaron gaps nocturnos. Si continúa, verificar conexión eléctrica del tracker.';
    }

    const status: ITrackerStatus = {
      trackerId: state.trackerId,
      deviceId: state.deviceId,

      odometer: {
        total: Math.round(displayOdometer),
        totalKm: Math.round(displayOdometer / 1000),
        currentTrip: currentTrip ? currentTrip.distance : 0,
        currentTripKm: currentTrip
          ? Math.round(currentTrip.distance / 1000)
          : 0,
      },

      currentState: {
        state: currentStateEnum,
        since: state.stateSince || state.firstSeenAt,
        duration: stateDuration,
      },

      lastPosition: state.lastLatitude && state.lastLongitude
        ? {
            timestamp: state.lastPositionTime || new Date(),
            latitude: state.lastLatitude,
            longitude: state.lastLongitude,
            speed: state.lastSpeed || 0,
            ignition: state.lastIgnition || false,
            heading: state.lastHeading,
            altitude: state.lastAltitude,
            age: lastSeenAgo,
          }
        : undefined,

      currentTrip,

      statistics: {
        totalTrips: state.totalTripsCount,
        totalDrivingTime: state.totalDrivingTime,
        totalDrivingHours: Math.round((state.totalDrivingTime / 3600) * 10) / 10,
        totalIdleTime: state.totalIdleTime,
        totalIdleHours: Math.round((state.totalIdleTime / 3600) * 10) / 10,
        totalStops: state.totalStopsCount,
        firstSeen: state.firstSeenAt,
        lastSeen: state.lastSeenAt,
        daysActive,
      },

      health: {
        status: healthStatus,
        lastSeenAgo,
      },

      powerDiagnostic: {
        powerType: state.powerType || 'unknown',
        overnightGapCount: state.overnightGapCount || 0,
        lastOvernightGapAt: state.lastOvernightGapAt,
        hasPowerIssue,
        recommendation: powerRecommendation,
      },
    };

    return status;
  }

  /**
   * Resetea el odómetro de un tracker
   */
  async resetOdometer(
    trackerId: string,
    resetData: IResetOdometer,
  ): Promise<void> {
    const state = await this.getState(trackerId);
    if (!state) {
      throw new Error(`Tracker ${trackerId} not found`);
    }

    this.logger.log(
      `Resetting odometer for ${trackerId} from ${state.totalOdometer} to ${resetData.newValue}. Reason: ${resetData.reason}`,
    );

    state.totalOdometer = resetData.newValue;
    state.updatedAt = new Date();

    await this.saveStateToRedis(trackerId, state);
    await this.persistToDb(state);
  }

  /**
   * Setea el odómetro inicial de un tracker (usando offset)
   * Calcula el offset necesario para que el odómetro GPS coincida con el real
   */
  async setOdometer(
    trackerId: string,
    initialOdometer: number,
    reason?: string,
  ): Promise<{
    previousOdometer: number;
    newOdometer: number;
    odometerOffset: number;
  }> {
    const state = await this.getState(trackerId);
    if (!state) {
      throw new Error(`Tracker ${trackerId} not found`);
    }

    const previousDisplayOdometer = state.totalOdometer + (state.odometerOffset || 0);

    // Calcular nuevo offset: initialOdometer - totalOdometer (GPS)
    const newOffset = initialOdometer - state.totalOdometer;

    this.logger.log(
      `Setting odometer for ${trackerId}: GPS=${state.totalOdometer}m, ` +
        `initialOdometer=${initialOdometer}m, offset=${newOffset}m. ` +
        `Reason: ${reason || 'not specified'}`,
    );

    state.odometerOffset = newOffset;
    state.updatedAt = new Date();

    await this.saveStateToRedis(trackerId, state);
    await this.persistToDb(state);

    return {
      previousOdometer: Math.round(previousDisplayOdometer),
      newOdometer: Math.round(initialOdometer),
      odometerOffset: Math.round(newOffset),
    };
  }

  /**
   * Obtiene lista de trackers activos
   */
  async getActiveTrackers(hoursAgo: number = 24): Promise<ITrackerStatus[]> {
    const trackers = await this.trackerStateRepository.findActive(hoursAgo);
    const statuses: ITrackerStatus[] = [];

    for (const tracker of trackers) {
      const status = await this.getTrackerStatus(tracker.tracker_id);
      if (status) {
        statuses.push(status);
      }
    }

    return statuses;
  }

  /**
   * Obtiene estadísticas globales
   */
  async getGlobalStats() {
    return this.trackerStateRepository.getGlobalStats();
  }

  // ========== MÉTODOS PRIVADOS ==========

  /**
   * Obtiene estado desde Redis o PostgreSQL
   * PÚBLICO: Usado por PositionSubscriberService para obtener último estado de ignición
   */
  public async getState(trackerId: string): Promise<ITrackerState | null> {
    // Intentar desde Redis primero
    let state = await this.getStateFromRedis(trackerId);

    // Si no está en Redis, cargar desde PostgreSQL
    if (!state) {
      const dbState = await this.trackerStateRepository.findByTrackerId(
        trackerId,
      );
      if (dbState) {
        state = this.mapEntityToInterface(dbState);
        // Guardar en Redis para próxima vez
        await this.saveStateToRedis(trackerId, state);
      }
    }

    return state;
  }

  /**
   * Obtiene estado desde Redis
   */
  private async getStateFromRedis(
    trackerId: string,
  ): Promise<ITrackerState | null> {
    const key = `${this.REDIS_KEY_PREFIX}${trackerId}`;
    const data = await this.redisService.get(key);

    if (!data) return null;

    try {
      // RedisService.get() ya retorna el objeto parseado
      // Convertir strings de fecha a Date objects
      return {
        ...data,
        lastPositionTime: data.lastPositionTime
          ? new Date(data.lastPositionTime)
          : undefined,
        stateSince: data.stateSince ? new Date(data.stateSince) : undefined,
        tripStartTime: data.tripStartTime
          ? new Date(data.tripStartTime)
          : undefined,
        firstSeenAt: new Date(data.firstSeenAt),
        lastSeenAt: new Date(data.lastSeenAt),
        createdAt: new Date(data.createdAt),
        updatedAt: new Date(data.updatedAt),
      };
    } catch (error) {
      this.logger.error(
        `Error processing state from Redis for ${trackerId}`,
        error,
      );
      return null;
    }
  }

  /**
   * Guarda estado en Redis
   */
  private async saveStateToRedis(
    trackerId: string,
    state: ITrackerState,
  ): Promise<void> {
    const key = `${this.REDIS_KEY_PREFIX}${trackerId}`;
    await this.redisService.set(key, JSON.stringify(state), this.STATE_TTL);
  }

  /**
   * Persiste estado en PostgreSQL
   */
  private async persistToDb(state: ITrackerState): Promise<void> {
    await this.trackerStateRepository.upsert(state.trackerId, {
      device_id: state.deviceId,
      total_odometer: state.totalOdometer,
      odometer_offset: state.odometerOffset,
      trip_odometer_start: state.tripOdometerStart || null,
      last_position_time: state.lastPositionTime || null,
      last_latitude: state.lastLatitude || null,
      last_longitude: state.lastLongitude || null,
      last_speed: state.lastSpeed || null,
      last_ignition: state.lastIgnition || null,
      last_heading: state.lastHeading || null,
      last_altitude: state.lastAltitude || null,
      current_state: state.currentState || null,
      state_since: state.stateSince || null,
      current_trip_id: state.currentTripId || null,
      trip_start_time: state.tripStartTime || null,
      trip_start_lat: state.tripStartLat || null,
      trip_start_lon: state.tripStartLon || null,
      total_trips_count: state.totalTripsCount,
      total_driving_time: state.totalDrivingTime,
      total_idle_time: state.totalIdleTime,
      total_stops_count: state.totalStopsCount,
      overnight_gap_count: state.overnightGapCount || 0,
      last_overnight_gap_at: state.lastOvernightGapAt || null,
      power_type: state.powerType || 'unknown',
      first_seen_at: state.firstSeenAt,
      last_seen_at: state.lastSeenAt,
    });
  }

  /**
   * Determina si debe persistir en BD
   * (cada 100 posiciones o cada hora)
   */
  private async shouldPersistToDb(trackerId: string): Promise<boolean> {
    const key = `${this.REDIS_KEY_PREFIX}${trackerId}:persist_counter`;
    const counter = await this.redisService.incr(key);

    if (counter === 1) {
      // Primera vez, setear TTL de 1 hora
      await this.redisService.expire(key, 3600);
    }

    // Resetear contador si alcanzó el límite
    if (counter >= 100) {
      await this.redisService.del(key);
      return true;
    }

    return false;
  }

  /**
   * Crea estado inicial para un tracker nuevo
   */
  private createInitialState(trackerId: string): ITrackerState {
    const now = new Date();
    return {
      trackerId,
      deviceId: trackerId,
      totalOdometer: 0,
      odometerOffset: 0,
      totalTripsCount: 0,
      totalDrivingTime: 0,
      totalIdleTime: 0,
      totalStopsCount: 0,
      overnightGapCount: 0,
      powerType: 'unknown',
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * Mapea entidad de BD a interfaz
   */
  private mapEntityToInterface(entity: any): ITrackerState {
    return {
      _id: entity.id,
      trackerId: entity.tracker_id,
      deviceId: entity.device_id,
      totalOdometer: entity.total_odometer,
      odometerOffset: entity.odometer_offset || 0,
      tripOdometerStart: entity.trip_odometer_start,
      lastPositionTime: entity.last_position_time,
      lastLatitude: entity.last_latitude,
      lastLongitude: entity.last_longitude,
      lastSpeed: entity.last_speed,
      lastIgnition: entity.last_ignition,
      lastHeading: entity.last_heading,
      lastAltitude: entity.last_altitude,
      currentState: entity.current_state,
      stateSince: entity.state_since,
      currentTripId: entity.current_trip_id,
      tripStartTime: entity.trip_start_time,
      tripStartLat: entity.trip_start_lat,
      tripStartLon: entity.trip_start_lon,
      totalTripsCount: entity.total_trips_count,
      totalDrivingTime: entity.total_driving_time,
      totalIdleTime: entity.total_idle_time,
      totalStopsCount: entity.total_stops_count,
      overnightGapCount: entity.overnight_gap_count || 0,
      lastOvernightGapAt: entity.last_overnight_gap_at,
      powerType: entity.power_type || 'unknown',
      firstSeenAt: entity.first_seen_at,
      lastSeenAt: entity.last_seen_at,
      createdAt: entity.created_at,
      updatedAt: entity.updated_at,
    };
  }

  /**
   * Calcula distancia entre dos coordenadas GPS (Haversine)
   * Retorna distancia en metros
   */
  private calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    // Radio ecuatorial WGS84 (estándar GPS) - más preciso que radio medio
    // Antes: 6371000 (radio medio) - Ahora: 6378137 (WGS84) = +0.11% precisión
    const R = 6378137; // Radio ecuatorial WGS84 en metros
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
      Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
      Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distancia en metros
  }

  /**
   * Actualiza solo el estado de ignición de un tracker
   * Usado cuando recibimos eventos de ignición separados (ej: GPS103 ACC events)
   */
  async updateIgnition(
    deviceId: string,
    ignition: boolean,
    timestamp: number,
  ): Promise<void> {
    try {
      let state = await this.getState(deviceId);

      // Si no existe, crear estado inicial
      if (!state) {
        state = this.createInitialState(deviceId);
        this.logger.log(`Creating new tracker state for ${deviceId}`);
      }

      // Actualizar ignición
      const previousIgnition = state.lastIgnition;
      state.lastIgnition = ignition;
      state.lastSeenAt = new Date();
      state.updatedAt = new Date();

      // Si hay timestamp, actualizar también el tiempo de posición
      if (timestamp) {
        state.lastPositionTime = new Date(timestamp);
      }

      // Guardar en Redis
      await this.saveStateToRedis(deviceId, state);

      // Persistir en BD inmediatamente (eventos de ignición son críticos)
      await this.persistToDb(state);

      this.logger.log(
        `Ignition updated for ${deviceId}: ${previousIgnition ?? 'unknown'} → ${ignition}`,
      );
    } catch (error) {
      this.logger.error(
        `Error updating ignition for ${deviceId}`,
        error.stack,
      );
    }
  }
}
