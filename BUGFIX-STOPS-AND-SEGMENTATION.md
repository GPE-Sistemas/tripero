# Fix: Stops sin finalizar y sobre-segmentación de trips

**Fecha:** 2025-11-17
**Versión:** v0.4.0

---

## Problemas Corregidos

### 1. ❌ Bug Crítico: Stops nunca se finalizaban

**Síntoma:**
- Todos los stops quedaban en estado `is_active = true` indefinidamente
- Esto causaba acumulación de stops activos en la base de datos
- Los stops completados nunca se publicaban correctamente

**Causa Raíz:**
En `state-machine.service.ts`, cuando se marcaba `actions.endStop = true`, el código limpiaba inmediatamente el `currentStopId`:

```typescript
// ANTIGUO - INCORRECTO
if (actions.endStop && updatedState.currentStopId) {
  // Limpiar estado de stop  ← PROBLEMA
  updatedState.currentStopId = undefined;
  updatedState.stopStartTime = undefined;
  // ...
}
```

Luego en `position-processor.service.ts`, al intentar publicar el evento:

```typescript
// currentStopId ya era undefined!
if (actions.endStop && updatedState.currentStopId) {
  // ❌ Este código nunca se ejecutaba
  await this.eventPublisher.publishStopCompleted(event);
}
```

**Solución:**
La state-machine NO debe limpiar los datos del stop. El `position-processor` los necesita para publicar el evento y los limpia después.

```typescript
// NUEVO - CORRECTO
if (actions.endStop && updatedState.currentStopId) {
  // Incrementar contador de stops
  if (updatedState.currentTripId) {
    updatedState.tripStopsCount = (updatedState.tripStopsCount || 0) + 1;
  }

  // ✅ NO limpiar datos aquí - position-processor lo hará después de publicar evento
}
```

---

### 2. ❌ Sobre-segmentación de Trips

**Síntoma:**
- Tripero creaba un nuevo trip cada vez que el vehículo se detenía y volvía a arrancar
- Ejemplo: Un colectivo con 20 paradas de 30 segundos → 20 trips separados
- Traccar correctamente los mantenía como 1 solo trip

**Causa Raíz:**
Tripero creaba un nuevo trip en TODA transición STOPPED → MOVING, sin considerar la duración de la parada.

**Comparación con Traccar:**
- **Traccar:** Solo segmenta trips si la parada dura >= 5 minutos (`minimalParkingDuration = 300s`)
- **Tripero (antiguo):** Segmentaba en TODA parada (sin umbral de tiempo)

**Solución:**
Implementar umbral de tiempo mínimo de parada (`minStopDuration = 300s` / 5 minutos):

```typescript
// Calcular duración del stop actual
const stopDuration = updatedState.currentStopId && updatedState.stopStartTime
  ? (updatedState.lastTimestamp - updatedState.stopStartTime) / 1000
  : 0;

// Solo crear nuevo trip si el stop duró >= 5 minutos
const shouldStartNewTrip =
  !updatedState.currentTripId ||  // Primer trip
  stopDuration >= this.thresholds.minStopDuration;  // Stop largo (>= 5 min)

if (shouldStartNewTrip) {
  // Finalizar trip anterior y crear nuevo
  actions.endTrip = true;
  actions.startTrip = true;
} else {
  // Stop corto - continuar el trip actual (no segmentar)
  // El stop se finaliza, pero el trip continúa
}
```

---

### 3. 🔄 Cambio en Lógica MOVING → STOPPED

**Antes:**
Cuando el vehículo se detenía, se finalizaba el trip inmediatamente:

```typescript
// ANTIGUO
if (previousState === MotionState.MOVING && newState === MotionState.STOPPED) {
  actions.endTrip = true;  // ❌ Cerraba el trip en cada parada
  actions.startStop = true;
}
```

**Ahora:**
El trip continúa abierto hasta que se determine si el stop es suficientemente largo:

```typescript
// NUEVO
if (previousState === MotionState.MOVING && newState === MotionState.STOPPED) {
  actions.startStop = true;  // ✅ Solo inicia stop, trip continúa
  // El trip se cerrará cuando se reanude el movimiento SI stop >= 5 min
}
```

---

## Comportamiento Nuevo vs Antiguo

### Caso: Colectivo Urbano con 20 paradas de 30 segundos

