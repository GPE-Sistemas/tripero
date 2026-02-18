# Tripero - Copilot Instructions

**Tripero** is an intelligent GPS trip detection & stop analysis microservice built with NestJS, PostgreSQL, and Redis. It processes GPS positions in real-time to detect trips, stops, and vehicle state changes.

## Build, Test, and Lint Commands

```bash
# Development
npm run start:dev          # Start with hot-reload
npm run start:debug        # Start with debugging enabled

# Build
npm run build             # Compile TypeScript to dist/

# Testing
npm test                  # Run unit tests with Jest
npm run test:watch        # Run tests in watch mode
npm run test:cov          # Run tests with coverage report
npm run test:e2e          # Run end-to-end tests

# Linting & Formatting
npm run lint              # ESLint with auto-fix
npm run format            # Prettier format all files

# Simulation & Manual Testing
node test-simple-trip.js       # Simulate a simple trip
node test-long-trip.js         # Simulate a long trip with stops
node test-stops.js             # Test stop detection
node test-position-publisher.js # Test position publishing
```

## Infrastructure

```bash
# Start required services (PostgreSQL + Redis)
docker-compose up -d

# Stop services
docker-compose down

# View logs
docker-compose logs -f redis
docker-compose logs -f postgres

# Access Redis CLI
docker-compose exec redis redis-cli

# Access PostgreSQL
docker-compose exec postgres psql -U postgres -d tripero
```

## High-Level Architecture

### Data Flow

1. **Position Ingestion**: GPS positions published to Redis channel `position:new` → `PositionSubscriberService` subscribes
2. **Processing Pipeline**: `PositionProcessorService` orchestrates:
   - Device-level queue management (sequential processing per device)
   - Distance validation (detects GPS jumps >200km/h)
   - Odometer calculation (Haversine formula)
   - State machine transitions
   - Event publishing
3. **State Machine**: `StateMachineService` manages state transitions:
   - `UNKNOWN` → `IDLE` → `MOVING` → `STOPPED` (and back)
   - Trip start/end detection
   - Stop detection during trips
4. **Persistence**: Event-driven persistence services react to state changes:
   - `TripPersistenceService` - Handles trip lifecycle
   - `StopPersistenceService` - Handles stop lifecycle
5. **Dual Storage**:
   - **Redis**: Real-time tracker state, caching, pub/sub events
   - **PostgreSQL**: Persistent trips, stops, tracker state (synced periodically)

### Core Services

| Service | Purpose |
|---------|---------|
| `PositionProcessorService` | Main orchestrator for position processing pipeline |
| `StateMachineService` | Trip/stop detection state machine |
| `TrackerStateService` | Manages tracker state (odometer, last position, statistics) |
| `EventPublisherService` | Publishes events to Redis channels |
| `TripPersistenceService` | Trip CRUD and lifecycle management |
| `StopPersistenceService` | Stop CRUD and lifecycle management |
| `DistanceValidatorService` | Validates GPS accuracy, detects impossible jumps |
| `OrphanTripCleanupService` | Background job to close abandoned trips |

### State Transitions

```
UNKNOWN (first position)
   ↓
STOPPED (ignition OFF, no movement)
   ↓
IDLE (ignition ON, no movement) → trip starts
   ↓
MOVING (ignition ON, speed > threshold)
   ↓
IDLE (stopped but ignition ON) → stop detected if duration > threshold
   ↓
STOPPED (ignition OFF) → trip ends
```

## Key Conventions

### State Management

- **Motion States**: `UNKNOWN`, `STOPPED`, `IDLE`, `MOVING` (defined in `motion-state.model.ts`)
- State stored in Redis: `tracker:state:{deviceId}` with full `IDeviceMotionState` structure
- State synced to PostgreSQL periodically (every 100 positions or hourly)

### Trip Detection Thresholds

Default thresholds (configurable via environment variables):

```typescript
minMovingSpeed: 5          // km/h - speed to consider "moving"
minTripDistance: 100       // meters - minimum trip distance
minTripDuration: 60        // seconds - minimum trip duration
minStopDuration: 300       // seconds - minimum stop to segment trips
maxGapDuration: 600        // seconds - max time gap before closing trip
maxOvernightGapDuration: 1800  // seconds - forces trip close regardless of stop
maxIdleDuration: 1800      // seconds - max time in IDLE before closing trip
```

### Event-Driven Architecture

**Published Events** (Redis channels):
- `tracker:state:changed` - State transitions (STOPPED ↔ IDLE ↔ MOVING)
- `trip:started` - Trip initiated
- `trip:completed` - Trip ended
- `stop:started` - Stop detected during trip
- `stop:completed` - Stop ended

**Subscribed Events**:
- `position:new` - Incoming GPS positions
- `ignition:change` - Ignition state changes (optional)

### Metadata Propagation

- Custom metadata from GPS positions propagates to trips and stops
- Common fields: `tenant_id`, `fleet_id`, `client_id`, `driver_id`
- Optimized database indexes for `tenant_id`, `client_id`, `fleet_id` (1-2ms queries)
- Generic `metadata` JSONB column for flexible custom fields

### Distance Calculation

