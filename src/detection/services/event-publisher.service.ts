import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../auxiliares/redis/redis.service';
import {
  ITripStartedEvent,
  ITripCompletedEvent,
  IStopStartedEvent,
  IStopCompletedEvent,
  ITrackerStateChangedEvent,
} from '../../interfaces';

/**
 * Servicio para publicar eventos de trips y stops
 */
@Injectable()
export class EventPublisherService {
  private readonly logger = new Logger(EventPublisherService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Publica evento de trip iniciado
   */
  async publishTripStarted(event: ITripStartedEvent): Promise<void> {
    try {
      await this.redis.publish('trip:started', JSON.stringify(event));
      this.logger.log(
        `Published trip:started for device ${event.deviceId}, trip ${event.tripId}`,
      );
    } catch (error) {
      this.logger.error('Error publishing trip:started', error.stack);
    }
  }

  /**
   * Publica evento de trip completado
   */
  async publishTripCompleted(event: ITripCompletedEvent): Promise<void> {
    try {
      await this.redis.publish('trip:completed', JSON.stringify(event));
      this.logger.log(
        `Published trip:completed for device ${event.deviceId}, trip ${event.tripId}`,
      );
    } catch (error) {
      this.logger.error('Error publishing trip:completed', error.stack);
    }
  }

  /**
   * Publica evento de stop iniciado
   */
  async publishStopStarted(event: IStopStartedEvent): Promise<void> {
    try {
      await this.redis.publish('stop:started', JSON.stringify(event));
      this.logger.log(
        `Published stop:started for device ${event.deviceId}, stop ${event.stopId}`,
      );
    } catch (error) {
      this.logger.error('Error publishing stop:started', error.stack);
    }
  }

  /**
   * Publica evento de stop completado
   */
  async publishStopCompleted(event: IStopCompletedEvent): Promise<void> {
    try {
      await this.redis.publish('stop:completed', JSON.stringify(event));
      this.logger.log(
        `Published stop:completed for device ${event.deviceId}, stop ${event.stopId}`,
      );
    } catch (error) {
      this.logger.error('Error publishing stop:completed', error.stack);
    }
  }

  /**
   * Publica evento de cambio de estado del tracker
   */
  async publishTrackerStateChanged(
    event: ITrackerStateChangedEvent,
  ): Promise<void> {
    try {
      await this.redis.publish('tracker:state:changed', JSON.stringify(event));
      this.logger.log(
        `Published tracker:state:changed for device ${event.trackerId}: ` +
          `${event.previousState} → ${event.currentState} (${event.reason})`,
      );
    } catch (error) {
      this.logger.error('Error publishing tracker:state:changed', error.stack);
    }
  }
}
