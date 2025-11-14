// Environment configuration
import * as dotenv from 'dotenv';

dotenv.config();

// Server
export const PORT = parseInt(process.env.PORT || '3000', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';

// Redis
export const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
export const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

// API URLs
export const API_DATOS_URL =
  process.env.API_DATOS_URL || 'http://localhost:3001';

// Trip Detection Config
export const TRIP_DETECTION_ENABLED =
  process.env.TRIP_DETECTION_ENABLED !== 'false';

export const POSITION_THROTTLE_MS = parseInt(
  process.env.POSITION_THROTTLE_MS || '1000',
  10,
);

export const BATCH_WRITE_INTERVAL_MS = parseInt(
  process.env.BATCH_WRITE_INTERVAL_MS || '5000',
  10,
);

export const BATCH_MAX_SIZE = parseInt(
  process.env.BATCH_MAX_SIZE || '100',
  10,
);

// Database (TimescaleDB/PostgreSQL)
export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
export const DB_USERNAME = process.env.DB_USERNAME || 'postgres';
export const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
export const DB_DATABASE = process.env.DB_DATABASE || 'tripero';
export const DB_SYNCHRONIZE = process.env.DB_SYNCHRONIZE === 'true';
export const DB_LOGGING = process.env.DB_LOGGING === 'true';
