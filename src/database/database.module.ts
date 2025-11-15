import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DB_HOST,
  DB_PORT,
  DB_USERNAME,
  DB_PASSWORD,
  DB_DATABASE,
  DB_LOGGING,
} from '../env';
import { Trip, Stop, TrackerState } from './entities';
import { TripRepository, StopRepository, TrackerStateRepository } from './repositories';
import { DatabaseInitService } from './services/database-init.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: DB_HOST,
      port: DB_PORT,
      username: DB_USERNAME,
      password: DB_PASSWORD,
      database: DB_DATABASE,
      entities: [Trip, Stop, TrackerState],
      synchronize: true, // TypeORM auto-crea/actualiza tablas
      logging: DB_LOGGING,
      // Opciones adicionales para TimescaleDB
      extra: {
        max: 20, // pool size máximo
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      },
    }),
    TypeOrmModule.forFeature([Trip, Stop, TrackerState]),
  ],
  providers: [
    TripRepository,
    StopRepository,
    TrackerStateRepository,
    DatabaseInitService,
  ],
  exports: [TypeOrmModule, TripRepository, StopRepository, TrackerStateRepository],
})
export class DatabaseModule {}
