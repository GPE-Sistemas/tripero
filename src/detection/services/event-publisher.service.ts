import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { REDIS_CHANNELS } from '../../auxiliares/redis/redis.constants';
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
      await this.redis.publish(REDIS_CHANNELS.TRIP_STARTED, JSON.stringify(event));
      this.logger.log(
        `Published ${REDIS_CHANNELS.TRIP_STARTED} for device ${event.deviceId}, trip ${event.tripId}`,
      );
    } catch (error) {
      this.logger.error(`Error publishing ${REDIS_CHANNELS.TRIP_STARTED}`, error.stack);
    }
  }

  /**
   * Publica evento de trip completado
   */
  async publishTripCompleted(event: ITripCompletedEvent): Promise<void> {
    try {
      await this.redis.publish(REDIS_CHANNELS.TRIP_COMPLETED, JSON.stringify(event));
      this.logger.log(
        `Published ${REDIS_CHANNELS.TRIP_COMPLETED} for device ${event.deviceId}, trip ${event.tripId}`,
      );
    } catch (error) {
      this.logger.error(`Error publishing ${REDIS_CHANNELS.TRIP_COMPLETED}`, error.stack);
    }
  }

  /**
   * Publica evento de stop iniciado
   */
  async publishStopStarted(event: IStopStartedEvent): Promise<void> {
    try {
      await this.redis.publish(REDIS_CHANNELS.STOP_STARTED, JSON.stringify(event));
      this.logger.log(
        `Published ${REDIS_CHANNELS.STOP_STARTED} for device ${event.deviceId}, stop ${event.stopId}`,
      );
    } catch (error) {
      this.logger.error(`Error publishing ${REDIS_CHANNELS.STOP_STARTED}`, error.stack);
    }
  }

  /**
   * Publica evento de stop completado
   */
  async publishStopCompleted(event: IStopCompletedEvent): Promise<void> {
    try {
      await this.redis.publish(REDIS_CHANNELS.STOP_COMPLETED, JSON.stringify(event));
      this.logger.log(
        `Published ${REDIS_CHANNELS.STOP_COMPLETED} for device ${event.deviceId}, stop ${event.stopId}`,
      );
    } catch (error) {
      this.logger.error(`Error publishing ${REDIS_CHANNELS.STOP_COMPLETED}`, error.stack);
    }
  }

  /**
   * Publica evento de cambio de estado del tracker
   */
  async publishTrackerStateChanged(
    event: ITrackerStateChangedEvent,
  ): Promise<void> {
    try {
      await this.redis.publish(REDIS_CHANNELS.TRACKER_STATE_CHANGED, JSON.stringify(event));
      this.logger.log(
        `Published ${REDIS_CHANNELS.TRACKER_STATE_CHANGED} for device ${event.trackerId}: ` +
          `${event.previousState} → ${event.currentState} (${event.reason})`,
      );
    } catch (error) {
      this.logger.error(`Error publishing ${REDIS_CHANNELS.TRACKER_STATE_CHANGED}`, error.stack);
    }
  }
}
