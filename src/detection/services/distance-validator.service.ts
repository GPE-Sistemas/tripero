import { Injectable, Logger } from '@nestjs/common';

/**
 * Resultado de la validación de un segmento GPS
 */
export interface ISegmentValidationResult {
  /**
   * Indica si el segmento es válido (sin anomalías detectadas)
   */
  isValid: boolean;

  /**
   * Distancia ajustada después de aplicar correcciones (en metros)
   */
  adjustedDistance: number;

  /**
   * Distancia original calculada por Haversine (en metros)
   */
  originalDistance: number;

  /**
   * Razón de la anomalía si se detectó alguna
   */
  reason?: SegmentAnomalyReason;

  /**
   * Metadata adicional para análisis
   */
  metadata: {
    linearDistance: number; // Distancia lineal del segmento (misma que originalDistance)
    routeLinearRatio: number; // Ratio ruta acumulada / distancia lineal desde inicio
    implicitSpeed: number; // Velocidad implícita calculada del segmento (km/h)
    timeDelta: number; // Tiempo entre posiciones (segundos)
  };
}

/**
 * Razones de anomalías en segmentos GPS
 */
export enum SegmentAnomalyReason {
  EXCESSIVE_RATIO = 'excessive_ratio', // Ratio ruta/lineal > 5
  IMPOSSIBLE_SPEED = 'impossible_speed', // Velocidad > 200 km/h
  CIRCULAR_MOVEMENT = 'circular_movement', // Movimientos circulares detectados
  GPS_NOISE = 'gps_noise', // Ruido GPS (movimiento mínimo con velocidad 0)
}

/**
 * Posición GPS simplificada para validación
 */
export interface IPosition {
  lat: number;
  lon: number;
  timestamp: number;
  speed: number;
  ignition?: boolean;
}

/**
 * Contexto del trip para validación avanzada
 */
export interface ITripContext {
  startLat: number;
  startLon: number;
  currentDistance: number;
  startTime: number;
}

/**
 * Servicio para validar segmentos GPS y detectar anomalías en la acumulación de distancias
 *
 * Este servicio implementa el algoritmo de validación de distancias propuesto en
 * PLAN-MEJORAS-ODOMETRO-TRIPERO.md para resolver el problema de acumulación excesiva
 * de distancias en áreas pequeñas.
 */
@Injectable()
export class DistanceValidatorService {
  private readonly logger = new Logger(DistanceValidatorService.name);

  /**
   * Radio de la Tierra en metros (usado para cálculo de Haversine)
   */
  private readonly EARTH_RADIUS_M = 6371000;

  /**
   * Umbrales de validación configurables
   */
  private readonly THRESHOLDS = {
    MAX_SPEED_KMH: 200, // Velocidad máxima permitida
    MIN_MOVEMENT_METERS: 5, // Movimiento mínimo para considerar válido
    MAX_TRIP_RATIO: 5, // Ratio máximo ruta/lineal permitido
    RATIO_CORRECTION_FACTOR: 0.7, // Factor de corrección cuando ratio es excesivo
    MIN_LINEAR_DISTANCE_FOR_RATIO: 100, // Distancia lineal mínima para calcular ratio
  };

