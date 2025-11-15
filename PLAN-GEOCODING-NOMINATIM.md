# Plan de Implementación: Geocoding con Nominatim

## Objetivo
Integrar Nominatim para reverse geocoding, reemplazando la funcionalidad de Traccar.

## Opciones de Deployment Nominatim

### Opción 1: Nominatim Auto-Hospedado (Docker)
Ya tienes experiencia con esto según vi en el historial. Recomendado para IRIX.

```yaml
# docker-compose.yml
services:
  nominatim:
    image: mediagis/nominatim:4.4
    container_name: tripero-nominatim
    ports:
      - "8080:8080"
    environment:
      PBF_URL: https://download.geofabrik.de/south-america/argentina-latest.osm.pbf
      REPLICATION_URL: https://download.geofabrik.de/south-america/argentina-updates/
      IMPORT_WIKIPEDIA: "false"
      IMPORT_US_POSTCODES: "false"
      IMPORT_GB_POSTCODES: "false"
    volumes:
      - nominatim-data:/var/lib/postgresql/12/main
    shm_size: 1gb

volumes:
  nominatim-data:
```

### Opción 2: Nominatim Público (Limitado)
Para testing o bajo volumen. Limitado a 1 req/s.

```
https://nominatim.openstreetmap.org/reverse?lat=X&lon=Y&format=json
```

## 1. Crear Módulo Geocoding

### geocoding/geocoding.module.ts
```typescript
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GeocodingService } from './geocoding.service';

@Module({
  imports: [HttpModule],
  providers: [GeocodingService],
  exports: [GeocodingService],
})
export class GeocodingModule {}
```

## 2. Crear Service

