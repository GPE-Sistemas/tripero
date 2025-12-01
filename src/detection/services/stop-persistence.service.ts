import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { StopRepository } from '../../database/repositories/stop.repository';
import { DeviceEventQueueManager } from './device-event-queue.manager';
import {
  IStopStartedEvent,
  IStopCompletedEvent,
} from '../../interfaces/trip-events.interface';

/**
 * Servicio encargado de escuchar eventos de stops
 * y persistirlos en PostgreSQL
 *
 * Eventos:
 * - stop:started - Crear registro de stop en BD
 * - stop:completed - Actualizar stop con datos finales
 */
@Injectable()
export class StopPersistenceService implements OnModuleInit {
  private readonly logger = new Logger(StopPersistenceService.name);
  private subscriber: any; // Redis client para suscripciones

  constructor(
    private readonly redisService: RedisService,
    private readonly stopRepository: StopRepository,
    private readonly eventQueueManager: DeviceEventQueueManager,
  ) {}

  /**
   * Al iniciar el módulo, suscribirse a eventos de stops
   */
  async onModuleInit() {
    await this.subscribeToStopEvents();
  }

  /**
   * Suscribirse a eventos de stops via Redis PubSub
   */
  private async subscribeToStopEvents(): Promise<void> {
    try {
      this.logger.log('Suscribiéndose a eventos de stops...');

      // Crear cliente subscriber separado usando el método del RedisService
      this.subscriber = this.redisService.createSubscriber();

      // Manejar eventos - encolar para procesamiento secuencial por dispositivo
      this.subscriber.on('message', async (channel: string, message: string) => {
        try {
          const event = JSON.parse(message);
          const deviceId = event.deviceId;

          if (!deviceId) {
            this.logger.warn(`Event without deviceId on channel ${channel}`);
            return;
          }

          // Encolar evento para procesamiento secuencial
          if (channel === 'stop:started') {
            await this.eventQueueManager.enqueue(deviceId, async () => {
              await this.handleStopStarted(message);
            });
          } else if (channel === 'stop:completed') {
            await this.eventQueueManager.enqueue(deviceId, async () => {
              await this.handleStopCompleted(message);
            });
          }
        } catch (error) {
          this.logger.error(
            `Error enqueuing event from channel ${channel}`,
            error.stack,
          );
        }
      });

      // Suscribirse a canales
      await this.subscriber.subscribe('stop:started');
      await this.subscriber.subscribe('stop:completed');

      this.logger.log('Suscrito a eventos: stop:started, stop:completed');
    } catch (error) {
      this.logger.error('Error suscribiéndose a eventos de stops', error.stack);
      throw error;
    }
  }

  /**
   * Maneja evento stop:started
   * Crea un nuevo registro de stop en la BD
   */
  private async handleStopStarted(message: string): Promise<void> {
    try {
      const event: IStopStartedEvent = JSON.parse(message);

      this.logger.debug(
        `Creando stop ${event.stopId} para device ${event.deviceId}`,
      );

      // Extraer lat/lon del formato GeoJSON [lon, lat]
      const [longitude, latitude] = event.location.coordinates;

      await this.stopRepository.create({
        id: event.stopId,
        id_activo: event.deviceId,
        start_time: new Date(event.startTime),
        latitude,
        longitude,
        reason: event.reason,
        trip_id: event.tripId,
        start_odometer: event.odometer,
        metadata: event.metadata,
      });

      this.logger.log(
        `Stop ${event.stopId} creado en BD para device ${event.deviceId} (razón: ${event.reason})`,
      );
    } catch (error) {
      this.logger.error(
        `Error creando stop en BD: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Maneja evento stop:completed
   * Actualiza el stop con datos finales
   */
  private async handleStopCompleted(message: string): Promise<void> {
    try {
      const event: IStopCompletedEvent = JSON.parse(message);

      this.logger.debug(
        `Completando stop ${event.stopId} para device ${event.deviceId}`,
      );

      // Buscar stop por ID directo para evitar race conditions
      // cuando hay múltiples stops sucesivos
      const stop = await this.stopRepository.findById(event.stopId);

      if (!stop) {
        this.logger.warn(
          `Stop ${event.stopId} no encontrado en BD`,
        );
        return;
      }

      // Verificar que el stop pertenece al dispositivo correcto (seguridad)
      if (stop.id_activo !== event.deviceId) {
        this.logger.error(
          `Stop ${event.stopId} pertenece a device ${stop.id_activo}, no a ${event.deviceId}`,
        );
        return;
      }

      // Actualizar con datos finales
      await this.stopRepository.update(stop.id, {
        end_time: new Date(event.endTime),
        duration: event.duration,
        is_active: false,
        end_odometer: event.odometer,
        metadata: event.metadata || stop.metadata || undefined,
      });

      this.logger.log(
        `Stop ${stop.id} completado para device ${event.deviceId}: ` +
          `${event.duration}s (${stop.latitude.toFixed(4)}, ${stop.longitude.toFixed(4)})`,
      );
    } catch (error) {
      this.logger.error(
        `Error completando stop en BD: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Cleanup al destruir el servicio
   */
  async onModuleDestroy() {
    if (this.subscriber) {
      await this.subscriber.quit();
    }
  }
}
