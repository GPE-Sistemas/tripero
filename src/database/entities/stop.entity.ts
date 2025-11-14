import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Index,
  CreateDateColumn,
} from 'typeorm';

@Entity('stops')
@Index(['trip_id', 'start_time'])
@Index(['id_activo', 'start_time'])
@Index(['start_time'])
export class Stop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'trip_id' })
  @Index()
  trip_id: string;

  @Column({ type: 'uuid', name: 'id_activo' })
  @Index()
  id_activo: string;

  @Column({ type: 'timestamptz', name: 'start_time' })
  @Index()
  start_time: Date;

  @Column({ type: 'timestamptz', name: 'end_time', nullable: true })
  end_time: Date | null;

  @Column({ type: 'int', default: 0 })
  duration: number;

  @Column({ type: 'float8' })
  lat: number;

  @Column({ type: 'float8' })
  lon: number;

  @Column({ type: 'text', nullable: true })
  address: string | null;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  @Index()
  is_active: boolean;

  @Column({ type: 'text', name: 'stop_type', default: 'motion' })
  stop_type: string;

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
