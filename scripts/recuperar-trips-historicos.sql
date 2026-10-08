-- Recuperación de trips huérfanos históricos sin distancia.
--
-- Mismo criterio que TripRepairService (src/detection/services/trip-repair.service.ts),
-- pero sin ventana de días y en una sola pasada por SQL:
--   - candidatos: cerrados por orphan_cleanup, distancia 0 o nula, sin metadata.reparacion;
--   - odómetro de inicio: end_odometer (o start_odometer) de la última parada del
--     vehículo que empezó antes del trip;
--   - odómetro de fin: el mayor start_odometer de las paradas que empezaron durante
--     el trip o hasta 10 min después de su fin;
--   - la distancia se acepta sólo si es >= 0 y no supera 200 km/h en la duración;
--   - cada trip queda marcado en metadata.reparacion (reparado o irreparable), con
--     origen 'script_historico', así ni este script ni el servicio lo vuelven a mirar.
-- max_speed no se toca: las paradas no la guardan.
--
-- Por defecto NO escribe (ROLLBACK). Uso:
--   psql -U tripero_user -d tripero -f recuperar-trips-historicos.sql                 # simulación
--   psql -U tripero_user -d tripero -v aplicar=true -f recuperar-trips-historicos.sql # aplica
-- Variables opcionales:
--   schema  (por defecto tripero_b)
--   dias    sólo trips que empezaron hace más de N días (por defecto 0 = todos)
--
-- Antes de modificar, guarda distance/avg_speed/duration/metadata originales en
-- trips_respaldo_reparacion. Para deshacer:
--   UPDATE trips t SET distance = r.distance, avg_speed = r.avg_speed,
--          duration = r.duration, metadata = r.metadata
--   FROM trips_respaldo_reparacion r WHERE t.id = r.id;

\set ON_ERROR_STOP on
\if :{?aplicar}
\else
  \set aplicar false
\endif
\if :{?schema}
\else
  \set schema tripero_b
\endif
\if :{?dias}
\else
  \set dias 0
\endif

SET search_path TO :"schema";

BEGIN;

CREATE TEMP TABLE candidatos ON COMMIT DROP AS
SELECT t.id,
       t.id_activo,
       t.start_time,
       COALESCE(t.end_time, t.updated_at) AS fin,
       CASE
         WHEN t.duration > 0 THEN t.duration
         ELSE GREATEST(0, floor(extract(epoch FROM COALESCE(t.end_time, t.updated_at) - t.start_time)))::int
       END AS duracion
FROM trips t
WHERE t.is_active = false
  AND (t.distance = 0 OR t.distance IS NULL)
  AND t.metadata->>'closedBy' = 'orphan_cleanup'
  AND t.metadata->'reparacion' IS NULL
  AND t.start_time < now() - make_interval(days => :dias);

CREATE TEMP TABLE resultado ON COMMIT DROP AS
SELECT c.id,
       c.start_time,
       c.duracion,
       a.odo_ini,
       p.odo_fin,
       round(p.odo_fin - a.odo_ini) AS distancia,
       CASE
         WHEN a.odo_ini IS NULL THEN 'sin_parada_anterior'
         WHEN p.odo_fin IS NULL THEN 'sin_parada_al_final'
         WHEN round(p.odo_fin - a.odo_ini) < 0
           OR round(p.odo_fin - a.odo_ini) > (200 / 3.6) * GREATEST(c.duracion, 60)
           THEN 'distancia_implausible'
       END AS motivo
FROM candidatos c
LEFT JOIN LATERAL (
  SELECT COALESCE(s.end_odometer, s.start_odometer) AS odo_ini
  FROM stops s
  WHERE s.id_activo = c.id_activo
    AND s.start_time <= c.start_time
  ORDER BY s.start_time DESC
  LIMIT 1
) a ON true
LEFT JOIN LATERAL (
  SELECT max(s.start_odometer) AS odo_fin
  FROM stops s
  WHERE s.id_activo = c.id_activo
    AND s.start_time > c.start_time
    AND s.start_time <= c.fin + interval '10 minutes'
) p ON true;

\echo
\echo '== Resultado por motivo (vacío = reparable) =='
SELECT COALESCE(motivo, 'reparado') AS estado,
       count(*) AS trips,
       round(sum(distancia) FILTER (WHERE motivo IS NULL) / 1000.0) AS km_recuperados,
       min(start_time)::date AS desde,
       max(start_time)::date AS hasta
FROM resultado
GROUP BY 1
ORDER BY 2 DESC;

\echo '== Reparables por mes =='
SELECT to_char(date_trunc('month', start_time), 'YYYY-MM') AS mes,
       count(*) FILTER (WHERE motivo IS NULL) AS reparables,
       count(*) AS candidatos
FROM resultado
GROUP BY 1
ORDER BY 1;

\echo '== Muestra de reparables =='
SELECT id, start_time, duracion AS duracion_s, odo_ini, odo_fin, distancia AS distancia_m,
       CASE WHEN duracion > 0 THEN round(distancia / duracion * 3.6) ELSE 0 END AS avg_kmh
FROM resultado
WHERE motivo IS NULL
ORDER BY start_time DESC
LIMIT 15;

CREATE TABLE IF NOT EXISTS trips_respaldo_reparacion (
  id varchar(255) PRIMARY KEY,
  distance float8,
  avg_speed float8,
  duration int,
  metadata jsonb,
  respaldado_en timestamptz NOT NULL DEFAULT now()
);

INSERT INTO trips_respaldo_reparacion (id, distance, avg_speed, duration, metadata)
SELECT t.id, t.distance, t.avg_speed, t.duration, t.metadata
FROM trips t
JOIN resultado r ON r.id = t.id
ON CONFLICT (id) DO NOTHING;

UPDATE trips t
SET distance  = r.distancia,
    avg_speed = CASE WHEN r.duracion > 0 THEN round(r.distancia / r.duracion * 3.6) ELSE 0 END,
    duration  = CASE WHEN t.duration > 0 THEN t.duration ELSE r.duracion END,
    metadata  = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object('reparacion', jsonb_build_object(
                  'estado', 'reparado',
                  'fuente', 'paradas',
                  'distancia', r.distancia,
                  'odometroInicio', r.odo_ini,
                  'odometroFin', r.odo_fin,
                  'origen', 'script_historico',
                  'fecha', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
FROM resultado r
WHERE t.id = r.id
  AND r.motivo IS NULL;

UPDATE trips t
SET metadata = COALESCE(t.metadata, '{}'::jsonb) || jsonb_build_object('reparacion', jsonb_strip_nulls(jsonb_build_object(
                 'estado', 'irreparable',
                 'fuente', CASE WHEN r.motivo = 'distancia_implausible' THEN 'paradas' END,
                 'motivo', r.motivo,
                 'odometroInicio', r.odo_ini,
                 'odometroFin', r.odo_fin,
                 'origen', 'script_historico',
                 'fecha', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))))
FROM resultado r
WHERE t.id = r.id
  AND r.motivo IS NOT NULL;

\if :aplicar
  COMMIT;
  \echo '== APLICADO =='
\else
  ROLLBACK;
  \echo '== SIMULACIÓN: no se escribió nada (usar -v aplicar=true para aplicar) =='
\endif
