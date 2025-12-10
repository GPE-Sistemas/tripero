import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { TrackerStateService } from '../detection/services';
import type { IResetOdometer } from '../models';
import { SetOdometerDto, BulkStatusDto } from './dto';

/**
 * Controller para consultar estado de trackers
 *
 * Endpoints:
 * - GET /trackers/:trackerId/status - Estado completo de un tracker
 * - POST /trackers/status/bulk - Estado de múltiples trackers
 * - GET /trackers - Lista de trackers
 * - GET /trackers/stats - Estadísticas globales
 * - POST /trackers/:trackerId/odometer/reset - Resetear odómetro
 */
@Controller('trackers')
export class TrackersController {
  private readonly logger = new Logger(TrackersController.name);

  constructor(private readonly trackerStateService: TrackerStateService) {}

  /**
   * GET /trackers/:trackerId/status
   *
   * Obtiene el estado completo de un tracker incluyendo:
   * - Odómetro total y del trip actual
   * - Última posición conocida
   * - Estado de movimiento (STOPPED/MOVING/etc.)
   * - Trip actual en progreso
   * - Estadísticas acumulativas
   * - Health status
   */
  @Get(':trackerId/status')
  async getTrackerStatus(@Param('trackerId') trackerId: string) {
    try {
      const status = await this.trackerStateService.getTrackerStatus(trackerId);

      if (!status) {
        throw new HttpException(
          {
            statusCode: HttpStatus.NOT_FOUND,
            message: `Tracker ${trackerId} not found`,
            error: 'Not Found',
          },
          HttpStatus.NOT_FOUND,
        );
      }

      return {
        success: true,
        data: status,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        `Error getting tracker status for ${trackerId}`,
        error.stack,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Error getting tracker status',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /trackers/status/bulk
   *
   * Obtiene el estado actual de múltiples trackers de forma optimizada
   *
   * Body: { trackerIds: ["TRACKER001", "TRACKER002", ...] }
   *
   * Retorna solo el currentState de cada tracker:
   * - STOPPED: Vehículo detenido con ignición apagada
   * - MOVING: Vehículo en movimiento
   * - IDLE: Vehículo detenido con ignición encendida
   * - OFFLINE: Sin reportar por más de 24 horas
   * - UNKNOWN: Tracker no encontrado o sin datos suficientes
   */
  @Post('status/bulk')
  async getBulkTrackerStatus(@Body() bulkStatusDto: BulkStatusDto) {
    try {
      const { trackerIds } = bulkStatusDto;

      // Usar método optimizado que consulta Redis en paralelo y PostgreSQL en batch
      const results =
        await this.trackerStateService.getBulkCurrentState(trackerIds);

      // Separar encontrados de no encontrados
      const found: Record<string, string> = {};
      const notFound: string[] = [];

      for (const trackerId of trackerIds) {
        const state = results[trackerId];
        if (state && state !== 'UNKNOWN') {
          found[trackerId] = state;
        } else {
          notFound.push(trackerId);
        }
      }

      return {
        success: true,
        data: found,
        notFound,
        total: trackerIds.length,
        found: Object.keys(found).length,
      };
    } catch (error) {
      this.logger.error('Error getting bulk tracker status', error.stack);
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Error getting bulk tracker status',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /trackers?status=online&hoursAgo=24
   *
   * Lista trackers activos
   *
   * Query params:
   * - status: online | offline | all (default: online)
   * - hoursAgo: horas hacia atrás para considerar activo (default: 24)
   */
  @Get()
  async listTrackers(
    @Query('status') status: 'online' | 'offline' | 'all' = 'online',
    @Query('hoursAgo') hoursAgo: string = '24',
  ) {
    try {
      const hoursAgoNum = parseInt(hoursAgo, 10) || 24;

      // Por ahora solo soportamos listado de activos
      const trackers =
        await this.trackerStateService.getActiveTrackers(hoursAgoNum);

      return {
        success: true,
        data: trackers,
        total: trackers.length,
        filters: {
          status,
          hoursAgo: hoursAgoNum,
        },
      };
    } catch (error) {
      this.logger.error('Error listing trackers', error.stack);
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Error listing trackers',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * GET /trackers/stats
   *
   * Obtiene estadísticas globales de todos los trackers:
   * - Total de trackers
   * - Trackers online/offline
   * - Odómetro total acumulado
   * - Total de trips
   * - Tiempo total de conducción
   */
  @Get('stats')
  async getGlobalStats() {
    try {
      const stats = await this.trackerStateService.getGlobalStats();

      return {
        success: true,
        data: {
          ...stats,
          totalOdometerKm: Math.round(stats.totalOdometer / 1000),
          totalDrivingHours:
            Math.round((stats.totalDrivingTime / 3600) * 10) / 10,
        },
      };
    } catch (error) {
      this.logger.error('Error getting global stats', error.stack);
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Error getting global stats',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /trackers/:trackerId/odometer/reset
   *
   * Resetea el odómetro de un tracker
   *
   * Body:
   * {
   *   "newValue": 0,
   *   "reason": "Tracker reemplazado"
   * }
   */
  @Post(':trackerId/odometer/reset')
  async resetOdometer(
    @Param('trackerId') trackerId: string,
    @Body() resetData: IResetOdometer,
  ) {
    try {
      // Validar datos
      if (typeof resetData.newValue !== 'number' || resetData.newValue < 0) {
        throw new HttpException(
          {
            statusCode: HttpStatus.BAD_REQUEST,
            message: 'newValue must be a non-negative number',
            error: 'Bad Request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      if (!resetData.reason || resetData.reason.trim().length === 0) {
        throw new HttpException(
          {
            statusCode: HttpStatus.BAD_REQUEST,
            message: 'reason is required',
            error: 'Bad Request',
          },
          HttpStatus.BAD_REQUEST,
        );
      }

      await this.trackerStateService.resetOdometer(trackerId, resetData);

      this.logger.log(
        `Odometer reset for tracker ${trackerId} to ${resetData.newValue}. Reason: ${resetData.reason}`,
      );

      return {
        success: true,
        message: `Odometer reset to ${resetData.newValue} meters`,
        data: {
          trackerId,
          newOdometerValue: resetData.newValue,
          newOdometerKm: Math.round(resetData.newValue / 1000),
          reason: resetData.reason,
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(
        `Error resetting odometer for ${trackerId}`,
        error.stack,
      );
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: error.message || 'Error resetting odometer',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * POST /trackers/:trackerId/odometer
   *
   * Setea el odómetro inicial de un tracker para que coincida con el odómetro real del vehículo
   * Utiliza un offset que se suma al odómetro GPS
   *
   * Body:
   * {
   *   "initialOdometer": 125000,  // metros (125 km)
   *   "reason": "vehicle_odometer_sync"
   * }
   */
  @Post(':trackerId/odometer')
  async setOdometer(
    @Param('trackerId') trackerId: string,
    @Body() setOdometerDto: SetOdometerDto,
  ) {
    try {
      const result = await this.trackerStateService.setOdometer(
        trackerId,
        setOdometerDto.initialOdometer,
        setOdometerDto.reason,
      );

      this.logger.log(
        `Odometer set for tracker ${trackerId}: ` +
          `previous=${result.previousOdometer}m, new=${result.newOdometer}m, ` +
          `offset=${result.odometerOffset}m. Reason: ${setOdometerDto.reason || 'not specified'}`,
      );

      return {
        success: true,
        message: `Odometer set to ${result.newOdometer} meters`,
        data: {
          trackerId,
          previousOdometer: result.previousOdometer,
          previousOdometerKm: Math.round(result.previousOdometer / 1000),
          newOdometer: result.newOdometer,
          newOdometerKm: Math.round(result.newOdometer / 1000),
          odometerOffset: result.odometerOffset,
          odometerOffsetKm: Math.round(result.odometerOffset / 1000),
          reason: setOdometerDto.reason || 'not specified',
          updatedAt: new Date().toISOString(),
        },
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      this.logger.error(`Error setting odometer for ${trackerId}`, error.stack);
      throw new HttpException(
        {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: error.message || 'Error setting odometer',
          error: 'Internal Server Error',
        },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
