import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  DB_HOST,
  DB_PORT,
  DB_USERNAME,
  DB_PASSWORD,
  DB_DATABASE,
  DB_SYNCHRONIZE,
  DB_LOGGING,
} from '../env';
import { Trip, Stop } from './entities';
import { TripRepository, StopRepository } from './repositories';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: DB_HOST,
      port: DB_PORT,
      username: DB_USERNAME,
      password: DB_PASSWORD,
      database: DB_DATABASE,
      entities: [Trip, Stop],
      synchronize: DB_SYNCHRONIZE, // Solo en desarrollo
      logging: DB_LOGGING,
      // Opciones adicionales para TimescaleDB
      extra: {
        max: 20, // pool size máximo
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 30000,
      },
    }),
    TypeOrmModule.forFeature([Trip, Stop]),
  ],
  providers: [TripRepository, StopRepository],
  exports: [TypeOrmModule, TripRepository, StopRepository],
})
export class DatabaseModule {}
