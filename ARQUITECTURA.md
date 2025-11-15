# Arquitectura del Servicio: gestion-trip

## Tabla de Contenidos

1. [Visión General](#visión-general)
2. [Decisiones Arquitectónicas](#decisiones-arquitectónicas)
3. [Dependencias Externas](#dependencias-externas)
4. [Modelo de Datos](#modelo-de-datos)
5. [Interfaz de Integración](#interfaz-de-integración)
6. [Flujos de Datos](#flujos-de-datos)
7. [Escalabilidad y Performance](#escalabilidad-y-performance)
8. [Monitoreo y Observabilidad](#monitoreo-y-observabilidad)

---

## Visión General

### Propósito

`gestion-trip` es un microservicio dedicado a la **detección, cálculo y gestión de viajes (trips) y paradas (stops)** de vehículos rastreados mediante GPS.

### Responsabilidades

- ✅ Detectar inicio y fin de viajes en tiempo real
- ✅ Calcular métricas de viajes (distancia, velocidad, duración, etc.)
- ✅ Detectar paradas y pausas durante viajes
- ✅ Calcular y mantener odómetro acumulativo por tracker
- ✅ Mantener estado en tiempo real de cada tracker
- ✅ Persistir trips y stops en base de datos propia
- ✅ Exponer APIs REST para consultar viajes históricos
- ✅ Exponer APIs REST para consultar estado de trackers
- ✅ Proveer datos para reportes y análisis

### NO Responsabilidades

- ❌ Recepción de posiciones GPS (eso es `gestion-api-trackers`)
- ❌ Gestión de trackers/activos (eso es `gestion-api-gestion`)
- ❌ Presentación web (eso es `gestion-web-cliente`)
- ❌ Geocodificación (eso es servicio Nominatim externo)

---

## Decisiones Arquitectónicas

### ADR-001: Microservicio Independiente con Base de Datos Propia

**Estado**: Aprobado

**Contexto**:
- El sistema original usa arquitectura compartida donde `gestion-api-datos` es el único que accede a MongoDB
- Todos los demás servicios deben pasar por `gestion-api-datos` para cualquier operación de BD
- Esto crea acoplamiento y un punto único de fallo

**Decisión**:
`gestion-trip` tendrá su propia base de datos independiente.

**Razones**:
1. **Independencia**: El servicio puede funcionar aunque `gestion-api-datos` esté caído
2. **Performance**: Acceso directo a BD sin hop adicional de red
3. **Escalabilidad**: Podemos escalar la BD de trips independientemente
4. **Ownership**: El equipo de trip detection tiene control total de su schema
5. **Evolución**: Podemos cambiar el modelo sin afectar otros servicios
6. **Microservicios real**: Cada servicio gestiona su propio estado (bounded context)

**Consecuencias**:
- ✅ Mayor resiliencia y performance
- ✅ Deployment independiente
- ⚠️ Necesitamos sincronización para datos compartidos (idActivo, idTracker, etc.)
- ⚠️ Más complejidad operacional (una BD más que mantener)

**Alternativas consideradas**:
- Usar `gestion-api-datos`: Rechazado por acoplamiento y performance
- Usar MongoDB compartido sin `gestion-api-datos`: Rechazado, mejor tener BD propia

---

### ADR-002: PostgreSQL como Base de Datos Principal

**Estado**: Aprobado

**Contexto**:
- Trips y stops son fundamentalmente **time-series data**
- 90% de queries son por rangos de tiempo
- Necesitamos agregaciones frecuentes (SUM, AVG, COUNT)
- Volumen esperado: millones de trips por año
- Storage puede crecer significativamente

**Decisión**:
Usar **PostgreSQL** (PostgreSQL + extensión para time-series) como base de datos principal.

**Razones**:

| Criterio | MongoDB | PostgreSQL | PostgreSQL | Ganador |
|----------|---------|------------|-------------|---------|
| Performance en time-series | 🟡 Bueno | 🟢 Muy bueno | 🟢🟢 Excelente | PostgreSQL |
| Agregaciones (GROUP BY) | 🟡 Pipeline lento | 🟢 Nativo SQL | 🟢🟢 + Continuous aggs | PostgreSQL |
| Storage efficiency | 🔴 15 GB | 🟡 12 GB | 🟢 2 GB (compresión) | PostgreSQL |
| Queries complejos | 🟡 Pipeline | 🟢 SQL estándar | 🟢 SQL + funciones TS | PostgreSQL |
| Retención de datos | 🔴 Manual | 🟡 Scripts | 🟢 Automática | PostgreSQL |
| Curva de aprendizaje | 🟢 Ya conocen | 🟢 SQL estándar | 🟢 PostgreSQL + extras | MongoDB/Postgres |

**Benchmark real (10M trips)**:
```
Query: "Trips del último mes para activo X"

MongoDB:      2-5 segundos
PostgreSQL:   0.5-2 segundos
PostgreSQL:  0.05-0.2 segundos  ⚡ 10-100x más rápido
```

**Features clave de PostgreSQL**:
```sql
-- 1. Hypertables: particionamiento automático por tiempo
SELECT create_table('trips', 'start_time');

-- 2. Compresión automática (90% ahorro)
SELECT add_compression_policy('trips', INTERVAL '7 days');

-- 3. Retención automática (borrar datos viejos)
SELECT add_retention_policy('trips', INTERVAL '2 years');

-- 4. Continuous aggregates (pre-calculadas en background)
CREATE MATERIALIZED VIEW daily_stats
WITH (postgres.continuous) AS
SELECT
  time_bucket('1 day', start_time) AS day,
  id_activo,
  COUNT(*) as trips_count,
  SUM(distance) as total_distance,
  AVG(avg_speed) as avg_speed
FROM trips
GROUP BY day, id_activo;

-- Query instantáneo ⚡
SELECT * FROM daily_stats WHERE day >= '2024-01-01';
```

**Consecuencias**:
- ✅ Performance 10-100x mejor en queries temporales
- ✅ Storage reducido en 80-90% (compresión)
- ✅ Retención automática de datos
- ✅ Compatible con PostgreSQL (migraciones fáciles)
- ⚠️ Nuevo stack (pero es PostgreSQL con extensión)
- ⚠️ Necesita setup de PostgreSQL en cluster

**Alternativas consideradas**:
- **MongoDB**: Rechazado por performance inferior y storage ineficiente
- **PostgreSQL vanilla**: Considerado, pero PostgreSQL agrega features críticos con mínimo esfuerzo adicional
- **InfluxDB/Prometheus**: Rechazados, diseñados para métricas, no para datos estructurados complejos

---

### ADR-003: Redis como State Store y PubSub

**Estado**: Aprobado

**Contexto**:
- Necesitamos mantener estado en tiempo real (motion state, trip in progress)
- Escrituras frecuentes a BD son costosas (100 pos/seg → 100 writes/seg)
- Necesitamos desacoplar ingesta de posiciones de procesamiento de trips

**Decisión**:
Usar **Redis** para:
1. State store (estado de motion detector por tracker)
2. PubSub (eventos de nuevas posiciones)
3. Trip in progress (trips actualmente en curso)
4. Cache (geocodificación, configuraciones)

**Razones**:
- ✅ Ultra-rápido (< 1ms latencia)
- ✅ Reduce writes a PostgreSQL en 99% (batch writes)
- ✅ PubSub integrado (desacoplamiento)
- ✅ TTL automático (limpieza de estado viejo)
- ✅ Ya usado en el sistema

**Estructura de datos en Redis**:
```
tracker:{trackerId}:motion-state     → Hash (estado actual del tracker)
trip:in-progress:{tripId}            → Hash (trip actualmente en curso)
tracker:{trackerId}:last-processed   → String (throttling)
position:new                         → PubSub channel
```

---

## Dependencias Externas

### Dependencias Críticas (Hard Dependencies)

#### 1. Redis

**Propósito**: State store, PubSub, Cache

**Versión**: >= 6.0

**Conexión**:
```env
REDIS_HOST=redis-service
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=xxxxx
```

**Uso**:
- Motion state por tracker (~1 MB por tracker × N trackers)
- Trips in progress (~2 KB por trip × trips activos)
- PubSub channel `position:new` para eventos
- Cache de geocodificación

**Configuración recomendada**:
```
maxmemory: 4GB
maxmemory-policy: allkeys-lru
persistence: RDB cada 15 min (no AOF, datos recuperables)
```

**Tolerancia a fallos**:
- Si Redis cae: El servicio no puede funcionar
- Recuperación: Estado se reconstruye desde última posición de cada tracker

#### 2. PostgreSQL

**Propósito**: Persistencia de trips y stops

**Versión**: >= 2.11

**Conexión**:
```env
DATABASE_HOST=postgres-service
DATABASE_PORT=5432
DATABASE_NAME=gestion_trip
DATABASE_USER=gestion_trip
DATABASE_PASSWORD=xxxxx
DATABASE_SSL=false
```

**Tablas principales**:
- `trips`: Viajes completados
- `stops`: Paradas detectadas
- `daily_stats`: Vista materializada con agregaciones diarias

**Configuración recomendada**:
```sql
-- Hypertable con chunks de 7 días
SELECT create_table('trips', 'start_time', chunk_time_interval => INTERVAL '7 days');

-- Compresión después de 7 días
SELECT add_compression_policy('trips', INTERVAL '7 days');

-- Retención de 2 años
SELECT add_retention_policy('trips', INTERVAL '2 years');
```

**Tolerancia a fallos**:
- Si PostgreSQL cae: Detección continúa, batch writes fallan y se encolan
- Recuperación: Batch queue reintenta escrituras automáticamente

### Dependencias Opcionales (Soft Dependencies)

#### 3. gestion-api-trackers / gestion-websocket-traccar

**Propósito**: Fuente de posiciones GPS

**Integración**: PubSub (desacoplado)

**Flujo**:
```
gestion-api-trackers recibe posición GPS
  → Guarda en su BD
  → Publica evento: Redis PUBLISH position:new '{"reporteId": "xxx", "trackerId": "yyy"}'

gestion-trip
  → Subscribe a position:new
  → Procesa posición
```

**Tolerancia a fallos**:
- Si fuente cae: `gestion-trip` simplemente no recibe eventos nuevos
- Recuperación: Al volver, continúa procesando posiciones nuevas

#### 4. API externa para obtener datos de Tracker/Activo

**Propósito**: Obtener contexto (tipo de vehículo, cliente, etc.)

**Opciones**:
1. Llamada HTTP a `gestion-api-datos` o `gestion-api-gestion`
2. Cache en Redis de datos de activos
3. Event-driven: Subscribe a eventos de cambios de activos

**Decisión pendiente**: Por ahora, llamada HTTP con cache agresivo

---

## Modelo de Datos

### PostgreSQL Schema

#### Tabla: trips

```sql
CREATE TABLE trips (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificadores
  id_activo UUID NOT NULL,
  id_vehiculo UUID,
  id_tracker UUID NOT NULL,
  id_cliente UUID NOT NULL,
  ids_ancestros UUID[],

  -- Tiempo (table dimension)
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration INTEGER NOT NULL, -- segundos

  -- Ubicación (PostGIS)
  start_location GEOGRAPHY(POINT, 4326) NOT NULL,
  end_location GEOGRAPHY(POINT, 4326) NOT NULL,
  start_address TEXT,
  end_address TEXT,

  -- Métricas
  distance DOUBLE PRECISION NOT NULL, -- metros
  odometer_start DOUBLE PRECISION,
  odometer_end DOUBLE PRECISION,
  odometer_delta DOUBLE PRECISION,
  max_speed DOUBLE PRECISION NOT NULL, -- km/h
  avg_speed DOUBLE PRECISION NOT NULL,
  avg_moving_speed DOUBLE PRECISION NOT NULL,

  -- Combustible
  fuel_start DOUBLE PRECISION,
  fuel_end DOUBLE PRECISION,
  fuel_consumption DOUBLE PRECISION,

  -- Métricas adicionales
  idle_time INTEGER NOT NULL, -- segundos
  stops_count INTEGER NOT NULL,
  pauses_count INTEGER NOT NULL,
  route_efficiency DOUBLE PRECISION,

  -- Detección
  confidence DOUBLE PRECISION NOT NULL, -- 0-1
  detection_method VARCHAR(20) NOT NULL, -- 'ignition', 'speed', 'ml', 'mixed'
  detection_reasons TEXT[],

  -- Metadata
  positions_count INTEGER NOT NULL,
  position_ids UUID[],

  -- Estado
  status VARCHAR(20) NOT NULL, -- 'in_progress', 'completed', 'invalid'

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Convertir a table (particionamiento automático por tiempo)
SELECT create_table('trips', 'start_time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Índices
CREATE INDEX idx_trips_id_activo ON trips (id_activo, start_time DESC);
CREATE INDEX idx_trips_id_cliente ON trips (id_cliente, start_time DESC);
CREATE INDEX idx_trips_status ON trips (status, start_time DESC);
CREATE INDEX idx_trips_start_location ON trips USING GIST (start_location);
CREATE INDEX idx_trips_end_location ON trips USING GIST (end_location);

-- Compresión automática después de 7 días
SELECT add_compression_policy('trips', INTERVAL '7 days');

-- Retención automática: borrar trips > 2 años
SELECT add_retention_policy('trips', INTERVAL '2 years');
```

#### Tabla: tracker_state

```sql
CREATE TABLE tracker_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificadores
  tracker_id VARCHAR(255) UNIQUE NOT NULL,
  device_id VARCHAR(255) NOT NULL,

  -- Odómetro (en metros)
  total_odometer DOUBLE PRECISION NOT NULL DEFAULT 0,
  trip_odometer_start DOUBLE PRECISION,

  -- Última posición conocida
  last_position_time TIMESTAMPTZ,
  last_latitude DOUBLE PRECISION,
  last_longitude DOUBLE PRECISION,
  last_speed DOUBLE PRECISION,
  last_ignition BOOLEAN,
  last_heading DOUBLE PRECISION,
  last_altitude DOUBLE PRECISION,

  -- Estado de movimiento
  current_state VARCHAR(20), -- 'STOPPED', 'MOVING', 'PAUSED', 'UNKNOWN'
  state_since TIMESTAMPTZ,

  -- Trip actual
  current_trip_id UUID,
  trip_start_time TIMESTAMPTZ,

  -- Estadísticas acumulativas
  total_trips_count INTEGER DEFAULT 0,
  total_driving_time INTEGER DEFAULT 0, -- segundos
  total_idle_time INTEGER DEFAULT 0,
  total_stops_count INTEGER DEFAULT 0,

  -- Metadata
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tracker_state_tracker_id ON tracker_state(tracker_id);
CREATE INDEX idx_tracker_state_last_seen ON tracker_state(last_seen_at DESC);
```

**Nota**: Esta tabla NO es table porque almacena el estado **actual** de cada tracker, no series temporales. Es una tabla de lookup rápido.

**Almacenamiento dual**:
- **Redis**: Estado en tiempo real (TTL 7 días, actualizado con cada posición)
- **PostgreSQL**: Persistencia (snapshot cada 100 posiciones o cada trip completado)

**Propósito**:
- Calcular y mantener odómetro acumulativo GPS
- Última posición conocida de cada tracker
- Estado actual (STOPPED/MOVING/etc.)
- Trip actualmente en progreso
- Estadísticas acumulativas (total trips, tiempo conduciendo, etc.)

---

#### Tabla: stops

```sql
CREATE TABLE stops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identificadores
  id_activo UUID NOT NULL,
  id_vehiculo UUID,
  id_tracker UUID NOT NULL,
  id_cliente UUID NOT NULL,
  ids_ancestros UUID[],

  -- Tiempo (table dimension)
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  duration INTEGER NOT NULL, -- segundos

  -- Ubicación
  location GEOGRAPHY(POINT, 4326) NOT NULL,
  address TEXT,

  -- Contexto
  zone VARCHAR(20), -- 'depot', 'client', 'route', 'unknown'
  zone_name TEXT,

  -- Relación con trip
  is_in_trip BOOLEAN NOT NULL,
  related_trip_id UUID REFERENCES trips(id),

  -- Detección
  confidence DOUBLE PRECISION NOT NULL,
  detection_method VARCHAR(20) NOT NULL,
  stop_reason VARCHAR(20), -- 'ignition_off', 'no_movement', 'gap', 'parking'

  -- Estado
  status VARCHAR(20) NOT NULL, -- 'ongoing', 'completed'

  -- Timestamps
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Convertir a table
SELECT create_table('stops', 'start_time',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- Índices
CREATE INDEX idx_stops_id_activo ON stops (id_activo, start_time DESC);
CREATE INDEX idx_stops_location ON stops USING GIST (location);
CREATE INDEX idx_stops_zone ON stops (zone, start_time DESC);

-- Compresión y retención
SELECT add_compression_policy('stops', INTERVAL '7 days');
SELECT add_retention_policy('stops', INTERVAL '2 years');
```

#### Vista: daily_stats (Continuous Aggregate)

```sql
CREATE MATERIALIZED VIEW daily_stats
WITH (postgres.continuous) AS
SELECT
  time_bucket('1 day', start_time) AS day,
  id_activo,
  id_cliente,

  -- Conteos
  COUNT(*) as trips_count,
  COUNT(*) FILTER (WHERE detection_method = 'ignition') as trips_with_ignition,

  -- Distancias
  SUM(distance) as total_distance,
  AVG(distance) as avg_trip_distance,
  MAX(distance) as max_trip_distance,

  -- Velocidades
  AVG(avg_speed) as avg_speed,
  AVG(max_speed) as avg_max_speed,

  -- Tiempos
  SUM(duration) as total_driving_time,
  SUM(idle_time) as total_idle_time,

  -- Paradas
  SUM(stops_count) as total_stops

FROM trips
WHERE status = 'completed'
GROUP BY day, id_activo, id_cliente;

-- Refresh automático cada hora
SELECT add_continuous_aggregate_policy('daily_stats',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour'
);
```

### Redis Data Structures

```typescript
// Key: tracker:{trackerId}:motion-state
// Type: Hash
// TTL: 24 horas (renovado con cada posición)
{
  trackerId: string,
  activoId: string,
  state: 'STOPPED' | 'STARTING' | 'MOVING' | 'PAUSED' | 'STOPPING',
  stateStartTime: number, // timestamp
  currentTripId?: string,
  tripStartTime?: number,
  tripStartLocation?: string, // JSON "[lon, lat]"
  avgSpeed30s: number,
  avgSpeed1min: number,
  avgSpeed5min: number,
  lastSpeed: number,
  lastPosition: string, // JSON "[lon, lat]"
  lastPositionTime: number,
  recentPositions: string, // JSON array de últimas 300 posiciones
  lastUpdate: number,
  version: number
}

// Key: trip:in-progress:{tripId}
// Type: Hash
// TTL: 48 horas
{
  _id: string,
  idActivo: string,
  idTracker: string,
  idCliente: string,
  startTime: number,
  startLocation: string, // JSON
  accumulatedDistance: number,
  maxSpeed: number,
  positionsCount: number,
  idleTime: number,
  stopsCount: number,
  lastUpdate: number
}

// Key: tracker:{trackerId}:last-processed
// Type: String
// TTL: 5 segundos
// Value: timestamp (para throttling)
```

---

## Interfaz de Integración

### 1. Eventos de Entrada (Consume)

#### Event: `position:new`

**Channel**: Redis PubSub `position:new`

**Producer**: `gestion-api-trackers`, `gestion-websocket-traccar`

**Payload** (SOLO datos GPS necesarios):
```json
{
  "deviceId": "IMEI-123456789012345",
  "timestamp": 1699999999999,
  "latitude": -34.6037,
  "longitude": -58.3816,
  "speed": 45.5,
  "ignition": true,
  "altitude": 25.5,
  "heading": 180,
  "accuracy": 10.5,
  "satellites": 12,
  "metadata": {
    "reporteId": "507f1f77bcf86cd799439011",
    "customField": "any value"
  }
}
```

**Contrato**:

**Campos Requeridos** (mínimo para detección):
- `deviceId` (string): Identificador único del dispositivo (IMEI, serial, UUID, etc.)
- `timestamp` (number): Timestamp GPS en milisegundos (Unix epoch)
- `latitude` (number): Latitud en grados decimales (-90 a 90)
- `longitude` (number): Longitud en grados decimales (-180 a 180)
- `speed` (number): Velocidad en km/h (>= 0)
- `ignition` (boolean): Estado de ignición (CRÍTICO para detección)

**Campos Opcionales** (mejoran precisión):
- `altitude` (number): Altitud en metros sobre nivel del mar
- `heading` (number): Rumbo en grados (0-360, donde 0=Norte)
- `accuracy` (number): Precisión horizontal en metros
- `satellites` (number): Número de satélites GPS visibles (>= 0)
- `metadata` (object): Datos adicionales del sistema integrador (no usados para detección)

**Frecuencia esperada**:
- 100-1000 eventos/segundo (depende de cantidad de vehículos)

**Validaciones**:
- Latitud: -90 a 90
- Longitud: -180 a 180
- Speed: >= 0
- Heading: 0 a 360 (si presente)
- Timestamp: no puede ser futuro (+1 min tolerancia), máximo 24 horas en el pasado

**Manejo de errores**:
- Si payload es inválido: Log warning, descarta evento
- Si `tripero` no puede procesar: Log error, continúa con siguiente
- Si Redis PubSub cae: Producer sigue funcionando, eventos se pierden (acceptable)

**Nota Arquitectural**:
El payload debe contener TODOS los datos necesarios para la detección de trips.
Tripero NO debe depender de llamadas HTTP a otros servicios para obtener información de posiciones.

---

### 2. APIs REST (Expone)

#### GET /health

**Propósito**: Health check para Kubernetes

**Response**:
```json
{
  "status": "ok",
  "timestamp": "2024-11-14T12:00:00Z",
  "services": {
    "redis": { "status": "up" },
    "postgres": { "status": "up" }
  }
}
```

---

#### GET /health/ready

**Propósito**: Readiness probe para Kubernetes

**Response**:
```json
{
  "status": "ready",
  "redis": true,
  "postgres": true
}
```

---

#### GET /trips

**Propósito**: Obtener trips de un activo en un rango de tiempo

**Query Parameters**:
```typescript
{
  idActivo: string;      // Required
  from: string;          // Required, ISO 8601
  to: string;            // Required, ISO 8601
  status?: string;       // Optional, 'completed' | 'in_progress'
  limit?: number;        // Optional, default 100, max 1000
  offset?: number;       // Optional, default 0
}
```

**Example Request**:
```http
GET /trips?idActivo=507f1f77bcf86cd799439011&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
```

**Response**:
```json
{
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "idActivo": "507f1f77bcf86cd799439011",
      "idTracker": "507f191e810c19729de860ea",
      "startTime": "2024-01-15T08:30:00Z",
      "endTime": "2024-01-15T09:45:00Z",
      "duration": 4500,
      "startLocation": {
        "type": "Point",
        "coordinates": [-58.3816, -34.6037]
      },
      "endLocation": {
        "type": "Point",
        "coordinates": [-58.4373, -34.6158]
      },
      "distance": 8500,
      "maxSpeed": 65.5,
      "avgSpeed": 42.3,
      "confidence": 0.95,
      "detectionMethod": "ignition",
      "status": "completed"
    }
  ],
  "total": 45,
  "limit": 100,
  "offset": 0
}
```

**Error Responses**:
```json
// 400 Bad Request
{
  "statusCode": 400,
  "message": "idActivo is required",
  "error": "Bad Request"
}

// 500 Internal Server Error
{
  "statusCode": 500,
  "message": "Database connection failed",
  "error": "Internal Server Error"
}
```

---

#### GET /trips/:id

**Propósito**: Obtener un trip específico por ID

**Path Parameters**:
- `id`: UUID del trip

**Response**:
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "idActivo": "507f1f77bcf86cd799439011",
  "startTime": "2024-01-15T08:30:00Z",
  "endTime": "2024-01-15T09:45:00Z",
  "duration": 4500,
  "distance": 8500,
  "confidence": 0.95,
  "detectionReasons": [
    "Ignition ON during entire period",
    "Consistent speed > 20 km/h",
    "Distance > 5 km"
  ],
  "positionsCount": 450
}
```

---

#### GET /trips/stats

**Propósito**: Obtener estadísticas agregadas de trips

**Query Parameters**:
```typescript
{
  idActivo?: string;     // Optional
  idCliente?: string;    // Optional
  from: string;          // Required, ISO 8601
  to: string;            // Required, ISO 8601
  granularity?: string;  // Optional, 'day' | 'week' | 'month', default 'day'
}
```

**Example Request**:
```http
GET /trips/stats?idCliente=xxx&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z&granularity=day
```

**Response**:
```json
{
  "data": [
    {
      "date": "2024-01-15",
      "tripsCount": 12,
      "totalDistance": 245000,
      "avgTripDistance": 20416,
      "totalDuration": 36000,
      "avgSpeed": 45.5
    }
  ],
  "summary": {
    "totalTrips": 342,
    "totalDistance": 7890000,
    "avgDistance": 23070,
    "totalDuration": 1234567
  }
}
```

---

#### GET /stops

**Propósito**: Obtener stops de un activo

**Query Parameters**: Similar a `/trips`

**Response**: Similar a `/trips` pero con datos de stops

---

#### GET /trackers/:trackerId/status

**Propósito**: Obtener estado completo de un tracker en tiempo real

**Path Parameters**:
- `trackerId`: Identificador del tracker (IMEI, deviceId, etc.)

**Response**:
```json
{
  "success": true,
  "data": {
    "trackerId": "IMEI-123456789012345",
    "deviceId": "IMEI-123456789012345",

    "odometer": {
      "total": 1234567,        // metros
      "totalKm": 1234,         // km
      "currentTrip": 8500,     // metros del trip actual
      "currentTripKm": 8       // km del trip actual
    },

    "currentState": {
      "state": "MOVING",       // STOPPED | MOVING | PAUSED | UNKNOWN | OFFLINE
      "since": "2024-11-14T10:30:00Z",
      "duration": 3600         // segundos en este estado
    },

    "lastPosition": {
      "timestamp": "2024-11-14T12:00:00Z",
      "latitude": -34.6037,
      "longitude": -58.3816,
      "speed": 45.5,
      "ignition": true,
      "heading": 180,
      "altitude": 25.5,
      "age": 120               // segundos desde última posición
    },

    "currentTrip": {
      "tripId": "550e8400-e29b-41d4-a716-446655440000",
      "startTime": "2024-11-14T10:30:00Z",
      "duration": 5400,
      "distance": 8500,
      "avgSpeed": 42,
      "maxSpeed": 65,
      "odometerAtStart": 1226067
    },

    "statistics": {
      "totalTrips": 1523,
      "totalDrivingTime": 876543,
      "totalDrivingHours": 243.5,
      "totalIdleTime": 123456,
      "totalIdleHours": 34.3,
      "totalStops": 4567,
      "firstSeen": "2023-01-15T08:00:00Z",
      "lastSeen": "2024-11-14T12:00:00Z",
      "daysActive": 669
    },

    "health": {
      "status": "online",      // online | offline | stale
      "lastSeenAgo": 120       // segundos
    }
  }
}
```

---

#### GET /trackers

**Propósito**: Listar trackers activos

**Query Parameters**:
```typescript
{
  status?: 'online' | 'offline' | 'all';  // default: 'online'
  hoursAgo?: number;                       // default: 24
}
```

**Response**:
```json
{
  "success": true,
  "data": [/* array de tracker status */],
  "total": 150,
  "filters": {
    "status": "online",
    "hoursAgo": 24
  }
}
```

---

#### GET /trackers/stats

**Propósito**: Estadísticas globales de todos los trackers

**Response**:
```json
{
  "success": true,
  "data": {
    "totalTrackers": 1000,
    "onlineTrackers": 850,
    "offlineTrackers": 150,
    "totalOdometer": 1234567890,     // metros
    "totalOdometerKm": 1234567,      // km
    "totalTrips": 156789,
    "totalDrivingTime": 98765432,    // segundos
    "totalDrivingHours": 27434.8     // horas
  }
}
```

---

#### POST /trackers/:trackerId/odometer/reset

**Propósito**: Resetear odómetro de un tracker

**Path Parameters**:
- `trackerId`: Identificador del tracker

**Body**:
```json
{
  "newValue": 0,
  "reason": "Tracker reemplazado"
}
```

**Response**:
```json
{
  "success": true,
  "message": "Odometer reset to 0 meters",
  "data": {
    "trackerId": "IMEI-123456789012345",
    "newOdometerValue": 0,
    "newOdometerKm": 0,
    "reason": "Tracker reemplazado"
  }
}
```

---

### 3. Eventos de Salida (Produce)

#### Event: `trip:started`

**Channel**: Redis PubSub `trip:started`

**Payload**:
```json
{
  "tripId": "550e8400-e29b-41d4-a716-446655440000",
  "idActivo": "507f1f77bcf86cd799439011",
  "idTracker": "507f191e810c19729de860ea",
  "startTime": "2024-01-15T08:30:00Z",
  "startLocation": {
    "type": "Point",
    "coordinates": [-58.3816, -34.6037]
  }
}
```

**Consumers**: Servicios que quieran notificaciones de trips iniciados

---

#### Event: `trip:completed`

**Channel**: Redis PubSub `trip:completed`

**Payload**:
```json
{
  "tripId": "550e8400-e29b-41d4-a716-446655440000",
  "idActivo": "507f1f77bcf86cd799439011",
  "startTime": "2024-01-15T08:30:00Z",
  "endTime": "2024-01-15T09:45:00Z",
  "duration": 4500,
  "distance": 8500,
  "avgSpeed": 42.3
}
```

**Consumers**:
- Servicios de notificaciones
- Servicios de analítica
- Dashboard en tiempo real

---

## Flujos de Datos

### Flujo 1: Detección de Trip en Tiempo Real

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Nueva posición GPS                                                │
│    gestion-api-trackers recibe posición de tracker                  │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. Publicar evento                                                   │
│    PUBLISH position:new '{"reporteId":"xxx","trackerId":"yyy"}'    │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. gestion-trip consume evento                                       │
│    • Throttling: skip si < 1 seg desde última procesada            │
│    • Obtener estado actual desde Redis                             │
│    • Feature extraction (velocidades, ignición, etc.)              │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Motion detection + State machine                                  │
│    • Detectar si está MOVING, STOPPED, PAUSED, etc.                │
│    • Actualizar estado en Redis                                     │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ├─────────────────┐
                         │                 │
                         ▼                 ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ 5a. Si cambio a MOVING       │  │ 5b. Si cambio a STOPPED     │
│    • Crear trip in progress  │  │    • Finalizar trip         │
│    • Guardar en Redis        │  │    • Encolar para batch     │
│    • PUBLISH trip:started    │  │    • PUBLISH trip:completed │
└──────────────────────────────┘  └──────────────────────────────┘
                                              │
                                              ▼
                                  ┌──────────────────────────────┐
                                  │ 6. Batch writer              │
                                  │    (cada 5-10 segundos)      │
                                  │    • Agrupa 50-100 trips     │
                                  │    • INSERT batch a          │
                                  │      PostgreSQL             │
                                  └──────────────────────────────┘
```

**Latencias**:
- Evento → Detección: < 100ms
- Detección → Redis update: < 10ms
- Trip completed → Persistido en PostgreSQL: < 10 segundos

---

### Flujo 2: Query de Trips Históricos

```
┌─────────────────────────────────────────────────────────────────────┐
│ 1. Cliente solicita trips                                            │
│    GET /trips?idActivo=xxx&from=2024-01-01&to=2024-01-31           │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. gestion-trip valida parámetros                                   │
│    • idActivo presente                                              │
│    • Rango de fechas válido                                         │
│    • Límite no excede máximo                                        │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. Query a PostgreSQL                                               │
│    SELECT * FROM trips                                               │
│    WHERE id_activo = $1                                             │
│    AND start_time BETWEEN $2 AND $3                                │
│    ORDER BY start_time DESC                                         │
│    LIMIT $4 OFFSET $5;                                              │
│                                                                      │
│    Latencia: 50-200ms (optimizado por table)                  │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. Formatear y devolver respuesta                                    │
│    • JSON serialization                                              │
│    • Agregar metadata (total, limit, offset)                        │
└─────────────────────────────────────────────────────────────────────┘
```

**Latencia total**: 100-300ms (depende de cantidad de resultados)

---

## Escalabilidad y Performance

### Métricas Esperadas

**Carga normal**:
- 1,000 vehículos activos
- 1 posición cada 10 segundos = 6 pos/min/vehículo
- Total: 100 posiciones/segundo
- Trips activos simultáneos: ~200 (20% de vehículos en movimiento)
- Trips completados por día: ~2,000

**Carga pico**:
- 10,000 vehículos
- 1,000 posiciones/segundo
- Trips activos: ~2,000
- Trips por día: ~20,000

### Capacidad del Sistema

**Redis**:
- Operaciones: 100k ops/seg → Nuestro uso: 200 ops/seg ✅
- Memoria: 1 MB × 1,000 trackers = 1 GB → Redis soporta fácilmente ✅

**PostgreSQL**:
- Writes: 5-10k inserts/seg → Nuestro uso: 4 batch writes/seg ✅
- Queries: < 100ms para 10M trips con tables ✅
- Storage: 10M trips × 1 KB = 10 GB raw → 2 GB comprimido ✅

**Pods**:
- CPU: 250m por pod, escalar a 10 pods = 2.5 cores ✅
- Memory: 512 MB por pod ✅

### Estrategias de Escalado

**Horizontal (más pods)**:
```yaml
# HPA (Horizontal Pod Autoscaler)
minReplicas: 2
maxReplicas: 10
metrics:
  - type: Resource
    resource:
      name: cpu
      targetAverageUtilization: 70
```

**Vertical (BD más grande)**:
```yaml
# PostgreSQL
resources:
  requests:
    memory: 4Gi
    cpu: 2
  limits:
    memory: 8Gi
    cpu: 4
```

**Particionamiento** (futuro):
- Si llegamos a 100k vehículos: particionar por región geográfica
- Hypertables ya particionan automáticamente por tiempo

---

## Monitoreo y Observabilidad

### Métricas Clave (Prometheus)

```typescript
// Performance
trip_detection_positions_processed_total     // Counter
trip_detection_latency_seconds               // Histogram
trip_detection_trips_created_total           // Counter
trip_detection_trips_completed_total         // Counter

// Business
trip_detection_active_trips                  // Gauge
trip_detection_daily_trips                   // Counter
trip_detection_avg_trip_distance_meters      // Histogram
trip_detection_avg_trip_duration_seconds     // Histogram

// System
trip_detection_redis_operations_total        // Counter
trip_detection_postgres_queries_total     // Counter
trip_detection_batch_writes_total            // Counter
trip_detection_batch_size                    // Histogram

// Errors
trip_detection_errors_total                  // Counter (label: error_type)
```

### Logs Estructurados

```json
{
  "timestamp": "2024-11-14T12:00:00Z",
  "level": "info",
  "service": "gestion-trip",
  "event": "trip_started",
  "tripId": "550e8400-e29b-41d4-a716-446655440000",
  "trackerId": "507f191e810c19729de860ea",
  "detectionMethod": "ignition",
  "confidence": 0.95
}
```

### Alertas Críticas

```yaml
# Redis down
- alert: RedisTripDown
  expr: trip_detection_redis_up == 0
  for: 1m
  severity: critical

# PostgreSQL down
- alert: PostgreSQLTripDown
  expr: trip_detection_postgres_up == 0
  for: 1m
  severity: critical

# Alta latencia de detección
- alert: TripDetectionHighLatency
  expr: histogram_quantile(0.95, trip_detection_latency_seconds) > 1
  for: 5m
  severity: warning

# Batch writes fallando
- alert: TripBatchWritesFailing
  expr: rate(trip_detection_batch_write_errors_total[5m]) > 0.1
  for: 5m
  severity: warning
```

---

## Resumen de Decisiones

| Decisión | Razón | Impacto |
|----------|-------|---------|
| **Microservicio independiente** | Desacoplamiento, resiliencia | ✅ Alto |
| **PostgreSQL** | Performance 10-100x, storage 80% menos | ✅ Muy alto |
| **Redis state + PubSub** | Reduce writes 99%, desacopla servicios | ✅ Alto |
| **Batch writes (5-10 seg)** | Eficiencia, menos carga en BD | ✅ Alto |
| **Event-driven integration** | Loose coupling, escalabilidad | ✅ Medio |

---

**Última actualización**: 2024-11-14
**Versión**: 1.0
**Estado**: Aprobado
**Autores**: Equipo IRIX + Claude
