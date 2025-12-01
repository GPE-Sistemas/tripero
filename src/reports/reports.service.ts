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
    const { deviceId, from, to, tenantId, clientId, fleetId, metadata } = query;
    const fromDate = new Date(from);
    const toDate = new Date(to);

    this.logger.debug(
      `Getting trips: deviceId=${deviceId?.join(',') || 'all'}, from=${from}, to=${to}, ` +
        `tenantId=${tenantId || 'none'}, clientId=${clientId || 'none'}, fleetId=${fleetId || 'none'}`,
    );

    let trips: Trip[];

    // Si hay filtros de metadata, usar query builder
    const hasMetadataFilters = tenantId || clientId || fleetId || metadata;

    if (hasMetadataFilters) {
      trips = await this.findTripsWithMetadata(
        deviceId,
        fromDate,
        toDate,
        { tenantId, clientId, fleetId, metadata },
      );
    } else {
      // Usar métodos simples del repositorio si no hay filtros de metadata
      if (deviceId && deviceId.length > 0) {
        const allTrips = await Promise.all(
          deviceId.map((id) =>
            this.tripRepository.findByAssetAndTimeRange(id, fromDate, toDate),
          ),
        );
        trips = allTrips.flat();
      } else {
        trips = await this.tripRepository.findByTimeRange(fromDate, toDate);
      }
    }

    this.logger.debug(`Found ${trips.length} trips`);

    return this.mapTripsToDto(trips);
  }

  /**
   * Obtener stops históricos
   * GET /api/reports/stops
   */
  async getStops(query: QueryReportsDto): Promise<StopResponseDto[]> {
    const { deviceId, from, to, tenantId, clientId, fleetId, metadata } = query;
    const fromDate = new Date(from);
    const toDate = new Date(to);

    this.logger.debug(
      `Getting stops: deviceId=${deviceId?.join(',') || 'all'}, from=${from}, to=${to}, ` +
        `tenantId=${tenantId || 'none'}, clientId=${clientId || 'none'}, fleetId=${fleetId || 'none'}`,
    );

    let stops: Stop[];

    // Si hay filtros de metadata, usar query builder
    const hasMetadataFilters = tenantId || clientId || fleetId || metadata;

    if (hasMetadataFilters) {
      stops = await this.findStopsWithMetadata(
        deviceId,
        fromDate,
        toDate,
        { tenantId, clientId, fleetId, metadata },
      );
    } else {
      // Usar métodos simples del repositorio si no hay filtros de metadata
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
    }

    this.logger.debug(`Found ${stops.length} stops`);

    return this.mapStopsToDto(stops);
  }

  /**
   * Buscar trips con filtros de metadata usando query builder
   * Utiliza índices optimizados para tenant_id, client_id, fleet_id
   */
  private async findTripsWithMetadata(
    deviceIds: string[] | undefined,
    fromDate: Date,
    toDate: Date,
    filters: {
      tenantId?: string;
      clientId?: string;
      fleetId?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<Trip[]> {
    const { tenantId, clientId, fleetId, metadata } = filters;

    // Necesitamos acceder al repository de TypeORM directamente
    // para usar el query builder
    const tripRepo = (this.tripRepository as any).tripRepo;

    const queryBuilder = tripRepo
      .createQueryBuilder('trip')
      .where('trip.start_time BETWEEN :fromDate AND :toDate', {
        fromDate,
        toDate,
      });

    // Filtro por deviceId
    if (deviceIds && deviceIds.length > 0) {
      queryBuilder.andWhere('trip.id_activo IN (:...deviceIds)', { deviceIds });
    }

    // Filtros optimizados con B-tree indexes (~1-2ms)
    if (tenantId) {
      queryBuilder.andWhere("trip.metadata->>'tenant_id' = :tenantId", {
        tenantId,
      });
    }

    if (clientId) {
      queryBuilder.andWhere("trip.metadata->>'client_id' = :clientId", {
        clientId,
      });
    }

    if (fleetId) {
      queryBuilder.andWhere("trip.metadata->>'fleet_id' = :fleetId", {
        fleetId,
      });
    }

    // Filtro genérico JSONB con GIN index (~5-10ms)
    // Usa el operador @> (contains) para buscar coincidencias parciales
    if (metadata && Object.keys(metadata).length > 0) {
      queryBuilder.andWhere('trip.metadata @> :metadata', {
        metadata: JSON.stringify(metadata),
      });
    }

    queryBuilder.orderBy('trip.start_time', 'DESC');

    return await queryBuilder.getMany();
  }

  /**
   * Buscar stops con filtros de metadata usando query builder
   * Utiliza índices optimizados para tenant_id, client_id, fleet_id
   */
  private async findStopsWithMetadata(
    deviceIds: string[] | undefined,
    fromDate: Date,
    toDate: Date,
    filters: {
      tenantId?: string;
      clientId?: string;
      fleetId?: string;
      metadata?: Record<string, any>;
    },
  ): Promise<Stop[]> {
    const { tenantId, clientId, fleetId, metadata } = filters;

    // Necesitamos acceder al repository de TypeORM directamente
    // para usar el query builder
    const stopRepo = (this.stopRepository as any).stopRepo;

    const queryBuilder = stopRepo
      .createQueryBuilder('stop')
      .where('stop.start_time BETWEEN :fromDate AND :toDate', {
        fromDate,
        toDate,
      });

    // Filtro por deviceId
    if (deviceIds && deviceIds.length > 0) {
      queryBuilder.andWhere('stop.id_activo IN (:...deviceIds)', { deviceIds });
    }

    // Filtros optimizados con B-tree indexes (~1-2ms)
    if (tenantId) {
      queryBuilder.andWhere("stop.metadata->>'tenant_id' = :tenantId", {
        tenantId,
      });
    }

    if (clientId) {
      queryBuilder.andWhere("stop.metadata->>'client_id' = :clientId", {
        clientId,
      });
    }

    if (fleetId) {
      queryBuilder.andWhere("stop.metadata->>'fleet_id' = :fleetId", {
        fleetId,
      });
    }

    // Filtro genérico JSONB con GIN index (~5-10ms)
    if (metadata && Object.keys(metadata).length > 0) {
      queryBuilder.andWhere('stop.metadata @> :metadata', {
        metadata: JSON.stringify(metadata),
      });
    }

    queryBuilder.orderBy('stop.start_time', 'DESC');

    return await queryBuilder.getMany();
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
      startAddress: undefined, // Geocoding should be done by consuming service
      startLat: trip.start_lat,
      startLon: trip.start_lon,
      endTime: trip.end_time?.toISOString() || trip.start_time.toISOString(),
      endAddress: undefined, // Geocoding should be done by consuming service
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
      address: undefined, // Geocoding should be done by consuming service
      engineHours: undefined, // TODO: si se necesita
      startOdometer: stop.start_odometer ?? undefined,
      endOdometer: stop.end_odometer ?? undefined,
    }));
  }
}
