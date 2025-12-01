import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { TripRepository } from '../../database/repositories/trip.repository';
import { StopRepository } from '../../database/repositories/stop.repository';
import { DeviceStateService } from './device-state.service';
import { DEFAULT_THRESHOLDS } from '../models';

/**
 * Servicio encargado de limpiar trips y stops huérfanos
 *
 * Ejecuta periódicamente (cada hora) para:
 * - Cerrar trips activos sin actualizaciones en las últimas N horas
 * - Cerrar stops activos sin actualizaciones
 * - Limpiar estados en Redis de dispositivos inactivos
 *
 * Esto maneja casos donde:
 * - El tracker dejó de reportar permanentemente
 * - Se perdió el estado en Redis por reinicio
 * - Bugs que dejaron trips/stops sin cerrar
 */
@Injectable()
export class OrphanTripCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OrphanTripCleanupService.name);
  private cleanupInterval: NodeJS.Timeout | null = null;

  // Intervalo de cleanup en milisegundos (1 hora)
  private readonly CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

  // Timeout para considerar un trip huérfano (en horas)
  private readonly ORPHAN_TIMEOUT_HOURS =
    DEFAULT_THRESHOLDS.orphanTripTimeout / 3600; // 4 horas por defecto

  constructor(
    private readonly tripRepository: TripRepository,
    private readonly stopRepository: StopRepository,
    private readonly deviceStateService: DeviceStateService,
  ) {}

  async onModuleInit() {
    // Ejecutar cleanup inicial
    await this.runCleanup();

    // Programar cleanup periódico cada hora
    this.cleanupInterval = setInterval(() => {
      this.runCleanup().catch((error) => {
        this.logger.error('Error in scheduled cleanup', error.stack);
      });
    }, this.CLEANUP_INTERVAL_MS);

    this.logger.log(
      `Orphan cleanup service started (interval: ${this.CLEANUP_INTERVAL_MS / 1000 / 60} minutes, ` +
        `timeout: ${this.ORPHAN_TIMEOUT_HOURS} hours)`,
    );
  }

  async onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Ejecuta el proceso de limpieza completo
   */
  async runCleanup(): Promise<void> {
    const startTime = Date.now();
    this.logger.log('Starting orphan cleanup...');

    try {
      const tripsCleanedUp = await this.cleanupOrphanTrips();
      const stopsCleanedUp = await this.cleanupOrphanStops();
      const redisCleanedUp = await this.cleanupOrphanRedisStates();

      const duration = Date.now() - startTime;
      this.logger.log(
        `Orphan cleanup completed in ${duration}ms: ` +
          `${tripsCleanedUp} trips, ${stopsCleanedUp} stops, ${redisCleanedUp} redis states`,
      );
    } catch (error) {
      this.logger.error('Error during orphan cleanup', error.stack);
    }
  }

  /**
   * Cierra trips huérfanos que no se actualizaron en el tiempo configurado
   */
  private async cleanupOrphanTrips(): Promise<number> {
    try {
      const orphanTrips = await this.tripRepository.findOrphanTrips(
        this.ORPHAN_TIMEOUT_HOURS,
      );

      if (orphanTrips.length === 0) {
        return 0;
      }

      this.logger.warn(
        `Found ${orphanTrips.length} orphan trips without updates in ${this.ORPHAN_TIMEOUT_HOURS}+ hours`,
      );

      let closedCount = 0;

      for (const trip of orphanTrips) {
        try {
          // Calcular duración desde inicio hasta última actualización
          const duration = Math.floor(
            (trip.updated_at.getTime() - trip.start_time.getTime()) / 1000,
          );

          await this.tripRepository.update(trip.id, {
            end_time: trip.updated_at,
            is_active: false,
            duration: duration > 0 ? duration : 0,
            metadata: {
              ...(trip.metadata || {}),
              closedBy: 'orphan_cleanup',
              cleanupReason: `no_update_${this.ORPHAN_TIMEOUT_HOURS}h`,
              originalUpdatedAt: trip.updated_at.toISOString(),
              cleanupTimestamp: new Date().toISOString(),
            },
          });

          this.logger.log(
            `Closed orphan trip ${trip.id} (device: ${trip.id_activo}, ` +
              `started: ${trip.start_time.toISOString()}, ` +
              `last update: ${trip.updated_at.toISOString()})`,
          );

          closedCount++;
        } catch (error) {
          this.logger.error(
            `Error closing orphan trip ${trip.id}: ${error.message}`,
          );
        }
      }

      return closedCount;
    } catch (error) {
      this.logger.error('Error finding orphan trips', error.stack);
      return 0;
    }
  }

  /**
   * Cierra stops huérfanos que quedaron activos sin trip asociado
   */
  private async cleanupOrphanStops(): Promise<number> {
    try {
      const orphanStops = await this.stopRepository.findOrphanStops(
        this.ORPHAN_TIMEOUT_HOURS,
      );

      if (orphanStops.length === 0) {
        return 0;
      }

      this.logger.warn(
        `Found ${orphanStops.length} orphan stops without updates in ${this.ORPHAN_TIMEOUT_HOURS}+ hours`,
      );

      let closedCount = 0;

      for (const stop of orphanStops) {
        try {
          // Calcular duración desde inicio hasta última actualización
          const duration = Math.floor(
            (stop.updated_at.getTime() - stop.start_time.getTime()) / 1000,
          );

          await this.stopRepository.update(stop.id, {
            end_time: stop.updated_at,
            is_active: false,
            duration: duration > 0 ? duration : 0,
            metadata: {
              ...(stop.metadata || {}),
              closedBy: 'orphan_cleanup',
              cleanupReason: `no_update_${this.ORPHAN_TIMEOUT_HOURS}h`,
              cleanupTimestamp: new Date().toISOString(),
            },
          });

          this.logger.log(
            `Closed orphan stop ${stop.id} (device: ${stop.id_activo})`,
          );

          closedCount++;
        } catch (error) {
          this.logger.error(
            `Error closing orphan stop ${stop.id}: ${error.message}`,
          );
        }
      }

      return closedCount;
    } catch (error) {
      this.logger.error('Error finding orphan stops', error.stack);
      return 0;
    }
  }

  /**
   * Limpia estados de Redis para dispositivos con trips huérfanos cerrados
   * Esto permite que cuando el dispositivo vuelva a reportar, empiece fresh
   */
  private async cleanupOrphanRedisStates(): Promise<number> {
    try {
      const activeDevices = await this.deviceStateService.getAllActiveDevices();

      if (activeDevices.length === 0) {
        return 0;
      }

      let cleanedCount = 0;
      const cutoffTime = Date.now() - this.ORPHAN_TIMEOUT_HOURS * 60 * 60 * 1000;

      for (const deviceId of activeDevices) {
        try {
          const state = await this.deviceStateService.getDeviceState(deviceId);

          if (!state) continue;

          // Si el estado tiene un trip activo y no se ha actualizado en mucho tiempo,
          // limpiar el estado para que el dispositivo empiece fresh
          if (
            state.currentTripId &&
            state.lastUpdate &&
            state.lastUpdate < cutoffTime
          ) {
            this.logger.log(
              `Cleaning stale Redis state for device ${deviceId} ` +
                `(last update: ${new Date(state.lastUpdate).toISOString()})`,
            );

            await this.deviceStateService.deleteDeviceState(deviceId);
            cleanedCount++;
          }
        } catch (error) {
          this.logger.error(
            `Error cleaning Redis state for device ${deviceId}: ${error.message}`,
          );
        }
      }

      return cleanedCount;
    } catch (error) {
      this.logger.error('Error cleaning orphan Redis states', error.stack);
      return 0;
    }
  }
}
