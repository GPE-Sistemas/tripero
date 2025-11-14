import { Module } from '@nestjs/common';
import { AuxiliaresModule } from '../auxiliares/auxiliares.module';
import { DatabaseModule } from '../database/database.module';
import {
  StateMachineService,
  DeviceStateService,
  EventPublisherService,
  PositionProcessorService,
  PositionSubscriberService,
  TrackerStateService,
} from './services';

@Module({
  imports: [AuxiliaresModule, DatabaseModule],
  providers: [
    StateMachineService,
    DeviceStateService,
    EventPublisherService,
    PositionProcessorService,
    PositionSubscriberService,
    TrackerStateService,
  ],
  exports: [
    StateMachineService,
    DeviceStateService,
    EventPublisherService,
    PositionProcessorService,
    PositionSubscriberService,
    TrackerStateService,
  ],
})
export class DetectionModule {}
