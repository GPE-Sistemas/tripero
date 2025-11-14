import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThanOrEqual } from 'typeorm';
import { Stop } from '../entities/stop.entity';

export interface ICreateStopData {
  trip_id: string;
  id_activo: string;
  start_time: Date;
  lat: number;
  lon: number;
  stop_type?: string;
  metadata?: Record<string, any>;
}

export interface IUpdateStopData {
  end_time?: Date;
  duration?: number;
  address?: string;
  is_active?: boolean;
  metadata?: Record<string, any>;
}

@Injectable()
export class StopRepository {
  constructor(
    @InjectRepository(Stop)
    private readonly stopRepo: Repository<Stop>,
  ) {}

  async create(data: ICreateStopData): Promise<Stop> {
    const stop = this.stopRepo.create({
      ...data,
      is_active: true,
      duration: 0,
    });

    return await this.stopRepo.save(stop);
  }

  async findById(id: string): Promise<Stop | null> {
    return await this.stopRepo.findOne({ where: { id } });
  }

  async findActiveByAsset(id_activo: string): Promise<Stop | null> {
    return await this.stopRepo.findOne({
      where: { id_activo, is_active: true },
      order: { start_time: 'DESC' },
    });
  }

  async findActiveByTrip(trip_id: string): Promise<Stop | null> {
    return await this.stopRepo.findOne({
      where: { trip_id, is_active: true },
      order: { start_time: 'DESC' },
    });
  }

  async update(id: string, data: IUpdateStopData): Promise<Stop | null> {
    const stop = await this.findById(id);
    if (!stop) return null;

    Object.assign(stop, {
      ...data,
      updated_at: new Date(),
    });

    return await this.stopRepo.save(stop);
  }

  async findByTrip(trip_id: string): Promise<Stop[]> {
    return await this.stopRepo.find({
      where: { trip_id },
      order: { start_time: 'ASC' },
    });
  }

  async findByAssetAndTimeRange(
    id_activo: string,
    startTime: Date,
    endTime: Date,
  ): Promise<Stop[]> {
    return await this.stopRepo.find({
      where: {
        id_activo,
        start_time: Between(startTime, endTime),
      },
      order: { start_time: 'DESC' },
    });
  }

  async closeStop(
    id: string,
    endData: {
      end_time: Date;
      duration: number;
      address?: string;
    },
  ): Promise<Stop | null> {
    return await this.update(id, {
      ...endData,
      is_active: false,
    });
  }

  async getStatsByTrip(trip_id: string): Promise<{
    total_stops: number;
    total_duration: number;
    avg_stop_duration: number;
  }> {
    const result = await this.stopRepo
      .createQueryBuilder('stop')
      .select('COUNT(*)', 'total_stops')
      .addSelect('COALESCE(SUM(stop.duration), 0)', 'total_duration')
      .addSelect('COALESCE(AVG(stop.duration), 0)', 'avg_stop_duration')
      .where('stop.trip_id = :trip_id', { trip_id })
      .getRawOne();

    return {
      total_stops: parseInt(result.total_stops, 10),
      total_duration: parseInt(result.total_duration, 10),
      avg_stop_duration: parseFloat(result.avg_stop_duration),
    };
  }

  async getStatsByAsset(
    id_activo: string,
    startTime: Date,
    endTime: Date,
  ): Promise<{
    total_stops: number;
    total_duration: number;
    avg_stop_duration: number;
  }> {
    const result = await this.stopRepo
      .createQueryBuilder('stop')
      .select('COUNT(*)', 'total_stops')
      .addSelect('COALESCE(SUM(stop.duration), 0)', 'total_duration')
      .addSelect('COALESCE(AVG(stop.duration), 0)', 'avg_stop_duration')
      .where('stop.id_activo = :id_activo', { id_activo })
      .andWhere('stop.start_time BETWEEN :startTime AND :endTime', {
        startTime,
        endTime,
      })
      .getRawOne();

    return {
      total_stops: parseInt(result.total_stops, 10),
      total_duration: parseInt(result.total_duration, 10),
      avg_stop_duration: parseFloat(result.avg_stop_duration),
    };
  }

  async deleteOldStops(olderThan: Date): Promise<number> {
    const result = await this.stopRepo.delete({
      start_time: LessThanOrEqual(olderThan),
    });

    return result.affected || 0;
  }
}
