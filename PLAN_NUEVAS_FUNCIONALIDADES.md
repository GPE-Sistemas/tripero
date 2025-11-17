# Plan: Nuevas Funcionalidades Tripero

## Fecha: 2025-11-17
## Versión objetivo: v0.3.0

---

## 1. Publicación de Eventos de Estado del Tracker (Real-time State Events)

### Objetivo
Permitir a IRIX recibir actualizaciones en tiempo real sobre el estado de los trackers sin necesidad de polling, usando Redis PubSub.

### Eventos a Publicar

#### 1.1. Estado de Movimiento (`tracker:state:changed`)
**Canal Redis:** `tracker:state:changed`

**Payload:**
```typescript
{
  trackerId: string;           // ID del dispositivo
  previousState: MotionState;  // STOPPED | IDLE | MOVING
  newState: MotionState;       // STOPPED | IDLE | MOVING
  timestamp: string;           // ISO 8601
  reason: string;              // threshold_reached, ignition_on, ignition_off
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  speed: number;               // km/h
  odometer: number;            // metros totales
}
```

**Cuándo publicar:**
- Cuando ocurre transición de estado en `state-machine.service.ts`
- En cada cambio STOPPED ↔ IDLE ↔ MOVING

#### 1.2. Trip Iniciado (ya existe, extender)
**Canal Redis:** `trip:started`

**Cambios:**
- Agregar `currentState: MotionState` (siempre será MOVING)
- Agregar `odometer: number` (odómetro al inicio del trip)

#### 1.3. Trip Completado (ya existe, extender)
**Canal Redis:** `trip:completed`

**Cambios:**
- Agregar `currentState: MotionState` (puede ser STOPPED o IDLE)
- Agregar `odometer: number` (odómetro al final del trip)

#### 1.4. Stop Iniciado (ya existe, extender)
**Canal Redis:** `stop:started`

**Cambios:**
- Agregar `currentState: MotionState` (siempre será IDLE)

#### 1.5. Stop Completado (ya existe, extender)
**Canal Redis:** `stop:completed`

**Cambios:**
- Agregar `currentState: MotionState` (será MOVING si retoma movimiento)

### Implementación

#### Archivos a modificar:

1. **`src/interfaces/tracker-state-event.interface.ts`** (NUEVO)
   ```typescript
   export interface ITrackerStateChangedEvent {
     trackerId: string;
     previousState: MotionState;
     newState: MotionState;
     timestamp: string;
     reason: string;
     location: {
       type: 'Point';
       coordinates: [number, number];
     };
     speed: number;
     odometer: number;
   }
   ```

2. **`src/detection/services/event-publisher.service.ts`**
   - Agregar método: `publishTrackerStateChanged(event: ITrackerStateChangedEvent)`
   - Extender interfaces existentes de trip/stop events

3. **`src/detection/services/position-processor.service.ts`**
   - Publicar evento cuando `result.transitionOccurred === true`
   - Incluir odómetro actual del tracker

### Patrones de Uso en IRIX

```typescript
// IRIX subscribe a eventos
const redis = createClient();
await redis.subscribe('tracker:state:changed', (message) => {
  const event = JSON.parse(message);
  // Actualizar UI/estado sin polling
  updateTrackerState(event.trackerId, event.newState);
});
```

---

## 2. Seteo de Odómetro Inicial

### Objetivo
Permitir configurar el odómetro inicial de un tracker para que coincida con el odómetro real del vehículo.

### API Endpoint

#### POST `/trackers/:trackerId/odometer`

**Request:**
```json
{
  "initialOdometer": 125000,  // metros (125 km)
  "reason": "vehicle_odometer_sync"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "trackerId": "1234",
    "previousOdometer": 0,
    "newOdometer": 125000,
    "odometerOffset": 125000,
    "updatedAt": "2025-11-17T12:00:00Z"
  }
}
```

**Validaciones:**
- `initialOdometer` debe ser >= 0
- `initialOdometer` debe ser en metros
- Solo se puede setear si el tracker existe
- (Opcional) Requiere autenticación/autorización

### Modelo de Datos

#### Cambios en `tracker_state` entity:

```typescript
@Column({ type: 'float8', default: 0, name: 'odometer_offset' })
odometer_offset: number; // Offset aplicado al odómetro
```

#### Cálculo del Odómetro Real:
```typescript
odometerReal = odometer_base + odometer_offset
```

**Ejemplo:**
1. Odómetro base (calculado por GPS): 50,000m
2. Offset configurado: 125,000m
3. Odómetro real mostrado: 175,000m (175 km)

### Implementación

#### Archivos a modificar/crear:

