import {
  Entity,
  PrimaryColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity('stops')
@Index(['trip_id', 'start_time'])
@Index(['id_activo', 'start_time'])
@Index(['start_time'])
@Index(['id', 'id_activo']) // Para búsquedas por ID + validación de device
export class Stop {
  @PrimaryColumn({ type: 'varchar', length: 255 })
  id: string;

  @Column({ type: 'varchar', length: 255, name: 'trip_id', nullable: true })
  @Index()
  trip_id: string | null;

  @Column({ type: 'varchar', length: 255, name: 'id_activo' })
  @Index()
  id_activo: string;

  @Column({ type: 'timestamptz', name: 'start_time' })
  start_time: Date;

  @Column({ type: 'timestamptz', name: 'end_time', nullable: true })
  end_time: Date | null;

  @Column({ type: 'int', default: 0 })
  duration: number;

  @Column({ type: 'float8', name: 'latitude' })
  latitude: number;

  @Column({ type: 'float8', name: 'longitude' })
  longitude: number;

  @Column({ type: 'text', name: 'reason', default: 'ignition_off' })
  reason: string; // 'ignition_off' | 'no_movement' | 'parking'

  @Column({ type: 'float8', name: 'start_odometer', nullable: true })
  start_odometer: number | null;

  @Column({ type: 'float8', name: 'end_odometer', nullable: true })
  end_odometer: number | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  @Index()
  is_active: boolean;

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
