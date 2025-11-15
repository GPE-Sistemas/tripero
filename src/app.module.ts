import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuxiliaresModule } from './auxiliares/auxiliares.module';
import { HealthModule } from './health/health.module';
import { DatabaseModule } from './database/database.module';
import { DetectionModule } from './detection/detection.module';
import { TrackersModule } from './trackers/trackers.module';
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    DatabaseModule,
    AuxiliaresModule,
    HealthModule,
    DetectionModule, // Fase 1: Trip/Stop detection
    TrackersModule, // Gestión de estado y odómetro de trackers
    ReportsModule, // API de reportes históricos (compatible con Traccar)
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
