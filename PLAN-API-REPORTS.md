# Plan de Implementación: API Reportes Históricos

## Objetivo
Crear endpoints REST compatibles con Traccar para consultar trips y stops históricos.

## 1. Crear Módulo Reports

### reports/reports.module.ts
```typescript
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
```

## 2. Crear DTOs

### reports/dto/query-reports.dto.ts
```typescript
import { IsString, IsOptional, IsDateString, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';

export class QueryReportsDto {
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(id => id.trim());
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  deviceId?: string[];

  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map(id => id.trim());
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  groupId?: string[];

  @IsDateString()
  from: string; // ISO 8601

  @IsDateString()
  to: string; // ISO 8601
}
```

### reports/dto/trip-response.dto.ts
```typescript
// Compatible con formato Traccar
export class TripResponseDto {
  deviceId: string;
  deviceName?: string;
  maxSpeed: number;
  averageSpeed: number;
  distance: number;
  spentFuel?: number;
  duration: number;
  startTime: string; // ISO 8601
  startAddress?: string;
  startLat: number;
  startLon: number;
  endTime: string;
  endAddress?: string;
  endLat: number;
  endLon: number;
  driverUniqueId?: string;
  driverName?: string;
}
```

### reports/dto/stop-response.dto.ts
```typescript
// Compatible con formato Traccar
export class StopResponseDto {
  deviceId: string;
  deviceName?: string;
  duration: number;
  startTime: string; // ISO 8601
  endTime: string;
  latitude: number;
  longitude: number;
  address?: string;
  engineHours?: number;
}
```

## 3. Crear Service

### reports/reports.service.ts
```typescript
import { Injectable } from '@nestjs/common';
import { TripRepository } from '../database/repositories/trip.repository';
import { StopRepository } from '../database/repositories/stop.repository';
import { QueryReportsDto } from './dto/query-reports.dto';
import { TripResponseDto } from './dto/trip-response.dto';
import { StopResponseDto } from './dto/stop-response.dto';

@Injectable()
export class ReportsService {
  constructor(
    private readonly tripRepository: TripRepository,
    private readonly stopRepository: StopRepository,
  ) {}

  async getTrips(query: QueryReportsDto): Promise<TripResponseDto[]> {
    const { deviceId, from, to } = query;
    const fromDate = new Date(from);
    const toDate = new Date(to);

    // Si hay deviceId específico, filtrar por él
    if (deviceId && deviceId.length > 0) {
      const allTrips = await Promise.all(
        deviceId.map(id =>
          this.tripRepository.findByAssetAndTimeRange(id, fromDate, toDate),
        ),
      );
      const trips = allTrips.flat();
      return this.mapTripsToDto(trips);
    }

    // Si no, traer todos los trips en el rango de fechas
    const trips = await this.tripRepository.findByTimeRange(fromDate, toDate);
    return this.mapTripsToDto(trips);
  }

  async getStops(query: QueryReportsDto): Promise<StopResponseDto[]> {
    const { deviceId, from, to } = query;
    const fromDate = new Date(from);
    const toDate = new Date(to);

    if (deviceId && deviceId.length > 0) {
      const allStops = await Promise.all(
        deviceId.map(id =>
          this.stopRepository.findByAssetAndTimeRange(id, fromDate, toDate),
        ),
      );
      const stops = allStops.flat();
      return this.mapStopsToDto(stops);
    }

    const stops = await this.stopRepository.findByTimeRange(fromDate, toDate);
    return this.mapStopsToDto(stops);
  }

  private mapTripsToDto(trips: Trip[]): TripResponseDto[] {
    return trips.map(trip => ({
      deviceId: trip.id_activo,
      deviceName: undefined, // TODO: join con activos si se necesita
      maxSpeed: trip.max_speed,
      averageSpeed: trip.avg_speed,
      distance: trip.distance,
      spentFuel: undefined, // TODO: calcular si hay sensores
      duration: trip.duration,
      startTime: trip.start_time.toISOString(),
      startAddress: trip.start_address,
      startLat: trip.start_lat,
      startLon: trip.start_lon,
      endTime: trip.end_time?.toISOString(),
      endAddress: trip.end_address,
      endLat: trip.end_lat,
      endLon: trip.end_lon,
      driverUniqueId: undefined, // TODO: si se necesita
      driverName: undefined,
    }));
  }

  private mapStopsToDto(stops: Stop[]): StopResponseDto[] {
    return stops.map(stop => ({
      deviceId: stop.id_activo,
      deviceName: undefined,
      duration: stop.duration,
      startTime: stop.start_time.toISOString(),
      endTime: stop.end_time?.toISOString(),
      latitude: stop.latitude,
      longitude: stop.longitude,
      address: stop.address,
      engineHours: undefined, // TODO: si se necesita
    }));
  }
}
```

## 4. Crear Controller

