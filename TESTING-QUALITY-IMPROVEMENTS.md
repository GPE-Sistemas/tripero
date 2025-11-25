# Guía de Testing: Mejoras de Calidad del Odómetro

**Fecha:** 2025-11-25
**Rama:** `feature/odometer-quality-improvements`
**Refs:** PLAN-MEJORAS-ODOMETRO-TRIPERO.md

---

## 📋 Resumen de Cambios

Esta implementación resuelve el problema de acumulación excesiva de distancias en Tripero cuando los vehículos se mueven en áreas pequeñas (ratios ruta/lineal de 100-300x).

### Sistema de Validación en Dos Niveles

1. **Nivel 1: Validación por Segmento** (durante el trip)
   - Detecta velocidades imposibles (>200 km/h) → descarta
   - Filtra ruido GPS (<5m con velocidad 0) → descarta
   - Detecta ratios excesivos (>5x) → aplica corrección 0.7x
   - Registra anomalías en metadata

2. **Nivel 2: Análisis de Trip Completo** (al finalizar)
   - Analiza área de operación (bounding box)
   - Calcula ratio ruta/lineal del trip completo
   - Aplica corrección adicional si:
     - Área < 500m Y ratio > 5
   - Guarda métricas de calidad en BD

---

## 🚀 Pasos para Testing

### 1. Aplicar Migración de Base de Datos

```bash
# Conectarse a la base de datos de Tripero
kubectl port-forward -n default postgres-tripero-0 5432:5432 &

# Aplicar migración
PGPASSWORD='TriperoP@ssw0rd2024!' psql -h localhost -p 5432 -U tripero_user -d tripero \
  -f migrations/003-add-quality-metrics.sql

# Verificar que las columnas se crearon
PGPASSWORD='TriperoP@ssw0rd2024!' psql -h localhost -p 5432 -U tripero_user -d tripero \
  -c "\d trips"
```

**Columnas nuevas esperadas:**
- `distance_original` (float8, nullable)
- `distance_linear` (float8, nullable)
- `route_linear_ratio` (float8, nullable)
- `operation_area_diameter` (float8, nullable)
- `quality_flag` (varchar(50), nullable)
- `quality_metadata` (jsonb, nullable)

**Vistas nuevas esperadas:**
- `trips_quality_analysis` - Análisis agregado por dispositivo/fecha
- `trips_with_high_corrections` - Trips con correcciones >10%

### 2. Desplegar Nueva Versión

```bash
# Desde directorio tripero/
docker build -t tripero:quality-improvements .

# Si estás en desarrollo local
npm run start:dev

# Si estás en Kubernetes
kubectl set image deployment/tripero-test-deployment \
  tripero=tripero:quality-improvements

# Verificar que el pod está corriendo
kubectl get pods -l app=tripero

# Ver logs para confirmar que inició correctamente
kubectl logs -f deployment/tripero-test-deployment
```

**Logs esperados al iniciar:**
```
[TripPersistenceService] Suscrito a eventos: trip:started, trip:completed
[DistanceValidatorService] Initialized with thresholds...
[TripQualityAnalyzerService] Initialized...
```

### 3. Monitorear Trips en Tiempo Real

```bash
# Ver trips detectados con métricas de calidad
PGPASSWORD='TriperoP@ssw0rd2024!' psql -h localhost -p 5432 -U tripero_user -d tripero \
  -c "SELECT
    id,
    id_activo,
    distance,
    distance_original,
    distance_linear,
    route_linear_ratio,
    operation_area_diameter,
    quality_flag,
    start_time
FROM trips
WHERE start_time > NOW() - INTERVAL '1 hour'
ORDER BY start_time DESC
LIMIT 10;"
```

### 4. Analizar Trips con Correcciones

```bash
# Ver trips que fueron ajustados (corrección > 10%)
PGPASSWORD='TriperoP@ssw0rd2024!' psql -h localhost -p 5432 -U tripero_user -d tripero \
  -c "SELECT * FROM trips_with_high_corrections LIMIT 10;"

# Ver resumen de calidad por dispositivo
PGPASSWORD='TriperoP@ssw0rd2024!' psql -h localhost -p 5432 -U tripero_user -d tripero \
  -c "SELECT * FROM trips_quality_analysis WHERE date = CURRENT_DATE ORDER BY total_correction DESC LIMIT 10;"
```

