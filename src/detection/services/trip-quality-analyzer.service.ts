import { Injectable, Logger } from '@nestjs/common';

/**
 * Análisis de calidad de un trip completo
 * Solo métricas informativas - NO aplica correcciones
 */
export interface ITripQualityAnalysis {
  /**
   * Ratio ruta/lineal del trip completo
   */
  tripRatio: number;

  /**
   * Distancia lineal entre inicio y fin (metros)
   */
  linearDistance: number;

  /**
   * Diámetro del bounding box (metros)
   */
  boundingBoxDiameter: number;

  /**
   * Distancia máxima alcanzada desde el origen (metros)
   */
  maxDistanceFromOrigin: number;

  /**
   * Velocidad promedio del trip (km/h)
   */
  avgSpeed: number;

  /**
   * Flag de calidad (informativo)
   */
  qualityFlag: TripQualityFlag;

  /**
   * Mensaje descriptivo del análisis
   */
  message: string;

  /**
   * Indica si el trip fue afectado por ruido GPS
   */
  hadGpsNoise: boolean;

  /**
   * Porcentaje de segmentos que fueron ruido GPS
   */
  gpsNoisePercentage: number;
}

/**
 * Flags de calidad de un trip (informativos, no para corrección)
 */
export enum TripQualityFlag {
  VALID = 'valid', // Trip normal sin anomalías
  GPS_NOISE_FILTERED = 'gps_noise_filtered', // Se filtró ruido GPS
  CIRCULAR_ROUTE = 'circular_route', // Recorrido circular legítimo
  SHORT_TRIP = 'short_trip', // Trip muy corto
}

/**
 * Servicio para analizar la calidad de un trip completo
 *
 * IMPORTANTE: Este servicio solo calcula métricas informativas.
 * NO aplica correcciones - eso se hace en tiempo real en DistanceValidatorService.
 */
@Injectable()
export class TripQualityAnalyzerService {
  private readonly logger = new Logger(TripQualityAnalyzerService.name);

  /**
   * Radio de la Tierra en metros (WGS84)
   */
  private readonly EARTH_RADIUS_M = 6378137;

  /**
   * Análisis completo de calidad de un trip (solo métricas)
   *
   * @param startLat Latitud de inicio
   * @param startLon Longitud de inicio
   * @param endLat Latitud de fin
   * @param endLon Longitud de fin
   * @param tripDistance Distancia total del trip (metros) - ya corregida por ruido GPS
   * @param maxDistanceFromOrigin Distancia máxima alcanzada desde el origen
   * @param boundingBoxDiameter Diámetro del bounding box
   * @param avgSpeed Velocidad promedio del trip
   * @param gpsNoiseSegments Cantidad de segmentos filtrados por ruido GPS
   * @param totalSegments Total de segmentos procesados
   * @returns Análisis de calidad (informativo)
   */
  analyzeTripQuality(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    tripDistance: number,
    maxDistanceFromOrigin: number = 0,
    boundingBoxDiameter: number = 0,
    avgSpeed: number = 0,
    gpsNoiseSegments: number = 0,
    totalSegments: number = 0,
  ): ITripQualityAnalysis {
    // Calcular distancia lineal inicio-fin
    const linearDistance = this.haversineDistance(startLat, startLon, endLat, endLon);

    // Calcular ratio (evitar división por cero)
    const tripRatio = tripDistance / Math.max(linearDistance, 50);

    // Determinar si hubo ruido GPS
    const hadGpsNoise = gpsNoiseSegments > 0;
    const gpsNoisePercentage =
      totalSegments > 0 ? (gpsNoiseSegments / totalSegments) * 100 : 0;

    // Determinar quality flag (informativo)
    let qualityFlag = TripQualityFlag.VALID;
    let message = 'Trip con calidad normal';

    if (hadGpsNoise && gpsNoisePercentage > 50) {
      qualityFlag = TripQualityFlag.GPS_NOISE_FILTERED;
      message = `Trip con ${gpsNoisePercentage.toFixed(0)}% de segmentos filtrados por ruido GPS`;
    } else if (tripRatio > 5 && maxDistanceFromOrigin > 300) {
      qualityFlag = TripQualityFlag.CIRCULAR_ROUTE;
      message = `Recorrido circular legítimo (ratio: ${tripRatio.toFixed(1)}, max dist: ${(maxDistanceFromOrigin / 1000).toFixed(1)}km)`;
    } else if (tripDistance < 500 && boundingBoxDiameter < 200) {
      qualityFlag = TripQualityFlag.SHORT_TRIP;
      message = `Trip corto (${tripDistance.toFixed(0)}m en área de ${boundingBoxDiameter.toFixed(0)}m)`;
    }

    return {
      tripRatio,
      linearDistance,
      boundingBoxDiameter,
      maxDistanceFromOrigin,
      avgSpeed,
      qualityFlag,
      message,
      hadGpsNoise,
      gpsNoisePercentage,
    };
  }

  /**
   * Calcula la distancia entre dos puntos GPS usando la fórmula de Haversine
   */
  private haversineDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
  ): number {
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return this.EARTH_RADIUS_M * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}
