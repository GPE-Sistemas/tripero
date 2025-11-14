import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity('trips')
@Index(['id_activo', 'start_time'])
@Index(['start_time'])
export class Trip {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'timestamptz', name: 'start_time' })
  @Index()
  start_time: Date;

  @Column({ type: 'timestamptz', name: 'end_time', nullable: true })
  end_time: Date | null;

  @Column({ type: 'uuid', name: 'id_activo' })
  @Index()
  id_activo: string;

  @Column({ type: 'float8', default: 0 })
  distance: number;

  @Column({ type: 'float8', name: 'max_speed', default: 0 })
  max_speed: number;

  @Column({ type: 'float8', name: 'avg_speed', default: 0 })
  avg_speed: number;

  @Column({ type: 'int', default: 0 })
  duration: number;

  @Column({ type: 'float8', name: 'start_lat' })
  start_lat: number;

  @Column({ type: 'float8', name: 'start_lon' })
  start_lon: number;

  @Column({ type: 'float8', name: 'end_lat', nullable: true })
  end_lat: number | null;

  @Column({ type: 'float8', name: 'end_lon', nullable: true })
  end_lon: number | null;

  @Column({ type: 'text', name: 'start_address', nullable: true })
  start_address: string | null;

  @Column({ type: 'text', name: 'end_address', nullable: true })
  end_address: string | null;

  @Column({ type: 'jsonb', name: 'route_points', default: '[]' })
  route_points: Array<{
    lat: number;
    lon: number;
    timestamp: string;
    speed: number;
  }>;

  @Column({ type: 'int', name: 'stop_count', default: 0 })
  stop_count: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  @Index()
  is_active: boolean;

  @Column({ type: 'text', name: 'detection_method', default: 'ignition' })
  detection_method: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @Column({
    type: 'timestamptz',
    name: 'updated_at',
    default: () => 'CURRENT_TIMESTAMP',
  })
  updated_at: Date;
}
