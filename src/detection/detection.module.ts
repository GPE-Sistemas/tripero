import { Module } from '@nestjs/common';
import { AuxiliaresModule } from '../auxiliares/auxiliares.module';
import {
  StateMachineService,
  DeviceStateService,
  EventPublisherService,
  PositionProcessorService,
  PositionSubscriberService,
} from './services';

@Module({
  imports: [AuxiliaresModule],
  providers: [
    StateMachineService,
    DeviceStateService,
    EventPublisherService,
    PositionProcessorService,
    PositionSubscriberService,
  ],
  exports: [
    StateMachineService,
    DeviceStateService,
    EventPublisherService,
    PositionProcessorService,
    PositionSubscriberService,
  ],
})
export class DetectionModule {}
