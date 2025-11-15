import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { PositionProcessorService } from './position-processor.service';
import { IPositionEvent, validatePositionEvent } from '../../interfaces';

/**
 * Servicio de suscripción a eventos de posiciones GPS
 *
 * Escucha el canal Redis PubSub 'position:new' y procesa cada posición
 */
@Injectable()
export class PositionSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PositionSubscriberService.name);
  private subscriber: Redis;
  private isSubscribed = false;
  private receivedCount = 0;
  private invalidCount = 0;

  constructor(
    private readonly redisService: RedisService,
    private readonly positionProcessor: PositionProcessorService,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing position subscriber...');
    await this.subscribe();

    // Log de métricas cada minuto
    setInterval(() => {
      if (this.isSubscribed) {
        this.logger.log(
          `Subscription metrics: ${this.receivedCount} received, ${this.invalidCount} invalid`,
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
   * Suscribe al canal position:new
   */
  private async subscribe(): Promise<void> {
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
            this.logger.log('Attempting to reconnect subscriber...');
            this.subscribe();
          }
        }, 5000);
      });

      this.subscriber.on('connect', () => {
        this.logger.log('Redis subscriber connected');
      });

      this.subscriber.on('ready', () => {
        this.logger.log('Redis subscriber ready');
      });

      this.subscriber.on('message', async (channel, message) => {
        if (channel === 'position:new') {
          await this.handlePositionMessage(message);
        }
      });

      await this.subscriber.subscribe('position:new');
      this.isSubscribed = true;

      this.logger.log('Successfully subscribed to position:new channel');
    } catch (error) {
      this.logger.error('Error subscribing to position:new', error.stack);

      // Reintentar después de 5 segundos
      setTimeout(() => {
        this.logger.log('Retrying subscription...');
        this.subscribe();
      }, 5000);
    }
  }

  /**
   * Desuscribe del canal
   */
  private async unsubscribe(): Promise<void> {
    if (this.subscriber) {
      try {
        await this.subscriber.unsubscribe('position:new');
        await this.subscriber.quit();
        this.isSubscribed = false;
        this.logger.log('Unsubscribed from position:new channel');
      } catch (error) {
        this.logger.error('Error unsubscribing', error.stack);
      }
    }
  }

  /**
   * Maneja un mensaje de posición recibido
   */
  private async handlePositionMessage(message: string): Promise<void> {
    this.receivedCount++;

    try {
      // Parsear el mensaje JSON
      const position = JSON.parse(message);

      // Validar el payload
      if (!validatePositionEvent(position)) {
        this.invalidCount++;
        this.logger.warn(
          `Invalid position event received: ${JSON.stringify(position)}`,
        );
        return;
      }

      // Procesar la posición
      await this.positionProcessor.processPosition(position as IPositionEvent);
    } catch (error) {
      this.logger.error(
        `Error handling position message: ${message}`,
        error.stack,
      );
    }
  }

  /**
   * Verifica si está suscrito
   */
  isActive(): boolean {
    return this.isSubscribed;
  }

  /**
   * Obtiene métricas del subscriber
   */
  getMetrics() {
    return {
      isSubscribed: this.isSubscribed,
      receivedCount: this.receivedCount,
      invalidCount: this.invalidCount,
    };
  }
}
