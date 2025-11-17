# Análisis: Metadata Personalizado en Tripero

**Fecha:** 2025-11-17
**Versión objetivo:** v0.3.0+

## 📋 Objetivo

Permitir agregar metadata personalizado a las posiciones GPS que:
1. Se propague a trips y stops
2. Permita filtrar queries (ej: por `tenant_id`, `client_id`, `fleet_id`)
3. Sea flexible para diferentes casos de uso
4. Tenga buena performance en queries

---

## 🔍 Análisis de Opciones

### Opción 1: Campo Específico (`tenant_id`)

**Pros:**
- ✅ Simple y directo
- ✅ Type-safe en TypeScript
- ✅ Fácil de indexar (B-tree index estándar)
- ✅ Queries muy rápidas

**Cons:**
- ❌ No flexible (¿qué pasa si necesitamos `client_id`, `fleet_id`, etc.?)
- ❌ Requiere migración de schema para cada nuevo campo
- ❌ Limitado a un solo concepto de particionamiento

**Ejemplo:**
```typescript
interface Trip {
  tenant_id: string;  // Solo un campo
}
```

---

### Opción 2: JSONB Metadata (Recomendado ✨)

**Pros:**
- ✅ **Ya implementado parcialmente** (trips y stops tienen campo `metadata`)
- ✅ Extremadamente flexible
- ✅ PostgreSQL JSONB con índices GIN es muy performante
- ✅ No requiere cambios de schema para nuevos campos
- ✅ Permite queries complejos en metadata
- ✅ Type-safe con TypeScript generics

**Cons:**
- ⚠️ Requiere índices GIN correctamente configurados
- ⚠️ Queries levemente más complejas (pero PostgreSQL lo hace fácil)
- ⚠️ Necesita documentación clara

**Ejemplo:**
```typescript
interface Trip {
  metadata: {
    tenant_id?: string;
    client_id?: string;
    fleet_id?: string;
    driver_id?: string;
    vehicle_plate?: string;
    custom_field?: any;
  } | null;
}
```

---

### Opción 3: Híbrido

**Pros:**
- ✅ Campos muy comunes indexados directamente (`tenant_id`)
- ✅ JSONB para metadata adicional

**Cons:**
- ❌ Complejidad innecesaria
- ❌ Decisión arbitraria de qué va en campos vs metadata
- ❌ Más difícil de mantener

---

## 🎯 Recomendación: Opción 2 (JSONB Metadata)

**Razones:**

1. **Ya está implementado al 80%:**
   - ✅ `IPositionEvent` tiene `metadata?: { [key: string]: any }`
   - ✅ `Trip` entity tiene `metadata: Record<string, any> | null`
   - ✅ `Stop` entity tiene `metadata: Record<string, any> | null`

2. **PostgreSQL JSONB es muy bueno:**
   - Índices GIN permiten queries eficientes
   - Operadores nativos: `->`, `->>`, `@>`, `?`
   - Soporte para índices parciales

3. **Flexibilidad real:**
   - Multi-tenancy: `metadata.tenant_id`
   - Flotas: `metadata.fleet_id`
   - Clientes: `metadata.client_id`
   - Cualquier campo custom sin cambios de código

---

## 🛠️ Implementación Propuesta

### 1. Estado Actual (Ya Implementado)

```typescript
// ✅ Ya existe en IPositionEvent
interface IPositionEvent {
  deviceId: string;
  // ... otros campos
  metadata?: {
    [key: string]: any;
  };
}

// ✅ Ya existe en Trip entity
@Entity('trips')
class Trip {
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}

// ✅ Ya existe en Stop entity
@Entity('stops')
class Stop {
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;
}
```

### 2. Lo que Falta Implementar

#### A. Propagar metadata de position → trip/stop

**Archivo:** `src/detection/services/position-processor.service.ts`

Actualmente cuando se crea un trip, no se está guardando el metadata del position event inicial.

**Modificación necesaria:**
```typescript
// En executeActions(), al crear trip
if (actions.startTrip && updatedState.currentTripId) {
  const event: ITripStartedEvent = {
    // ... campos actuales
  };

  // NUEVO: Guardar metadata en device state para usarlo al finalizar trip
  updatedState.tripMetadata = position.metadata;
}

// Al finalizar trip, persistir en BD
await this.tripRepository.create({
  // ... campos actuales
  metadata: updatedState.tripMetadata || position.metadata || null,
});
```

