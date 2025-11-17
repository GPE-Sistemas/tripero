import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('tracker_state')
@Index(['tracker_id'], { unique: true })
@Index(['last_seen_at'])
export class TrackerState {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  // Identificadores
  @Column({ type: 'varchar', length: 255, name: 'tracker_id', unique: true })
  tracker_id: string;

  @Column({ type: 'varchar', length: 255, name: 'device_id' })
  device_id: string;

  // Odómetro (en metros)
  @Column({ type: 'float8', name: 'total_odometer', default: 0 })
  total_odometer: number;

  @Column({ type: 'float8', name: 'odometer_offset', default: 0 })
  odometer_offset: number;

  @Column({ type: 'float8', name: 'trip_odometer_start', nullable: true })
  trip_odometer_start: number | null;

  // Última posición conocida
  @Column({ type: 'timestamptz', name: 'last_position_time', nullable: true })
  last_position_time: Date | null;

  @Column({ type: 'float8', name: 'last_latitude', nullable: true })
  last_latitude: number | null;

  @Column({ type: 'float8', name: 'last_longitude', nullable: true })
  last_longitude: number | null;

  @Column({ type: 'float8', name: 'last_speed', nullable: true })
  last_speed: number | null;

  @Column({ type: 'boolean', name: 'last_ignition', nullable: true })
  last_ignition: boolean | null;

  @Column({ type: 'float8', name: 'last_heading', nullable: true })
  last_heading: number | null;

  @Column({ type: 'float8', name: 'last_altitude', nullable: true })
  last_altitude: number | null;

  // Estado de movimiento
  @Column({ type: 'varchar', length: 20, name: 'current_state', nullable: true })
  current_state: string | null;

  @Column({ type: 'timestamptz', name: 'state_since', nullable: true })
  state_since: Date | null;

  // Trip actual
  @Column({ type: 'varchar', length: 255, name: 'current_trip_id', nullable: true })
  current_trip_id: string | null;

  @Column({ type: 'timestamptz', name: 'trip_start_time', nullable: true })
  trip_start_time: Date | null;

  // Estadísticas acumulativas
  @Column({ type: 'int', name: 'total_trips_count', default: 0 })
  total_trips_count: number;

  @Column({ type: 'int', name: 'total_driving_time', default: 0 })
  total_driving_time: number;

  @Column({ type: 'int', name: 'total_idle_time', default: 0 })
  total_idle_time: number;

  @Column({ type: 'int', name: 'total_stops_count', default: 0 })
  total_stops_count: number;

  // Metadata
  @Column({ type: 'timestamptz', name: 'first_seen_at' })
  first_seen_at: Date;

  @Column({ type: 'timestamptz', name: 'last_seen_at' })
  last_seen_at: Date;

  // Timestamps
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updated_at: Date;
}
