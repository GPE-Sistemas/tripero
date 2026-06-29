-- Migration: Add (id_activo, end_time) index on stops
-- Date: 2026-06-29
-- Description: getStops usa solapamiento de rango:
--   WHERE id_activo = X AND start_time <= toDate AND (end_time >= fromDate OR end_time IS NULL)
-- El único índice usable era (id_activo, start_time), pero start_time <= now()
-- matchea TODAS las paradas históricas del activo -> escaneo completo y lentitud.
-- El predicado selectivo real es end_time >= fromDate (acota a la ventana).
-- Este índice lo hace rangeable por activo (incluye paradas activas, end_time NULL).
--
-- NOTA: en producción, si la tabla `stops` es grande, ejecutar con CONCURRENTLY
-- fuera de transacción para evitar lock prolongado:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stops_id_activo_end_time ON stops(id_activo, end_time);

CREATE INDEX IF NOT EXISTS idx_stops_id_activo_end_time ON stops(id_activo, end_time);

COMMENT ON INDEX idx_stops_id_activo_end_time IS 'Para getStops (solapamiento por rango): acota por end_time >= fromDate por activo';
