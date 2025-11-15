import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { TripRepository } from '../../database/repositories/trip.repository';
import {
  ITripStartedEvent,
  ITripCompletedEvent,
} from '../../interfaces/trip-events.interface';

/**
 * Servicio encargado de escuchar eventos de trips
 * y persistirlos en PostgreSQL
 *
 * Eventos:
 * - trip:started - Crear registro de trip en BD
 * - trip:completed - Actualizar trip con datos finales
 */
@Injectable()
export class TripPersistenceService implements OnModuleInit {
  private readonly logger = new Logger(TripPersistenceService.name);
  private subscriber: any; // Redis client para suscripciones

  constructor(
    private readonly redisService: RedisService,
    private readonly tripRepository: TripRepository,
  ) {}

  /**
   * Al iniciar el módulo, suscribirse a eventos de trips
   */
  async onModuleInit() {
    await this.subscribeToTripEvents();
  }

  /**
   * Suscribirse a eventos de trips via Redis PubSub
   */
  private async subscribeToTripEvents(): Promise<void> {
    try {
      this.logger.log('Suscribiéndose a eventos de trips...');

      // Crear cliente subscriber separado usando el método del RedisService
      this.subscriber = this.redisService.createSubscriber();

      // Manejar eventos
      this.subscriber.on('message', async (channel: string, message: string) => {
        if (channel === 'trip:started') {
          await this.handleTripStarted(message).catch((error) => {
            this.logger.error('Error handling trip:started event', error.stack);
          });
        } else if (channel === 'trip:completed') {
          await this.handleTripCompleted(message).catch((error) => {
            this.logger.error('Error handling trip:completed event', error.stack);
          });
        }
      });

      // Suscribirse a canales
      await this.subscriber.subscribe('trip:started');
      await this.subscriber.subscribe('trip:completed');

      this.logger.log('Suscrito a eventos: trip:started, trip:completed');
    } catch (error) {
      this.logger.error('Error suscribiéndose a eventos de trips', error.stack);
      throw error;
    }
  }

  /**
   * Maneja evento trip:started
   * Crea un nuevo registro de trip en la BD
   */
  private async handleTripStarted(message: string): Promise<void> {
    try {
      const event: ITripStartedEvent = JSON.parse(message);

      this.logger.debug(
        `Creando trip ${event.tripId} para device ${event.deviceId}`,
      );

      // Extraer lat/lon del formato GeoJSON [lon, lat]
      const [longitude, latitude] = event.startLocation.coordinates;

      await this.tripRepository.create({
        id_activo: event.deviceId,
        start_time: new Date(event.startTime),
        start_lat: latitude,
        start_lon: longitude,
        detection_method: event.detectionMethod,
        metadata: {
          tripId: event.tripId,
        },
      });

      this.logger.log(
        `Trip ${event.tripId} creado en BD para device ${event.deviceId}`,
      );
    } catch (error) {
      this.logger.error(
        `Error creando trip en BD: ${error.message}`,
        error.stack,
      );
    }
  }

  /**
   * Maneja evento trip:completed
   * Actualiza el trip con datos finales
   */
  private async handleTripCompleted(message: string): Promise<void> {
    try {
      const event: ITripCompletedEvent = JSON.parse(message);

      this.logger.debug(
        `Completando trip ${event.tripId} para device ${event.deviceId}`,
      );

      // Encontrar el trip activo por deviceId
      // (ya que el tripId es solo un identificador del evento, no el PK de la BD)
      const trip = await this.tripRepository.findActiveByAsset(event.deviceId);

      if (!trip) {
        this.logger.warn(
          `No se encontró trip activo para device ${event.deviceId}`,
        );
        return;
      }

      // Extraer lat/lon del formato GeoJSON [lon, lat]
      const [endLongitude, endLatitude] = event.endLocation.coordinates;

      // Actualizar con datos finales
      await this.tripRepository.update(trip.id, {
        end_time: new Date(event.endTime),
        end_lat: endLatitude,
        end_lon: endLongitude,
        distance: event.distance,
        max_speed: event.maxSpeed,
        avg_speed: event.avgSpeed,
        duration: event.duration,
        stop_count: event.stopsCount,
        is_active: false,
        metadata: {
          ...trip.metadata,
          tripId: event.tripId,
        },
      });

      this.logger.log(
        `Trip ${trip.id} completado para device ${event.deviceId}: ` +
          `${event.distance}m en ${event.duration}s`,
      );
    } catch (error) {
      this.logger.error(
        `Error completando trip en BD: ${error.message}`,
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