### reports/reports.controller.ts
```typescript
import { Controller, Get, Query, ValidationPipe } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { QueryReportsDto } from './dto/query-reports.dto';
import { TripResponseDto } from './dto/trip-response.dto';
import { StopResponseDto } from './dto/stop-response.dto';

@Controller('api/reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /**
   * GET /api/reports/trips
   * Compatible con Traccar API
   *
   * Query params:
   * - deviceId: string | string[] (comma-separated)
   * - groupId: string | string[] (comma-separated, opcional)
   * - from: ISO 8601 date-time
   * - to: ISO 8601 date-time
   *
   * Ejemplo:
   * /api/reports/trips?deviceId=TEST-001&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
   * /api/reports/trips?deviceId=TEST-001,TEST-002&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z
   */
  @Get('trips')
  async getTrips(
    @Query(new ValidationPipe({ transform: true }))
    query: QueryReportsDto,
  ): Promise<TripResponseDto[]> {
    return await this.reportsService.getTrips(query);
  }

  /**
   * GET /api/reports/stops
   * Compatible con Traccar API
   *
   * Query params:
   * - deviceId: string | string[] (comma-separated)
   * - groupId: string | string[] (comma-separated, opcional)
   * - from: ISO 8601 date-time
   * - to: ISO 8601 date-time
   */
  @Get('stops')
  async getStops(
    @Query(new ValidationPipe({ transform: true }))
    query: QueryReportsDto,
  ): Promise<StopResponseDto[]> {
    return await this.reportsService.getStops(query);
  }
}
```

## 5. Actualizar App Module

### app.module.ts
```typescript
import { ReportsModule } from './reports/reports.module';

@Module({
  imports: [
    // ... otros imports
    ReportsModule,
  ],
})
export class AppModule {}
```

## 6. Agregar métodos faltantes a Repositories

### database/repositories/trip.repository.ts
```typescript
// Agregar si no existe
async findByTimeRange(startTime: Date, endTime: Date): Promise<Trip[]> {
  return await this.tripRepo.find({
    where: {
      start_time: Between(startTime, endTime),
    },
    order: { start_time: 'DESC' },
  });
}
```

### database/repositories/stop.repository.ts
```typescript
// Agregar
async findByTimeRange(startTime: Date, endTime: Date): Promise<Stop[]> {
  return await this.stopRepo.find({
    where: {
      start_time: Between(startTime, endTime),
    },
    order: { start_time: 'DESC' },
  });
}
```

## 7. Testing

### reports/reports.controller.spec.ts
```typescript
describe('ReportsController', () => {
  describe('GET /api/reports/trips', () => {
    it('debe retornar trips para un device en rango de fechas', async () => {
      const query = {
        deviceId: 'TEST-001',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-31T23:59:59Z',
      };

      const response = await request(app.getHttpServer())
        .get('/api/reports/trips')
        .query(query)
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
      expect(response.body[0]).toMatchObject({
        deviceId: 'TEST-001',
        maxSpeed: expect.any(Number),
        averageSpeed: expect.any(Number),
        distance: expect.any(Number),
        duration: expect.any(Number),
        startTime: expect.any(String),
        endTime: expect.any(String),
      });
    });

    it('debe soportar múltiples deviceIds', async () => {
      const query = {
        deviceId: 'TEST-001,TEST-002',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-31T23:59:59Z',
      };

      const response = await request(app.getHttpServer())
        .get('/api/reports/trips')
        .query(query)
        .expect(200);

      const deviceIds = response.body.map(trip => trip.deviceId);
      expect(deviceIds).toContain('TEST-001');
      expect(deviceIds).toContain('TEST-002');
    });
  });

  describe('GET /api/reports/stops', () => {
    it('debe retornar stops para un device en rango de fechas', async () => {
      const query = {
        deviceId: 'TEST-001',
        from: '2024-01-01T00:00:00Z',
        to: '2024-01-31T23:59:59Z',
      };

      const response = await request(app.getHttpServer())
        .get('/api/reports/stops')
        .query(query)
        .expect(200);

      expect(response.body).toBeInstanceOf(Array);
      expect(response.body[0]).toMatchObject({
        deviceId: 'TEST-001',
        duration: expect.any(Number),
        startTime: expect.any(String),
        endTime: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
      });
    });
  });
});
```

## 8. Documentación OpenAPI

```typescript
// Agregar decoradores Swagger
@ApiTags('reports')
@Controller('api/reports')
export class ReportsController {
  @Get('trips')
  @ApiOperation({ summary: 'Obtener trips históricos' })
  @ApiQuery({ name: 'deviceId', required: false, type: String, description: 'ID del dispositivo o lista separada por comas' })
  @ApiQuery({ name: 'from', required: true, type: String, description: 'Fecha inicio en formato ISO 8601' })
  @ApiQuery({ name: 'to', required: true, type: String, description: 'Fecha fin en formato ISO 8601' })
  @ApiResponse({ status: 200, description: 'Lista de trips', type: [TripResponseDto] })
  async getTrips(...) { ... }
}
```

## Criterios de Aceptación

- [ ] Endpoint GET /api/reports/trips funcional
- [ ] Endpoint GET /api/reports/stops funcional
- [ ] Soporta filtro por deviceId (uno o múltiples)
- [ ] Soporta filtro por rango de fechas (from/to)
- [ ] Formato de respuesta compatible con Traccar
- [ ] Query params transformados correctamente (comma-separated a array)
- [ ] Retorna arrays vacíos si no hay datos (no 404)
- [ ] Tests unitarios e integración
- [ ] Documentación OpenAPI/Swagger

## Ejemplo de Uso

```bash
# Un solo device
curl "http://localhost:3000/api/reports/trips?deviceId=TEST-001&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z"

# Múltiples devices
curl "http://localhost:3000/api/reports/trips?deviceId=TEST-001,TEST-002&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z"

# Stops
curl "http://localhost:3000/api/reports/stops?deviceId=TEST-001&from=2024-01-01T00:00:00Z&to=2024-01-31T23:59:59Z"
```

## Notas

- La API es compatible con la API de Traccar, lo que facilita la migración
- El parámetro `groupId` está soportado en el DTO pero no implementado (puede agregarse después si se necesita)
- El mapeo a DTOs permite agregar campos adicionales en el futuro sin romper la compatibilidad