#### B. Índices GIN en PostgreSQL

**Crear migración:**
```sql
-- Índice GIN genérico en todo el metadata
CREATE INDEX idx_trips_metadata_gin ON trips USING GIN (metadata);
CREATE INDEX idx_stops_metadata_gin ON stops USING GIN (metadata);

-- Índices específicos para campos comunes (opcional, pero más rápido)
CREATE INDEX idx_trips_metadata_tenant ON trips
  USING btree ((metadata->>'tenant_id'))
  WHERE metadata->>'tenant_id' IS NOT NULL;

CREATE INDEX idx_trips_metadata_client ON trips
  USING btree ((metadata->>'client_id'))
  WHERE metadata->>'client_id' IS NOT NULL;

CREATE INDEX idx_stops_metadata_tenant ON stops
  USING btree ((metadata->>'tenant_id'))
  WHERE metadata->>'tenant_id' IS NOT NULL;
```

**Performance:**
- GIN index: Queries en ~5-10ms incluso con millones de rows
- Índices parciales B-tree: Queries en ~1-2ms para campos indexados

#### C. API de Reports - Agregar filtro por metadata

**Archivo:** `src/reports/dto/query-reports.dto.ts`

```typescript
export class QueryReportsDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((id) => id.trim());
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  deviceId?: string[];

  @IsDateString()
  from: string;

  @IsDateString()
  to: string;

  // NUEVO: Filtros por metadata
  @IsOptional()
  @IsString()
  tenantId?: string;  // Shortcut para metadata.tenant_id

  @IsOptional()
  @IsString()
  clientId?: string;  // Shortcut para metadata.client_id

  @IsOptional()
  @IsString()
  fleetId?: string;   // Shortcut para metadata.fleet_id

  // NUEVO: Filtro genérico por metadata
  @IsOptional()
  @ValidateNested()
  @Type(() => Object)
  metadata?: Record<string, any>;  // Filtro flexible
}
```

**Archivo:** `src/reports/reports.service.ts`

```typescript
async getTrips(query: QueryReportsDto) {
  const qb = this.tripRepository.createQueryBuilder('trip')
    .where('trip.start_time >= :from', { from: query.from })
    .andWhere('trip.start_time <= :to', { to: query.to });

  // Filtro por deviceId (ya existe)
  if (query.deviceId && query.deviceId.length > 0) {
    qb.andWhere('trip.id_activo IN (:...deviceIds)', {
      deviceIds: query.deviceId
    });
  }

  // NUEVO: Filtros por metadata shortcuts
  if (query.tenantId) {
    qb.andWhere("trip.metadata->>'tenant_id' = :tenantId", {
      tenantId: query.tenantId
    });
  }

  if (query.clientId) {
    qb.andWhere("trip.metadata->>'client_id' = :clientId", {
      clientId: query.clientId
    });
  }

  if (query.fleetId) {
    qb.andWhere("trip.metadata->>'fleet_id' = :fleetId", {
      fleetId: query.fleetId
    });
  }

  // NUEVO: Filtro genérico por metadata
  if (query.metadata) {
    qb.andWhere('trip.metadata @> :metadata', {
      metadata: query.metadata
    });
  }

  return await qb.getMany();
}
```

---

## 📚 Ejemplos de Uso

### Publicar Posición con Metadata

```typescript
// Producer publica posición con metadata
const position = {
  deviceId: "VEHICLE-001",
  timestamp: Date.now(),
  latitude: -34.603722,
  longitude: -58.381592,
  speed: 45,
  ignition: true,
  metadata: {
    tenant_id: "tenant-123",
    client_id: "client-456",
    fleet_id: "fleet-789",
    driver_id: "driver-001",
    vehicle_plate: "ABC123",
    custom_notes: "Delivery truck"
  }
};

await redis.publish('position:new', JSON.stringify(position));
```

### Query Trips por Tenant

```http
GET /api/reports/trips?from=2024-11-01T00:00:00Z&to=2024-11-30T23:59:59Z&tenantId=tenant-123
```

```sql
-- Query SQL generado
SELECT * FROM trips
WHERE start_time >= '2024-11-01'
  AND start_time <= '2024-11-30'
  AND metadata->>'tenant_id' = 'tenant-123';
```

### Query Trips por Cliente y Flota

