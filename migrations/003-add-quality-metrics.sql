-- Migration 003: Add quality metrics columns to trips table
-- Date: 2025-11-25
-- Purpose: Add columns for tracking trip quality metrics and distance validation
-- Refs: PLAN-MEJORAS-ODOMETRO-TRIPERO.md

-- Add quality metrics columns to trips table
ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS distance_original REAL,           -- Distancia sin ajustes (metros)
  ADD COLUMN IF NOT EXISTS distance_linear REAL,             -- Distancia lineal inicio-fin (metros)
  ADD COLUMN IF NOT EXISTS route_linear_ratio REAL,          -- Ratio ruta/lineal
  ADD COLUMN IF NOT EXISTS operation_area_diameter REAL,     -- Diámetro del área de operación (metros)
  ADD COLUMN IF NOT EXISTS quality_flag VARCHAR(50),         -- 'valid', 'adjusted_small_area', 'adjusted_high_ratio', 'anomalous'
  ADD COLUMN IF NOT EXISTS quality_metadata JSONB;           -- Metadata detallada de calidad

-- Add comments to columns for documentation
COMMENT ON COLUMN trips.distance_original IS 'Distancia original calculada sin aplicar correcciones (metros)';
COMMENT ON COLUMN trips.distance_linear IS 'Distancia lineal entre punto de inicio y fin del trip (metros)';
COMMENT ON COLUMN trips.route_linear_ratio IS 'Ratio entre distancia de ruta y distancia lineal (valores altos indican movimiento circular o ruido GPS)';
COMMENT ON COLUMN trips.operation_area_diameter IS 'Diámetro del bounding box del trip (diagonal máxima en metros)';
COMMENT ON COLUMN trips.quality_flag IS 'Flag de calidad: valid (normal), adjusted_small_area (ajustado por área pequeña), adjusted_high_ratio (ajustado por ratio alto), anomalous (anomalía detectada)';
COMMENT ON COLUMN trips.quality_metadata IS 'Metadata JSON con detalles de calidad: segmentos totales, ajustados, anomalías detectadas, etc.';

-- Create indexes for quality analysis queries
CREATE INDEX IF NOT EXISTS idx_trips_quality_flag ON trips(quality_flag);
CREATE INDEX IF NOT EXISTS idx_trips_route_ratio ON trips(route_linear_ratio) WHERE route_linear_ratio > 5;
CREATE INDEX IF NOT EXISTS idx_trips_small_area ON trips(operation_area_diameter) WHERE operation_area_diameter < 500;

-- Create view for quality analysis
CREATE OR REPLACE VIEW trips_quality_analysis AS
SELECT
  id_activo,
  DATE(start_time) as date,
  COUNT(*) as total_trips,
  COUNT(*) FILTER (WHERE quality_flag = 'valid') as valid_trips,
  COUNT(*) FILTER (WHERE quality_flag = 'adjusted_small_area') as adjusted_small_area_trips,
  COUNT(*) FILTER (WHERE quality_flag = 'adjusted_high_ratio') as adjusted_high_ratio_trips,
  COUNT(*) FILTER (WHERE quality_flag = 'anomalous') as anomalous_trips,
  COUNT(*) FILTER (WHERE route_linear_ratio > 5) as high_ratio_trips,
  AVG(route_linear_ratio) as avg_ratio,
  AVG(operation_area_diameter) as avg_area_diameter,
  SUM(distance) as total_distance_adjusted,
  SUM(distance_original) as total_distance_original,
  SUM(COALESCE(distance_original, distance) - distance) as total_correction,
  CASE
    WHEN SUM(COALESCE(distance_original, distance)) > 0
    THEN ROUND((SUM(COALESCE(distance_original, distance) - distance) / SUM(COALESCE(distance_original, distance)) * 100)::numeric, 2)
    ELSE 0
  END as correction_percentage
FROM trips
WHERE start_time > NOW() - INTERVAL '30 days'
GROUP BY id_activo, DATE(start_time)
ORDER BY date DESC, id_activo;

-- Comment on view
COMMENT ON VIEW trips_quality_analysis IS 'Análisis agregado de calidad de trips por dispositivo y fecha. Útil para monitorear efectividad de correcciones de odómetro.';

-- Create view for trips with high corrections (potential issues)
CREATE OR REPLACE VIEW trips_with_high_corrections AS
SELECT
  id,
  id_activo,
  start_time,
  distance as distance_adjusted,
  distance_original,
  distance_linear,
  route_linear_ratio,
  operation_area_diameter,
  quality_flag,
  ROUND(((COALESCE(distance_original, distance) - distance) / NULLIF(COALESCE(distance_original, distance), 0) * 100)::numeric, 2) as correction_percentage,
  quality_metadata
FROM trips
WHERE
  distance_original IS NOT NULL
  AND distance_original > distance
  AND ((distance_original - distance) / NULLIF(distance_original, 0)) > 0.1  -- More than 10% correction
ORDER BY correction_percentage DESC;

-- Comment on view
COMMENT ON VIEW trips_with_high_corrections IS 'Trips con correcciones de distancia superiores al 10%. Útil para identificar casos problemáticos que requieren revisión.';

-- Add check constraints
ALTER TABLE trips
  ADD CONSTRAINT check_distance_positive CHECK (distance >= 0),
  ADD CONSTRAINT check_distance_original_positive CHECK (distance_original IS NULL OR distance_original >= 0),
  ADD CONSTRAINT check_distance_linear_positive CHECK (distance_linear IS NULL OR distance_linear >= 0),
  ADD CONSTRAINT check_ratio_positive CHECK (route_linear_ratio IS NULL OR route_linear_ratio >= 0),
  ADD CONSTRAINT check_area_positive CHECK (operation_area_diameter IS NULL OR operation_area_diameter >= 0);

-- Migration complete
-- Next steps:
-- 1. Deploy this migration to development environment
-- 2. Verify existing trips still work (all new columns are nullable)
-- 3. Monitor quality metrics for new trips
-- 4. After validation, consider backfilling quality metrics for historical trips (optional)
