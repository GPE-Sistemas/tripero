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
    linearDistance: number;
    distanceFromOrigin: number;
    implicitSpeed: number;
    timeDelta: number;
    isGpsNoise: boolean;
  };
}

/**
 * Razones de anomalías en segmentos GPS
 */
export enum SegmentAnomalyReason {
  IMPOSSIBLE_SPEED = 'impossible_speed', // Velocidad > 200 km/h
  GPS_NOISE = 'gps_noise', // Ruido GPS detectado (vehículo quieto)
  INVALID_TIME = 'invalid_time', // Delta de tiempo inválido
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
 * Contexto del trip para validación - EXTENDIDO para detección de ruido GPS
 */
export interface ITripContext {
  startLat: number;
  startLon: number;
  currentDistance: number;
  startTime: number;

  // Nuevos campos para detección de ruido GPS
  maxDistanceFromOrigin: number; // Distancia máxima alcanzada desde el origen
  boundingBox: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  speedSum: number; // Suma de velocidades para calcular promedio
  positionCount: number; // Cantidad de posiciones procesadas
}

/**
 * Servicio para validar segmentos GPS y detectar RUIDO GPS
 *
 * NUEVA LÓGICA (v2):
 * - NO penaliza recorridos circulares legítimos (colectivos, ida/vuelta, etc.)
 * - SOLO filtra ruido GPS cuando el vehículo está genuinamente quieto
 *
 * Criterios para detectar ruido GPS:
 * 1. El vehículo NUNCA se alejó significativamente del origen (< 150m)
 * 2. El área de operación (bounding box) es muy pequeña (< 100m)
 * 3. La velocidad promedio es muy baja (< 5 km/h)
 * 4. La velocidad reportada del segmento es 0 o muy baja
 */
@Injectable()
export class DistanceValidatorService {
  private readonly logger = new Logger(DistanceValidatorService.name);

  /**
   * Radio de la Tierra en metros (WGS84 ecuatorial)
   */
  private readonly EARTH_RADIUS_M = 6378137;

  /**
   * Umbrales para detección de ruido GPS
   */
  private readonly THRESHOLDS = {
    // Velocidad máxima físicamente posible (km/h)
    MAX_SPEED_KMH: 200,

    // Umbral de velocidad para considerar "quieto" (km/h)
    STATIONARY_SPEED_KMH: 5,

    // Distancia mínima del segmento para considerar movimiento (metros)
    MIN_SEGMENT_DISTANCE: 5,

    // === UMBRALES PARA DETECTAR RUIDO GPS ===
    // Si el vehículo NUNCA superó esta distancia del origen, podría ser ruido GPS
    MAX_ORIGIN_DISTANCE_FOR_NOISE: 150,

    // Si el bounding box es menor a esto, podría ser ruido GPS
    MAX_BBOX_FOR_NOISE: 100,

    // Si la velocidad promedio es menor a esto, podría ser ruido GPS
    MAX_AVG_SPEED_FOR_NOISE: 5,

    // === UMBRAL PARA CONFIRMAR MOVIMIENTO REAL ===
    // Si el vehículo alguna vez estuvo a más de esta distancia, TODO es válido
    MIN_DISTANCE_FOR_REAL_MOVEMENT: 300,
  };

