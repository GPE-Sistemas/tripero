import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { Trip } from '../entities/trip.entity';

export interface ICreateTripData {
  id: string;
  id_activo: string;
  start_time: Date;
  start_lat: number;
  start_lon: number;
  detection_method?: string;
  metadata?: Record<string, any>;
}

export interface IUpdateTripData {
  end_time?: Date;
  end_lat?: number;
  end_lon?: number;
  distance?: number;
  distance_original?: number;
  distance_linear?: number;
  route_linear_ratio?: number;
  operation_area_diameter?: number;
  quality_flag?: string;
  quality_metadata?: Record<string, any>;
  max_speed?: number;
  avg_speed?: number;
  duration?: number;
  route_points?: Array<{
    lat: number;
    lon: number;
    timestamp: string;
    speed: number;
  }>;
  stop_count?: number;
  is_active?: boolean;
  metadata?: Record<string, any>;
}

@Injectable()
export class TripRepository {
  constructor(
    @InjectRepository(Trip)
    private readonly tripRepo: Repository<Trip>,
  ) {}

  async create(data: ICreateTripData): Promise<Trip> {
    const trip = this.tripRepo.create({
      ...data,
      is_active: true,
      distance: 0,
      max_speed: 0,
      avg_speed: 0,
      duration: 0,
      stop_count: 0,
      route_points: [],
    });

    return await this.tripRepo.save(trip);
  }

  async findById(id: string): Promise<Trip | null> {
    return await this.tripRepo.findOne({ where: { id } });
  }

  async findActiveByAsset(id_activo: string): Promise<Trip | null> {
    return await this.tripRepo.findOne({
      where: { id_activo, is_active: true },
      order: { start_time: 'DESC' },
    });
  }

  async update(id: string, data: IUpdateTripData): Promise<Trip | null> {
    const trip = await this.findById(id);
    if (!trip) return null;

    Object.assign(trip, {
      ...data,
      updated_at: new Date(),
    });

    return await this.tripRepo.save(trip);
  }

  async findByAssetAndTimeRange(
    id_activo: string,
    startTime: Date,
    endTime: Date,
    includeActive: boolean = false,
  ): Promise<Trip[]> {
    const where: any = {
      id_activo,
      start_time: Between(startTime, endTime),
    };

    // Por defecto solo devolver trips completados
    if (!includeActive) {
      where.is_active = false;
    }

    return await this.tripRepo.find({
      where,
      order: { start_time: 'DESC' },
    });
  }

  async findByTimeRange(
    startTime: Date,
    endTime: Date,
    includeActive: boolean = false,
  ): Promise<Trip[]> {
    const where: any = {
      start_time: Between(startTime, endTime),
    };

    // Por defecto solo devolver trips completados
    if (!includeActive) {
      where.is_active = false;
    }

    return await this.tripRepo.find({
      where,
      order: { start_time: 'DESC' },
    });
  }

  async findRecentByAsset(
    id_activo: string,
    limit: number = 10,
  ): Promise<Trip[]> {
    return await this.tripRepo.find({
      where: { id_activo },
      order: { start_time: 'DESC' },
      take: limit,
    });
  }

  async closeTrip(
    id: string,
    endData: {
      end_time: Date;
      end_lat: number;
      end_lon: number;
      end_address?: string;
    },
  ): Promise<Trip | null> {
    return await this.update(id, {
      ...endData,
      is_active: false,
    });
  }

  async addRoutePoint(
    id: string,
    point: { lat: number; lon: number; timestamp: string; speed: number },
  ): Promise<Trip | null> {
    const trip = await this.findById(id);
    if (!trip) return null;

    trip.route_points.push(point);
    trip.updated_at = new Date();

    return await this.tripRepo.save(trip);
  }

  async incrementStopCount(id: string): Promise<Trip | null> {
    const trip = await this.findById(id);
    if (!trip) return null;

    trip.stop_count += 1;
    trip.updated_at = new Date();

    return await this.tripRepo.save(trip);
  }

  /**
   * Actualiza el timestamp updated_at del trip para indicar actividad reciente
   * Usado para detectar trips huérfanos (sin posiciones recientes)
   */
  async touchTrip(id: string): Promise<void> {
    await this.tripRepo.update({ id }, { updated_at: new Date() });
  }

  async getStatsByAsset(
    id_activo: string,
    startTime: Date,
    endTime: Date,
  ): Promise<{
    total_trips: number;
    total_distance: number;
    total_duration: number;
    avg_trip_distance: number;
    avg_trip_duration: number;
  }> {
    const result = await this.tripRepo
      .createQueryBuilder('trip')
      .select('COUNT(*)', 'total_trips')
      .addSelect('COALESCE(SUM(trip.distance), 0)', 'total_distance')
      .addSelect('COALESCE(SUM(trip.duration), 0)', 'total_duration')
      .addSelect('COALESCE(AVG(trip.distance), 0)', 'avg_trip_distance')
      .addSelect('COALESCE(AVG(trip.duration), 0)', 'avg_trip_duration')
      .where('trip.id_activo = :id_activo', { id_activo })
      .andWhere('trip.start_time BETWEEN :startTime AND :endTime', {
        startTime,
        endTime,
      })
      .andWhere('trip.is_active = false')
      .getRawOne();

    return {
      total_trips: parseInt(result.total_trips, 10),
      total_distance: parseFloat(result.total_distance),
      total_duration: parseInt(result.total_duration, 10),
      avg_trip_distance: parseFloat(result.avg_trip_distance),
      avg_trip_duration: parseFloat(result.avg_trip_duration),
    };
  }

  async findOrphanTrips(hoursWithoutUpdate: number): Promise<Trip[]> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hoursWithoutUpdate);

    return await this.tripRepo.find({
      where: {
        is_active: true,
      },
    }).then(trips =>
      trips.filter(trip => trip.updated_at < cutoffTime)
    );
  }

  /**
   * Elimina un trip por ID
   * @returns true si se eliminó, false si no existía
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.tripRepo.delete({ id });
    return (result.affected || 0) > 0;
  }

  async deleteOldTrips(olderThan: Date): Promise<number> {
    const result = await this.tripRepo.delete({
      start_time: LessThanOrEqual(olderThan),
    });

    return result.affected || 0;
  }
}