- Uses Haversine formula for GPS distance calculation
- Validates segments for GPS noise/jumps (rejects >200km/h speed)
- Accumulates into device odometer (total + per-trip)
- Odometer offset support (sync with vehicle's real odometer)

### Naming Conventions

- **Entities**: Singular, PascalCase (e.g., `Trip`, `Stop`, `TrackerState`)
- **Services**: `{Domain}{Action}Service` (e.g., `TripPersistenceService`)
- **Controllers**: `{Resource}Controller` (e.g., `TrackersController`, `ReportsController`)
- **Database columns**: snake_case (e.g., `start_time`, `id_activo`)
- **TypeScript interfaces**: PascalCase with `I` prefix (e.g., `IDeviceMotionState`)

### Module Organization

```
src/
├── detection/           # Core trip/stop detection logic
│   ├── services/       # State machine, position processing, persistence
│   └── models/         # Domain models and interfaces
├── trackers/           # Tracker status API
├── reports/            # Historical reports API (Traccar-compatible)
├── database/           # TypeORM entities and repositories
│   ├── entities/       # Trip, Stop, TrackerState
│   └── repositories/   # Data access layer
├── auxiliares/         # Auxiliary services
│   ├── redis/         # Redis client wrapper
│   ├── logger/        # Custom logger
│   └── http/          # HTTP client
└── health/            # Health check endpoints
```

### Database Schema Notes

- **trips** table: Stores completed trips with time-indexed queries
  - Primary index: `(id_activo, start_time)`
  - Supports filtering by metadata fields
- **stops** table: Stores stops with `trip_id` foreign key
  - Linked to trips via `trip_id`
  - Index: `(id_activo, start_time)`
- **tracker_state** table: Current state of each tracker
  - Synced from Redis periodically
  - Contains odometer, statistics, last position

### API Compatibility

Reports API is **Traccar-compatible** for easy integration:
- `GET /api/reports/trips` - Trip history
- `GET /api/reports/stops` - Stop history
- Query params: `deviceId`, `from`, `to`, `tenantId`, `fleetId`, `clientId`, `metadata`

Custom API:
- `GET /trackers/:trackerId/status` - Real-time tracker status
- `POST /trackers/:trackerId/odometer` - Set initial odometer with offset

### TypeScript Configuration

- Target: ES2023
- Module: NodeNext (ESM compatible)
- Decorators enabled (NestJS requirement)
- Strict null checks enabled
- No implicit any disabled (legacy compatibility)

### Testing Strategy

- Unit tests: Jest with `*.spec.ts` files
- Manual testing: Simulation scripts in `/test-*.js` files
- Integration testing: Redis pub/sub with manual position publishing
- E2E tests: `/test/` directory with Jest

### Environment Variables

Essential variables (see `.env.example` for complete list):
- `PORT` - Server port (default: 3001)
- `REDIS_HOST`, `REDIS_PORT` - Redis connection
- `DB_HOST`, `DB_PORT`, `DB_DATABASE` - PostgreSQL connection
- `TRIP_MIN_DURATION`, `TRIP_MIN_DISTANCE` - Detection thresholds
- `MOVING_THRESHOLD_SPEED` - Speed threshold for movement
- `STOP_DETECTION_TIME` - Time to trigger stop event
- `REDIS_KEY_PREFIX` - Prefix for Redis keys (for shared Redis instances)

## Important Implementation Details

### Device-Level Sequential Processing

Each device has its own processing queue (`DeviceQueueManager`) to ensure:
- Positions for the same device are processed sequentially
- Prevents race conditions on state updates
- Allows parallel processing across different devices

### Distance Validation

`DistanceValidatorService` validates GPS accuracy:
- Calculates speed based on distance/time between positions
- Rejects segments with >200 km/h speed (GPS jumps/noise)
- Prevents odometer corruption from bad GPS data

### Orphan Trip Cleanup

`OrphanTripCleanupService` runs every 5 minutes to:
- Find trips without positions for >30 minutes
- Automatically close abandoned trips
- Prevents "zombie" trips from staying open indefinitely

### Trip Quality Metrics

Trips track quality metrics for debugging:
- `segmentsTotal` - Total GPS segments processed
- `segmentsAdjusted` - Segments adjusted for GPS noise
- `gpsNoiseSegments` - Segments rejected due to invalid data
- `originalDistance` vs `adjustedDistance` - Impact of noise filtering

### Redis Key Patterns

- `tracker:state:{deviceId}` - Current tracker state
- `device:queue:{deviceId}` - Processing queue state
- Channels: `position:new`, `trip:started`, `trip:completed`, `stop:started`, `stop:completed`, `tracker:state:changed`

## Development Workflow

1. **Starting development**: Run `docker-compose up -d` to start Redis and PostgreSQL
2. **Making changes**: Run `npm run start:dev` for hot-reload
3. **Testing changes**: Use simulation scripts or publish positions to Redis manually
4. **Checking state**: Query Redis with `docker-compose exec redis redis-cli GET tracker:state:TEST-001`
5. **Checking database**: Query PostgreSQL with `docker-compose exec postgres psql -U postgres -d tripero`
6. **Before committing**: Run `npm run lint` and `npm test`

## Documentation

- `README.md` - Complete API documentation and usage guide
- `ARQUITECTURA.md` - Architectural decisions (ADRs) and design rationale
- `REDIS_EVENTS.md` - Complete Redis PubSub events API reference
- `METADATA_ANALYSIS.md` - Metadata feature implementation details
- `TESTING.md` - Testing guide and manual test procedures
- `TODO.md` - Project roadmap and pending tasks