  /**
   * Valida un segmento GPS y detecta si es ruido GPS
   *
   * @param from Posición GPS de origen
   * @param to Posición GPS de destino
   * @param tripContext Contexto del trip actual (requerido para detección precisa)
   * @returns Resultado de validación con distancia (ajustada si es ruido GPS)
   */
  validateSegment(
    from: IPosition,
    to: IPosition,
    tripContext?: ITripContext,
  ): ISegmentValidationResult {
    // 1. Calcular distancia del segmento usando Haversine
    const distance = this.haversineDistance(from.lat, from.lon, to.lat, to.lon);
    const timeDelta = (to.timestamp - from.timestamp) / 1000;

    // 2. Validar tiempo
    if (timeDelta <= 0) {
      this.logger.warn(
        `Invalid time delta: ${timeDelta}s (from: ${from.timestamp}, to: ${to.timestamp})`,
      );
      return this.createResult(distance, 0, false, SegmentAnomalyReason.INVALID_TIME, {
        distanceFromOrigin: 0,
        timeDelta,
      });
    }

    // 3. Calcular velocidad implícita (m/s → km/h)
    const implicitSpeed = (distance / timeDelta) * 3.6;

    // 4. Validar velocidad imposible (> 200 km/h)
    if (implicitSpeed > this.THRESHOLDS.MAX_SPEED_KMH) {
      this.logger.warn(
        `Impossible speed: ${implicitSpeed.toFixed(1)} km/h ` +
          `(${distance.toFixed(1)}m in ${timeDelta.toFixed(1)}s)`,
      );
      return this.createResult(distance, 0, false, SegmentAnomalyReason.IMPOSSIBLE_SPEED, {
        distanceFromOrigin: tripContext?.maxDistanceFromOrigin || 0,
        timeDelta,
        implicitSpeed,
      });
    }

    // 5. Si hay contexto de trip, evaluar si es ruido GPS
    if (tripContext) {
      // Calcular distancia actual desde el origen
      const distanceFromOrigin = this.haversineDistance(
        tripContext.startLat,
        tripContext.startLon,
        to.lat,
        to.lon,
      );

      // Calcular tamaño del bounding box
      const bboxDiameter = this.calculateBoundingBoxDiameter(tripContext.boundingBox);

      // Calcular velocidad promedio del trip
      const avgSpeed =
        tripContext.positionCount > 0
          ? tripContext.speedSum / tripContext.positionCount
          : to.speed;

      // === REGLA CLAVE: Si alguna vez se alejó significativamente, TODO es válido ===
      if (tripContext.maxDistanceFromOrigin >= this.THRESHOLDS.MIN_DISTANCE_FOR_REAL_MOVEMENT) {
        // El vehículo se movió de verdad - aceptar todo sin corrección
        return this.createResult(distance, distance, true, undefined, {
          distanceFromOrigin,
          timeDelta,
          implicitSpeed,
          isGpsNoise: false,
        });
      }

      // === DETECTAR RUIDO GPS ===
      // Solo aplicar si se cumplen TODAS las condiciones de vehículo quieto
      const isLikelyGpsNoise =
        tripContext.maxDistanceFromOrigin < this.THRESHOLDS.MAX_ORIGIN_DISTANCE_FOR_NOISE &&
        bboxDiameter < this.THRESHOLDS.MAX_BBOX_FOR_NOISE &&
        avgSpeed < this.THRESHOLDS.MAX_AVG_SPEED_FOR_NOISE &&
        to.speed < this.THRESHOLDS.STATIONARY_SPEED_KMH;

      if (isLikelyGpsNoise && distance < 20) {
        // Es ruido GPS - descartar este segmento
        this.logger.debug(
          `GPS noise detected: segment=${distance.toFixed(1)}m, ` +
            `maxFromOrigin=${tripContext.maxDistanceFromOrigin.toFixed(1)}m, ` +
            `bbox=${bboxDiameter.toFixed(1)}m, avgSpeed=${avgSpeed.toFixed(1)}km/h`,
        );
        return this.createResult(distance, 0, true, SegmentAnomalyReason.GPS_NOISE, {
          distanceFromOrigin,
          timeDelta,
          implicitSpeed,
          isGpsNoise: true,
        });
      }

      // No es ruido GPS - aceptar distancia completa
      return this.createResult(distance, distance, true, undefined, {
        distanceFromOrigin,
        timeDelta,
        implicitSpeed,
        isGpsNoise: false,
      });
    }

    // 6. Sin contexto de trip - validación básica
    // Filtrar solo movimientos muy pequeños con velocidad 0
    if (distance < this.THRESHOLDS.MIN_SEGMENT_DISTANCE && to.speed === 0) {
      return this.createResult(distance, 0, true, SegmentAnomalyReason.GPS_NOISE, {
        distanceFromOrigin: 0,
        timeDelta,
        implicitSpeed,
        isGpsNoise: true,
      });
    }

    return this.createResult(distance, distance, true, undefined, {
      distanceFromOrigin: 0,
      timeDelta,
      implicitSpeed,
      isGpsNoise: false,
    });
  }

  /**
   * Actualiza el contexto del trip con una nueva posición
   * Debe llamarse después de validateSegment para mantener el contexto actualizado
   */
  updateTripContext(
    context: ITripContext,
    position: IPosition,
  ): ITripContext {
    const distanceFromOrigin = this.haversineDistance(
      context.startLat,
      context.startLon,
      position.lat,
      position.lon,
    );

    return {
      ...context,
      maxDistanceFromOrigin: Math.max(context.maxDistanceFromOrigin, distanceFromOrigin),
      boundingBox: {
        minLat: Math.min(context.boundingBox.minLat, position.lat),
        maxLat: Math.max(context.boundingBox.maxLat, position.lat),
        minLon: Math.min(context.boundingBox.minLon, position.lon),
        maxLon: Math.max(context.boundingBox.maxLon, position.lon),
      },
      speedSum: context.speedSum + position.speed,
      positionCount: context.positionCount + 1,
    };
  }

  /**
   * Crea un contexto de trip inicial
   */
  createInitialTripContext(startLat: number, startLon: number, startTime: number): ITripContext {
    return {
      startLat,
      startLon,
      currentDistance: 0,
      startTime,
      maxDistanceFromOrigin: 0,
      boundingBox: {
        minLat: startLat,
        maxLat: startLat,
        minLon: startLon,
        maxLon: startLon,
      },
      speedSum: 0,
      positionCount: 0,
    };
  }

  /**
   * Calcula el diámetro del bounding box (diagonal)
   */
  private calculateBoundingBoxDiameter(bbox: ITripContext['boundingBox']): number {
    return this.haversineDistance(
      bbox.minLat,
      bbox.minLon,
      bbox.maxLat,
      bbox.maxLon,
    );
  }

  /**
   * Calcula la distancia entre dos puntos GPS usando la fórmula de Haversine
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

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }

  /**
   * Crea un resultado de validación
   */
  private createResult(
    originalDistance: number,
    adjustedDistance: number,
    isValid: boolean,
    reason?: SegmentAnomalyReason,
    extra?: {
      distanceFromOrigin?: number;
      timeDelta?: number;
      implicitSpeed?: number;
      isGpsNoise?: boolean;
    },
  ): ISegmentValidationResult {
    return {
      isValid,
      adjustedDistance,
      originalDistance,
      reason,
      metadata: {
        linearDistance: originalDistance,
        distanceFromOrigin: extra?.distanceFromOrigin || 0,
        implicitSpeed: extra?.implicitSpeed || 0,
        timeDelta: extra?.timeDelta || 0,
        isGpsNoise: extra?.isGpsNoise || false,
      },
    };
  }
}
