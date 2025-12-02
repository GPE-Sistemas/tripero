import { Injectable, Logger } from '@nestjs/common';
import {
  IPositionEvent,
  ITripStartedEvent,
  ITripCompletedEvent,
  IStopStartedEvent,
  IStopCompletedEvent,
  ITrackerStateChangedEvent,
} from '../../interfaces';
import { StateMachineService } from './state-machine.service';
import { DeviceStateService } from './device-state.service';
import { EventPublisherService } from './event-publisher.service';
import { TrackerStateService } from './tracker-state.service';
import { MotionState } from '../models';

/**
 * Servicio principal de procesamiento de posiciones GPS
 *
 * Orquesta:
 * - Validación de posiciones
 * - Throttling
 * - Máquina de estados
 * - Cálculo de odómetro
 * - Persistencia de estado
 * - Publicación de eventos
 */
@Injectable()
export class PositionProcessorService {
  private readonly logger = new Logger(PositionProcessorService.name);
  private processedCount = 0;
  private errorCount = 0;

  constructor(
    private readonly stateMachine: StateMachineService,
    private readonly deviceState: DeviceStateService,
    private readonly eventPublisher: EventPublisherService,
    private readonly trackerState: TrackerStateService,
  ) {
    // Log de métricas cada minuto
    setInterval(() => {
      this.logger.log(
        `Metrics: ${this.processedCount} positions processed, ${this.errorCount} errors`,
      );
      this.processedCount = 0;
      this.errorCount = 0;
    }, 60000);
  }

  /**
   * Procesa una nueva posición GPS
   */
  async processPosition(position: IPositionEvent): Promise<void> {
    const startTime = Date.now();

    try {
      // 1. Verificar throttling
      const isThrottled = await this.deviceState.isPositionThrottled(
        position.deviceId,
        position.timestamp,
      );

      if (isThrottled) {
        this.logger.debug(
          `Position throttled for device ${position.deviceId}`,
        );
        return;
      }

      // 2. Actualizar estado del tracker (odómetro, última posición, etc.)
      await this.trackerState.updateWithPosition(position);

      // 3. Obtener estado actual del dispositivo
      const currentState = await this.deviceState.getDeviceState(
        position.deviceId,
      );

      // 4. Procesar con la máquina de estados
      const result = this.stateMachine.processPosition(position, currentState);

      // 5. Guardar nuevo estado
      await this.deviceState.saveDeviceState(result.updatedState);

      // 6. Ejecutar acciones (publicar eventos)
      await this.executeActions(position, result);

      // 7. Publicar evento de cambio de estado si ocurrió transición
      if (result.transitionOccurred) {
        await this.publishStateChangeEvent(position, result);

        this.logger.log(
          `State transition for device ${position.deviceId}: ` +
            `${result.previousState} → ${result.newState} ` +
            `(${result.reason})`,
        );
      }

      this.processedCount++;

      const processingTime = Date.now() - startTime;
      if (processingTime > 100) {
        this.logger.warn(
          `Slow position processing for device ${position.deviceId}: ${processingTime}ms`,
        );
      }
    } catch (error) {
      this.errorCount++;
      this.logger.error(
        `Error processing position for device ${position.deviceId}`,
        error.stack,
      );
    }
  }

