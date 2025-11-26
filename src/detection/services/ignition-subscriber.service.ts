import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { REDIS_CHANNELS } from '../../auxiliares/redis/redis.constants';
import { TrackerStateService } from './tracker-state.service';
import { IIgnitionEvent, validateIgnitionEvent } from '../../interfaces';

/**
 * Servicio de suscripción a eventos de ignición
 *
 * Escucha el canal Redis PubSub 'ignition:changed' y actualiza el estado de ignición
 * de los trackers en TrackerState. Esto permite que trackers que reportan ignición
 * como eventos separados (ej: GPS103) mantengan un estado persistente.
 */
@Injectable()
export class IgnitionSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IgnitionSubscriberService.name);
  private subscriber: Redis;
  private isSubscribed = false;
  private receivedCount = 0;
  private invalidCount = 0;

  constructor(
    private readonly redisService: RedisService,
    private readonly trackerStateService: TrackerStateService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing ignition subscriber...');
    await this.subscribe();

    // Log de métricas cada minuto
    setInterval(() => {
      if (this.isSubscribed && this.receivedCount > 0) {
        this.logger.log(
          `Ignition subscription metrics: ${this.receivedCount} received, ${this.invalidCount} invalid`,
        );
        this.receivedCount = 0;
        this.invalidCount = 0;
      }
    }, 60000);
  }

  async onModuleDestroy() {
    await this.unsubscribe();
  }

  /**
   * Suscribe al canal ignition:changed
   */
  private async subscribe(): Promise<void> {
    const channel = REDIS_CHANNELS.IGNITION_CHANGED;
    const prefixedChannel = this.redisService.getPrefixedChannel(channel);

    try {
      this.subscriber = this.redisService.createSubscriber();

      this.subscriber.on('error', (error) => {
        this.logger.error('Redis subscriber error', error.stack);
        this.isSubscribed = false;
      });

      this.subscriber.on('close', () => {
        this.logger.warn('Redis subscriber connection closed');
        this.isSubscribed = false;

        // Intentar reconectar después de 5 segundos
        setTimeout(() => {
          if (!this.isSubscribed) {
            this.logger.log('Attempting to reconnect ignition subscriber...');
            this.subscribe();
          }
        }, 5000);
      });

      this.subscriber.on('connect', () => {
        this.logger.log('Redis ignition subscriber connected');
      });

      this.subscriber.on('ready', () => {
        this.logger.log('Redis ignition subscriber ready');
      });

      this.subscriber.on('message', async (ch, message) => {
        if (ch === prefixedChannel) {
          await this.handleIgnitionMessage(message);
        }
      });

      await this.subscriber.subscribe(prefixedChannel);
      this.isSubscribed = true;

      this.logger.log(`Successfully subscribed to ${prefixedChannel} channel`);
    } catch (error) {
      this.logger.error(`Error subscribing to ${prefixedChannel}`, error.stack);

      // Reintentar después de 5 segundos
      setTimeout(() => {
        this.logger.log('Retrying ignition subscription...');
        this.subscribe();
      }, 5000);
    }
  }

  /**
   * Desuscribe del canal
   */
  private async unsubscribe(): Promise<void> {
    if (this.subscriber) {
      const prefixedChannel = this.redisService.getPrefixedChannel(
        REDIS_CHANNELS.IGNITION_CHANGED,
      );
      try {
        await this.subscriber.unsubscribe(prefixedChannel);
        await this.subscriber.quit();
        this.isSubscribed = false;
        this.logger.log(`Unsubscribed from ${prefixedChannel} channel`);
      } catch (error) {
        this.logger.error(`Error unsubscribing from ${prefixedChannel}`, error.stack);
      }
    }
  }

  /**
   * Procesa un mensaje de ignición desde Redis
   */
  private async handleIgnitionMessage(message: string): Promise<void> {
    this.receivedCount++;

    try {
      const event: IIgnitionEvent = JSON.parse(message);

      // Validar evento
      if (!validateIgnitionEvent(event)) {
        this.invalidCount++;
        this.logger.warn(`Invalid ignition event received: ${message}`);
        return;
      }

      // Procesar evento
      await this.processIgnitionEvent(event);
    } catch (error) {
      this.invalidCount++;
      this.logger.error('Error handling ignition message', error.stack);
    }
  }

  /**
   * Procesa un evento de ignición validado
   */
  private async processIgnitionEvent(event: IIgnitionEvent): Promise<void> {
    this.logger.debug(
      `Ignition ${event.ignition ? 'ON' : 'OFF'} for device ${event.deviceId}`,
    );

    // Actualizar estado del tracker
    await this.trackerStateService.updateIgnition(
      event.deviceId,
      event.ignition,
      event.timestamp,
    );
  }
}