### 5. Verificar Logs de Correcciones

```bash
# Ver logs de segmentos ajustados
kubectl logs -f deployment/tripero-test-deployment | grep "Excessive ratio detected"

# Ver logs de trips ajustados al finalizar
kubectl logs -f deployment/tripero-test-deployment | grep "Trip.*adjusted:"
```

**Ejemplo de log esperado:**
```
[DistanceValidatorService] Excessive ratio detected: 8.45
  (trip: 12.50km, linear: 1.48km).
  Applying correction: 150.00m → 105.00m

[TripPersistenceService] Trip abc-123 adjusted:
  original=13990m, adjusted=6995m,
  area=80m, ratio=181.29, correction_factor=0.50
```

---

## 🔍 Casos de Prueba Específicos

### Caso 1: Vehículo de Reparto en Área Pequeña

**Escenario:** Vehículo AB-1019 hace repartos en área de 200m durante 1 hora

**Esperado:**
- Ratio ruta/lineal: Debería bajar de 180x a <5x
- quality_flag: `adjusted_small_area`
- operation_area_diameter: ~200m
- distance_original: ~14,000m
- distance (ajustada): ~3,000-5,000m

**Query para verificar:**
```sql
SELECT
  id,
  id_activo,
  ROUND(distance) as distance_adjusted,
  ROUND(distance_original) as distance_original,
  ROUND(distance_linear) as distance_linear,
  ROUND(route_linear_ratio, 2) as ratio,
  ROUND(operation_area_diameter) as area_diameter,
  quality_flag,
  quality_metadata->'correctionApplied' as was_corrected
FROM trips
WHERE id_activo = 'AB-1019'
  AND start_time > NOW() - INTERVAL '24 hours'
ORDER BY start_time DESC;
```

### Caso 2: Viaje Normal en Autopista

**Escenario:** Vehículo hace 50km en autopista

**Esperado:**
- Ratio ruta/lineal: ~1.1-1.3x (normal para autopista)
- quality_flag: `valid`
- distance_original: ≈ distance (sin corrección)
- operation_area_diameter: >10,000m

### Caso 3: Ruido GPS Durante Parada

**Escenario:** Vehículo detenido con GPS oscilando

**Esperado:**
- Segmentos <5m con velocidad 0 → descartados
- No acumulan en tripDistance
- Anomalías registradas en tripQualityMetrics

---

## 📊 Métricas de Éxito

### KPIs a Monitorear

| Métrica | Baseline (Antes) | Target (Después) | Query |
|---------|------------------|------------------|-------|
| Ratio ruta/lineal promedio en áreas pequeñas | 100-300x | <5x | `SELECT AVG(route_linear_ratio) FROM trips WHERE operation_area_diameter < 500 AND start_time > NOW() - INTERVAL '7 days'` |
| % de trips con corrección aplicada | 0% | 10-20% | `SELECT COUNT(*) FILTER (WHERE quality_flag LIKE 'adjusted%') * 100.0 / COUNT(*) FROM trips WHERE start_time > NOW() - INTERVAL '7 days'` |
| % de trips con ratio >5x | 30-40% | <5% | `SELECT COUNT(*) FILTER (WHERE route_linear_ratio > 5) * 100.0 / COUNT(*) FROM trips WHERE start_time > NOW() - INTERVAL '7 days'` |

### Dashboard de Monitoreo

```sql
-- Resumen diario de calidad
SELECT
  DATE(start_time) as date,
  COUNT(*) as total_trips,
  COUNT(*) FILTER (WHERE quality_flag = 'valid') as valid_trips,
  COUNT(*) FILTER (WHERE quality_flag LIKE 'adjusted%') as adjusted_trips,
  AVG(route_linear_ratio) as avg_ratio,
  AVG(CASE WHEN distance_original IS NOT NULL
      THEN (distance_original - distance) / NULLIF(distance_original, 0) * 100
      ELSE 0 END) as avg_correction_pct
FROM trips
WHERE start_time > NOW() - INTERVAL '7 days'
GROUP BY DATE(start_time)
ORDER BY date DESC;
```

