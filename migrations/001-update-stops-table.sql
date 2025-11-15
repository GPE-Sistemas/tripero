-- Migration: Update stops table to match Stop entity
-- Date: 2025-11-14
-- Description: Add new fields and update existing ones for stop detection

-- Add new columns
ALTER TABLE stops
  ADD COLUMN IF NOT EXISTS trip_id UUID,
  ADD COLUMN IF NOT EXISTS latitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS reason TEXT DEFAULT 'ignition_off',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;

-- Copy data from old columns to new ones (if needed)
UPDATE stops
SET
  latitude = start_lat,
  longitude = start_lon
WHERE latitude IS NULL;

-- Change id_activo from UUID to VARCHAR(255) for flexibility
-- Note: This requires creating a new column and migrating data
ALTER TABLE stops ADD COLUMN IF NOT EXISTS id_activo_new VARCHAR(255);
UPDATE stops SET id_activo_new = id_activo::text WHERE id_activo_new IS NULL;
ALTER TABLE stops DROP COLUMN IF EXISTS id_activo CASCADE;
ALTER TABLE stops RENAME COLUMN id_activo_new TO id_activo;
ALTER TABLE stops ALTER COLUMN id_activo SET NOT NULL;

-- Drop old columns that are no longer needed
ALTER TABLE stops DROP COLUMN IF EXISTS start_lat;
ALTER TABLE stops DROP COLUMN IF EXISTS start_lon;
ALTER TABLE stops DROP COLUMN IF EXISTS detection_method;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_stops_trip_id ON stops(trip_id);
CREATE INDEX IF NOT EXISTS idx_stops_id_activo_start_time ON stops(id_activo, start_time);
CREATE INDEX IF NOT EXISTS idx_stops_is_active ON stops(is_active);

-- Add composite index for better query performance
CREATE INDEX IF NOT EXISTS idx_stops_trip_start ON stops(trip_id, start_time);

COMMENT ON TABLE stops IS 'Vehicle stops detected by Tripero';
COMMENT ON COLUMN stops.trip_id IS 'Associated trip UUID (nullable for stops outside trips)';
COMMENT ON COLUMN stops.id_activo IS 'Device/asset identifier';
COMMENT ON COLUMN stops.reason IS 'Stop reason: ignition_off, no_movement, or parking';
COMMENT ON COLUMN stops.is_active IS 'Whether the stop is currently active (not yet completed)';
