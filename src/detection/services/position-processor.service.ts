import { Injectable, Logger } from '@nestjs/common';
import {
  IPositionEvent,
  ITripStartedEvent,
  ITripCompletedEvent,
  IStopStartedEvent,
  IStopCompletedEvent
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

      // 6. Log de transición si ocurrió
      if (result.transitionOccurred) {
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
    const { actions, updatedState } = result;

    try {
      // Iniciar trip
      if (actions.startTrip && updatedState.currentTripId) {
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
        };

        await this.eventPublisher.publishTripStarted(event);

        // Notificar al TrackerStateService
        await this.trackerState.onTripStarted(
          position.deviceId,
          updatedState.currentTripId,
        );
      }

      // Finalizar trip
      if (actions.endTrip && updatedState.currentTripId) {
        const tripDuration =
          (updatedState.lastTimestamp - updatedState.tripStartTime) / 1000;

        const event: ITripCompletedEvent = {
          tripId: updatedState.currentTripId,
          deviceId: position.deviceId,
          startTime: new Date(updatedState.tripStartTime).toISOString(),
          endTime: new Date(updatedState.lastTimestamp).toISOString(),
          duration: Math.round(tripDuration),
          distance: Math.round(updatedState.tripDistance || 0),
          avgSpeed: this.calculateAvgSpeed(
            updatedState.tripDistance || 0,
            tripDuration,
          ),
          maxSpeed: Math.round(updatedState.tripMaxSpeed || 0),
          stopsCount: updatedState.tripStopsCount || 0,
          startLocation: {
            type: 'Point',
            coordinates: [
              updatedState.tripStartLon,
              updatedState.tripStartLat,
            ],
          },
          endLocation: {
            type: 'Point',
            coordinates: [updatedState.lastLon, updatedState.lastLat],
          },
          detectionMethod: position.ignition ? 'ignition' : 'motion',
        };

        await this.eventPublisher.publishTripCompleted(event);

        // Notificar al TrackerStateService (para actualizar estadísticas)
        await this.trackerState.onTripCompleted(
          position.deviceId,
          event.duration,
          0, // idle time - TODO: calcular desde trip
          event.stopsCount,
        );

        // Limpiar datos del trip en el estado
        updatedState.currentTripId = undefined;
        updatedState.tripStartTime = undefined;
        updatedState.tripStartLat = undefined;
        updatedState.tripStartLon = undefined;
        updatedState.tripDistance = undefined;
        updatedState.tripMaxSpeed = undefined;
        updatedState.tripStopsCount = undefined;

        await this.deviceState.saveDeviceState(updatedState);
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
        };

        await this.eventPublisher.publishStopStarted(event);

        // Guardar info del stop en el estado para cuando se complete
        updatedState.currentStopId = stopId;
        updatedState.stopStartTime = position.timestamp;
        updatedState.stopStartLat = position.latitude;
        updatedState.stopStartLon = position.longitude;
        updatedState.stopReason = reason;
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
          // address: undefined, // Geocoding será manejado por servicio externo
          reason: updatedState.stopReason || 'no_movement',
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
