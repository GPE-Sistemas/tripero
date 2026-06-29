import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, SelectQueryBuilder } from 'typeorm';
import { Stop } from '../entities/stop.entity';

export interface ICreateStopData {
  id: string;
  id_activo: string;
  start_time: Date;
  latitude: number;
  longitude: number;
  reason?: string;
  trip_id?: string;
  start_odometer?: number;
  metadata?: Record<string, any>;
}

export interface IUpdateStopData {
  end_time?: Date;
  duration?: number;
  address?: string;
  is_active?: boolean;
  end_odometer?: number;
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

  /**
   * Actualiza el timestamp updated_at del stop para indicar actividad reciente.
   * Espeja a TripRepository.touchTrip: mientras el tracker sigue reportando (vehículo
   * estacionado pero device vivo), refresca updated_at para que el orphan cleanup NO
   * cierre como huérfana una parada EN CURSO. Si el tracker deja de reportar, updated_at
   * deja de avanzar y el cleanup la cierra al último heartbeat (≈ último reporte real).
   */
  async touchStop(id: string): Promise<void> {
    await this.stopRepo.update({ id }, { updated_at: new Date() });
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
    includeActive: boolean = false,
  ): Promise<Stop[]> {
    const qb = this.stopRepo
      .createQueryBuilder('stop')
      .where('stop.id_activo = :id_activo', { id_activo });

    this.aplicarSolapamientoRango(qb, startTime, endTime, includeActive);

    return await qb.orderBy('stop.start_time', 'DESC').getMany();
  }

  async findByTimeRange(
    startTime: Date,
    endTime: Date,
    includeActive: boolean = false,
  ): Promise<Stop[]> {
    const qb = this.stopRepo.createQueryBuilder('stop');

    this.aplicarSolapamientoRango(qb, startTime, endTime, includeActive);

    return await qb.orderBy('stop.start_time', 'DESC').getMany();
  }

  /**
   * Filtra paradas que se SOLAPAN con el rango [startTime, endTime], en vez de
   * solo las que inician dentro del rango. Una parada se cruza con el período si:
   *   - empezó antes del fin del rango (start_time <= endTime), y
   *   - terminó después del inicio del rango (end_time >= startTime) o sigue en curso (end_time IS NULL).
   * Así se incluyen paradas que comenzaron antes de startTime y terminaron dentro,
   * y paradas aún no terminadas (p. ej. cuando endTime es la hora actual).
   */
  private aplicarSolapamientoRango(
    qb: SelectQueryBuilder<Stop>,
    startTime: Date,
    endTime: Date,
    includeActive: boolean,
  ): void {
    qb.andWhere('stop.start_time <= :endTime', { endTime }).andWhere(
      '(stop.end_time >= :startTime OR stop.end_time IS NULL)',
      { startTime },
    );

    // Por defecto solo devolver stops completados
    if (!includeActive) {
      qb.andWhere('stop.is_active = false');
    }
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
      .andWhere('stop.is_active = false')
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

  /**
   * Encuentra stops huérfanos (activos sin actualización en las últimas N horas)
   */
  async findOrphanStops(hoursWithoutUpdate: number): Promise<Stop[]> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hoursWithoutUpdate);

    return await this.stopRepo
      .find({
        where: {
          is_active: true,
        },
      })
      .then((stops) => stops.filter((stop) => stop.updated_at < cutoffTime));
  }
}