**Antes (sobre-segmentación):**
```
Trip #1: Terminal → Parada 1 (30s) → Cierra trip
Trip #2: Parada 1 → Parada 2 (30s) → Cierra trip
Trip #3: Parada 2 → Parada 3 (30s) → Cierra trip
...
Trip #20: Parada 19 → Parada 20 → Terminal
```
Resultado: **20 trips** (sobre-segmentado)

**Ahora (correcto):**
```
Trip #1:
  - Terminal → Parada 1 (stop 30s)
  → Parada 2 (stop 30s)
  → Parada 3 (stop 30s)
  → ...
  → Parada 20 (stop 30s)
  → Terminal (stop 15 min) → Cierra trip (stop >= 5min)

Trip #2: Terminal → ...
```
Resultado: **1 trip** con 20 stops internos (correcto)

---

## Configuración de Umbrales

```typescript
export const DEFAULT_THRESHOLDS: IDetectionThresholds = {
  minMovingSpeed: 5,         // km/h - velocidad mínima para considerar "movimiento"
  minTripDistance: 100,      // metros - distancia mínima para guardar un trip
  minTripDuration: 60,       // segundos (1 min) - duración mínima para guardar un trip
  minStopDuration: 300,      // segundos (5 min) - duración mínima para SEGMENTAR trips ⭐ NUEVO
  maxGapDuration: 600,       // segundos (10 min) - gap máximo antes de cerrar trip automáticamente
  positionBufferSize: 300,   // posiciones - buffer para cálculos de promedios
};
```

**Nota:** `minStopDuration = 300s` es igual al `minimalParkingDuration` de Traccar.

---

## Archivos Modificados

1. **`tripero/src/detection/services/state-machine.service.ts`**
   - Línea 112-126: Fix de limpieza de stop data
   - Línea 357-419: Implementación de umbral de tiempo mínimo de parada
   - Línea 421-430: Cambio en lógica MOVING → STOPPED

2. **`tripero/src/detection/models/motion-state.model.ts`**
   - Línea 120: Cambio de `minStopDuration` de 180s (3 min) a 300s (5 min)

---

## Testing

### Verificar que los Stops se Finalizan

```sql
-- Antes del fix: Todos los stops activos
SELECT COUNT(*) FROM stops WHERE is_active = true;
-- Resultado esperado antes: 100+

-- Después del fix: Solo stops verdaderamente activos
SELECT COUNT(*) FROM stops WHERE is_active = true;
-- Resultado esperado: 0-5 (solo los que están ocurriendo ahora)
```

### Verificar Reducción de Trips

```sql
-- Comparar trips antes y después para mismo período
SELECT
  id_activo,
  COUNT(*) as trip_count,
  SUM(distance) as total_distance
FROM trips
WHERE start_time >= '2025-11-17 00:00:00'
GROUP BY id_activo;

-- Esperado: Menos trips, pero similar distancia total
```

---

## Casos de Uso

### ✅ Colectivo Urbano
- Múltiples paradas cortas (30seg - 2min)
- Antes: 50-100 trips por día
- Ahora: 5-10 trips por día (uno por recorrido completo)

### ✅ Delivery / Reparto
- Múltiples entregas cortas (2-5 min)
- Antes: Un trip por entrega (20-30 trips/día)
- Ahora: Trips agrupados por ronda de entregas (3-5 trips/día)

### ✅ Vehículo Particular
- Paradas en semáforos, tráfico (<5 min): NO segmentan trip
- Paradas en destinos (>5 min): SÍ segmentan trip
- Comportamiento esperado y natural

---

## Próximos Pasos

1. ✅ Desplegar en ambiente de test
2. ⏳ Monitorear por 48 horas
3. ⏳ Comparar métricas con Traccar (debería haber paridad ahora)
4. ⏳ Si funciona bien, desplegar a producción
5. ⏳ Deprecar Traccar

---

## Rollback

Si es necesario revertir:

```bash
# Revertir a versión anterior
git revert <commit-hash>

# O cambiar umbral temporalmente a 0 (comportamiento antiguo)
kubectl set env deployment/tripero-test-deployment MIN_STOP_DURATION=0
```

---

**Autor:** Claude Code
**Revisado por:** [Pendiente]
**Aprobado por:** [Pendiente]