  /**
   * Valida un segmento GPS individual
   *
   * @param from Posición GPS de origen
   * @param to Posición GPS de destino
   * @param tripContext Contexto del trip actual (opcional, mejora precisión)
   * @returns Resultado de validación con distancia ajustada
   */
  validateSegment(
    from: IPosition,
    to: IPosition,
    tripContext?: ITripContext,
  ): ISegmentValidationResult {
    // 1. Calcular distancia del segmento usando Haversine
    const distance = this.haversineDistance(from.lat, from.lon, to.lat, to.lon);
    const timeDelta = (to.timestamp - from.timestamp) / 1000; // segundos

    // Evitar división por cero
    if (timeDelta <= 0) {
      this.logger.warn(
        `Invalid time delta: ${timeDelta}s (from: ${from.timestamp}, to: ${to.timestamp})`,
      );
      return this.createInvalidResult(distance, 0, SegmentAnomalyReason.GPS_NOISE);
    }

    const linearDistance = distance; // Guardar para metadata

    // 2. Calcular velocidad implícita del segmento (m/s → km/h)
    const implicitSpeed = (distance / timeDelta) * 3.6;

    // 3. Validar velocidad imposible (> 200 km/h)
    if (implicitSpeed > this.THRESHOLDS.MAX_SPEED_KMH) {
      this.logger.warn(
        `Impossible speed detected: ${implicitSpeed.toFixed(2)} km/h ` +
          `(distance: ${distance.toFixed(2)}m, time: ${timeDelta.toFixed(2)}s)`,
      );
      return this.createInvalidResult(
        distance,
        timeDelta,
        SegmentAnomalyReason.IMPOSSIBLE_SPEED,
      );
    }

    // 4. Filtrar ruido GPS (movimiento muy pequeño con velocidad reportada = 0)
    if (distance < this.THRESHOLDS.MIN_MOVEMENT_METERS && to.speed === 0) {
      return this.createInvalidResult(
        distance,
        timeDelta,
        SegmentAnomalyReason.GPS_NOISE,
      );
    }

    // 5. Si hay contexto de trip, validar contra inicio del trip
    if (tripContext) {
      const tripLinearDistance = this.haversineDistance(
        tripContext.startLat,
        tripContext.startLon,
        to.lat,
        to.lon,
      );

      const tripRouteDistance = (tripContext.currentDistance || 0) + distance;

      // Calcular ratio del trip completo (con mínimo para evitar divisiones problemáticas)
      const tripRatio =
        tripRouteDistance /
        Math.max(tripLinearDistance, this.THRESHOLDS.MIN_LINEAR_DISTANCE_FOR_RATIO);

      // Si el ratio del trip completo es excesivo, aplicar corrección
      if (tripRatio > this.THRESHOLDS.MAX_TRIP_RATIO) {
        // Usar factor conservador para ajustar distancia
        const adjustedDistance = linearDistance * this.THRESHOLDS.RATIO_CORRECTION_FACTOR;

        this.logger.debug(
          `Excessive ratio detected: ${tripRatio.toFixed(2)} ` +
            `(trip: ${(tripRouteDistance / 1000).toFixed(2)}km, ` +
            `linear: ${(tripLinearDistance / 1000).toFixed(2)}km). ` +
            `Applying correction: ${distance.toFixed(2)}m → ${adjustedDistance.toFixed(2)}m`,
        );

        return {
          isValid: true, // Válido pero ajustado
          adjustedDistance,
          originalDistance: distance,
          reason: SegmentAnomalyReason.EXCESSIVE_RATIO,
          metadata: {
            linearDistance,
            routeLinearRatio: tripRatio,
            implicitSpeed,
            timeDelta,
          },
        };
      }
    }

    // 6. Segmento válido sin correcciones
    return {
      isValid: true,
      adjustedDistance: distance,
      originalDistance: distance,
      metadata: {
        linearDistance,
        routeLinearRatio: 1.0,
        implicitSpeed,
        timeDelta,
      },
    };
  }

  /**
   * Calcula la distancia entre dos puntos GPS usando la fórmula de Haversine
   *
   * @param lat1 Latitud del punto 1
   * @param lon1 Longitud del punto 1
   * @param lat2 Latitud del punto 2
   * @param lon2 Longitud del punto 2
   * @returns Distancia en metros
   */
  haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
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

  /**
   * Convierte grados a radianes
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Crea un resultado de validación inválido
   */
  private createInvalidResult(
    distance: number,
    timeDelta: number,
    reason: SegmentAnomalyReason,
  ): ISegmentValidationResult {
    return {
      isValid: false,
      adjustedDistance: 0, // Descartar completamente
      originalDistance: distance,
      reason,
      metadata: {
        linearDistance: distance,
        routeLinearRatio: 0,
        implicitSpeed: timeDelta > 0 ? (distance / timeDelta) * 3.6 : 0,
        timeDelta,
      },
    };
  }
}
