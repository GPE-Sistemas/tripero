-- Crear tablas para Tripero

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Tabla trips
CREATE TABLE IF NOT EXISTS trips (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  id_activo VARCHAR(255) NOT NULL,
  distance DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_speed DOUBLE PRECISION NOT NULL DEFAULT 0,
  avg_speed DOUBLE PRECISION NOT NULL DEFAULT 0,
  duration INTEGER NOT NULL DEFAULT 0,
  start_lat DOUBLE PRECISION NOT NULL,
  start_lon DOUBLE PRECISION NOT NULL,
  end_lat DOUBLE PRECISION,
  end_lon DOUBLE PRECISION,
  start_address TEXT,
  end_address TEXT,
  route_points JSONB NOT NULL DEFAULT '[]',
  stop_count INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  detection_method TEXT NOT NULL DEFAULT 'ignition',
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trips_start_time ON trips(start_time);
CREATE INDEX IF NOT EXISTS idx_trips_id_activo ON trips(id_activo);
CREATE INDEX IF NOT EXISTS idx_trips_is_active ON trips(is_active);
CREATE INDEX IF NOT EXISTS idx_trips_id_activo_start_time ON trips(id_activo, start_time);

-- Tabla stops
CREATE TABLE IF NOT EXISTS stops (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  trip_id UUID,
  id_activo VARCHAR(255) NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ,
  duration INTEGER NOT NULL DEFAULT 0,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  address TEXT,
  reason TEXT NOT NULL DEFAULT 'ignition_off',
  is_active BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stops_trip_id ON stops(trip_id);
CREATE INDEX IF NOT EXISTS idx_stops_start_time ON stops(start_time);
CREATE INDEX IF NOT EXISTS idx_stops_id_activo ON stops(id_activo);
CREATE INDEX IF NOT EXISTS idx_stops_is_active ON stops(is_active);
CREATE INDEX IF NOT EXISTS idx_stops_id_activo_start_time ON stops(id_activo, start_time);
CREATE INDEX IF NOT EXISTS idx_stops_trip_start ON stops(trip_id, start_time);

-- Tabla tracker_state
CREATE TABLE IF NOT EXISTS tracker_state (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tracker_id VARCHAR(255) UNIQUE NOT NULL,
  device_id VARCHAR(255) NOT NULL,
  total_odometer DOUBLE PRECISION NOT NULL DEFAULT 0,
  trip_odometer_start DOUBLE PRECISION,
  last_position_time TIMESTAMPTZ,
  last_latitude DOUBLE PRECISION,
  last_longitude DOUBLE PRECISION,
  last_speed DOUBLE PRECISION,
  last_ignition BOOLEAN,
  last_heading DOUBLE PRECISION,
  last_altitude DOUBLE PRECISION,
  current_state VARCHAR(20),
  state_since TIMESTAMPTZ,
  current_trip_id UUID,
  trip_start_time TIMESTAMPTZ,
  total_trips_count INTEGER DEFAULT 0,
  total_driving_time INTEGER DEFAULT 0,
  total_idle_time INTEGER DEFAULT 0,
  total_stops_count INTEGER DEFAULT 0,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracker_state_tracker_id ON tracker_state(tracker_id);
CREATE INDEX IF NOT EXISTS idx_tracker_state_last_seen ON tracker_state(last_seen_at DESC);
