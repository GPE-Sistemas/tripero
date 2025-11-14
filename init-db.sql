-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Las tablas serán creadas por TypeORM (synchronize o migrations)
-- Este script se ejecuta para configurar las hypertables después
-- de que TypeORM cree las tablas

-- Tablas gestionadas por TypeORM:
-- - trips: Viajes completados (hypertable)
-- - stops: Paradas detectadas (hypertable)
-- - tracker_state: Estado actual de cada tracker (tabla normal, no hypertable)

-- Nota: Este script asume que las tablas ya existen
-- Si usas DB_SYNCHRONIZE=true en desarrollo, TypeORM creará las tablas
-- Luego necesitarás ejecutar manualmente los siguientes comandos:

-- Para convertir la tabla trips en hypertable:
-- SELECT create_hypertable('trips', 'start_time', if_not_exists => TRUE);

-- Para convertir la tabla stops en hypertable:
-- SELECT create_hypertable('stops', 'start_time', if_not_exists => TRUE);

-- Para configurar compresión automática en trips (opcional, después de crear hypertable):
-- ALTER TABLE trips SET (
--   timescaledb.compress,
--   timescaledb.compress_segmentby = 'id_activo',
--   timescaledb.compress_orderby = 'start_time DESC'
-- );

-- Política de compresión: comprimir datos más viejos de 7 días
-- SELECT add_compression_policy('trips', INTERVAL '7 days');

-- Para configurar compresión automática en stops (opcional, después de crear hypertable):
-- ALTER TABLE stops SET (
--   timescaledb.compress,
--   timescaledb.compress_segmentby = 'id_activo',
--   timescaledb.compress_orderby = 'start_time DESC'
-- );

-- Política de compresión: comprimir datos más viejos de 7 días
-- SELECT add_compression_policy('stops', INTERVAL '7 days');

-- Política de retención: eliminar datos más viejos de 365 días (opcional)
-- SELECT add_retention_policy('trips', INTERVAL '365 days');
-- SELECT add_retention_policy('stops', INTERVAL '365 days');
