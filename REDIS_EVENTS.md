# Tripero - Redis PubSub Events API

**Version:** v0.3.0
**Last Updated:** 2025-11-17

Este documento describe la interfaz de comunicación basada en **Redis PubSub** que Tripero utiliza para publicar eventos en tiempo real sobre el estado de los trackers, trips y stops.

## Tabla de Contenidos

- [Descripción General](#descripción-general)
- [Configuración de Redis](#configuración-de-redis)
- [Eventos Publicados](#eventos-publicados)
  - [tracker:state:changed](#trackerstate changed)
  - [trip:started](#tripstarted)
  - [trip:completed](#tripcompleted)
  - [stop:started](#stopstarted)
  - [stop:completed](#stopcompleted)
- [Evento de Entrada](#evento-de-entrada)
  - [position:new](#positionnew)
- [Patrones de Integración](#patrones-de-integración)
- [Consideraciones de Diseño](#consideraciones-de-diseño)

---

## Descripción General

Tripero utiliza **Redis PubSub** como mecanismo de comunicación asíncrona para publicar eventos en tiempo real. Esto permite a sistemas consumidores (como IRIX) recibir actualizaciones sin necesidad de polling constante a la API REST.

**Ventajas:**
- ✅ **Real-time**: Eventos publicados instantáneamente al ocurrir
- ✅ **Desacoplamiento**: Consumidores independientes de Tripero
- ✅ **Escalabilidad**: Multiple consumers pueden suscribirse al mismo canal
- ✅ **Performance**: Elimina polling innecesario
- ✅ **Fire-and-forget**: No bloquea el procesamiento principal

**Limitaciones:**
- ⚠️ No hay persistencia (eventos no almacenados)
- ⚠️ No hay replay (si un consumer está offline, pierde eventos)
- ⚠️ No hay garantía de entrega (at-most-once semantics)

> **Nota:** Si se requiere persistencia o replay, considerar migrar a **Redis Streams** en el futuro.

---

## Configuración de Redis

**Variables de entorno:**
```bash
REDIS_HOST=redis-tripero-service  # Host de Redis
REDIS_PORT=6379                   # Puerto de Redis
REDIS_DB=0                        # Base de datos Redis
# REDIS_PASSWORD=                 # Password (opcional)
```

**Conexión en Node.js:**
```typescript
import { createClient } from 'redis';

const client = createClient({
  socket: {
    host: process.env.REDIS_HOST,
    port: parseInt(process.env.REDIS_PORT),
  },
  database: parseInt(process.env.REDIS_DB),
});

await client.connect();
```

---

## Eventos Publicados

Todos los eventos se publican en formato **JSON** en canales específicos de Redis PubSub.

### `tracker:state:changed`

**Canal:** `tracker:state:changed`

**Descripción:** Publicado cuando un tracker cambia su estado de movimiento.

**Cuándo se publica:**
- Transición `STOPPED` → `IDLE`
- Transición `IDLE` → `MOVING`
- Transición `MOVING` → `IDLE`
- Transición `IDLE` → `STOPPED`

**Payload:**
```typescript
{
  "trackerId": string,           // ID del tracker/dispositivo
  "previousState": "STOPPED" | "IDLE" | "MOVING",
  "newState": "STOPPED" | "IDLE" | "MOVING",
  "timestamp": string,           // ISO 8601 format
  "reason": string,              // Razón del cambio (ej: "threshold_reached", "ignition_on")
  "location": {
    "type": "Point",
    "coordinates": [number, number]  // [lon, lat]
  },
  "speed": number,               // Velocidad actual en km/h
  "odometer": number             // Odómetro total en metros (incluye offset)
}
```

**Ejemplo:**
```json
{
  "trackerId": "1334",
  "previousState": "IDLE",
  "newState": "MOVING",
  "timestamp": "2025-11-17T14:23:45.123Z",
  "reason": "threshold_reached",
  "location": {
    "type": "Point",
    "coordinates": [-58.381592, -34.603722]
  },
  "speed": 35,
  "odometer": 125450000
}
```

**Razones comunes:**
- `threshold_reached` - Velocidad superó/bajó del umbral
- `ignition_on` - Ignición encendida
- `ignition_off` - Ignición apagada
- `timeout` - Timeout de inactividad

---

### `trip:started`

**Canal:** `trip:started`

**Descripción:** Publicado cuando un tracker inicia un nuevo trip (viaje).

**Cuándo se publica:**
- Ignición ON y velocidad > umbral
- Movimiento detectado por velocidad (sin ignición)

**Payload:**
```typescript
{
  "tripId": string,              // ID único del trip
  "deviceId": string,            // ID del dispositivo
  "startTime": string,           // ISO 8601 format
  "startLocation": {
    "type": "Point",
    "coordinates": [number, number]  // [lon, lat]
  },
  "detectionMethod": "ignition" | "motion",
  "currentState": "MOVING",      // Siempre MOVING al iniciar
  "odometer": number,            // Odómetro en metros
  "metadata"?: {                 // Metadata personalizado (opcional)
    [key: string]: any
  }
}
```

**Ejemplo sin metadata:**
```json
{
  "tripId": "trip_1334_1700234625123_abc123",
  "deviceId": "1334",
  "startTime": "2025-11-17T14:23:45.123Z",
  "startLocation": {
    "type": "Point",
    "coordinates": [-58.381592, -34.603722]
  },
  "detectionMethod": "ignition",
  "currentState": "MOVING",
  "odometer": 125450000
}
```

**Ejemplo con metadata:**
```json
{
  "tripId": "trip_1334_1700234625123_abc123",
  "deviceId": "1334",
  "startTime": "2025-11-17T14:23:45.123Z",
  "startLocation": {
    "type": "Point",
    "coordinates": [-58.381592, -34.603722]
  },
  "detectionMethod": "ignition",
  "currentState": "MOVING",
  "odometer": 125450000,
  "metadata": {
    "tenant_id": "tenant-123",
    "client_id": "client-456",
    "fleet_id": "fleet-789"
  }
}
```

---

### `trip:completed`

**Canal:** `trip:completed`

**Descripción:** Publicado cuando un trip finaliza.

**Cuándo se publica:**
- Ignición OFF
- Velocidad < umbral durante tiempo configurado
- Nuevo trip inicia (auto-close del anterior)

**Payload:**
```typescript
{
  "tripId": string,
  "deviceId": string,
  "startTime": string,           // ISO 8601
  "endTime": string,             // ISO 8601
  "duration": number,            // Duración en segundos
  "distance": number,            // Distancia en metros
  "avgSpeed": number,            // Velocidad promedio en km/h
  "maxSpeed": number,            // Velocidad máxima en km/h
  "stopsCount": number,          // Número de stops durante el trip
  "startLocation": {
    "type": "Point",
    "coordinates": [number, number]
  },
  "endLocation": {
    "type": "Point",
    "coordinates": [number, number]
  },
  "detectionMethod": "ignition" | "motion",
  "currentState": "STOPPED" | "IDLE",  // Estado al finalizar
  "odometer": number             // Odómetro final en metros
}
```

**Ejemplo:**
```json
{
  "tripId": "trip_1334_1700234625123_abc123",
  "deviceId": "1334",
  "startTime": "2025-11-17T14:23:45.123Z",
  "endTime": "2025-11-17T15:45:12.456Z",
  "duration": 4887,
  "distance": 45230,
  "avgSpeed": 33,
  "maxSpeed": 68,
  "stopsCount": 3,
  "startLocation": {
    "type": "Point",
    "coordinates": [-58.381592, -34.603722]
  },
  "endLocation": {
    "type": "Point",
    "coordinates": [-58.445123, -34.587654]
  },
  "detectionMethod": "ignition",
  "currentState": "STOPPED",
  "odometer": 125495230
}
```

---

### `stop:started`

**Canal:** `stop:started`

**Descripción:** Publicado cuando el tracker inicia una parada durante un trip.

**Cuándo se publica:**
- Durante un trip activo
- Velocidad cae a 0 o casi 0
- Permanece sin movimiento durante tiempo configurado

**Payload:**
```typescript
{
  "stopId": string,              // ID único del stop
  "tripId": string,              // ID del trip al que pertenece
  "deviceId": string,
  "startTime": string,           // ISO 8601
  "location": {
    "type": "Point",
    "coordinates": [number, number]
  },
  "reason": "ignition_off" | "no_movement" | "parking",
  "currentState": "IDLE",        // Siempre IDLE al iniciar stop
  "odometer": number             // Odómetro en metros
}
```

**Ejemplo:**
```json
{
  "stopId": "stop_1334_1700236500000_xyz789",
  "tripId": "trip_1334_1700234625123_abc123",
  "deviceId": "1334",
  "startTime": "2025-11-17T14:55:00.000Z",
  "location": {
    "type": "Point",
    "coordinates": [-58.420456, -34.595123]
  },
  "reason": "no_movement",
  "currentState": "IDLE",
  "odometer": 125470000
}
```

---

### `stop:completed`

**Canal:** `stop:completed`

**Descripción:** Publicado cuando finaliza una parada y el tracker retoma movimiento.

**Cuándo se publica:**
- El tracker retoma movimiento (velocidad > umbral)
- El trip finaliza con un stop activo

**Payload:**
```typescript
{
  "stopId": string,
  "tripId": string,
  "deviceId": string,
  "startTime": string,           // ISO 8601
  "endTime": string,             // ISO 8601
  "duration": number,            // Duración en segundos
  "location": {
    "type": "Point",
    "coordinates": [number, number]
  },
  "reason": "ignition_off" | "no_movement" | "parking",
  "currentState": "MOVING" | "STOPPED",  // Estado al finalizar
  "odometer": number             // Odómetro en metros
}
```

**Ejemplo:**
```json
{
  "stopId": "stop_1334_1700236500000_xyz789",
  "tripId": "trip_1334_1700234625123_abc123",
  "deviceId": "1334",
  "startTime": "2025-11-17T14:55:00.000Z",
  "endTime": "2025-11-17T15:05:30.000Z",
  "duration": 630,
  "location": {
    "type": "Point",
    "coordinates": [-58.420456, -34.595123]
  },
  "reason": "no_movement",
  "currentState": "MOVING",
  "odometer": 125470000
}
```

---

## Evento de Entrada

### `position:new`

**Canal:** `position:new`

**Descripción:** Canal de **entrada** donde sistemas externos publican posiciones GPS para ser procesadas por Tripero.

**Payload:**
```typescript
{
  "deviceId": string,            // ID único del dispositivo (IMEI, UUID, etc.)
  "timestamp": number,           // Unix timestamp en milisegundos
  "latitude": number,            // Latitud (-90 a 90)
  "longitude": number,           // Longitud (-180 a 180)
  "speed": number,               // Velocidad en km/h
  "ignition"?: boolean,          // Estado de ignición (opcional)
  "altitude"?: number,           // Altitud en metros (opcional)
  "heading"?: number,            // Rumbo en grados 0-360 (opcional)
  "accuracy"?: number,           // Precisión en metros (opcional)
  "satellites"?: number,         // Número de satélites (opcional)
  "metadata"?: {                 // Metadata adicional (opcional)
    [key: string]: any
  }
}
```

**Ejemplo sin metadata:**
```json
{
  "deviceId": "1334",
  "timestamp": 1700234625123,
  "latitude": -34.603722,
  "longitude": -58.381592,
  "speed": 45,
  "ignition": true,
  "altitude": 25,
  "heading": 180,
  "accuracy": 5,
  "satellites": 12
}
```

**Ejemplo con metadata (recomendado):**
```json
{
  "deviceId": "1334",
  "timestamp": 1700234625123,
  "latitude": -34.603722,
  "longitude": -58.381592,
  "speed": 45,
  "ignition": true,
  "altitude": 25,
  "heading": 180,
  "accuracy": 5,
  "satellites": 12,
  "metadata": {
    "tenant_id": "tenant-123",
    "client_id": "client-456",
    "fleet_id": "fleet-789",
    "driver_id": "driver-001",
    "vehicle_plate": "ABC123",
    "route_number": "R42",
    "custom_field": "any value"
  }
}
```

> **💡 Campos de metadata con índices optimizados:**
>
> Los siguientes campos tienen índices B-tree dedicados para queries ultra-rápidas (~1-2ms):
> - `tenant_id` - Para multi-tenancy y aislamiento de datos por tenant
> - `client_id` - Para filtrar por cliente/empresa
> - `fleet_id` - Para gestión de flotas
>
> Puedes usar cualquier otro campo personalizado (con índice GIN genérico, ~5-10ms).
>
> El metadata se propaga automáticamente a todos los trips y stops generados.

**Validaciones:**
- `deviceId` es requerido
- `timestamp` no puede ser futuro ni más antiguo que `POSITION_MAX_AGE_HOURS` (configurable)
- `latitude` debe estar entre -90 y 90
- `longitude` debe estar entre -180 y 180
- `speed` debe ser >= 0
- `ignition` se asume `false` si no se proporciona

---

## Patrones de Integración

### Patrón 1: Suscripción Simple (Node.js)

```typescript
import { createClient } from 'redis';

const subscriber = createClient({
  socket: { host: 'redis-tripero-service', port: 6379 },
});

await subscriber.connect();

// Suscribirse a cambios de estado
await subscriber.subscribe('tracker:state:changed', (message) => {
  const event = JSON.parse(message);
  console.log(`Tracker ${event.trackerId}: ${event.previousState} → ${event.newState}`);

  // Actualizar UI, base de datos, etc.
  updateTrackerState(event.trackerId, event.newState, event.odometer);
});

// Suscribirse a trips completados
await subscriber.subscribe('trip:completed', (message) => {
  const trip = JSON.parse(message);
  console.log(`Trip ${trip.tripId} completado: ${trip.distance}m, ${trip.duration}s`);

  // Guardar en BD, enviar notificación, etc.
  saveTripToDatabase(trip);
  notifyUser(trip.deviceId, trip);
});
```

### Patrón 2: Múltiples Canales

```typescript
const channels = [
  'tracker:state:changed',
  'trip:started',
  'trip:completed',
  'stop:started',
  'stop:completed',
];

for (const channel of channels) {
  await subscriber.subscribe(channel, (message) => {
    handleEvent(channel, JSON.parse(message));
  });
}

function handleEvent(channel: string, event: any) {
  switch (channel) {
    case 'tracker:state:changed':
      handleStateChange(event);
      break;
    case 'trip:started':
      handleTripStarted(event);
      break;
    case 'trip:completed':
      handleTripCompleted(event);
      break;
    // ...
  }
}
```

### Patrón 3: Publicar Posiciones (Producer)

```typescript
const publisher = createClient({
  socket: { host: 'redis-tripero-service', port: 6379 },
});

await publisher.connect();

// Publicar posición GPS
const position = {
  deviceId: '1334',
  timestamp: Date.now(),
  latitude: -34.603722,
  longitude: -58.381592,
  speed: 45,
  ignition: true,
  heading: 180,
  accuracy: 5,
};

await publisher.publish('position:new', JSON.stringify(position));
```

---

## Consideraciones de Diseño

### Idempotencia

Los eventos **NO son idempotentes** por defecto. Cada evento tiene un ID único (`tripId`, `stopId`) que puede usarse para detectar duplicados si es necesario.

### Orden de Eventos

Redis PubSub **garantiza orden FIFO** para mensajes publicados en el mismo canal desde el mismo producer. Sin embargo, entre diferentes canales no hay garantía de orden.

**Ejemplo:**
- `trip:started` y `stop:started` pueden llegar en orden incorrecto si se publican casi simultáneamente
- Los consumers deben manejar esto basándose en timestamps

### Pérdida de Mensajes

Si un subscriber se desconecta, **perderá todos los eventos** publicados mientras estuvo offline.

**Mitigación:**
- Usar API REST de Tripero para sincronizar estado al reconectar
- Considerar Redis Streams para persistencia futura

### Performance

- Redis PubSub es **muy rápido** (<1ms de latencia típicamente)
- No hay límite teórico de subscribers
- Fire-and-forget: no afecta el procesamiento de Tripero

### Monitoreo

Para monitorear el sistema:

```bash
# Ver canales activos
redis-cli PUBSUB CHANNELS

# Ver número de subscribers por canal
redis-cli PUBSUB NUMSUB tracker:state:changed trip:started trip:completed

# Monitor en tiempo real (desarrollo)
redis-cli MONITOR | grep PUBLISH
```

---

## Metadata Personalizado

### Descripción

Tripero soporta metadata personalizado en las posiciones GPS que se propaga automáticamente a todos los trips y stops generados. Esto permite:

- **Multi-tenancy**: Aislar datos por tenant (`tenant_id`)
- **Gestión de flotas**: Organizar por flota (`fleet_id`)
- **Clientes**: Filtrar por cliente/empresa (`client_id`)
- **Tracking personalizado**: Agregar cualquier campo relevante para tu negocio

### Campos Recomendados (con índices optimizados)

Tripero tiene índices B-tree dedicados para estos campos, lo que garantiza queries ultra-rápidas (~1-2ms):

| Campo | Descripción | Caso de uso |
|-------|-------------|-------------|
| `tenant_id` | Identificador de tenant | Multi-tenancy, SaaS, aislamiento de datos |
| `client_id` | Identificador de cliente/empresa | Filtrar reportes por cliente |
| `fleet_id` | Identificador de flota | Gestión de múltiples flotas de vehículos |

**Ejemplo:**
```json
{
  "deviceId": "VEHICLE-001",
  "timestamp": 1700234625123,
  "latitude": -34.603722,
  "longitude": -58.381592,
  "speed": 45,
  "ignition": true,
  "metadata": {
    "tenant_id": "acme-corp",
    "client_id": "client-north",
    "fleet_id": "delivery-trucks"
  }
}
```

### Campos Personalizados

Puedes agregar cualquier otro campo que necesites. Estos usan un índice GIN genérico (~5-10ms):

**Ejemplos comunes:**
```json
{
  "metadata": {
    "tenant_id": "tenant-123",
    "driver_id": "driver-456",
    "driver_name": "Juan Pérez",
    "vehicle_plate": "ABC123",
    "vehicle_type": "truck",
    "route_id": "route-789",
    "delivery_id": "delivery-001",
    "priority": "high",
    "notes": "Entrega urgente"
  }
}
```

### Propagación Automática

El metadata se propaga automáticamente:

1. **Position event** → `position.metadata`
2. **Trip started** → `trip.metadata` (persiste en BD)
3. **Stop started** → `stop.metadata` (usa metadata del trip)
4. **Trip/Stop completed** → metadata se mantiene en BD

**Ejemplo de flujo:**

```
1. Publicas position con metadata:
   { deviceId: "V1", metadata: { tenant_id: "T1", fleet_id: "F1" } }

2. Trip se crea automáticamente con ese metadata

3. Stops dentro del trip heredan el metadata

4. Puedes consultar todos los trips/stops filtrados:
   GET /api/reports/trips?tenantId=T1&fleetId=F1
```

### Performance

| Tipo de query | Campo | Tiempo típico |
|---------------|-------|---------------|
| Indexado (B-tree) | `tenant_id`, `client_id`, `fleet_id` | ~1-2ms |
| Genérico (GIN) | Cualquier otro campo | ~5-10ms |
| Sin índice | N/A | ~500-2000ms ❌ |

### Consideraciones

- **Inmutable**: El metadata se guarda al crear el trip y no cambia
- **Opcional**: Puedes omitir metadata si no lo necesitas
- **Flexible**: Cualquier estructura JSON válida
- **Type-safe**: Valida con TypeScript en el código

---

## Changelog

### v0.3.0 (2025-11-17)

**✨ Nuevas funcionalidades:**
- Nuevo canal `tracker:state:changed` para cambios de estado en tiempo real
- Campos `currentState` y `odometer` agregados a todos los eventos de trip/stop
- Soporte para `odometer_offset` (odómetro sincronizado con vehículo real)
- **Metadata personalizado**: Soporte completo para metadata en positions, trips y stops
  - Campos optimizados con índices B-tree: `tenant_id`, `client_id`, `fleet_id` (~1-2ms)
  - Índices GIN para campos personalizados (~5-10ms)
  - Propagación automática de metadata a trips y stops
  - Ideal para multi-tenancy, gestión de flotas, y tracking personalizado

**📝 Cambios en eventos existentes:**
- `trip:started`: agregados `currentState` (siempre `MOVING`) y `odometer`
- `trip:completed`: agregados `currentState` y `odometer`
- `stop:started`: agregados `currentState` (siempre `IDLE`) y `odometer`
- `stop:completed`: agregados `currentState` y `odometer`

**⚙️ Breaking changes:**
- Ninguno (solo adiciones, backward compatible)

---

## Soporte

Para dudas o issues:
- GitHub: https://github.com/gpe-sistemas/tripero/issues
- Email: soporte@gpesistemas.com
