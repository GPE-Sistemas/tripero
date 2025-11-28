<div align="center">

<img src="https://storage.googleapis.com/assets-generales/tripero-beta.png" width="200" alt="Tripero Logo" />

# Tripero

**Intelligent GPS Trip Detection & Stop Analysis Microservice**

*Production-ready, real-time trip detection and analysis for GPS tracking systems*

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue.svg)](https://www.typescriptlang.org/)
[![NestJS](https://img.shields.io/badge/NestJS-10.0-red.svg)](https://nestjs.com/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-blue.svg)](https://www.postgresql.org/)

[Features](#-features) • [Quick Start](#-quick-start) • [API Docs](#-api-documentation) • [Architecture](#-architecture) • [Contributing](#-contributing)

</div>

---

## 📋 Overview

**Tripero** is an open-source microservice that provides intelligent, real-time detection and analysis of vehicle trips and stops from GPS position data. Built with enterprise-grade technologies and designed for high-throughput GPS tracking systems.

### Why Tripero?

- **🎯 Precise Detection**: Advanced state machine with configurable thresholds for accurate trip/stop detection
- **⚡ Real-time Processing**: Event-driven architecture with Redis pub/sub for instant analysis
- **📊 Optimized Storage**: PostgreSQL with time-indexed queries for efficient historical data access
- **🔄 Dual State Management**: Redis for real-time state + PostgreSQL for persistence
- **📈 Production Ready**: Built-in health checks, metrics, and Kubernetes deployment support
- **🛠️ Traccar Compatible**: Drop-in replacement with compatible API endpoints

---

## ✨ Features

### Core Capabilities

- **🚦 Trip Detection**
  - Ignition-based detection (accurate start/stop with engine on/off)
  - Motion-based detection (fallback for devices without ignition sensor)
  - Configurable duration and distance thresholds
  - Automatic trip discard for very short trips

- **⏸️ Stop Analysis**
  - Intelligent stop detection during trips
  - Classification by reason: `ignition_off`, `no_movement`, `parking`
  - Duration tracking and location capture
  - Automatic geocoding support (extensible)

- **📏 Odometer Management** ✨ *New in v0.3.0*
  - Cumulative distance tracking per device (total odometer)
  - **Initial odometer setting with offset** (sync with vehicle's real odometer)
  - Per-trip odometer with start/end values
  - Haversine formula for GPS distance calculation
  - Safety validations to prevent impossible distance jumps (>200 km/h)
  - REST API endpoint to configure odometer offset

- **📊 Statistics & Reporting**
  - Real-time tracker status with current state
  - Historical trip and stop reports (Traccar-compatible API)
  - Accumulated statistics: total trips, driving time, idle time, stops
  - Device health monitoring (online/offline/stale)

- **🔔 Real-time Events** ✨ *New in v0.3.0*
  - **Redis PubSub for real-time state changes** (no polling needed!)
  - Event: `tracker:state:changed` - State transitions (STOPPED ↔ IDLE ↔ MOVING)
  - Enhanced events: All trip/stop events now include `currentState` and `odometer`
  - Instant notifications for external systems (IRIX, dashboards, etc.)
  - See [REDIS_EVENTS.md](./REDIS_EVENTS.md) for complete event API documentation

- **🏷️ Custom Metadata** ✨ *New in v0.3.0*
  - Add custom metadata to GPS positions (tenant_id, fleet_id, client_id, etc.)
  - Metadata propagates automatically to trips and stops
  - Optimized database indexes for fast queries (~1-2ms for tenant_id, client_id, fleet_id)
  - Perfect for multi-tenancy, fleet management, and custom tracking
  - Flexible: Use any custom fields you need

- **🔧 Advanced Features**
  - Throttling to handle high-frequency GPS updates
  - State persistence with automatic sync (every 100 positions or hourly)
  - Event-driven architecture for extensibility
  - Optimized indexes for fast time-based queries

---

## 🚀 Quick Start

### Prerequisites

- **Node.js** 20+
- **Docker** and **Docker Compose**

### Installation

1. **Clone and navigate to the project**:
```bash
git clone <repository-url>
cd tripero
```

2. **Install dependencies**:
```bash
npm install
```

3. **Configure environment**:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. **Start infrastructure services** (PostgreSQL + Redis):
```bash
docker-compose up -d
```

5. **Start the application**:
```bash
npm run start:dev
```

The database will be automatically initialized on first run.

6. **Verify it's running**:
```bash
curl http://localhost:3001/health
```

You should see:
```json
{
  "status": "ok",
  "timestamp": "2024-11-14T23:00:00.000Z",
  "services": {
    "redis": { "status": "up" },
    "database": { "status": "up" }
  }
}
```

### Quick Test

Run the included simulation script to see Tripero in action:

```bash
node test/simulate-trip.js
```

This simulates a complete trip with:
- Ignition ON → vehicle starts moving
- Movement for ~70 meters
- Stop for 12+ seconds (stop detection)
- Resume movement
- Ignition OFF → trip ends

Check the results:
```bash
# Get tracker status
curl http://localhost:3001/trackers/TEST-DEVICE-001/status

# Get trip history
curl "http://localhost:3001/api/reports/trips?deviceId=TEST-DEVICE-001&from=2024-01-01T00:00:00Z&to=2025-12-31T23:59:59Z"

# Get stop history
curl "http://localhost:3001/api/reports/stops?deviceId=TEST-DEVICE-001&from=2024-01-01T00:00:00Z&to=2025-12-31T23:59:59Z"
```

---

## 📚 API Documentation

### Tracker Status API

**Get real-time status of a tracker**

```http
GET /trackers/:trackerId/status
```

**Example Response**:
```json
{
  "success": true,
  "data": {
    "trackerId": "VEHICLE-001",
    "deviceId": "VEHICLE-001",
    "odometer": {
      "total": 125430,
      "totalKm": 125,
      "currentTrip": 8540,
      "currentTripKm": 8
    },
    "currentState": {
      "state": "MOVING",
      "since": "2024-11-14T10:30:00.000Z",
      "duration": 3600
    },
    "lastPosition": {
      "timestamp": "2024-11-14T11:30:00.000Z",
      "latitude": -31.4201,
      "longitude": -64.1888,
      "speed": 45,
      "ignition": true,
      "heading": 135,
      "altitude": 420,
      "age": 5
    },
    "currentTrip": {
      "tripId": "trip_VEHICLE-001_1731582600000_abc123",
      "startTime": "2024-11-14T10:30:00.000Z",
      "duration": 3600,
      "distance": 8540,
      "avgSpeed": 8,
      "maxSpeed": 60,
      "odometerAtStart": 116890
    },
    "statistics": {
      "totalTrips": 45,
      "totalDrivingTime": 180000,
      "totalDrivingHours": 50,
      "totalIdleTime": 18000,
      "totalIdleHours": 5,
      "totalStops": 120,
      "firstSeen": "2024-01-01T00:00:00.000Z",
      "lastSeen": "2024-11-14T11:30:00.000Z",
      "daysActive": 318
    },
    "health": {
      "status": "online",
      "lastSeenAgo": 5
    }
  }
}
```

**State Values**:
- `MOVING` - Vehicle is in motion (ignition ON and speed > threshold)
- `IDLE` - Vehicle stopped but ignition ON (motor running, vehicle stationary)
- `STOPPED` - Vehicle completely stopped (ignition OFF, no movement)

---

### Reports API (Traccar Compatible)

**Get trip history**

```http
GET /api/reports/trips?deviceId=VEHICLE-001&from=2024-11-01T00:00:00Z&to=2024-11-30T23:59:59Z
```

**Query Parameters**:
- `deviceId` - Device ID(s), comma-separated for multiple devices, or "all" for all devices
- `from` - Start date (ISO 8601 format)
- `to` - End date (ISO 8601 format)
- `tenantId` ✨ *v0.3.0* - Filter by tenant ID (optimized, ~1-2ms)
- `clientId` ✨ *v0.3.0* - Filter by client ID (optimized, ~1-2ms)
- `fleetId` ✨ *v0.3.0* - Filter by fleet ID (optimized, ~1-2ms)
- `metadata` ✨ *v0.3.0* - Filter by custom metadata (JSON string, ~5-10ms)

**Metadata Filter Examples**:
```bash
# Filter by tenant (optimized)
GET /api/reports/trips?tenantId=acme-corp&from=...&to=...

# Filter by fleet (optimized)
GET /api/reports/trips?fleetId=delivery-trucks&from=...&to=...

# Combine optimized filters
GET /api/reports/trips?tenantId=acme-corp&fleetId=delivery-trucks&from=...&to=...

# Filter by custom metadata fields
GET /api/reports/trips?metadata={"driver_id":"driver-123","region":"north"}&from=...&to=...
```

**Example Response**:
```json
[
  {
    "deviceId": "VEHICLE-001",
    "deviceName": null,
    "maxSpeed": 85,
    "averageSpeed": 42,
    "distance": 12450,
    "spentFuel": null,
    "duration": 1068,
    "startTime": "2024-11-14T08:00:00.000Z",
    "startAddress": null,
    "startLat": -31.4201,
    "startLon": -64.1888,
    "endTime": "2024-11-14T08:17:48.000Z",
    "endAddress": null,
    "endLat": -31.3956,
    "endLon": -64.2134,
    "driverUniqueId": null,
    "driverName": null
  }
]
```

---

**Get stop history**

```http
GET /api/reports/stops?deviceId=VEHICLE-001&from=2024-11-01T00:00:00Z&to=2024-11-30T23:59:59Z
```

**Query Parameters**: Same as trips (including metadata filters)

**Example Response**:
```json
[
  {
    "deviceId": "VEHICLE-001",
    "deviceName": null,
    "duration": 720,
    "startTime": "2024-11-14T12:00:00.000Z",
    "endTime": "2024-11-14T12:12:00.000Z",
    "latitude": -31.4201,
    "longitude": -64.1888,
    "address": null,
    "engineHours": null
  }
]
```

---

### Position Ingestion

Tripero subscribes to the Redis channel `position:new` for incoming GPS positions.

**Position Event Format** (publish to `position:new`):
```json
{
  "deviceId": "VEHICLE-001",
  "timestamp": 1731582600000,
  "latitude": -31.4201,
  "longitude": -64.1888,
  "speed": 45,
  "heading": 135,
  "altitude": 420,
  "ignition": true,
  "metadata": {
    "tenant_id": "acme-corp",
    "fleet_id": "delivery-trucks",
    "driver_id": "driver-123"
  }
}
```

> **Note:** The `metadata` field is optional but recommended. It propagates automatically to all trips and stops.

**Events Published by Tripero**:

- `tracker:state:changed` ✨ *v0.3.0* - Tracker state transition (STOPPED ↔ IDLE ↔ MOVING)
- `trip:started` - Trip has started
- `trip:completed` - Trip has ended
- `stop:started` - Stop detected during trip
- `stop:completed` - Stop has ended

> 📘 **See [REDIS_EVENTS.md](./REDIS_EVENTS.md)** for complete event payloads, examples, and integration patterns.

---

### Odometer Management ✨ *New in v0.3.0*

**Set initial odometer** (to sync with vehicle's real odometer):

```http
POST /trackers/:trackerId/odometer
Content-Type: application/json

{
  "initialOdometer": 125000000,
  "reason": "vehicle_odometer_sync"
}
```

**Example Response**:
```json
{
  "success": true,
  "message": "Odometer set to 125000000 meters",
  "data": {
    "trackerId": "VEHICLE-001",
    "previousOdometer": 50000,
    "previousOdometerKm": 50,
    "newOdometer": 125000000,
    "newOdometerKm": 125000,
    "odometerOffset": 124950000,
    "odometerOffsetKm": 124950,
    "reason": "vehicle_odometer_sync",
    "updatedAt": "2025-11-17T10:30:00.000Z"
  }
}
```

**How it works**:
- Tripero calculates GPS-based odometer automatically
- Setting initial odometer adds an offset: `realOdometer = gpsOdometer + offset`
- All future readings include this offset
- Useful when replacing GPS device or syncing with vehicle's dashboard

---

## 🏗️ Architecture

### High-Level Overview

```
┌─────────────────┐
│  GPS Devices    │
└────────┬────────┘
         │ Position Data
         ▼
┌─────────────────┐
│  Position       │
│  Ingestion      │──┐
│  (External)     │  │
└─────────────────┘  │
                     │ Publish to Redis
                     │ channel: position:new
                     ▼
         ┌───────────────────────┐
         │                       │
         │      TRIPERO          │
         │                       │
         │  ┌─────────────────┐  │
         │  │ Position        │  │
         │  │ Processor       │  │
         │  └────────┬────────┘  │
         │           │           │
         │  ┌────────▼────────┐  │
         │  │ State Machine   │  │
         │  │ (Trip/Stop      │  │
         │  │  Detection)     │  │
         │  └────────┬────────┘  │
         │           │           │
         │  ┌────────▼────────┐  │
         │  │ Event Publisher │  │
         │  │ (Redis Pub/Sub) │  │
         │  └────────┬────────┘  │
         │           │           │
         │  ┌────────▼────────┐  │
         │  │ Persistence     │  │
         │  │ Services        │  │
         │  └─────────────────┘  │
         │                       │
         └───────────────────────┘
                     │
         ┌───────────┼───────────┐
         │           │           │
         ▼           ▼           ▼
    ┌────────┐ ┌──────────┐ ┌────────┐
    │ Redis  │ │PostgreSQL│ │ Event  │
    │(Cache &│ │(Persistent│ │Consumers│
    │ State) │ │  Storage) │ │(External)│
    └────────┘ └──────────┘ └────────┘
```

### Key Components

1. **Position Processor** (`position-processor.service.ts`)
   - Orchestrates the entire position processing pipeline
   - Throttling, validation, odometer calculation
   - Coordinates state machine and persistence

2. **State Machine** (`state-machine.service.ts`)
   - Implements trip/stop detection logic
   - Manages state transitions: UNKNOWN → IDLE → MOVING → PAUSED → STOPPED
   - Configurable thresholds for different detection modes

3. **Tracker State Service** (`tracker-state.service.ts`)
   - Manages tracker state (odometer, last position, statistics)
   - Dual storage: Redis (real-time) + PostgreSQL (persistent)
   - Automatic sync every 100 positions or hourly

4. **Event Publisher** (`event-publisher.service.ts`)
   - Publishes events to Redis channels
   - Enables event-driven integration with external systems

5. **Persistence Services** (`trip-persistence.service.ts`, `stop-persistence.service.ts`)
   - Listen to trip/stop events and persist to PostgreSQL
   - Manage trip/stop lifecycle (create, update, complete)

### Data Flow

1. **Position arrives** → Published to Redis `position:new` channel
2. **Position Subscriber** → Receives and validates position
3. **Position Processor** → Processes position through pipeline:
   - Throttling check
   - Odometer calculation and update
   - State machine processing
   - State persistence
   - Event publishing
4. **Persistence Services** → React to events and persist to PostgreSQL
5. **API Layer** → Serves historical and real-time data

---

## 🗄️ Database Schema

### Tables

**trips** (PostgreSQL table)
- Stores completed trips with start/end times, distance, duration, speeds
- Indexed by `(id_activo, start_time)` and `(start_time)` for efficient time-series queries

**stops** (PostgreSQL table)
- Stores stops with location, duration, and reason
- Linked to trips via `trip_id`
- Indexed by `(id_activo, start_time)` for efficient queries

**tracker_state**
- Current state of each tracker
- Odometer, statistics, last position
- Synced from Redis periodically

### Indexes

Optimized for common query patterns:
- Device ID + time range queries
- Active trip/stop lookups
- Tracker status retrieval

---

## 🛠️ Configuration

### Environment Variables

```bash
# Server
PORT=3001
NODE_ENV=development

# Database (PostgreSQL)
DB_HOST=localhost
DB_PORT=5432
DB_USERNAME=postgres
DB_PASSWORD=postgres
DB_DATABASE=tripero
DB_LOGGING=false  # Enable SQL query logging for debugging

# Redis
REDIS_HOST=localhost
REDIS_PORT=6380
REDIS_DB=0

# Trip Detection Thresholds
TRIP_MIN_DURATION=60              # Minimum trip duration (seconds)
TRIP_MIN_DISTANCE=100             # Minimum trip distance (meters)
MOVING_THRESHOLD_SPEED=5          # Speed to consider "moving" (km/h)
STOP_DETECTION_TIME=10            # Time stopped to trigger stop event (seconds)
POSITION_THROTTLE_INTERVAL=5      # Minimum seconds between position processing

# Logging
LOG_LEVEL=debug
```

### Threshold Tuning

Adjust detection sensitivity based on your use case:

**Urban delivery** (frequent stops):
```bash
TRIP_MIN_DURATION=30
TRIP_MIN_DISTANCE=50
MOVING_THRESHOLD_SPEED=3
STOP_DETECTION_TIME=5
```

**Long-haul trucking** (fewer stops):
```bash
TRIP_MIN_DURATION=300
TRIP_MIN_DISTANCE=1000
MOVING_THRESHOLD_SPEED=10
STOP_DETECTION_TIME=30
```

---

## 📦 Project Structure

```
tripero/
├── src/
│   ├── auxiliares/           # Auxiliary services
│   │   ├── redis/           # Redis client & service
│   │   ├── http/            # HTTP client
│   │   └── logger/          # Custom logger
│   ├── database/            # Database layer
│   │   ├── entities/        # TypeORM entities
│   │   └── repositories/    # Data access repositories
│   ├── detection/           # Core trip/stop detection
│   │   ├── services/        # Detection services
│   │   │   ├── position-processor.service.ts
│   │   │   ├── state-machine.service.ts
│   │   │   ├── tracker-state.service.ts
│   │   │   ├── trip-persistence.service.ts
│   │   │   └── stop-persistence.service.ts
│   │   └── models/          # Domain models
│   ├── trackers/            # Tracker API
│   │   └── trackers.controller.ts
│   ├── reports/             # Reports API
│   │   └── reports.controller.ts
│   ├── health/              # Health checks
│   ├── interfaces/          # TypeScript interfaces
│   ├── models/              # Domain models
│   ├── app.module.ts        # Main application module
│   └── main.ts              # Bootstrap
├── test/                    # Test & simulation scripts
│   └── simulate-trip.js     # Trip simulation script
├── docs/                    # Documentation
│   ├── ARQUITECTURA.md      # Architecture decisions
│   ├── TESTING.md           # Testing guide
│   └── INTEGRACION.md       # Integration guide
├── docker-compose.yml       # Local development stack
├── Dockerfile               # Production container
└── init-db.sql             # Database initialization
```

---

## 🧪 Testing

### Run the trip simulation

```bash
node test/simulate-trip.js
```

This simulates a complete vehicle trip including:
- Ignition events
- Movement patterns
- Stops
- Speed variations

### Manual testing with Redis CLI

Publish a test position:
```bash
docker-compose exec redis redis-cli
> PUBLISH position:new '{"deviceId":"TEST-001","timestamp":1731582600000,"latitude":-31.4201,"longitude":-64.1888,"speed":45,"heading":135,"altitude":420,"ignition":true}'
```

Monitor events:
```bash
# In another terminal
docker-compose exec redis redis-cli
> SUBSCRIBE trip:started trip:completed stop:started stop:completed
```

### Check state in Redis

```bash
docker-compose exec redis redis-cli GET tracker:state:TEST-001
```

### Query database directly

```bash
docker-compose exec postgres psql -U postgres -d tripero
```

```sql
-- View recent trips
SELECT * FROM trips ORDER BY start_time DESC LIMIT 10;

-- View stops
SELECT * FROM stops ORDER BY start_time DESC LIMIT 10;

-- View tracker state
SELECT * FROM tracker_state;
```

---

## 🚢 Deployment

### Docker

Build production image:
```bash
docker build -t tripero:latest .
```

Run with docker-compose:
```bash
docker-compose -f docker-compose.prod.yml up -d
```

### Kubernetes

See deployment manifests in your cluster repository. Tripero includes:
- Health check endpoints (`/health`, `/health/ready`)
- Graceful shutdown
- Prometheus metrics (TODO)

**Example deployment**:
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: tripero
spec:
  replicas: 3
  template:
    spec:
      containers:
      - name: tripero
        image: tripero:latest
        ports:
        - containerPort: 3001
        livenessProbe:
          httpGet:
            path: /health
            port: 3001
          initialDelaySeconds: 30
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3001
          initialDelaySeconds: 5
          periodSeconds: 5
```

---

## 🔌 Integration Examples

### Consuming Trip Events

**Node.js example**:
```javascript
const Redis = require('ioredis');
const subscriber = new Redis({ host: 'localhost', port: 6380 });

subscriber.subscribe('trip:started', 'trip:completed');

subscriber.on('message', (channel, message) => {
  const event = JSON.parse(message);

  if (channel === 'trip:started') {
    console.log(`Trip started: ${event.tripId} for device ${event.deviceId}`);
    // Send notification, update dashboard, etc.
  }

  if (channel === 'trip:completed') {
    console.log(`Trip completed: ${event.tripId}`);
    console.log(`  Duration: ${event.duration}s, Distance: ${event.distance}m`);
    // Generate report, calculate fuel consumption, etc.
  }
});
```

### Publishing Positions

**From your GPS gateway**:
```javascript
const Redis = require('ioredis');
const publisher = new Redis({ host: 'localhost', port: 6380 });

async function publishPosition(deviceId, gpsData, metadata = {}) {
  const position = {
    deviceId,
    timestamp: Date.now(),
    latitude: gpsData.lat,
    longitude: gpsData.lon,
    speed: gpsData.speed,
    heading: gpsData.heading || 0,
    altitude: gpsData.altitude || 0,
    ignition: gpsData.ignition || false,
    metadata: metadata  // Optional: tenant_id, fleet_id, driver_id, etc.
  };

  await publisher.publish('position:new', JSON.stringify(position));
}

// Example with metadata for multi-tenancy
publishPosition('VEHICLE-001', gpsData, {
  tenant_id: 'acme-corp',
  fleet_id: 'delivery-trucks',
  driver_id: 'driver-123'
});
```

---

## 📖 Documentation

- **[REDIS_EVENTS.md](./REDIS_EVENTS.md)** - Complete Redis PubSub events API reference
- **[METADATA_ANALYSIS.md](./METADATA_ANALYSIS.md)** - Metadata feature analysis and implementation
- **[ARQUITECTURA.md](./ARQUITECTURA.md)** - Architectural decisions (ADRs)
- **[TESTING.md](./TESTING.md)** - Comprehensive testing guide
- **[INTEGRACION.md](./INTEGRACION.md)** - Integration with external systems
- **[TODO.md](./TODO.md)** - Project roadmap and pending tasks
- **[PLAN-IMPLEMENTACION-TRIP-DETECTION.md](./PLAN-IMPLEMENTACION-TRIP-DETECTION.md)** - Implementation plan
- **[ANALISIS-TRIPS-TRACCAR.md](./ANALISIS-TRIPS-TRACCAR.md)** - Analysis of Traccar's trip system

---

## 🗺️ Roadmap

### ✅ Phase 0: Foundation (Completed)
- [x] Trip detection (ignition + motion based)
- [x] Stop detection and persistence
- [x] Odometer calculation and accumulation
- [x] Tracker state management
- [x] Event-driven architecture
- [x] PostgreSQL integration
- [x] Traccar-compatible API
- [x] Real-time state change events (v0.3.0)
- [x] Odometer offset and management (v0.3.0)
- [x] Custom metadata support for multi-tenancy (v0.3.0)

### 🚧 Phase 1: Enhancements (In Progress)
- [ ] Metadata-based query filters in Reports API
- [ ] Geocoding integration for addresses
- [ ] Prometheus metrics
- [ ] GraphQL API
- [ ] WebSocket support for real-time updates
- [ ] Advanced analytics (fuel consumption estimation)
- [ ] Driver behavior scoring

### 🔮 Phase 2: Advanced Features (Future)
- [ ] Machine learning for anomaly detection
- [ ] Predictive maintenance alerts
- [ ] Route optimization suggestions
- [ ] Admin dashboard

See [TODO.md](./TODO.md) for detailed task list.

---

## 🤝 Contributing

Contributions are welcome! Here's how you can help:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Commit** your changes (`git commit -m 'Add amazing feature'`)
4. **Push** to the branch (`git push origin feature/amazing-feature`)
5. **Open** a Pull Request

### Development Guidelines

- Follow the existing code style (NestJS conventions)
- Add tests for new features
- Update documentation
- Ensure CI passes

### Ideas for Contributions

See [TODO.md](./TODO.md) for a list of planned features and improvements.

---

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

```
MIT License

Copyright (c) 2024 GPE Sistemas

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction...
```

---

## 🙏 Acknowledgments

- **NestJS** - Framework for building efficient server-side applications
- **PostgreSQL** - Time-series database for IoT and GPS data
- **Traccar** - Inspiration for API compatibility
- **GPE Sistemas** - Development and maintenance

---

## 📞 Support

- **Issues**: [GitHub Issues](../../issues)
- **Discussions**: [GitHub Discussions](../../discussions)
- **Email**: support@gpesistemas.com

---

<div align="center">

**Made with ❤️ by GPE Sistemas**

⭐ Star this repo if you find it useful!

[Report Bug](../../issues) · [Request Feature](../../issues) · [Documentation](./docs/)

</div>
