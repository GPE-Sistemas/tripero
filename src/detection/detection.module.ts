import { Module } from '@nestjs/common';
import { AuxiliaresModule } from '../auxiliares/auxiliares.module';
import { DatabaseModule } from '../database/database.module';
import {
  StateMachineService,
  DeviceStateService,
  EventPublisherService,
  PositionProcessorService,
  PositionSubscriberService,
  IgnitionSubscriberService,
  TrackerStateService,
  TripPersistenceService,
  StopPersistenceService,
  DeviceQueueManager,
  DeviceEventQueueManager,
} from './services';

@Module({
  imports: [AuxiliaresModule, DatabaseModule],
  providers: [
    StateMachineService,
    DeviceStateService,
    EventPublisherService,
    PositionProcessorService,
    DeviceQueueManager,
    DeviceEventQueueManager,
    PositionSubscriberService,
    IgnitionSubscriberService,
    TrackerStateService,
    TripPersistenceService,
    StopPersistenceService,
  ],
  exports: [
    StateMachineService,
    DeviceStateService,
    EventPublisherService,
    PositionProcessorService,
    DeviceQueueManager,
    DeviceEventQueueManager,
    PositionSubscriberService,
    IgnitionSubscriberService,
    TrackerStateService,
    TripPersistenceService,
    StopPersistenceService,
  ],
})
export class DetectionModule {}
