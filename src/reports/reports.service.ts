import { Injectable, Logger } from '@nestjs/common';
import { TripRepository } from '../database/repositories/trip.repository';
import { StopRepository } from '../database/repositories/stop.repository';
import { Trip } from '../database/entities/trip.entity';
import { Stop } from '../database/entities/stop.entity';
import { QueryReportsDto, TripResponseDto, StopResponseDto } from './dto';

/**
 * Servicio de reportes históricos
 * Endpoints compatibles con API de Traccar
 */
@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    private readonly tripRepository: TripRepository,
    private readonly stopRepository: StopRepository,
  ) {}

  /**
   * Obtener trips históricos
   * GET /api/reports/trips
   */
  async getTrips(query: QueryReportsDto): Promise<TripResponseDto[]> {
    const { deviceId, from, to } = query;
    const fromDate = new Date(from);
    const toDate = new Date(to);

    this.logger.debug(
      `Getting trips: deviceId=${deviceId?.join(',') || 'all'}, from=${from}, to=${to}`,
    );

    let trips: Trip[];

    // Si hay deviceId específico, filtrar por él
    if (deviceId && deviceId.length > 0) {
      const allTrips = await Promise.all(
        deviceId.map((id) =>
          this.tripRepository.findByAssetAndTimeRange(id, fromDate, toDate),
        ),
      );
      trips = allTrips.flat();
    } else {
      // Si no, traer todos los trips en el rango de fechas
      trips = await this.tripRepository.findByTimeRange(fromDate, toDate);
    }

    this.logger.debug(`Found ${trips.length} trips`);

    return this.mapTripsToDto(trips);
  }

  /**
   * Obtener stops históricos
   * GET /api/reports/stops
   */
  async getStops(query: QueryReportsDto): Promise<StopResponseDto[]> {
    const { deviceId, from, to } = query;
    const fromDate = new Date(from);
    const toDate = new Date(to);

    this.logger.debug(
      `Getting stops: deviceId=${deviceId?.join(',') || 'all'}, from=${from}, to=${to}`,
    );

    let stops: Stop[];

    if (deviceId && deviceId.length > 0) {
      const allStops = await Promise.all(
        deviceId.map((id) =>
          this.stopRepository.findByAssetAndTimeRange(id, fromDate, toDate),
        ),
      );
      stops = allStops.flat();
    } else {
      stops = await this.stopRepository.findByTimeRange(fromDate, toDate);
    }

    this.logger.debug(`Found ${stops.length} stops`);

    return this.mapStopsToDto(stops);
  }

  /**
   * Mapear entidades Trip a DTOs
   */
  private mapTripsToDto(trips: Trip[]): TripResponseDto[] {
    return trips.map((trip) => ({
      deviceId: trip.id_activo,
      deviceName: undefined, // TODO: join con activos si se necesita
      maxSpeed: trip.max_speed,
      averageSpeed: trip.avg_speed,
      distance: trip.distance,
      spentFuel: undefined, // TODO: calcular si hay sensores
      duration: trip.duration,
      startTime: trip.start_time.toISOString(),
      startAddress: trip.start_address ?? undefined,
      startLat: trip.start_lat,
      startLon: trip.start_lon,
      endTime: trip.end_time?.toISOString() || trip.start_time.toISOString(),
      endAddress: trip.end_address ?? undefined,
      endLat: trip.end_lat || trip.start_lat,
      endLon: trip.end_lon || trip.start_lon,
      driverUniqueId: undefined, // TODO: si se necesita
      driverName: undefined,
    }));
  }

  /**
   * Mapear entidades Stop a DTOs
   */
  private mapStopsToDto(stops: Stop[]): StopResponseDto[] {
    return stops.map((stop) => ({
      deviceId: stop.id_activo,
      deviceName: undefined,
      duration: stop.duration,
      startTime: stop.start_time.toISOString(),
      endTime: stop.end_time?.toISOString() || stop.start_time.toISOString(),
      latitude: stop.latitude,
      longitude: stop.longitude,
      address: stop.address ?? undefined,
      engineHours: undefined, // TODO: si se necesita
    }));
  }
}
