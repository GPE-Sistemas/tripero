import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuxiliaresModule } from './auxiliares/auxiliares.module';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { DetectionModule } from './detection/detection.module';

@Module({
  imports: [
    DatabaseModule,
    AuxiliaresModule,
    HealthModule,
    DetectionModule, // Fase 1: Trip detection
    // PersistenceModule, // TODO: Fase 2
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
