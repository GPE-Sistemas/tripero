# Guía de Integración - Tripero

Esta guía explica cómo integrar sistemas externos con Tripero para detección de trips y stops.

---

## Arquitectura de Integración

Tripero es un microservicio **completamente independiente** que:

✅ **NO depende** de otros servicios para funcionar
✅ **NO hace** llamadas HTTP a otros servicios para obtener datos
✅ Solo depende de **Redis** (PubSub + Cache) y **PostgreSQL** (persistencia)

---

## 📥 Enviar Posiciones GPS a Tripero

### Canal: Redis PubSub `position:new`

Para que Tripero detecte trips, los sistemas que reciben posiciones GPS deben publicar eventos en el canal `position:new` con **todos los datos completos**.

### Payload Mínimo Necesario

```typescript
interface IPositionEvent {
  // === REQUERIDOS (mínimo para detectar trips) ===
  deviceId: string;         // ID único del dispositivo (IMEI, serial, UUID, etc.)
  timestamp: number;        // Timestamp GPS en milisegundos (Unix epoch)
  latitude: number;         // Latitud en grados decimales (-90 a 90)
  longitude: number;        // Longitud en grados decimales (-180 a 180)
  speed: number;            // Velocidad en km/h (>= 0)
  ignition: boolean;        // Estado ignición (CRÍTICO para detección)

  // === OPCIONALES (mejoran precisión) ===
  altitude?: number;        // Altitud en metros
  heading?: number;         // Rumbo 0-360 (0=Norte)
  accuracy?: number;        // Precisión GPS en metros
  satellites?: number;      // Número de satélites visibles

  // === METADATA (no usada para detección, solo trazabilidad) ===
  metadata?: {
    [key: string]: any;     // Datos custom del integrador
  };
}
```

### Ejemplo de Publicación (Node.js con ioredis)

```typescript
import Redis from 'ioredis';

const redis = new Redis({
  host: 'redis-host',
  port: 6379,
});

// Cuando llega una nueva posición GPS
async function publishPosition(gpsData: any) {
  const event: IPositionEvent = {
    // Campos requeridos
    deviceId: gpsData.imei || gpsData.deviceId,
    timestamp: gpsData.timestamp,
    latitude: gpsData.lat,
    longitude: gpsData.lon,
    speed: gpsData.speed || 0,
    ignition: gpsData.ignition || false,

    // Campos opcionales (si disponibles)
    altitude: gpsData.altitude,
    heading: gpsData.heading,
    accuracy: gpsData.accuracy,
    satellites: gpsData.satellites,

    // Metadata para trazabilidad (opcional)
    metadata: {
      reportId: gpsData._id?.toString(),
      vehicleId: gpsData.vehicleId,
      customField: gpsData.customValue,
    },
  };

  // Publicar en Redis PubSub
  await redis.publish('position:new', JSON.stringify(event));

  console.log(`Published position for device ${event.deviceId}`);
}
```

### Validaciones Importantes

Antes de publicar, validar:

- ✅ `deviceId` no vacío
- ✅ Latitud entre -90 y 90
- ✅ Longitud entre -180 y 180
- ✅ Velocidad >= 0
- ✅ Timestamp no es futuro (+1 min tolerancia)
- ✅ Timestamp no es más de 24 horas en el pasado
- ✅ `ignition` es boolean (crítico para detección)
- ✅ `heading` entre 0-360 (si presente)
- ✅ `accuracy` >= 0 (si presente)
- ✅ `satellites` >= 0 (si presente)

---

## 📤 Consumir Eventos de Trips

### Canal: Redis PubSub `trip:started`

```typescript
import Redis from 'ioredis';

const subscriber = new Redis({
  host: 'redis-host',
  port: 6379,
});

subscriber.subscribe('trip:started', (err, count) => {
  if (err) {
    console.error('Failed to subscribe:', err);
    return;
  }
  console.log(`Subscribed to ${count} channel(s)`);
});

subscriber.on('message', (channel, message) => {
  if (channel === 'trip:started') {
    const event = JSON.parse(message);

    console.log('Trip iniciado:', {
      tripId: event.tripId,
      idActivo: event.idActivo,
      startTime: event.startTime,
      location: event.startLocation.coordinates,
    });

    // Aquí puedes:
    // - Enviar notificación push
    // - Actualizar dashboard en tiempo real
    // - Registrar en sistema de analítica
  }
});
```

### Canal: Redis PubSub `trip:completed`

```typescript
subscriber.subscribe('trip:completed');

subscriber.on('message', (channel, message) => {
  if (channel === 'trip:completed') {
    const event = JSON.parse(message);

    console.log('Trip finalizado:', {
      tripId: event.tripId,
      duration: event.duration,
      distance: event.distance,
      avgSpeed: event.avgSpeed,
    });

    // Aquí puedes:
    // - Generar reporte de viaje
    // - Calcular consumo de combustible
    // - Actualizar estadísticas
    // - Enviar factura
  }
});
```

---

## 🔍 Consultar Trips Históricos

### REST API

