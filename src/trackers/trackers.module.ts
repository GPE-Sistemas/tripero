import { Module } from '@nestjs/common';
import { DetectionModule } from '../detection/detection.module';
import { TrackersController } from './trackers.controller';

@Module({
  imports: [DetectionModule],
  controllers: [TrackersController],
})
export class TrackersModule {}
