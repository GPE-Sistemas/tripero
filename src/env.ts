// Environment configuration
import * as dotenv from 'dotenv';

dotenv.config();

// Server
export const PORT = parseInt(process.env.PORT || '3001', 10);
export const NODE_ENV = process.env.NODE_ENV || 'development';

// Redis
export const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
export const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
export const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);
export const REDIS_PASSWORD = process.env.REDIS_PASSWORD;

// Database (TimescaleDB/PostgreSQL)
export const DB_HOST = process.env.DB_HOST || 'localhost';
export const DB_PORT = parseInt(process.env.DB_PORT || '5432', 10);
export const DB_USERNAME = process.env.DB_USERNAME || 'postgres';
export const DB_PASSWORD = process.env.DB_PASSWORD || 'postgres';
export const DB_DATABASE = process.env.DB_DATABASE || 'tripero';
export const DB_LOGGING = process.env.DB_LOGGING === 'true';
