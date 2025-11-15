# Testing de Tripero

Guía para probar el sistema de detección de trips.

---

## Requisitos

1. **Redis** corriendo en `localhost:6379`
2. **PostgreSQL** corriendo en `localhost:5432` (opcional para esta fase)
3. **Node.js 20+**

---

## Setup para Testing Local

### 1. Iniciar servicios de infraestructura

```bash
# En el directorio tripero/
docker-compose up -d
```

Verificar que Redis está corriendo:
```bash
docker-compose logs redis
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env
```

Editar `.env` y configurar:
```env
# Habilitar detección de trips
TRIP_DETECTION_ENABLED=true

# Redis local
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=0

# Database (PostgreSQL) - opcional para Fase 1
DB_HOST=localhost
DB_PORT=5432
DB_SYNCHRONIZE=true  # Solo en desarrollo!
```

### 3. Iniciar Tripero

```bash
npm run start:dev
```

Deberías ver en los logs:
```
[Nest] 12345  - 11/14/2024, 4:25:00 PM     LOG [RedisService] Redis conectado localhost:6379 db 0
[Nest] 12345  - 11/14/2024, 4:25:00 PM     LOG [PositionSubscriberService] Initializing position subscriber...
[Nest] 12345  - 11/14/2024, 4:25:00 PM     LOG [PositionSubscriberService] Successfully subscribed to position:new channel
```

---

## Testing Manual

### Opción 1: Script de Simulación Automática

Ejecuta el script de prueba que simula un viaje completo:

```bash
node test-position-publisher.js
```

El script publicará posiciones simuladas que representan:
1. Vehículo detenido (ignition OFF)
2. Motor encendido pero sin moverse (IDLE)
3. Comienza a moverse → **TRIP STARTED**
4. Varias posiciones en movimiento
5. Parada intermedia (IDLE dentro del trip)
6. Continúa movimiento
7. Motor apagado → **TRIP COMPLETED**

### Opción 2: Publicar Posiciones Manualmente

En otra terminal, abrir redis-cli:

```bash
redis-cli
```

Publicar una posición GPS:

```redis
PUBLISH position:new '{"deviceId":"TEST-001","timestamp":1699999999999,"latitude":-34.6037,"longitude":-58.3816,"speed":0,"ignition":false}'
```

**Ejemplo de trip completo**:

```bash
# 1. Motor encendido
PUBLISH position:new '{"deviceId":"TEST-001","timestamp":1699999999000,"latitude":-34.6037,"longitude":-58.3816,"speed":0,"ignition":true}'

# 2. Empieza a moverse (TRIP STARTED)
PUBLISH position:new '{"deviceId":"TEST-001","timestamp":1699999999010000,"latitude":-34.6040,"longitude":-58.3820,"speed":25,"ignition":true}'

# 3. Continúa moviéndose
PUBLISH position:new '{"deviceId":"TEST-001","timestamp":1699999999020000,"latitude":-34.6050,"longitude":-58.3830,"speed":45,"ignition":true}'

# 4. Motor apagado (TRIP COMPLETED)
PUBLISH position:new '{"deviceId":"TEST-001","timestamp":1699999999030000,"latitude":-34.6060,"longitude":-58.3840,"speed":0,"ignition":false}'
```

---

## Monitorear Eventos

### En una terminal, suscribirse a eventos de trips:

```bash
redis-cli SUBSCRIBE trip:started trip:completed
```

Deberías ver:
```
Reading messages... (press Ctrl-C to quit)
1) "subscribe"
2) "trip:started"
3) (integer) 1
1) "message"
2) "trip:started"
3) "{\"tripId\":\"trip_TEST-001_1699999999010_abc123\",\"deviceId\":\"TEST-001\",\"startTime\":\"2024-01-15T10:00:00.000Z\",\"startLocation\":{\"type\":\"Point\",\"coordinates\":[-58.3820,-34.6040]},\"detectionMethod\":\"ignition\"}"
```

### Ver estado de un dispositivo en Redis:

```bash
redis-cli GET "device:state:TEST-001"
```

### Ver logs de Tripero:

Los logs mostrarán:
- Posiciones recibidas
- Transiciones de estado
- Trips iniciados/completados
- Métricas cada minuto

```
[PositionSubscriberService] Subscription metrics: 15 received, 0 invalid
[PositionProcessorService] Metrics: 15 positions processed, 0 errors
[PositionProcessorService] State transition for device TEST-001: STOPPED → MOVING (ignition_on)
[EventPublisherService] Published trip:started for device TEST-001, trip trip_TEST-001_...
```

---

## Verificar Funcionamiento