---

## 🐛 Troubleshooting

### Problema: Trips no tienen métricas de calidad

**Síntomas:**
- Columnas `distance_original`, `quality_flag` son NULL

**Diagnóstico:**
```bash
# Verificar que TripQualityAnalyzerService está inyectado
kubectl logs deployment/tripero-test-deployment | grep TripQualityAnalyzer

# Verificar logs de errores al completar trips
kubectl logs deployment/tripero-test-deployment | grep "Error completando trip"
```

**Solución:**
- Verificar que la migración se aplicó correctamente
- Reiniciar el pod: `kubectl delete pod -l app=tripero`

### Problema: Correcciones demasiado agresivas

**Síntomas:**
- Distancia ajustada muy inferior a la real
- Viajes normales siendo ajustados

**Diagnóstico:**
```sql
-- Ver trips con corrección >50%
SELECT * FROM trips
WHERE distance_original IS NOT NULL
  AND (distance_original - distance) / NULLIF(distance_original, 0) > 0.5
ORDER BY start_time DESC LIMIT 10;
```

**Solución:**
- Ajustar umbrales en `DistanceValidatorService.THRESHOLDS`
- Ajustar `RATIO_CORRECTION_FACTOR` (actualmente 0.7)

### Problema: Correcciones no se aplican

**Síntomas:**
- Trips con ratio alto pero sin corrección

**Diagnóstico:**
```sql
-- Ver trips con ratio alto pero flag = 'valid'
SELECT * FROM trips
WHERE route_linear_ratio > 5
  AND quality_flag = 'valid'
ORDER BY start_time DESC LIMIT 10;
```

**Solución:**
- Verificar lógica en `trip-persistence.service.ts:241-256`
- Verificar logs para ver si se detectó pero no se aplicó

---

## 📈 Análisis Post-Implementación

### Después de 7 días de testing

```sql
-- Comparación antes/después por dispositivo
SELECT
  id_activo,
  COUNT(*) as trips,
  AVG(CASE WHEN quality_flag = 'valid' THEN distance ELSE NULL END) as avg_valid_distance,
  AVG(CASE WHEN quality_flag LIKE 'adjusted%' THEN distance ELSE NULL END) as avg_adjusted_distance,
  AVG(route_linear_ratio) as avg_ratio,
  SUM(CASE WHEN quality_metadata->>'correctionApplied' = 'true' THEN 1 ELSE 0 END) as corrected_trips
FROM trips
WHERE start_time > NOW() - INTERVAL '7 days'
GROUP BY id_activo
ORDER BY corrected_trips DESC;
```

### Exportar para análisis externo

```bash
# Exportar trips con métricas de calidad
PGPASSWORD='TriperoP@ssw0rd2024!' psql -h localhost -p 5432 -U tripero_user -d tripero \
  -c "COPY (
    SELECT * FROM trips
    WHERE start_time > NOW() - INTERVAL '7 days'
  ) TO STDOUT CSV HEADER" > trips_quality_export.csv
```

---

## ✅ Checklist de Validación

Antes de mergear a `main`:

- [ ] Migración aplicada sin errores
- [ ] Pods reiniciados y logs sin errores
- [ ] Trips nuevos tienen métricas de calidad
- [ ] Correcciones se aplican en casos problemáticos (áreas pequeñas)
- [ ] Trips normales NO son corregidos incorrectamente
- [ ] Ratios ruta/lineal bajaron de >100x a <5x en casos problemáticos
- [ ] Vistas SQL funcionan correctamente
- [ ] Dashboard de calidad muestra datos coherentes
- [ ] Logs de correcciones son informativos y útiles
- [ ] Performance no degradó (< 10ms adicional por posición)

---

## 📞 Soporte

Si encuentras problemas:

1. Revisar logs: `kubectl logs -f deployment/tripero-test-deployment`
2. Verificar queries SQL de este documento
3. Comparar con PLAN-MEJORAS-ODOMETRO-TRIPERO.md
4. Reportar en issue con logs + queries

---

**Última actualización:** 2025-11-25
**Autor:** Claude Code
