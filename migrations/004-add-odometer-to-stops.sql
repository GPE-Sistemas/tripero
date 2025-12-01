-- Migration: 004-add-odometer-to-stops
-- Description: Agregar campos de odómetro a tabla stops para compatibilidad con Traccar
-- Date: 2024-12-01

-- Agregar columnas de odómetro a stops
ALTER TABLE stops
ADD COLUMN IF NOT EXISTS start_odometer DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS end_odometer DOUBLE PRECISION;

-- Comentarios para documentación
COMMENT ON COLUMN stops.start_odometer IS 'Odómetro al inicio del stop (metros)';
COMMENT ON COLUMN stops.end_odometer IS 'Odómetro al final del stop (metros)';

-- Verificar que se agregaron las columnas
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'stops' AND column_name = 'start_odometer'
  ) THEN
    RAISE NOTICE 'Column start_odometer added successfully';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'stops' AND column_name = 'end_odometer'
  ) THEN
    RAISE NOTICE 'Column end_odometer added successfully';
  END IF;
END $$;
