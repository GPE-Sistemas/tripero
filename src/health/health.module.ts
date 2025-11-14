import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { AuxiliaresModule } from '../auxiliares/auxiliares.module';

@Module({
  imports: [AuxiliaresModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
