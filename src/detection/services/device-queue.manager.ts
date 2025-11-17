import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { IPositionEvent } from '../../interfaces';
import { PositionProcessorService } from './position-processor.service';

/**
 * Cola de procesamiento para un dispositivo específico
 *
 * Garantiza procesamiento secuencial de posiciones para evitar race conditions
 * en la creación/completado de stops y trips
 */
class DeviceQueue {
  private queue: IPositionEvent[] = [];
  private processing = false;
  private lastActivity: number;
  private readonly logger: Logger;

  constructor(
    private readonly deviceId: string,
    private readonly processor: PositionProcessorService,
    parentLogger: Logger,
  ) {
    this.lastActivity = Date.now();
    this.logger = new Logger(`${parentLogger.constructor.name}:Queue:${deviceId}`);
  }

  /**
   * Agrega una posición a la cola y dispara el procesamiento si no está activo
   */
  async add(position: IPositionEvent): Promise<void> {
    this.queue.push(position);
    this.lastActivity = Date.now();

    this.logger.debug(
      `Position enqueued for device ${this.deviceId}. Queue size: ${this.queue.length}`,
    );

    // Si no está procesando, iniciar procesamiento
    if (!this.processing) {
      // No await - procesamos en background para no bloquear el publisher
      this.processQueue().catch((error) => {
        this.logger.error(
          `Error in queue processing for device ${this.deviceId}`,
          error.stack,
        );
      });
    }
  }

  /**
   * Procesa todas las posiciones en la cola de forma secuencial
   */
  private async processQueue(): Promise<void> {
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const position = this.queue.shift();

        if (!position) {
          continue;
        }

        const startTime = Date.now();

        try {
          // Procesar posición de forma secuencial
          await this.processor.processPosition(position);

          const processingTime = Date.now() - startTime;

          if (processingTime > 200) {
            this.logger.warn(
              `Slow processing for device ${this.deviceId}: ${processingTime}ms`,
            );
          }
        } catch (error) {
          this.logger.error(
            `Error processing position for device ${this.deviceId}`,
            error.stack,
          );
          // Continuar con la siguiente posición incluso si esta falló
        }
      }
    } finally {
      this.processing = false;
      this.lastActivity = Date.now();
    }
  }

  /**
   * Verifica si la cola está inactiva (para cleanup)
   */
  isInactive(timeoutMs: number): boolean {
    const now = Date.now();
    return !this.processing && (now - this.lastActivity) > timeoutMs;
  }

  /**
   * Obtiene el tamaño actual de la cola
   */
  getSize(): number {
    return this.queue.length;
  }

  /**
   * Verifica si está procesando
   */
  isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Obtiene timestamp de última actividad
   */
  getLastActivity(): number {
    return this.lastActivity;
  }
}

/**
 * Gestor de colas de procesamiento por dispositivo
 *
 * Mantiene una cola independiente para cada dispositivo, garantizando
 * procesamiento secuencial de posiciones por tracker mientras permite
 * procesamiento paralelo entre diferentes trackers.
 *
 * Esto elimina race conditions en la persistencia de stops/trips que
 * ocurren cuando múltiples eventos (stop:started, stop:completed) se
 * publican casi simultáneamente.
 */
@Injectable()
export class DeviceQueueManager implements OnModuleInit {
  private readonly logger = new Logger(DeviceQueueManager.name);
  private queues: Map<string, DeviceQueue> = new Map();

  // Métricas
  private totalEnqueued = 0;
  private maxQueueSize = 0;
  private cleanupInterval?: NodeJS.Timeout;

  // Configuración
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
  private readonly QUEUE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos de inactividad

  constructor(private readonly processor: PositionProcessorService) {}

  async onModuleInit() {
    this.logger.log('Initializing Device Queue Manager...');
    this.startCleanupTask();

    // Log de métricas cada minuto
    setInterval(() => {
      this.logMetrics();
    }, 60000);
  }

  /**
   * Encola una posición para procesamiento secuencial por dispositivo
   */
  async enqueue(deviceId: string, position: IPositionEvent): Promise<void> {
    let queue = this.queues.get(deviceId);

    if (!queue) {
      this.logger.debug(`Creating new queue for device ${deviceId}`);
      queue = new DeviceQueue(deviceId, this.processor, this.logger);
      this.queues.set(deviceId, queue);
    }

    this.totalEnqueued++;
    await queue.add(position);

    // Actualizar máximo tamaño de cola
    const currentSize = queue.getSize();
    if (currentSize > this.maxQueueSize) {
      this.maxQueueSize = currentSize;

      if (this.maxQueueSize > 10) {
        this.logger.warn(
          `High queue size detected for device ${deviceId}: ${this.maxQueueSize} positions`,
        );
      }
    }
  }

  /**
   * Inicia tarea de limpieza de colas inactivas
   */
  private startCleanupTask(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupInactiveQueues();
    }, this.CLEANUP_INTERVAL_MS);

    this.logger.log(
      `Cleanup task started: checking every ${this.CLEANUP_INTERVAL_MS / 1000}s for inactive queues`,
    );
  }

  /**
   * Limpia colas que llevan inactivas más del timeout configurado
   */
  private cleanupInactiveQueues(): void {
    const before = this.queues.size;
    let removed = 0;

    for (const [deviceId, queue] of this.queues) {
      if (queue.isInactive(this.QUEUE_TIMEOUT_MS)) {
        this.queues.delete(deviceId);
        removed++;
        this.logger.debug(`Cleaned up inactive queue for device ${deviceId}`);
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Cleanup completed: removed ${removed} inactive queues (${before} -> ${this.queues.size})`,
      );
    }
  }

  /**
   * Obtiene métricas del gestor de colas
   */
  getMetrics() {
    const activeQueues = this.queues.size;
    let totalQueuedPositions = 0;
    let processingQueues = 0;
    const devicesWithBacklog: string[] = [];

    for (const [deviceId, queue] of this.queues) {
      const size = queue.getSize();
      totalQueuedPositions += size;

      if (queue.isProcessing()) {
        processingQueues++;
      }

      if (size > 5) {
        devicesWithBacklog.push(`${deviceId}:${size}`);
      }
    }

    return {
      activeQueues,
      totalEnqueued: this.totalEnqueued,
      totalQueuedPositions,
      processingQueues,
      maxQueueSizeEver: this.maxQueueSize,
      devicesWithBacklog,
      avgQueueSize: activeQueues > 0
        ? (totalQueuedPositions / activeQueues).toFixed(2)
        : 0,
    };
  }

  /**
   * Log de métricas
   */
  private logMetrics(): void {
    const metrics = this.getMetrics();

    this.logger.log(
      `Queue metrics: ${metrics.activeQueues} active queues, ` +
      `${metrics.totalQueuedPositions} positions queued, ` +
      `${metrics.processingQueues} processing, ` +
      `avg size: ${metrics.avgQueueSize}, ` +
      `max size ever: ${metrics.maxQueueSizeEver}`,
    );

    if (metrics.devicesWithBacklog.length > 0) {
      this.logger.warn(
        `Devices with backlog (>5): ${metrics.devicesWithBacklog.join(', ')}`,
      );
    }

    // Reset contador de enqueued para próximo período
    this.totalEnqueued = 0;
  }

  /**
   * Cleanup al destruir el servicio
   */
  onModuleDestroy() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    const metrics = this.getMetrics();
    this.logger.log(
      `Shutting down with ${metrics.activeQueues} active queues, ` +
      `${metrics.totalQueuedPositions} positions still queued`,
    );
  }
}
