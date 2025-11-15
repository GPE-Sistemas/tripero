# Plan de Implementación: Stop Detection

## Objetivo
Implementar detección y persistencia de stops (paradas) para reemplazar `/api/reports/stops` de Traccar.

## 1. Definir Interfaces

### interfaces/stop-events.interface.ts
```typescript
export interface IStopStartedEvent {
  stopId: string;
  deviceId: string;
  startTime: string; // ISO 8601
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  reason: 'ignition_off' | 'no_movement' | 'parking';
  tripId?: string; // Si está asociado a un trip
}

export interface IStopCompletedEvent {
  stopId: string;
  deviceId: string;
  startTime: string;
  endTime: string;
  duration: number; // Segundos
  location: {
    type: 'Point';
    coordinates: [number, number];
  };
  address?: string;
  reason: 'ignition_off' | 'no_movement' | 'parking';
  tripId?: string;
}
```

## 2. Crear Entidad Stop

### database/entities/stop.entity.ts
```typescript
@Entity('stops')
export class Stop {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'timestamptz', name: 'start_time' })
  start_time: Date;

  @Column({ type: 'timestamptz', name: 'end_time', nullable: true })
  end_time: Date | null;

  @Column({ type: 'varchar', length: 255, name: 'id_activo' })
  id_activo: string;

  @Column({ type: 'int', default: 0 })
  duration: number; // Segundos

  @Column({ type: 'float8', name: 'latitude' })
  latitude: number;

  @Column({ type: 'float8', name: 'longitude' })
  longitude: number;

  @Column({ type: 'text', name: 'address', nullable: true })
  address: string | null;

  @Column({ type: 'text', name: 'reason', default: 'ignition_off' })
  reason: string; // 'ignition_off' | 'no_movement' | 'parking'

  @Column({ type: 'uuid', name: 'trip_id', nullable: true })
  trip_id: string | null; // Si el stop ocurrió durante un trip

  @Column({ type: 'boolean', name: 'is_active', default: true })
  is_active: boolean;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  created_at: Date;

  @Column({ type: 'timestamptz', name: 'updated_at', default: () => 'CURRENT_TIMESTAMP' })
  updated_at: Date;
}
```

## 3. Crear Repository

### database/repositories/stop.repository.ts
```typescript
export interface ICreateStopData {
  id_activo: string;
  start_time: Date;
  latitude: number;
  longitude: number;
  reason: string;
  trip_id?: string;
  metadata?: Record<string, any>;
}

export interface IUpdateStopData {
  end_time?: Date;
  duration?: number;
  address?: string;
  is_active?: boolean;
  metadata?: Record<string, any>;
}

@Injectable()
export class StopRepository {
  constructor(
    @InjectRepository(Stop)
    private readonly stopRepo: Repository<Stop>,
  ) {}

  async create(data: ICreateStopData): Promise<Stop> {
    const stop = this.stopRepo.create({
      ...data,
      is_active: true,
      duration: 0,
    });
    return await this.stopRepo.save(stop);
  }

  async findActiveByAsset(id_activo: string): Promise<Stop | null> {
    return await this.stopRepo.findOne({
      where: { id_activo, is_active: true },
      order: { start_time: 'DESC' },
    });
  }

  async update(id: string, data: IUpdateStopData): Promise<Stop | null> {
    const stop = await this.stopRepo.findOne({ where: { id } });
    if (!stop) return null;

    Object.assign(stop, {
      ...data,
      updated_at: new Date(),
    });

    return await this.stopRepo.save(stop);
  }

  async findByAssetAndTimeRange(
    id_activo: string,
    startTime: Date,
    endTime: Date,
  ): Promise<Stop[]> {
    return await this.stopRepo.find({
      where: {
        id_activo,
        start_time: Between(startTime, endTime),
      },
      order: { start_time: 'DESC' },
    });
  }
}
```

## 4. Actualizar State Machine

### detection/services/state-machine.service.ts

Agregar lógica de detección de stops:

```typescript
// Configuración de thresholds para stops
private readonly STOP_SPEED_THRESHOLD = 1; // km/h
private readonly STOP_MIN_DURATION = 60; // segundos (1 minuto)

// En handleTransition, detectar inicio de stop
private async handleStoppedEntry(context: IStateContext): Promise<void> {
  const { deviceId, position } = context;

  // Si hay un trip activo, marcarlo como completado
  if (this.currentTripId) {
    await this.completeTripIfNeeded(context);
  }

  // Iniciar un nuevo stop
  const stopId = `stop_${deviceId}_${Date.now()}_${nanoid()}`;

  await this.eventPublisher.publishStopStarted({
    stopId,
    deviceId,
    startTime: position.timestamp,
    location: {
      type: 'Point',
      coordinates: [position.longitude, position.latitude],
    },
    reason: position.ignition ? 'no_movement' : 'ignition_off',
  });

  this.currentStopId = stopId;
  this.stopStartTime = Date.now();
  this.stopStartPosition = position;
}

// Completar stop cuando el vehículo se mueve
private async handleStoppedExit(context: IStateContext): Promise<void> {
  if (!this.currentStopId || !this.stopStartTime) return;

  const duration = (Date.now() - this.stopStartTime) / 1000;

  // Solo completar si el stop duró más del mínimo
  if (duration >= this.STOP_MIN_DURATION) {
    await this.eventPublisher.publishStopCompleted({
      stopId: this.currentStopId,
      deviceId: context.deviceId,
      startTime: new Date(this.stopStartTime).toISOString(),
      endTime: new Date().toISOString(),
      duration: Math.round(duration),
      location: {
        type: 'Point',
        coordinates: [
          this.stopStartPosition.longitude,
          this.stopStartPosition.latitude,
        ],
      },
      reason: context.position.ignition ? 'no_movement' : 'ignition_off',
    });
  }

  this.currentStopId = null;
  this.stopStartTime = null;
  this.stopStartPosition = null;
}
```