  /**
   * Ejecuta las acciones determinadas por la máquina de estados
   */
  private async executeActions(
    position: IPositionEvent,
    result: any,
  ): Promise<void> {
    const { actions, updatedState, overnightGap } = result;

    // Si se detectó un overnight gap, notificar al TrackerStateService
    // para tracking de problemas de energía
    if (overnightGap?.detected) {
      await this.trackerState.onOvernightGapDetected(
        position.deviceId,
        overnightGap.durationSeconds,
      );
    }

    try {
      // Obtener tracker state para incluir odómetro con offset en eventos
      const trackerState = await this.trackerState.getState(position.deviceId);
      const displayOdometer = trackerState
        ? trackerState.totalOdometer + (trackerState.odometerOffset || 0)
        : 0;

      // IMPORTANTE: Finalizar trip ANTES de iniciar nuevo para evitar race conditions
      // Usamos previousTrip cuando está disponible (auto-close) para tener los datos correctos

      // Descartar trip (limpiar sin publicar evento)
      if (actions.discardTrip) {
        this.logger.debug(
          `Discarding trip for device ${position.deviceId} without publishing event`,
        );

        // Solo limpiar estado si NO vamos a iniciar uno nuevo inmediatamente
        // Si startTrip también es true, el nuevo trip ya está inicializado en updatedState
        // y limpiar aquí sobrescribiría los datos del nuevo trip
        if (!actions.startTrip) {
          updatedState.currentTripId = undefined;
          updatedState.tripStartTime = undefined;
          updatedState.tripStartLat = undefined;
          updatedState.tripStartLon = undefined;
          updatedState.tripDistance = undefined;
          updatedState.tripMaxSpeed = undefined;
          updatedState.tripStopsCount = undefined;
          updatedState.tripMetadata = undefined;

          await this.deviceState.saveDeviceState(updatedState);
        }
      }

      // Finalizar trip (con evento)
      if (actions.endTrip) {
        // Si hay previousTrip, usar esos datos (caso auto-close)
        // Si no, usar updatedState (caso trip normal con ignición OFF)
        const tripData = result.previousTrip || {
          tripId: updatedState.currentTripId,
          startTime: updatedState.tripStartTime || 0,
          startLat: updatedState.tripStartLat || 0,
          startLon: updatedState.tripStartLon || 0,
          distance: updatedState.tripDistance || 0,
          maxSpeed: updatedState.tripMaxSpeed || 0,
          stopsCount: updatedState.tripStopsCount || 0,
        };

        const tripDuration = (updatedState.lastTimestamp - tripData.startTime) / 1000;

        // CRÍTICO: Calcular distancia del trip desde el odómetro global del TrackerState
        // Esto incluye TODA la distancia recorrida durante el trip, incluso durante stops
        // El state-machine solo acumula distancia cuando hay tripId activo,
        // pero el TrackerState acumula SIEMPRE, resolviendo el bug de pérdida de distancia
        let tripDistance = tripData.distance; // Fallback al valor anterior
        if (trackerState && trackerState.tripOdometerStart !== undefined) {
          tripDistance = trackerState.totalOdometer - trackerState.tripOdometerStart;
          this.logger.log(
            `Trip ${tripData.tripId} distance: state-machine=${tripData.distance}m, ` +
            `odometer-based=${tripDistance}m (diff=${tripDistance - tripData.distance}m)`,
          );
        } else {
          this.logger.warn(
            `TrackerState not available for ${position.deviceId}, using state-machine distance`,
          );
        }

        const event: ITripCompletedEvent = {
          tripId: tripData.tripId,
          deviceId: position.deviceId,
          startTime: new Date(tripData.startTime).toISOString(),
          endTime: new Date(updatedState.lastTimestamp).toISOString(),
          duration: Math.round(tripDuration),
          distance: Math.round(tripDistance), // Usar odómetro global
          avgSpeed: this.calculateAvgSpeed(tripDistance, tripDuration), // Recalcular con distancia correcta
          maxSpeed: Math.round(tripData.maxSpeed),
          stopsCount: tripData.stopsCount,
          startLocation: {
            type: 'Point',
            coordinates: [tripData.startLon, tripData.startLat],
          },
          endLocation: {
            type: 'Point',
            coordinates: [updatedState.lastLon, updatedState.lastLat],
          },
          detectionMethod: position.ignition ? 'ignition' : 'motion',
          currentState: (updatedState.currentMotionState || 'STOPPED') as 'STOPPED' | 'IDLE' | 'MOVING',
          odometer: Math.round(displayOdometer),
          metadata: updatedState.tripMetadata,
        };

        await this.eventPublisher.publishTripCompleted(event);

        // Notificar al TrackerStateService (para actualizar estadísticas)
        await this.trackerState.onTripCompleted(
          position.deviceId,
          event.duration,
          0, // idle time - TODO: calcular desde trip
          event.stopsCount,
        );

        // Solo limpiar datos del trip si NO vamos a iniciar uno nuevo inmediatamente
        // Si startTrip también es true, el nuevo trip ya está inicializado en updatedState
        // y limpiar aquí sobrescribiría los datos del nuevo trip
        if (!actions.startTrip) {
          updatedState.currentTripId = undefined;
          updatedState.tripStartTime = undefined;
          updatedState.tripStartLat = undefined;
          updatedState.tripStartLon = undefined;
          updatedState.tripDistance = undefined;
          updatedState.tripMaxSpeed = undefined;
          updatedState.tripStopsCount = undefined;
          updatedState.tripMetadata = undefined;

          await this.deviceState.saveDeviceState(updatedState);
        }
      }

      // Iniciar trip (DESPUÉS de finalizar el anterior para evitar race conditions)
      if (actions.startTrip && updatedState.currentTripId) {
        // Guardar metadata del position en el estado para cuando se complete el trip
        updatedState.tripMetadata = position.metadata;

        const event: ITripStartedEvent = {
          tripId: updatedState.currentTripId,
          deviceId: position.deviceId,
          startTime: new Date(updatedState.tripStartTime).toISOString(),
          startLocation: {
            type: 'Point',
            coordinates: [
              updatedState.tripStartLon,
              updatedState.tripStartLat,
            ],
          },
          detectionMethod: position.ignition ? 'ignition' : 'motion',
          currentState: 'MOVING', // Siempre MOVING al iniciar trip
          odometer: Math.round(displayOdometer),
          metadata: position.metadata,
        };

        await this.eventPublisher.publishTripStarted(event);

        // Notificar al TrackerStateService
        await this.trackerState.onTripStarted(
          position.deviceId,
          updatedState.currentTripId,
          updatedState.tripStartLat,
          updatedState.tripStartLon,
        );
      }

      // Iniciar stop
      if (actions.startStop) {
        // Generar ID único para el stop
        const stopId = `stop_${position.deviceId}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        // Determinar razón del stop
        let reason: 'ignition_off' | 'no_movement' | 'parking' = 'no_movement';
        if (!position.ignition) {
          reason = 'ignition_off';
        } else if (position.speed === 0) {
          reason = 'parking';
        }

        // Guardar metadata del position o usar metadata del trip si existe
        const stopMetadata = position.metadata || updatedState.tripMetadata;

        const event: IStopStartedEvent = {
          stopId,
          tripId: updatedState.currentTripId,
          deviceId: position.deviceId,
          startTime: new Date(position.timestamp).toISOString(),
          location: {
            type: 'Point',
            coordinates: [position.longitude, position.latitude],
          },
          reason,
          currentState: 'IDLE', // Siempre IDLE al iniciar stop
          odometer: Math.round(displayOdometer),
          metadata: stopMetadata,
        };

        await this.eventPublisher.publishStopStarted(event);

        // Guardar info del stop en el estado para cuando se complete
        updatedState.currentStopId = stopId;
        updatedState.stopStartTime = position.timestamp;
        updatedState.stopStartLat = position.latitude;
        updatedState.stopStartLon = position.longitude;
        updatedState.stopReason = reason;
        updatedState.stopMetadata = stopMetadata;
        await this.deviceState.saveDeviceState(updatedState);

        this.logger.debug(
          `Stop ${stopId} started for device ${position.deviceId} (reason: ${reason})`,
        );
      }

      // Finalizar stop
      if (actions.endStop && updatedState.currentStopId) {
        const stopDuration =
          (position.timestamp - updatedState.stopStartTime) / 1000;

        const event: IStopCompletedEvent = {
          stopId: updatedState.currentStopId,
          tripId: updatedState.currentTripId,
          deviceId: position.deviceId,
          startTime: new Date(updatedState.stopStartTime).toISOString(),
          endTime: new Date(position.timestamp).toISOString(),
          duration: Math.round(stopDuration),
          location: {
            type: 'Point',
            coordinates: [
              updatedState.stopStartLon,
              updatedState.stopStartLat,
            ],
          },
          reason: updatedState.stopReason || 'no_movement',
          currentState: (updatedState.currentMotionState || 'MOVING') as 'STOPPED' | 'IDLE' | 'MOVING',
          odometer: Math.round(displayOdometer),
          metadata: updatedState.stopMetadata,
        };

        await this.eventPublisher.publishStopCompleted(event);

        // Incrementar contador de stops en el trip
        if (updatedState.currentTripId) {
          updatedState.tripStopsCount = (updatedState.tripStopsCount || 0) + 1;
        }

        // Limpiar datos del stop
        updatedState.currentStopId = undefined;
        updatedState.stopStartTime = undefined;
        updatedState.stopStartLat = undefined;
        updatedState.stopStartLon = undefined;
        updatedState.stopReason = undefined;
        updatedState.stopMetadata = undefined;

        await this.deviceState.saveDeviceState(updatedState);

        this.logger.debug(
          `Stop ${event.stopId} completed for device ${position.deviceId}: ${event.duration}s`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Error executing actions for device ${position.deviceId}`,
        error.stack,
      );
    }
  }

