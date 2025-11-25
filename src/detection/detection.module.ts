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
  DistanceValidatorService,
  TripQualityAnalyzerService,
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
    DistanceValidatorService,
    TripQualityAnalyzerService,
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
    DistanceValidatorService,
    TripQualityAnalyzerService,
  ],
})
export class DetectionModule {}
