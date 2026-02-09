import { Controller, Get, Query, ValidationPipe, Logger } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { QueryReportsDto, TripResponseDto, StopResponseDto } from './dto';

/**
 * Controlador de reportes históricos
 * Endpoints compatibles con API de Traccar
 */
@Controller('api/reports')
export class ReportsController {
  private readonly logger = new Logger(ReportsController.name);

  constructor(private readonly reportsService: ReportsService) {}

  /**
   * GET /api/reports/trips
   * Obtener trips históricos
   *
   * Query params:
   * - deviceId: string | string[] (comma-separated) - ID del/los dispositivo(s)
   * - groupId: string | string[] (comma-separated, opcional) - ID del/los grupo(s)
   * - from: ISO 8601 date-time - Fecha inicio
   * - to: ISO 8601 date-time - Fecha fin
   * - limit: number (opcional) - Límite de resultados (trae los últimos x trips)
   *
   * Ejemplos:
   * GET /api/reports/trips?deviceId=TEST-001&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
   * GET /api/reports/trips?deviceId=TEST-001,TEST-002&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
   * GET /api/reports/trips?deviceId=TEST-001&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z&limit=10
   */
  @Get('trips')
  async getTrips(
    @Query(new ValidationPipe({ transform: true }))
    query: QueryReportsDto,
  ): Promise<TripResponseDto[]> {
    this.logger.log(
      `GET /api/reports/trips - deviceId=${query.deviceId?.join(',') || 'all'}, from=${query.from}, to=${query.to}`,
    );

    return await this.reportsService.getTrips(query);
  }

  /**
   * GET /api/reports/stops
   * Obtener stops históricos
   *
   * Query params:
   * - deviceId: string | string[] (comma-separated) - ID del/los dispositivo(s)
   * - groupId: string | string[] (comma-separated, opcional) - ID del/los grupo(s)
   * - from: ISO 8601 date-time - Fecha inicio
   * - to: ISO 8601 date-time - Fecha fin
   *
   * Ejemplos:
   * GET /api/reports/stops?deviceId=TEST-001&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
   * GET /api/reports/stops?deviceId=TEST-001,TEST-002&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
   */
  @Get('stops')
  async getStops(
    @Query(new ValidationPipe({ transform: true }))
    query: QueryReportsDto,
  ): Promise<StopResponseDto[]> {
    this.logger.log(
      `GET /api/reports/stops - deviceId=${query.deviceId?.join(',') || 'all'}, from=${query.from}, to=${query.to}`,
    );

    return await this.reportsService.getStops(query);
  }
}
