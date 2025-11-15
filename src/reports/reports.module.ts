import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Módulo de reportes históricos
 * Endpoints compatibles con API de Traccar:
 * - GET /api/reports/trips
 * - GET /api/reports/stops
 */
@Module({
  imports: [DatabaseModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