```http
GET /api/reports/trips?from=2024-11-01T00:00:00Z&to=2024-11-30T23:59:59Z&clientId=client-456&fleetId=fleet-789
```

### Query con Metadata Genérico

```http
GET /api/reports/trips?from=2024-11-01T00:00:00Z&to=2024-11-30T23:59:59Z&metadata={"vehicle_plate":"ABC123"}
```

```sql
-- Query SQL generado (operador @> = "contains")
SELECT * FROM trips
WHERE start_time >= '2024-11-01'
  AND start_time <= '2024-11-30'
  AND metadata @> '{"vehicle_plate":"ABC123"}'::jsonb;
```

### Query Múltiples Condiciones

```http
GET /api/reports/trips?tenantId=tenant-123&metadata={"driver_id":"driver-001","priority":"high"}
```

---

## 🔍 Performance

### Sin Índices GIN
```
Query time: ~500-2000ms (full table scan)
```

### Con Índices GIN
```
Query time: ~5-10ms (index scan)
```

### Con Índices Parciales B-tree en campos comunes
```
Query time: ~1-2ms (index-only scan)
```

### Recomendación de Índices

**Para 90% de casos (Multi-tenancy simple):**
```sql
-- Solo índice en tenant_id
CREATE INDEX idx_trips_metadata_tenant ON trips
  USING btree ((metadata->>'tenant_id'))
  WHERE metadata->>'tenant_id' IS NOT NULL;
```

**Para casos avanzados:**
```sql
-- Índice GIN genérico (permite queries en cualquier campo)
CREATE INDEX idx_trips_metadata_gin ON trips USING GIN (metadata);

-- Índices específicos para campos muy consultados
CREATE INDEX idx_trips_metadata_tenant ON trips ((metadata->>'tenant_id'));
CREATE INDEX idx_trips_metadata_fleet ON trips ((metadata->>'fleet_id'));
```

---

## 📖 Ventajas de esta Implementación

1. **✨ Flexibilidad Total**
   - Cualquier campo sin cambios de código
   - Estructura anidada si es necesario
   - Arrays, objetos, valores primitivos

2. **🚀 Performance**
   - Con índices GIN: queries en <10ms
   - Con índices B-tree parciales: queries en <2ms
   - Comparable a campos nativos

3. **🔧 Fácil Mantenimiento**
   - No requiere migraciones para nuevos campos
   - Documentación centralizada
   - Type-safe con TypeScript

4. **🌍 Casos de Uso Reales**
   - **Multi-tenancy:** `tenant_id` para SaaS
   - **Flotas:** `fleet_id`, `vehicle_type`
   - **Conductores:** `driver_id`, `driver_name`
   - **Clientes:** `client_id`, `project_id`
   - **Operaciones:** `route_id`, `delivery_id`
   - **Custom:** Cualquier campo específico del negocio

---

## 🚦 Plan de Implementación

### Fase 1: Propagación de Metadata (2-3 horas)
1. ✅ Modificar `DeviceState` para guardar `tripMetadata`
2. ✅ Actualizar `executeActions()` para guardar metadata al crear trip
3. ✅ Actualizar `TripRepository.create()` para persistir metadata
4. ✅ Actualizar `StopRepository.create()` para persistir metadata
5. ✅ Tests unitarios

### Fase 2: Índices y Queries (1-2 horas)
1. ✅ Crear migración con índices GIN
2. ✅ Actualizar `QueryReportsDto` con filtros metadata
3. ✅ Actualizar `ReportsService` con queries JSONB
4. ✅ Tests de integración

### Fase 3: Documentación (1 hora)
1. ✅ Actualizar REDIS_EVENTS.md con ejemplos de metadata
2. ✅ Crear METADATA.md con guía de uso
3. ✅ Actualizar README.md

**Total estimado:** 4-6 horas

---

## 🎯 Decisión Final

**Implementar Opción 2 (JSONB Metadata)** porque:

1. ✅ Ya está 80% implementado
2. ✅ Máxima flexibilidad sin sacrificar performance
3. ✅ Industry standard (usado por Stripe, GitHub, etc.)
4. ✅ PostgreSQL JSONB es production-proven
5. ✅ Type-safe con TypeScript
6. ✅ Fácil de documentar y usar

**NO implementar:**
- ❌ Campos específicos (limitado, inflexible)
- ❌ Híbrido (complejidad innecesaria)
