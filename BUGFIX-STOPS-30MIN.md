# Bugfix: Stops cortados artificialmente a los 30 minutos

## 📋 Problema Identificado

Al analizar la base de datos de producción, se detectó que **6,582 stops (5.05% del total)** tenían una duración exacta de 1800 segundos (30 minutos), con un pico anormal en comparación con duraciones cercanas:

```
Duración    | Cantidad
------------|----------
29 minutos  |      341
30 minutos  |    7,243  ← ¡Pico anormal!
31 minutos  |      304
```

### Causa Raíz

El problema estaba en `state-machine.service.ts` (líneas 581-620):

```typescript
// IDLE prolongado: cerrar trip después de maxIdleDuration (1800 segundos)
if (idleDuration >= this.thresholds.maxIdleDuration) {
  actions.endTrip = true;  // ✅ Correcto
  
  // ❌ PROBLEMA: Forzaba cierre del stop
  if (updatedState.currentStopId) {
    actions.endStop = true;
  }
}
```

**Comportamiento incorrecto:**
1. Vehículo pasa a IDLE (motor encendido, sin movimiento) → Stop inicia
2. A los 30 minutos se detecta `idleDuration >= maxIdleDuration`
3. Se cierra el stop con `endTime = timestamp_actual`
4. **Duración = exactamente 1800 segundos** (artificial, no real)

### Stops afectados

- **98.7%** de los stops cortados eran de tipo `parking`
- **6.54%** de todos los stops tipo "parking" fueron afectados
- Solo **5.97%** de stops superaban los 30 minutos antes del fix

## ✅ Solución Implementada

### Cambio 1: Eliminar cierre forzoso de stops por timeout

**Archivo:** `src/detection/services/state-machine.service.ts`

Se eliminó la línea que forzaba el cierre del stop cuando se excedía `maxIdleDuration`:

```typescript
// ANTES
if (idleDuration >= this.thresholds.maxIdleDuration) {
  actions.endTrip = true;
  if (updatedState.currentStopId) {
    actions.endStop = true;  // ❌ Eliminado
  }
}

// DESPUÉS
if (idleDuration >= this.thresholds.maxIdleDuration) {
  actions.endTrip = true;
  // Stop se cierra NATURALMENTE cuando:
  // 1. El vehículo vuelva a moverse (IDLE → MOVING)
  // 2. La ignición se apague (IDLE → STOPPED)
  // 3. El orphan cleanup lo cierre si queda huérfano
}
```

**Razonamiento:**
- Un stop debe cerrarse cuando el vehículo **cambia de estado**, no por un timeout arbitrario
- Los trips se cierran a los 30 min (correcto), pero los stops continúan hasta el próximo cambio de estado
- El orphan cleanup maneja stops huérfanos genuinos

### Cambio 2: Agregar metadata de closureType

**Archivos modificados:**
- `src/detection/services/position-processor.service.ts`
- `src/detection/services/orphan-trip-cleanup.service.ts`

Se agregó el campo `closureType` a la metadata de eventos para debugging:

```typescript
// Stops/Trips cerrados naturalmente
metadata: {
  ...existingMetadata,
  closureType: 'natural'
}

// Stops/Trips cerrados por orphan cleanup
metadata: {
  ...existingMetadata,
  closureType: 'timeout_cleanup',
  retrospectiveEnd: true,
  originalUpdatedAt: '...',
  cleanupTimestamp: '...'
}
```

**Beneficios:**
- Visibilidad de qué stops/trips fueron cerrados por timeout vs. cambio de estado
- Facilita debugging y análisis de calidad de datos
- Permite identificar trackers con comportamiento anormal

## 📊 Impacto Esperado

### Antes del fix:
- 6,582 stops (5.05%) con duración exacta de 1800 segundos
- Stops tipo "parking" cortados artificialmente
- Datos inconsistentes con la realidad del vehículo

### Después del fix:
- ✅ Stops se cierran con duraciones reales (cuando el vehículo cambia de estado)
- ✅ Solo stops huérfanos genuinos son cerrados por cleanup
- ✅ Mejor visibilidad con campo `closureType` para análisis
- ✅ Datos más precisos para reportes y análisis de comportamiento

### Stops que superarán 30 minutos correctamente:
- Vehículos estacionados con motor encendido por períodos largos
- Paradas en obras de construcción
- Esperas prolongadas en almacenes/depósitos
- Cualquier situación IDLE legítima > 30 minutos

## 🔍 Validación

Para validar el fix en producción, ejecutar esta query después del deployment:

```sql
-- Contar stops de exactamente 30 minutos después del fix
SELECT 
  COUNT(*) as stops_1800s,
  MIN(start_time) as primera_fecha
FROM stops
WHERE duration = 1800
  AND start_time > '2026-01-28 13:00:00'  -- Después del deployment
  AND metadata->>'closureType' = 'natural';
```

Se espera que el número disminuya significativamente.

## 📝 Archivos Modificados

1. **src/detection/services/state-machine.service.ts** (+9, -6 lines)
   - Eliminado cierre forzoso de stops por timeout de IDLE
   
2. **src/detection/services/position-processor.service.ts** (+10, -2 lines)
   - Agregado `closureType: 'natural'` a stops/trips cerrados normalmente
   
3. **src/detection/services/orphan-trip-cleanup.service.ts** (+5, -0 lines)
   - Agregado `closureType: 'timeout_cleanup'` y `retrospectiveEnd: true`

**Total:** 3 archivos, 18 inserciones (+), 6 eliminaciones (-)

## ⚠️ Consideraciones

### Stops de larga duración

Con este fix, es posible que aparezcan stops con duraciones muy largas (horas o días) si:
- Un tracker queda reportando en IDLE indefinidamente (bug del tracker)
- Un vehículo realmente está con motor encendido por mucho tiempo

Estos casos serán manejados por el orphan cleanup después de `orphanTripTimeout` (actualmente 30 min, pero es configurable).

### Configuración recomendada

Si se observan demasiados stops huérfanos, considerar aumentar `orphanTripTimeout`:

```env
# En .env
ORPHAN_TRIP_TIMEOUT=7200  # 2 horas en lugar de 30 minutos
```

## 🚀 Deployment

1. Hacer merge de los cambios a la rama principal
2. Desplegar en staging para validación
3. Monitorear logs para verificar comportamiento correcto
4. Desplegar en producción
5. Ejecutar query de validación después de 24 horas

---

**Fecha:** 2026-01-28  
**Autor:** GitHub Copilot CLI  
**Issue:** Stops cortados artificialmente a los 30 minutos  
**Impacto:** ~5% de stops, principalmente tipo "parking"