### geocoding/geocoding.service.ts
```typescript
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export interface IReverseGeocodeResult {
  address: string;
  displayName: string;
  city?: string;
  state?: string;
  country?: string;
  postalCode?: string;
}

@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);
  private readonly nominatimUrl: string;
  private readonly useCache: boolean = true;
  private cache: Map<string, IReverseGeocodeResult> = new Map();

  constructor(private readonly httpService: HttpService) {
    // Priorizar instancia local, fallback a público
    this.nominatimUrl =
      process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';

    this.logger.log(`Using Nominatim at: ${this.nominatimUrl}`);
  }

  /**
   * Reverse geocoding: lat/lon → dirección
   */
  async reverseGeocode(
    latitude: number,
    longitude: number,
  ): Promise<IReverseGeocodeResult | null> {
    try {
      // Cache key basado en coordenadas redondeadas (precisión ~11m)
      const cacheKey = `${latitude.toFixed(4)},${longitude.toFixed(4)}`;

      if (this.useCache && this.cache.has(cacheKey)) {
        this.logger.debug(`Cache hit for ${cacheKey}`);
        return this.cache.get(cacheKey)!;
      }

      const url = `${this.nominatimUrl}/reverse`;
      const params = {
        lat: latitude.toString(),
        lon: longitude.toString(),
        format: 'json',
        addressdetails: '1',
        'accept-language': 'es', // Español
      };

      this.logger.debug(`Geocoding ${latitude}, ${longitude}`);

      const response = await firstValueFrom(
        this.httpService.get(url, { params }),
      );

      const data = response.data;

      if (!data || data.error) {
        this.logger.warn(`Geocoding failed for ${latitude}, ${longitude}`);
        return null;
      }

      const result: IReverseGeocodeResult = {
        address: this.formatAddress(data.address),
        displayName: data.display_name,
        city: data.address.city || data.address.town || data.address.village,
        state: data.address.state,
        country: data.address.country,
        postalCode: data.address.postcode,
      };

      // Guardar en cache
      if (this.useCache) {
        this.cache.set(cacheKey, result);

        // Limitar tamaño del cache (últimas 10000 direcciones)
        if (this.cache.size > 10000) {
          const firstKey = this.cache.keys().next().value;
          this.cache.delete(firstKey);
        }
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Error geocoding ${latitude}, ${longitude}`,
        error.message,
      );
      return null;
    }
  }

  /**
   * Formatear dirección de forma legible
   */
  private formatAddress(address: any): string {
    const parts: string[] = [];

    // Nombre de calle + número
    if (address.road) {
      let street = address.road;
      if (address.house_number) {
        street += ` ${address.house_number}`;
      }
      parts.push(street);
    }

    // Barrio/Localidad
    if (address.suburb || address.neighbourhood) {
      parts.push(address.suburb || address.neighbourhood);
    }

    // Ciudad
    if (address.city || address.town || address.village) {
      parts.push(address.city || address.town || address.village);
    }

    // Provincia/Estado
    if (address.state) {
      parts.push(address.state);
    }

    // País
    if (address.country) {
      parts.push(address.country);
    }

    return parts.join(', ');
  }

  /**
   * Geocoding batch (múltiples coordenadas)
   * Útil para geocodificar trips/stops en lote
   */
  async reverseGeocodeBatch(
    coordinates: Array<{ latitude: number; longitude: number }>,
  ): Promise<Array<IReverseGeocodeResult | null>> {
    const results: Array<IReverseGeocodeResult | null> = [];

    for (const coord of coordinates) {
      const result = await this.reverseGeocode(coord.latitude, coord.longitude);
      results.push(result);

      // Rate limiting para API pública (1 req/s)
      if (this.nominatimUrl.includes('openstreetmap.org')) {
        await this.sleep(1000);
      }
    }

    return results;
  }

  /**
   * Limpiar cache
   */
  clearCache(): void {
    this.cache.clear();
    this.logger.log('Geocoding cache cleared');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
```

## 3. Integrar con Trip/Stop Persistence

### detection/services/trip-persistence.service.ts

Agregar geocoding al completar trip:

```typescript
import { GeocodingService } from '../../geocoding/geocoding.service';

@Injectable()
export class TripPersistenceService implements OnModuleInit {
  constructor(
    private readonly redisService: RedisService,
    private readonly tripRepository: TripRepository,
    private readonly geocodingService: GeocodingService, // Agregar
  ) {}

  private async handleTripCompleted(message: string): Promise<void> {
    const event: ITripCompletedEvent = JSON.parse(message);
    const trip = await this.tripRepository.findActiveByAsset(event.deviceId);

    if (!trip) return;

    const [endLongitude, endLatitude] = event.endLocation.coordinates;
    const [startLongitude, startLatitude] = event.startLocation.coordinates;

    // Geocodificar inicio y fin
    const [startGeocode, endGeocode] = await Promise.all([
      this.geocodingService.reverseGeocode(startLatitude, startLongitude),
      this.geocodingService.reverseGeocode(endLatitude, endLongitude),
    ]);

    await this.tripRepository.update(trip.id, {
      end_time: new Date(event.endTime),
      end_lat: endLatitude,
      end_lon: endLongitude,
      distance: event.distance,
      max_speed: event.maxSpeed,
      avg_speed: event.avgSpeed,
      duration: event.duration,
      stop_count: event.stopsCount,
      is_active: false,
      start_address: startGeocode?.address, // Agregar
      end_address: endGeocode?.address,     // Agregar
      metadata: {
        ...trip.metadata,
        tripId: event.tripId,
      },
    });

    this.logger.log(
      `Trip ${trip.id} completado: ${event.distance}m, ${startGeocode?.address} → ${endGeocode?.address}`,
    );
  }
}
```

### detection/services/stop-persistence.service.ts

Similar para stops:

```typescript
private async handleStopCompleted(message: string): Promise<void> {
  const event: IStopCompletedEvent = JSON.parse(message);
  const stop = await this.stopRepository.findActiveByAsset(event.deviceId);

  if (!stop) return;

  const [longitude, latitude] = event.location.coordinates;

  // Geocodificar ubicación del stop
  const geocode = await this.geocodingService.reverseGeocode(latitude, longitude);

  await this.stopRepository.update(stop.id, {
    end_time: new Date(event.endTime),
    duration: event.duration,
    address: geocode?.address, // Agregar
    is_active: false,
  });

  this.logger.log(
    `Stop ${stop.id} completado: ${event.duration}s en ${geocode?.address}`,
  );
}
```

## 4. Agregar Endpoint de Geocoding (Compatible Traccar)

### geocoding/geocoding.controller.ts
```typescript
import { Controller, Get, Query } from '@nestjs/common';
import { GeocodingService, IReverseGeocodeResult } from './geocoding.service';

@Controller('api/server')
export class GeocodingController {
  constructor(private readonly geocodingService: GeocodingService) {}

  /**
   * GET /api/server/geocode
   * Compatible con Traccar API
   *
   * Query params:
   * - latitude: number
   * - longitude: number
   *
   * Ejemplo:
   * /api/server/geocode?latitude=-34.603722&longitude=-58.381592
   */
  @Get('geocode')
  async reverseGeocode(
    @Query('latitude') latitude: string,
    @Query('longitude') longitude: string,
  ): Promise<{ address: string }> {
    const lat = parseFloat(latitude);
    const lon = parseFloat(longitude);

    const result = await this.geocodingService.reverseGeocode(lat, lon);

    return {
      address: result?.address || 'Unknown',
    };
  }
}
```

## 5. Variables de Entorno

### .env
```bash
# Geocoding
NOMINATIM_URL=http://localhost:8080  # Instancia local
# NOMINATIM_URL=https://nominatim.openstreetmap.org  # API pública (rate limited)
```

## 6. Testing

### geocoding/geocoding.service.spec.ts
```typescript
describe('GeocodingService', () => {
  it('debe geocodificar Obelisco de Buenos Aires', async () => {
    const result = await service.reverseGeocode(-34.603722, -58.381592);

    expect(result).toBeDefined();
    expect(result.address).toContain('Buenos Aires');
    expect(result.country).toBe('Argentina');
  });

  it('debe cachear resultados', async () => {
    const lat = -34.603722;
    const lon = -58.381592;

    const result1 = await service.reverseGeocode(lat, lon);
    const result2 = await service.reverseGeocode(lat, lon);

    expect(result1).toEqual(result2);
    // Segunda llamada debe ser del cache (más rápida)
  });

  it('debe geocodificar en batch', async () => {
    const coordinates = [
      { latitude: -34.603722, longitude: -58.381592 }, // Obelisco
      { latitude: -34.609, longitude: -58.371 },       // Cerca
    ];

    const results = await service.reverseGeocodeBatch(coordinates);

    expect(results).toHaveLength(2);
    expect(results[0]).toBeDefined();
    expect(results[1]).toBeDefined();
  });
});
```

## 7. Optimizaciones

### A. Worker Queue para Geocoding Asíncrono

Si el geocoding es lento, procesarlo en background:

```typescript
// geocoding/geocoding-queue.service.ts
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';

@Injectable()
export class GeocodingQueueService {
  async queueTripGeocoding(tripId: string, coordinates: any) {
    await this.geocodingQueue.add('geocode-trip', {
      tripId,
      coordinates,
    });
  }
}

// Worker procesa en background
@Process('geocode-trip')
async handleTripGeocoding(job: Job) {
  const { tripId, coordinates } = job.data;
  const geocode = await this.geocodingService.reverseGeocode(...);
  await this.tripRepository.update(tripId, { address: geocode.address });
}
```

### B. Cache Persistente (Redis)

Para compartir cache entre instancias:

```typescript
// Usar Redis en lugar de Map in-memory
private async getCachedGeocode(key: string): Promise<IReverseGeocodeResult | null> {
  const cached = await this.redisService.get(`geocode:${key}`);
  return cached ? JSON.parse(cached) : null;
}

private async setCachedGeocode(key: string, result: IReverseGeocodeResult): Promise<void> {
  await this.redisService.set(
    `geocode:${key}`,
    JSON.stringify(result),
    60 * 60 * 24 * 30, // 30 días TTL
  );
}
```

## 8. Monitoring

### geocoding/geocoding.service.ts

Agregar métricas:

```typescript
private stats = {
  requests: 0,
  cacheHits: 0,
  cacheMisses: 0,
  errors: 0,
};

@Cron('0 * * * *') // Cada hora
logStats() {
  this.logger.log(
    `Geocoding stats: ${this.stats.requests} requests, ` +
    `${this.stats.cacheHits} cache hits (${((this.stats.cacheHits / this.stats.requests) * 100).toFixed(1)}%), ` +
    `${this.stats.errors} errors`,
  );
}
```

## Criterios de Aceptación

- [ ] Servicio de geocoding funcional con Nominatim
- [ ] Integrado con trip persistence (start_address, end_address)
- [ ] Integrado con stop persistence (address)
- [ ] Cache in-memory para reducir llamadas
- [ ] Endpoint GET /api/server/geocode compatible con Traccar
- [ ] Rate limiting para API pública
- [ ] Formateo de direcciones legible
- [ ] Tests unitarios
- [ ] Docker Compose con Nominatim local
- [ ] Documentación de deployment

## Deployment Recomendado

Para IRIX, **usar Nominatim auto-hospedado**:

1. **Ventajas**:
   - Sin rate limits
   - Baja latencia
   - Datos de Argentina actualizados
   - No depende de servicios externos

2. **Recursos necesarios**:
   - RAM: ~8GB (Argentina dataset)
   - Disco: ~20GB
   - CPU: 2-4 cores

3. **Actualización de datos**:
   - Automática vía replication (configurado en docker-compose)
   - Actualiza diferencias diarias de OSM

## Ejemplo de Uso

```bash
# Geocode directo
curl "http://localhost:3000/api/server/geocode?latitude=-34.603722&longitude=-58.381592"

# Respuesta:
{
  "address": "Avenida Corrientes, San Nicolás, Comuna 1, Buenos Aires, Argentina"
}
```