## 5. Crear StopPersistenceService

### detection/services/stop-persistence.service.ts

Similar a TripPersistenceService:

```typescript
@Injectable()
export class StopPersistenceService implements OnModuleInit {
  private readonly logger = new Logger(StopPersistenceService.name);
  private subscriber: any;

  constructor(
    private readonly redisService: RedisService,
    private readonly stopRepository: StopRepository,
  ) {}

  async onModuleInit() {
    await this.subscribeToStopEvents();
  }

  private async subscribeToStopEvents(): Promise<void> {
    this.subscriber = this.redisService.createSubscriber();

    this.subscriber.on('message', async (channel: string, message: string) => {
      if (channel === 'stop:started') {
        await this.handleStopStarted(message);
      } else if (channel === 'stop:completed') {
        await this.handleStopCompleted(message);
      }
    });

    await this.subscriber.subscribe('stop:started');
    await this.subscriber.subscribe('stop:completed');

    this.logger.log('Suscrito a eventos: stop:started, stop:completed');
  }

  private async handleStopStarted(message: string): Promise<void> {
    const event: IStopStartedEvent = JSON.parse(message);
    const [longitude, latitude] = event.location.coordinates;

    await this.stopRepository.create({
      id_activo: event.deviceId,
      start_time: new Date(event.startTime),
      latitude,
      longitude,
      reason: event.reason,
      trip_id: event.tripId,
      metadata: { stopId: event.stopId },
    });

    this.logger.log(`Stop ${event.stopId} creado para device ${event.deviceId}`);
  }

  private async handleStopCompleted(message: string): Promise<void> {
    const event: IStopCompletedEvent = JSON.parse(message);
    const stop = await this.stopRepository.findActiveByAsset(event.deviceId);

    if (!stop) {
      this.logger.warn(`No se encontró stop activo para device ${event.deviceId}`);
      return;
    }

    await this.stopRepository.update(stop.id, {
      end_time: new Date(event.endTime),
      duration: event.duration,
      address: event.address,
      is_active: false,
    });

    this.logger.log(`Stop ${stop.id} completado: ${event.duration}s`);
  }
}
```

## 6. Migration SQL

```sql
CREATE TABLE stops (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ,
    id_activo VARCHAR(255) NOT NULL,
    duration INT DEFAULT 0,
    latitude FLOAT8 NOT NULL,
    longitude FLOAT8 NOT NULL,
    address TEXT,
    reason TEXT DEFAULT 'ignition_off',
    trip_id UUID REFERENCES trips(id),
    is_active BOOLEAN DEFAULT true,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_stops_id_activo ON stops(id_activo);
CREATE INDEX idx_stops_start_time ON stops(start_time);
CREATE INDEX idx_stops_id_activo_start_time ON stops(id_activo, start_time);
CREATE INDEX idx_stops_is_active ON stops(is_active);

-- Convertir a table para PostgreSQL
SELECT create_table('stops', 'start_time');
```

## Testing

```typescript
// Simular stop de 2 minutos
const positions = [
  { ignition: true, speed: 50, timestamp: '2024-01-01T10:00:00Z' }, // MOVING
  { ignition: true, speed: 0, timestamp: '2024-01-01T10:00:10Z' },  // STOPPED (inicio)
  { ignition: true, speed: 0, timestamp: '2024-01-01T10:00:20Z' },
  { ignition: true, speed: 0, timestamp: '2024-01-01T10:01:00Z' },
  { ignition: true, speed: 0, timestamp: '2024-01-01T10:02:00Z' },
  { ignition: true, speed: 0, timestamp: '2024-01-01T10:02:10Z' },  // 2min 10s total
  { ignition: true, speed: 20, timestamp: '2024-01-01T10:02:20Z' }, // MOVING (fin stop)
];
```

## Criterios de Aceptación

- [ ] Stops detectados cuando speed < 1 km/h
- [ ] Stops persistidos en PostgreSQL
- [ ] Stop mínimo de 60 segundos
- [ ] Eventos stop:started y stop:completed publicados
- [ ] API /stops implementada
- [ ] Compatible con formato Traccar Stop interface