### ✅ Checklist de Verificación

1. **Redis PubSub funcionando**
   - [ ] Tripero se suscribe correctamente a `position:new`
   - [ ] Logs muestran "Successfully subscribed to position:new channel"

2. **Procesamiento de posiciones**
   - [ ] Posiciones publicadas son recibidas
   - [ ] Logs muestran "X positions processed"
   - [ ] No hay errores de validación

3. **Detección de trips**
   - [ ] Cuando ignition pasa de OFF a ON y hay movimiento → trip:started
   - [ ] Cuando ignition pasa a OFF después de movimiento → trip:completed

4. **Estado en Redis**
   - [ ] Estado del dispositivo se guarda correctamente
   - [ ] Se puede recuperar con `redis-cli GET "device:state:DEVICE-ID"`

5. **Eventos publicados**
   - [ ] `trip:started` se publica con datos correctos
   - [ ] `trip:completed` se publica con distancia, duración, velocidades

---

## Debugging

### Ver todas las claves de Redis:

```bash
redis-cli KEYS "*"
```

### Ver canales activos:

```bash
redis-cli PUBSUB CHANNELS
```

### Ver número de subscriptores:

```bash
redis-cli PUBSUB NUMSUB position:new trip:started trip:completed
```

### Limpiar Redis:

```bash
redis-cli FLUSHDB
```

### Ver logs en tiempo real:

```bash
# Con npm run start:dev ya se ven en tiempo real
# O con pm2:
pm2 logs tripero
```

---

## Casos de Prueba

### Caso 1: Trip Normal (Ignition-First)

```bash
# Posición 1: Motor apagado, detenido
PUBLISH position:new '{"deviceId":"CAR-001","timestamp":1700000000000,"latitude":-34.6037,"longitude":-58.3816,"speed":0,"ignition":false}'

# Posición 2: Motor encendido, empieza a moverse → TRIP START
PUBLISH position:new '{"deviceId":"CAR-001","timestamp":1700000010000,"latitude":-34.6040,"longitude":-58.3820,"speed":30,"ignition":true}'

# Posición 3: Continúa
PUBLISH position:new '{"deviceId":"CAR-001","timestamp":1700000020000,"latitude":-34.6050,"longitude":-58.3830,"speed":40,"ignition":true}'

# Posición 4: Motor apagado → TRIP END
PUBLISH position:new '{"deviceId":"CAR-001","timestamp":1700000030000,"latitude":-34.6060,"longitude":-58.3840,"speed":0,"ignition":false}'
```

**Resultado esperado**:
- ✅ `trip:started` al recibir posición 2
- ✅ `trip:completed` al recibir posición 4
- ✅ Duración: ~30 segundos
- ✅ Distancia: ~1.5 km

### Caso 2: Trip con Parada Intermedia

```bash
# Motor encendido, moviéndose
PUBLISH position:new '{"deviceId":"CAR-002","timestamp":1700000000000,"latitude":-34.6037,"longitude":-58.3816,"speed":50,"ignition":true}'

# Parada en semáforo (motor encendido, sin movimiento)
PUBLISH position:new '{"deviceId":"CAR-002","timestamp":1700000030000,"latitude":-34.6050,"longitude":-58.3830,"speed":0,"ignition":true}'

# Continúa
PUBLISH position:new '{"deviceId":"CAR-002","timestamp":1700000060000,"latitude":-34.6055,"longitude":-58.3835,"speed":40,"ignition":true}'

# Fin
PUBLISH position:new '{"deviceId":"CAR-002","timestamp":1700000090000,"latitude":-34.6070,"longitude":-58.3850,"speed":0,"ignition":false}'
```

**Resultado esperado**:
- ✅ `trip:started` al inicio
- ✅ Contador de stops incrementado
- ✅ `trip:completed` al final con `stopsCount: 1`

### Caso 3: Validación de Payload Inválido

```bash
# Payload sin ignition (campo requerido)
PUBLISH position:new '{"deviceId":"CAR-003","timestamp":1700000000000,"latitude":-34.6037,"longitude":-58.3816,"speed":50}'
```

**Resultado esperado**:
- ✅ Log de warning: "Invalid position event received"
- ✅ No procesa la posición

---

## Próximos Pasos

Una vez verificado que la Fase 1 funciona:

1. **Fase 2**: Implementar persistencia en PostgreSQL (batch writes)
2. **Fase 3**: Implementar API REST para consultas
3. **Testing Automatizado**: Escribir tests unitarios y e2e

---

**Última actualización**: 2024-11-14
**Versión**: 0.1.0 (Fase 1 completada)