```typescript
import axios from 'axios';

const triperoAPI = axios.create({
  baseURL: 'http://tripero-service:3000',
});

// Obtener trips de un activo
async function getTrips(idActivo: string, from: Date, to: Date) {
  const response = await triperoAPI.get('/trips', {
    params: {
      idActivo,
      from: from.toISOString(),
      to: to.toISOString(),
      limit: 100,
      offset: 0,
    },
  });

  return response.data;
}

// Ejemplo de uso
const trips = await getTrips(
  '507f1f77bcf86cd799439011',
  new Date('2024-01-01'),
  new Date('2024-01-31')
);

console.log(`Total trips: ${trips.total}`);
trips.data.forEach(trip => {
  console.log(`Trip ${trip.id}: ${trip.distance}m, ${trip.duration}s`);
});
```

### Endpoints Disponibles

```
GET /health              - Health check
GET /health/ready        - Readiness probe

GET /trips               - Listar trips
GET /trips/:id           - Obtener trip específico
GET /trips/stats         - Estadísticas agregadas

GET /stops               - Listar stops
GET /stops/:id           - Obtener stop específico
```

---

## 📊 Diagrama de Flujo de Integración

```
┌─────────────────────────┐
│ gestion-api-trackers    │
│                         │
│ 1. Recibe posición GPS  │
│    del tracker          │
│                         │
│ 2. Guarda en MongoDB    │
│                         │
│ 3. Publica evento       │
│    position:new         │
│    CON DATOS COMPLETOS  │
└────────────┬────────────┘
             │
             │ Redis PubSub
             │ position:new
             ▼
    ┌────────────────────────┐
    │      TRIPERO           │
    │                        │
    │ 4. Valida payload      │
    │                        │
    │ 5. Actualiza estado    │
    │    en Redis            │
    │                        │
    │ 6. Detecta trip/stop   │
    │                        │
    │ 7. Guarda en           │
    │    PostgreSQL         │
    └────────┬───────────────┘
             │
             │ Redis PubSub
             │ trip:started
             │ trip:completed
             ▼
    ┌────────────────────────┐
    │   Consumidores         │
    │                        │
    │ - Dashboards           │
    │ - Notificaciones       │
    │ - Analítica            │
    │ - Facturación          │
    └────────────────────────┘
             ▲
             │
             │ HTTP REST API
             │ GET /trips
             │
    ┌────────┴────────────────┐
    │   Clientes REST         │
    │                         │
    │ - Frontend web          │
    │ - Apps móviles          │
    │ - Reportes              │
    └─────────────────────────┘
```

---

## ⚠️ Errores Comunes

### Error: "Invalid payload - missing required fields"

**Causa**: El evento `position:new` no contiene todos los campos requeridos.

**Solución**: Verificar que el payload incluye:
- `deviceId`, `timestamp`
- `latitude`, `longitude`
- `speed`, `ignition`

### Error: "Timestamp is in the future"

**Causa**: El `timestamp` del GPS es mayor que la hora actual del servidor.

**Solución**:
- Verificar que el timestamp está en milisegundos (no segundos)
- Verificar sincronización de reloj del tracker GPS

### Error: "Trip not found"

**Causa**: Consultando un trip que no existe o fue eliminado por política de retención.

**Solución**:
- Verificar que el `tripId` es correcto
- Verificar que el trip está dentro del período de retención (default: 2 años)

---

## 🔒 Consideraciones de Seguridad

1. **Redis PubSub**:
   - Usar Redis con autenticación (requirepass)
   - Usar TLS para comunicaciones en producción
   - Limitar acceso por firewall

2. **REST API**:
   - Implementar autenticación JWT (no incluido en v0.1.0)
   - Usar rate limiting para prevenir abuso
   - Validar todos los inputs

3. **Datos Sensibles**:
   - No incluir datos personales en eventos PubSub
   - Usar IDs en lugar de nombres/emails
   - Implementar GDPR compliance si aplica

---

## 📈 Performance y Escalabilidad

### Throughput Esperado

- **Entrada**: 100-1000 posiciones/segundo
- **Procesamiento**: < 10ms por posición
- **Latencia E2E**: < 100ms (posición → evento trip:started)

### Escalabilidad Horizontal

Tripero puede escalar horizontalmente:

1. **Múltiples instancias**: Cada instancia procesa eventos independientemente
2. **Redis Cluster**: Para alta disponibilidad de PubSub
3. **PostgreSQL**: Soporta sharding para grandes volúmenes

### Monitoreo

Métricas clave a monitorear:

- Rate de eventos `position:new` recibidos
- Rate de eventos `trip:started/completed` publicados
- Latencia de procesamiento
- Errores de validación
- Conexiones a Redis y PostgreSQL

---

## 🐛 Debugging

### Ver eventos en tiempo real

```bash
# Suscribirse a todos los canales
redis-cli PSUBSCRIBE "*"

# Ver eventos de entrada
redis-cli SUBSCRIBE position:new

# Ver eventos de salida
redis-cli SUBSCRIBE trip:started trip:completed
```

### Verificar estado de un tracker en Redis

```bash
redis-cli GET "tracker:{trackerId}:motion-state"
```

### Logs de Tripero

```bash
kubectl logs -f deployment/tripero --tail=100
```

---

## 📞 Soporte

- GitHub Issues: https://github.com/GPE-Sistemas/tripero/issues
- Documentación: [ARQUITECTURA.md](./ARQUITECTURA.md)
- TODO List: [TODO.md](./TODO.md)

---

**Última actualización**: 2024-11-14
**Versión**: 0.1.0