1. **`src/database/entities/tracker-state.entity.ts`**
   - Agregar campo `odometer_offset`
   - Migración de base de datos

2. **`src/trackers/trackers.controller.ts`** (ya existe)
   - Agregar endpoint `POST /:trackerId/odometer`
   - Agregar DTO para validación

3. **`src/trackers/dto/set-odometer.dto.ts`** (NUEVO)
   ```typescript
   export class SetOdometerDto {
     @IsNumber()
     @Min(0)
     initialOdometer: number;

     @IsString()
     @IsOptional()
     reason?: string;
   }
   ```

4. **`src/trackers/trackers.service.ts`** (ya existe)
   - Agregar método: `setOdometer(trackerId: string, dto: SetOdometerDto)`
   - Calcular offset = initialOdometer - currentOdometer
   - Actualizar `odometer_offset` en tracker_state

5. **`src/detection/services/tracker-state.service.ts`**
   - Modificar getter de `odometer` para incluir offset:
     ```typescript
     get displayOdometer(): number {
       return this.odometer + this.odometer_offset;
     }
     ```

### Casos de Uso

#### Caso 1: Vehículo nuevo con odómetro real
```bash
# Vehículo tiene 50,000 km = 50,000,000 metros
POST /trackers/1234/odometer
{
  "initialOdometer": 50000000,
  "reason": "new_vehicle_registration"
}
```

#### Caso 2: Reset por cambio de dispositivo GPS
```bash
# Nuevo tracker instalado, odómetro vehículo está en 100,000 km
POST /trackers/5678/odometer
{
  "initialOdometer": 100000000,
  "reason": "device_replacement"
}
```

---

## 3. Orden de Implementación

### Fase 1: Odómetro Inicial (más simple)
1. Agregar campo `odometer_offset` a entity
2. Crear migración de BD
3. Implementar endpoint REST
4. Modificar TrackerStateService
5. Tests

**Estimación:** 4-6 horas

### Fase 2: Eventos de Estado (más complejo)
1. Crear interfaces de eventos
2. Extender EventPublisherService
3. Modificar PositionProcessor para publicar eventos
4. Extender eventos existentes (trips/stops)
5. Tests
6. Documentación

**Estimación:** 6-8 horas

---

## 4. Consideraciones de Diseño

### Redis PubSub vs Streams
- **PubSub**: Simple, real-time, sin persistencia
- **Streams**: Persistencia, replay, consumer groups

**Decisión:** Usar PubSub inicialmente por simplicidad. Si IRIX necesita replay/persistencia, migrar a Streams.

### Seguridad del Endpoint de Odómetro
Opciones:
1. Sin autenticación (solo interno en cluster)
2. API Key simple
3. Integración con sistema de auth existente (gestion-api-auth)

**Decisión:** Empezar sin auth (interno), agregar API Key después si se expone externamente.

### Performance
- Eventos PubSub son fire-and-forget, no bloquean procesamiento
- Odómetro offset se guarda en Redis (rápido) y PostgreSQL (persistente)

---

## 5. Testing

### Tests Unitarios
- `TrackerStateService.setOdometer()`
- `TrackerStateService.displayOdometer` con offset
- `EventPublisherService.publishTrackerStateChanged()`

### Tests de Integración
- POST `/trackers/:trackerId/odometer` con varios escenarios
- Verificar eventos publicados en Redis
- Verificar cálculo correcto con offset

### Tests E2E
- Escenario completo: setear odómetro → procesar posiciones → verificar eventos

---

## 6. Documentación a Actualizar

1. **README.md**
   - Sección de Eventos Redis PubSub
   - Ejemplos de suscripción
   - Formato de payloads

2. **API.md** (nuevo)
   - Documentar endpoint de odómetro
   - Ejemplos de uso
   - Códigos de error

3. **ARCHITECTURE.md**
   - Diagrama de flujo de eventos
   - Explicación de odometer_offset

---

## 7. Versión y Deployment

### Versión: v0.3.0
- Feature: Real-time tracker state events via Redis PubSub
- Feature: Set initial odometer via REST API
- Breaking changes: None (solo adiciones)

### Migración
```sql
-- Agregar campo odometer_offset
ALTER TABLE tracker_state ADD COLUMN odometer_offset DOUBLE PRECISION DEFAULT 0;
```

### Variables de Entorno (nuevas)
Ninguna requerida inicialmente.

---

## 8. Próximos Pasos

1. Revisar y aprobar este plan
2. Crear rama `feature/tracker-events-and-odometer`
3. Implementar Fase 1 (odómetro)
4. Implementar Fase 2 (eventos)
5. Testing
6. Documentación
7. PR y review
8. Deploy a test
9. Validación
10. Deploy a producción
