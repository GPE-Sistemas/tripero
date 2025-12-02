import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { TripRepository } from '../../database/repositories/trip.repository';
import { DeviceEventQueueManager } from './device-event-queue.manager';
import {
  ITripStartedEvent,
  ITripCompletedEvent,
} from '../../interfaces/trip-events.interface';
import { TripQualityAnalyzerService } from './trip-quality-analyzer.service';

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
    private readonly eventQueueManager: DeviceEventQueueManager,
    private readonly tripQualityAnalyzer: TripQualityAnalyzerService,
  ) {}

  /**
   * Al iniciar el módulo, suscribirse a eventos de trips
   */
  async onModuleInit() {
    await this.cleanupOrphanTrips();
    await this.subscribeToTripEvents();
  }

  /**
   * Cierra trips huérfanos que no se actualizaron en más de 24 horas
   * Esto maneja casos donde:
   * - El servicio se reinició y perdió estado en Redis
   * - Dispositivos dejaron de reportar permanentemente
   * - Bugs que dejaron trips sin cerrar
   */
  private async cleanupOrphanTrips(): Promise<void> {
    try {
      this.logger.log('Verificando trips huérfanos...');

      // Buscar trips activos sin actualización en las últimas 24 horas
      const orphanTrips = await this.tripRepository.findOrphanTrips(24);

      if (orphanTrips.length === 0) {
        this.logger.log('No se encontraron trips huérfanos');
        return;
      }

      this.logger.warn(
        `Encontrados ${orphanTrips.length} trips huérfanos sin actualización en 24+ horas`,
      );

      // Cerrar cada trip huérfano
      for (const trip of orphanTrips) {
        try {
          // Calcular duración desde inicio hasta última actualización
          const duration = Math.floor(
            (trip.updated_at.getTime() - trip.start_time.getTime()) / 1000,
          );

          await this.tripRepository.update(trip.id, {
            end_time: trip.updated_at, // Usar última actualización como fin
            is_active: false,
            metadata: {
              ...(trip.metadata || {}),
              closedBy: 'orphan_cleanup',
              cleanupReason: 'no_update_24h',
              originalUpdatedAt: trip.updated_at.toISOString(),
            },
          });

          this.logger.log(
            `Trip huérfano ${trip.id} cerrado automáticamente ` +
              `(device: ${trip.id_activo}, última actualización: ${trip.updated_at.toISOString()})`,
          );
        } catch (error) {
          this.logger.error(
            `Error cerrando trip huérfano ${trip.id}: ${error.message}`,
            error.stack,
          );
        }
      }

      this.logger.log(
        `Limpieza de trips huérfanos completada: ${orphanTrips.length} trips cerrados`,
      );
    } catch (error) {
      this.logger.error(
        'Error en limpieza de trips huérfanos',
        error.stack,
      );
      // No lanzar error para no bloquear inicio del servicio
    }
  }

  /**
   * Suscribirse a eventos de trips via Redis PubSub
   */
  private async subscribeToTripEvents(): Promise<void> {
    try {
      this.logger.log('Suscribiéndose a eventos de trips...');

      // Crear cliente subscriber separado usando el método del RedisService
      this.subscriber = this.redisService.createSubscriber();

      // Obtener canales con prefijo (publish usa prefijo, así que subscribe también debe usarlo)
      const tripStartedChannel = this.redisService.getPrefixedChannel('trip:started');
      const tripCompletedChannel = this.redisService.getPrefixedChannel('trip:completed');

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
          if (channel === tripStartedChannel) {
            await this.eventQueueManager.enqueue(deviceId, async () => {
              await this.handleTripStarted(message);
            });
          } else if (channel === tripCompletedChannel) {
            await this.eventQueueManager.enqueue(deviceId, async () => {
              await this.handleTripCompleted(message);
            });
          }
        } catch (error) {
          this.logger.error(
            `Error enqueuing event from channel ${channel}`,
            error.stack,
          );
        }
      });

      // Suscribirse a canales con prefijo
      await this.subscriber.subscribe(tripStartedChannel);
      await this.subscriber.subscribe(tripCompletedChannel);

      this.logger.log(`Suscrito a eventos: ${tripStartedChannel}, ${tripCompletedChannel}`);
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
        id: event.tripId,
        id_activo: event.deviceId,
        start_time: new Date(event.startTime),
        start_lat: latitude,
        start_lon: longitude,
        detection_method: event.detectionMethod,
        metadata: event.metadata,
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
   *
   * NOTA: La distancia ya viene corregida por ruido GPS desde StateMachine.
   * NO aplicamos correcciones adicionales aquí.
   */
  private async handleTripCompleted(message: string): Promise<void> {
    try {
      const event: ITripCompletedEvent = JSON.parse(message);

      this.logger.debug(
        `Completando trip ${event.tripId} para device ${event.deviceId}`,
      );

      // Buscar trip por ID directo para evitar race conditions
      const trip = await this.tripRepository.findById(event.tripId);

      if (!trip) {
        this.logger.warn(
          `Trip ${event.tripId} no encontrado en BD`,
        );
        return;
      }

      // Verificar que el trip pertenece al dispositivo correcto
      if (trip.id_activo !== event.deviceId) {
        this.logger.error(
          `Trip ${event.tripId} pertenece a device ${trip.id_activo}, no a ${event.deviceId}`,
        );
        return;
      }

      // Extraer lat/lon del formato GeoJSON [lon, lat]
      const [endLongitude, endLatitude] = event.endLocation.coordinates;
      const [startLongitude, startLatitude] = [trip.start_lon, trip.start_lat];

      // Extraer métricas del contexto del trip (vienen en metadata)
      const tripMetrics = event.metadata?.tripQualityMetrics || {};
      const maxDistanceFromOrigin = event.metadata?.maxDistanceFromOrigin || 0;
      const boundingBoxDiameter = event.metadata?.boundingBoxDiameter || 0;

      // Analizar calidad del trip (solo métricas, SIN correcciones)
      const qualityAnalysis = this.tripQualityAnalyzer.analyzeTripQuality(
        startLatitude,
        startLongitude,
        endLatitude,
        endLongitude,
        event.distance, // Ya viene corregida por ruido GPS
        maxDistanceFromOrigin,
        boundingBoxDiameter,
        event.avgSpeed || 0,
        tripMetrics.gpsNoiseSegments || 0,
        tripMetrics.segmentsTotal || 0,
      );

      // La distancia final es la que viene del evento (ya corregida por ruido GPS)
      const finalDistance = event.distance;

      // Actualizar con datos finales y métricas de calidad
      await this.tripRepository.update(trip.id, {
        end_time: new Date(event.endTime),
        end_lat: endLatitude,
        end_lon: endLongitude,
        distance: finalDistance,
        distance_original: tripMetrics.originalDistance || event.distance,
        distance_linear: qualityAnalysis.linearDistance,
        route_linear_ratio: qualityAnalysis.tripRatio,
        operation_area_diameter: qualityAnalysis.boundingBoxDiameter,
        quality_flag: qualityAnalysis.qualityFlag,
        quality_metadata: {
          analysisMessage: qualityAnalysis.message,
          hadGpsNoise: qualityAnalysis.hadGpsNoise,
          gpsNoisePercentage: qualityAnalysis.gpsNoisePercentage,
          maxDistanceFromOrigin: qualityAnalysis.maxDistanceFromOrigin,
          segmentsTotal: tripMetrics.segmentsTotal || 0,
          segmentsAdjusted: tripMetrics.segmentsAdjusted || 0,
          gpsNoiseSegments: tripMetrics.gpsNoiseSegments || 0,
        },
        max_speed: event.maxSpeed,
        avg_speed: event.avgSpeed,
        duration: event.duration,
        stop_count: event.stopsCount,
        is_active: false,
        metadata: event.metadata || trip.metadata || undefined,
      });

      this.logger.log(
        `Trip ${trip.id} completado para device ${event.deviceId}: ` +
          `${finalDistance.toFixed(0)}m en ${event.duration}s ` +
          `(quality: ${qualityAnalysis.qualityFlag})`,
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
