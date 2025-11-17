-- Migration: Add GIN indexes for metadata JSONB fields
-- Date: 2025-11-17
-- Description: Add indexes to support efficient querying by metadata fields (multi-tenancy, fleet management, etc.)

-- Create GIN indexes for generic JSONB queries on trips
-- This allows queries like: WHERE metadata @> '{"tenant_id": "tenant-123"}'
CREATE INDEX IF NOT EXISTS idx_trips_metadata_gin ON trips USING GIN (metadata jsonb_path_ops);

-- Create GIN indexes for generic JSONB queries on stops
CREATE INDEX IF NOT EXISTS idx_stops_metadata_gin ON stops USING GIN (metadata jsonb_path_ops);

-- Create B-tree partial indexes for common metadata fields (optional but faster for specific queries)
-- These provide ~1-2ms query times vs ~5-10ms with GIN alone

-- Tenant ID indexes (common for multi-tenancy)
CREATE INDEX IF NOT EXISTS idx_trips_metadata_tenant ON trips
  USING btree ((metadata->>'tenant_id'))
  WHERE metadata->>'tenant_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stops_metadata_tenant ON stops
  USING btree ((metadata->>'tenant_id'))
  WHERE metadata->>'tenant_id' IS NOT NULL;

-- Client ID indexes (common for customer filtering)
CREATE INDEX IF NOT EXISTS idx_trips_metadata_client ON trips
  USING btree ((metadata->>'client_id'))
  WHERE metadata->>'client_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stops_metadata_client ON stops
  USING btree ((metadata->>'client_id'))
  WHERE metadata->>'client_id' IS NOT NULL;

-- Fleet ID indexes (common for fleet management)
CREATE INDEX IF NOT EXISTS idx_trips_metadata_fleet ON trips
  USING btree ((metadata->>'fleet_id'))
  WHERE metadata->>'fleet_id' IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_stops_metadata_fleet ON stops
  USING btree ((metadata->>'fleet_id'))
  WHERE metadata->>'fleet_id' IS NOT NULL;

-- Add comments explaining the indexes
COMMENT ON INDEX idx_trips_metadata_gin IS 'GIN index for generic metadata queries on trips';
COMMENT ON INDEX idx_stops_metadata_gin IS 'GIN index for generic metadata queries on stops';
COMMENT ON INDEX idx_trips_metadata_tenant IS 'B-tree index for fast tenant_id lookups on trips';
COMMENT ON INDEX idx_stops_metadata_tenant IS 'B-tree index for fast tenant_id lookups on stops';
COMMENT ON INDEX idx_trips_metadata_client IS 'B-tree index for fast client_id lookups on trips';
COMMENT ON INDEX idx_stops_metadata_client IS 'B-tree index for fast client_id lookups on stops';
COMMENT ON INDEX idx_trips_metadata_fleet IS 'B-tree index for fast fleet_id lookups on trips';
COMMENT ON INDEX idx_stops_metadata_fleet IS 'B-tree index for fast fleet_id lookups on stops';