  /**
   * Publica evento de cambio de estado del tracker
   */
  private async publishStateChangeEvent(
    position: IPositionEvent,
    result: any,
  ): Promise<void> {
    try {
      // Obtener el tracker state para conocer el odómetro con offset
      const trackerState = await this.trackerState.getState(position.deviceId);
      if (!trackerState) {
        this.logger.warn(
          `Cannot publish state change event: tracker state not found for ${position.deviceId}`,
        );
        return;
      }

      // Obtener el device motion state para información del trip actual
      const deviceState = result.updatedState;

      // Calcular odómetro con offset
      const displayOdometer = trackerState.totalOdometer + (trackerState.odometerOffset || 0);
      const totalKm = Math.round(displayOdometer / 1000);

      // Calcular edad de la última posición
      const now = Date.now();
      const age = Math.floor((now - position.timestamp) / 1000);

      // Construir información del odómetro
      const odometerInfo: any = {
        total: Math.round(displayOdometer),
        totalKm,
      };

      // Agregar info del trip actual si existe
      if (deviceState.currentTripId && deviceState.tripDistance !== undefined) {
        odometerInfo.currentTrip = Math.round(deviceState.tripDistance);
        odometerInfo.currentTripKm = Math.round(deviceState.tripDistance / 1000);
      }

      // Construir información del trip actual (si existe)
      let currentTripInfo: any = undefined;
      if (deviceState.currentTripId && deviceState.tripStartTime) {
        const tripDuration = Math.floor((now - deviceState.tripStartTime) / 1000);
        const tripDistance = deviceState.tripDistance || 0;
        const avgSpeed = tripDuration > 0
          ? Math.round((tripDistance / tripDuration) * 3.6)
          : 0;

        currentTripInfo = {
          tripId: deviceState.currentTripId,
          startTime: new Date(deviceState.tripStartTime).toISOString(),
          duration: tripDuration,
          distance: Math.round(tripDistance),
          avgSpeed,
          maxSpeed: deviceState.tripMaxSpeed || 0,
          odometerAtStart: Math.round(
            (trackerState.tripOdometerStart || 0) + (trackerState.odometerOffset || 0)
          ),
        };
      }

      const event: ITrackerStateChangedEvent = {
        trackerId: position.deviceId,
        deviceId: position.deviceId,
        previousState: result.previousState as 'STOPPED' | 'IDLE' | 'MOVING',
        currentState: result.newState as 'STOPPED' | 'IDLE' | 'MOVING',
        timestamp: new Date(position.timestamp).toISOString(),
        reason: result.reason,
        odometer: odometerInfo,
        lastPosition: {
          timestamp: new Date(position.timestamp).toISOString(),
          latitude: position.latitude,
          longitude: position.longitude,
          speed: position.speed,
          ignition: position.ignition,
          heading: position.heading,
          altitude: position.altitude,
          age,
        },
        currentTrip: currentTripInfo,
      };

      await this.eventPublisher.publishTrackerStateChanged(event);
    } catch (error) {
      this.logger.error(
        `Error publishing state change event for ${position.deviceId}`,
        error.stack,
      );
    }
  }

  /**
   * Calcula velocidad promedio
   */
  private calculateAvgSpeed(distanceMeters: number, durationSeconds: number): number {
    if (durationSeconds === 0) return 0;
    // (metros / segundos) * 3.6 = km/h
    return Math.round((distanceMeters / durationSeconds) * 3.6);
  }

  /**
   * Obtiene métricas de procesamiento
   */
  getMetrics() {
    return {
      processedCount: this.processedCount,
      errorCount: this.errorCount,
    };
  }
}
