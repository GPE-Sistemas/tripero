import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

/**
 * Cola de eventos para un dispositivo específico
 *
 * Procesa eventos de persistencia (stops/trips) de forma secuencial
 * para evitar race conditions en operaciones de BD
 */
class DeviceEventQueue {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private lastActivity: number;

  constructor(
    private readonly deviceId: string,
    private readonly logger: Logger,
  ) {
    this.lastActivity = Date.now();
  }

  /**
   * Agrega un evento a la cola y dispara el procesamiento si no está activo
   */
  async add(eventHandler: () => Promise<void>): Promise<void> {
    this.queue.push(eventHandler);
    this.lastActivity = Date.now();

    // Si no está procesando, iniciar procesamiento
    if (!this.processing) {
      // No await - procesamos en background
      this.processQueue().catch((error) => {
        this.logger.error(
          `Error in event queue processing for device ${this.deviceId}`,
          error.stack,
        );
      });
    }
  }

  /**
   * Procesa todos los eventos en la cola de forma secuencial
   */
  private async processQueue(): Promise<void> {
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const eventHandler = this.queue.shift();

        if (!eventHandler) {
          continue;
        }

        try {
          // Ejecutar handler de forma secuencial
          await eventHandler();
        } catch (error) {
          this.logger.error(
            `Error processing event for device ${this.deviceId}`,
            error.stack,
          );
          // Continuar con el siguiente evento incluso si este falló
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
}

/**
 * Gestor de colas de eventos de persistencia por dispositivo
 *
 * Garantiza procesamiento secuencial de eventos stop:started/completed
 * y trip:started/completed por dispositivo para evitar race conditions
 * en operaciones de base de datos.
 */
@Injectable()
export class DeviceEventQueueManager implements OnModuleInit {
  private readonly logger = new Logger(DeviceEventQueueManager.name);
  private queues: Map<string, DeviceEventQueue> = new Map();

  // Métricas
  private totalEnqueued = 0;
  private maxQueueSize = 0;
  private cleanupInterval?: NodeJS.Timeout;

  // Configuración
  private readonly CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutos
  private readonly QUEUE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutos de inactividad

  async onModuleInit() {
    this.logger.log('Initializing Device Event Queue Manager...');
    this.startCleanupTask();

    // Log de métricas cada minuto
    setInterval(() => {
      this.logMetrics();
    }, 60000);
  }

  /**
   * Encola un evento para procesamiento secuencial por dispositivo
   */
  async enqueue(
    deviceId: string,
    eventHandler: () => Promise<void>,
  ): Promise<void> {
    let queue = this.queues.get(deviceId);

    if (!queue) {
      queue = new DeviceEventQueue(deviceId, this.logger);
      this.queues.set(deviceId, queue);
    }

    this.totalEnqueued++;
    await queue.add(eventHandler);

    // Actualizar máximo tamaño de cola
    const currentSize = queue.getSize();
    if (currentSize > this.maxQueueSize) {
      this.maxQueueSize = currentSize;

      if (this.maxQueueSize > 10) {
        this.logger.warn(
          `High event queue size for device ${deviceId}: ${this.maxQueueSize} events`,
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
      `Cleanup task started: checking every ${this.CLEANUP_INTERVAL_MS / 1000}s for inactive event queues`,
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
      }
    }

    if (removed > 0) {
      this.logger.log(
        `Event queue cleanup: removed ${removed} inactive queues (${before} -> ${this.queues.size})`,
      );
    }
  }

  /**
   * Obtiene métricas del gestor de colas
   */
  getMetrics() {
    const activeQueues = this.queues.size;
    let totalQueuedEvents = 0;
    let processingQueues = 0;
    const devicesWithBacklog: string[] = [];

    for (const [deviceId, queue] of this.queues) {
      const size = queue.getSize();
      totalQueuedEvents += size;

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
      totalQueuedEvents,
      processingQueues,
      maxQueueSizeEver: this.maxQueueSize,
      devicesWithBacklog,
      avgQueueSize: activeQueues > 0
        ? (totalQueuedEvents / activeQueues).toFixed(2)
        : 0,
    };
  }

  /**
   * Log de métricas
   */
  private logMetrics(): void {
    const metrics = this.getMetrics();

    this.logger.log(
      `Event queue metrics: ${metrics.activeQueues} active queues, ` +
      `${metrics.totalQueuedEvents} events queued, ` +
      `${metrics.processingQueues} processing`,
    );

    if (metrics.devicesWithBacklog.length > 0) {
      this.logger.warn(
        `Devices with event backlog (>5): ${metrics.devicesWithBacklog.join(', ')}`,
      );
    }

    // Reset contador
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
      `Shutting down with ${metrics.activeQueues} active event queues, ` +
      `${metrics.totalQueuedEvents} events still queued`,
    );
  }
}
