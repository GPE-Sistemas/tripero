import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, LessThan } from 'typeorm';
import { TrackerState } from '../entities';

@Injectable()
export class TrackerStateRepository {
  constructor(
    @InjectRepository(TrackerState)
    private readonly repository: Repository<TrackerState>,
  ) {}

  /**
   * Obtener estado de un tracker por trackerId
   */
  async findByTrackerId(trackerId: string): Promise<TrackerState | null> {
    return this.repository.findOne({
      where: { tracker_id: trackerId },
    });
  }

  /**
   * Crear o actualizar estado de un tracker
   */
  async upsert(trackerId: string, data: Partial<TrackerState>): Promise<TrackerState> {
    let trackerState = await this.findByTrackerId(trackerId);

    if (trackerState) {
      // Actualizar existente
      Object.assign(trackerState, data);
      trackerState.updated_at = new Date();
    } else {
      // Crear nuevo
      trackerState = this.repository.create({
        tracker_id: trackerId,
        device_id: trackerId,
        total_odometer: 0,
        total_trips_count: 0,
        total_driving_time: 0,
        total_idle_time: 0,
        total_stops_count: 0,
        first_seen_at: new Date(),
        last_seen_at: new Date(),
        ...data,
      });
    }

    return this.repository.save(trackerState);
  }

  /**
   * Incrementar odómetro de un tracker
   */
  async incrementOdometer(
    trackerId: string,
    distanceDelta: number,
  ): Promise<TrackerState> {
    const trackerState = await this.findByTrackerId(trackerId);

    if (!trackerState) {
      throw new Error(`Tracker ${trackerId} not found`);
    }

    trackerState.total_odometer += distanceDelta;
    trackerState.last_seen_at = new Date();
    trackerState.updated_at = new Date();

    return this.repository.save(trackerState);
  }

  /**
   * Resetear odómetro de un tracker
   */
  async resetOdometer(trackerId: string, newValue: number = 0): Promise<TrackerState> {
    const trackerState = await this.findByTrackerId(trackerId);

    if (!trackerState) {
      throw new Error(`Tracker ${trackerId} not found`);
    }

    trackerState.total_odometer = newValue;
    trackerState.updated_at = new Date();

    return this.repository.save(trackerState);
  }

  /**
   * Obtener trackers activos (vistos en las últimas N horas)
   */
  async findActive(hoursAgo: number = 24): Promise<TrackerState[]> {
    const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

    return this.repository.find({
      where: {
        last_seen_at: MoreThan(cutoffTime),
      },
      order: {
        last_seen_at: 'DESC',
      },
    });
  }

  /**
   * Obtener trackers inactivos (no vistos en las últimas N horas)
   */
  async findInactive(hoursAgo: number = 24): Promise<TrackerState[]> {
    const cutoffTime = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);

    return this.repository.find({
      where: {
        last_seen_at: LessThan(cutoffTime),
      },
      order: {
        last_seen_at: 'DESC',
      },
    });
  }

  /**
   * Listar todos los trackers con paginación
   */
  async findAll(
    limit: number = 100,
    offset: number = 0,
  ): Promise<{ data: TrackerState[]; total: number }> {
    const [data, total] = await this.repository.findAndCount({
      order: {
        last_seen_at: 'DESC',
      },
      take: limit,
      skip: offset,
    });

    return { data, total };
  }

  /**
   * Obtener estadísticas globales
   */
  async getGlobalStats(): Promise<{
    totalTrackers: number;
    onlineTrackers: number;
    offlineTrackers: number;
    totalOdometer: number;
    totalTrips: number;
    totalDrivingTime: number;
  }> {
    const allTrackers = await this.repository.find();
    const onlineThreshold = new Date(Date.now() - 30 * 60 * 1000); // 30 minutos

    const totalTrackers = allTrackers.length;
    const onlineTrackers = allTrackers.filter(
      (t) => t.last_seen_at && t.last_seen_at > onlineThreshold,
    ).length;
    const totalOdometer = allTrackers.reduce(
      (sum, t) => sum + (t.total_odometer || 0),
      0,
    );
    const totalTrips = allTrackers.reduce(
      (sum, t) => sum + (t.total_trips_count || 0),
      0,
    );
    const totalDrivingTime = allTrackers.reduce(
      (sum, t) => sum + (t.total_driving_time || 0),
      0,
    );

    return {
      totalTrackers,
      onlineTrackers,
      offlineTrackers: totalTrackers - onlineTrackers,
      totalOdometer,
      totalTrips,
      totalDrivingTime,
    };
  }

  /**
   * Eliminar tracker (use con precaución)
   */
  async delete(trackerId: string): Promise<void> {
    await this.repository.delete({ tracker_id: trackerId });
  }
}
