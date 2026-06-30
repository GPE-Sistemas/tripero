import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import {
  GEOCODE_APIKEY,
  GEOCODE_PATH,
  GEOCODE_TIMEOUT_MS,
  GEOCODE_URL,
} from '../../env';

/**
 * Cliente de geocodificación inversa contra un servicio EXTERNO (configurable
 * por GEOCODE_URL + GEOCODE_PATH + GEOCODE_APIKEY). Se usa al crear/completar
 * stops y trips para guardar la dirección una sola vez, evitando geocodificar
 * en cada lectura.
 *
 * Best-effort: nunca lanza. Si falla o está deshabilitado (sin GEOCODE_URL),
 * devuelve null y la dirección queda sin resolver (el consumidor hace fallback).
 */
@Injectable()
export class GeocodeClientService {
  private readonly logger = new Logger(GeocodeClientService.name);

  constructor(private readonly http: HttpService) {}

  get enabled(): boolean {
    return !!GEOCODE_URL;
  }

  /** Reverse geocode (lat, lon) -> dirección o null. Nunca lanza. */
  async reverse(lat: number, lon: number): Promise<string | null> {
    if (!GEOCODE_URL) return null;
    if (typeof lat !== 'number' || typeof lon !== 'number') return null;
    try {
      const url = `${GEOCODE_URL}${GEOCODE_PATH}`;
      // El servicio espera coordenadas en formato [lon, lat].
      const res = await firstValueFrom(
        this.http.post(
          url,
          { coordenadas: [lon, lat] },
          {
            headers: GEOCODE_APIKEY ? { 'x-api-key': GEOCODE_APIKEY } : {},
            timeout: GEOCODE_TIMEOUT_MS,
          },
        ),
      );
      return res?.data?.direccion ?? null;
    } catch (error) {
      this.logger.warn(
        `Reverse geocode falló (${lat}, ${lon}): ${(error as Error).message}`,
      );
      return null;
    }
  }
}
