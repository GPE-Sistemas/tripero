import { Injectable, Logger } from '@nestjs/common';
import { IPosition } from './distance-validator.service';

/**
 * Análisis del área de operación de un trip
 */
export interface IOperationAreaAnalysis {
  /**
   * Diámetro del bounding box en metros
   * (diagonal máxima del rectángulo que contiene todos los puntos)
   */
  boundingBoxDiameter: number;

  /**
   * Indica si el trip ocurre en un área pequeña (< 500m)
   */
  isSmallArea: boolean;

  /**
   * Indica si el trip ocurre en un área muy pequeña (< 200m)
   */
  isVerySmallArea: boolean;

  /**
   * Factor de corrección recomendado (0.5 - 1.0)
   * 1.0 = sin corrección
   * 0.5 = corrección agresiva
   */
  recommendedCorrection: number;

  /**
   * Punto central del área de operación
   */
  centerPoint: { lat: number; lon: number };

  /**
   * Bounding box del área de operación
   */
  boundingBox: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
}

/**
 * Análisis de calidad de un trip completo
 */
export interface ITripQualityAnalysis {
  /**
   * Análisis del área de operación
   */
  operationArea: IOperationAreaAnalysis;

  /**
   * Ratio ruta/lineal del trip completo
   */
  tripRatio: number;

  /**
   * Distancia lineal entre inicio y fin (metros)
   */
  linearDistance: number;

  /**
   * Flag de calidad recomendado
   */
  qualityFlag: TripQualityFlag;

  /**
   * Mensaje descriptivo del análisis
   */
  message: string;
}

/**
 * Flags de calidad de un trip
 */
export enum TripQualityFlag {
  VALID = 'valid', // Trip normal sin anomalías
  ADJUSTED_SMALL_AREA = 'adjusted_small_area', // Ajustado por área pequeña
  ADJUSTED_HIGH_RATIO = 'adjusted_high_ratio', // Ajustado por ratio excesivo
  ANOMALOUS = 'anomalous', // Anomalía detectada pero sin corrección aplicada
}

/**
 * Servicio para analizar la calidad de un trip completo
 *
 * Este servicio analiza el contexto espacial de un trip para detectar:
 * - Movimientos en áreas pequeñas
 * - Ratios ruta/lineal anómalos
 * - Factores de corrección recomendados
 */
@Injectable()
export class TripQualityAnalyzerService {
  private readonly logger = new Logger(TripQualityAnalyzerService.name);

  /**
   * Radio de la Tierra en metros (usado para cálculo de Haversine)
   */
  private readonly EARTH_RADIUS_M = 6371000;

  /**
   * Umbrales para análisis de área
   */
  private readonly THRESHOLDS = {
    SMALL_AREA_METERS: 500, // Área considerada pequeña
    VERY_SMALL_AREA_METERS: 200, // Área considerada muy pequeña
    HIGH_RATIO_THRESHOLD: 5, // Ratio considerado alto
    VERY_HIGH_RATIO_THRESHOLD: 10, // Ratio considerado muy alto
    MIN_LINEAR_DISTANCE: 50, // Distancia lineal mínima para calcular ratio
  };

  /**
   * Analiza el área de operación de un trip
   *
   * @param positions Array de posiciones GPS del trip
   * @param tripDistance Distancia total acumulada del trip (metros)
   * @returns Análisis del área de operación
   */
  analyzeOperationArea(
    positions: IPosition[],
    tripDistance: number,
  ): IOperationAreaAnalysis {
    if (!positions || positions.length === 0) {
      this.logger.warn('No positions provided for operation area analysis');
      return this.createDefaultAreaAnalysis();
    }

    // 1. Calcular bounding box
    const lats = positions.map((p) => p.lat);
    const lons = positions.map((p) => p.lon);

    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLon = Math.min(...lons);
    const maxLon = Math.max(...lons);

    // 2. Calcular diámetro (diagonal del bounding box)
    const diameter = this.haversineDistance(minLat, minLon, maxLat, maxLon);

    // 3. Calcular centro del área
    const centerLat = (minLat + maxLat) / 2;
    const centerLon = (minLon + maxLon) / 2;

    // 4. Determinar si es área pequeña
    const isSmallArea = diameter < this.THRESHOLDS.SMALL_AREA_METERS;
    const isVerySmallArea = diameter < this.THRESHOLDS.VERY_SMALL_AREA_METERS;

    // 5. Calcular factor de corrección recomendado
    let recommendedCorrection = 1.0;

    if (isVerySmallArea) {
      // En área muy pequeña (<200m), aplicar corrección agresiva
      const ratio = tripDistance / Math.max(diameter, this.THRESHOLDS.MIN_LINEAR_DISTANCE);

      if (ratio > this.THRESHOLDS.VERY_HIGH_RATIO_THRESHOLD) {
        // Ratio muy alto (>10) → probable ruido GPS severo
        // Usar distancia lineal * factor conservador
        recommendedCorrection = Math.min(diameter / tripDistance * 2, 0.5);
      } else if (ratio > this.THRESHOLDS.HIGH_RATIO_THRESHOLD) {
        // Ratio alto (5-10) → corrección moderada
        recommendedCorrection = 0.7;
      }
    } else if (isSmallArea) {
      // En área pequeña (200-500m), corrección leve
      const ratio = tripDistance / diameter;
      if (ratio > this.THRESHOLDS.HIGH_RATIO_THRESHOLD) {
        recommendedCorrection = 0.85;
      }
    }

    return {
      boundingBoxDiameter: diameter,
      isSmallArea,
      isVerySmallArea,
      recommendedCorrection,
      centerPoint: { lat: centerLat, lon: centerLon },
      boundingBox: { minLat, maxLat, minLon, maxLon },
    };
  }

  /**
   * Calcula el ratio ruta/lineal de un trip completo
   *
   * @param startLat Latitud de inicio
   * @param startLon Longitud de inicio
   * @param endLat Latitud de fin
   * @param endLon Longitud de fin
   * @param tripDistance Distancia total del trip (metros)
   * @returns Ratio ruta/lineal
   */
  calculateTripRatio(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    tripDistance: number,
  ): number {
    const linearDistance = this.haversineDistance(startLat, startLon, endLat, endLon);

    // Evitar división por cero / valores muy pequeños
    const denominator = Math.max(linearDistance, this.THRESHOLDS.MIN_LINEAR_DISTANCE);

    return tripDistance / denominator;
  }

  /**
   * Análisis completo de calidad de un trip
   *
   * @param startLat Latitud de inicio
   * @param startLon Longitud de inicio
   * @param endLat Latitud de fin
   * @param endLon Longitud de fin
   * @param tripDistance Distancia total del trip (metros)
   * @param positions Array de posiciones intermedias (opcional)
   * @returns Análisis de calidad completo
   */
  analyzeTripQuality(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    tripDistance: number,
    positions?: IPosition[],
  ): ITripQualityAnalysis {
    // 1. Calcular ratio ruta/lineal
    const linearDistance = this.haversineDistance(startLat, startLon, endLat, endLon);
    const tripRatio = this.calculateTripRatio(
      startLat,
      startLon,
      endLat,
      endLon,
      tripDistance,
    );

    // 2. Analizar área de operación (si hay posiciones)
    let operationArea: IOperationAreaAnalysis;
    if (positions && positions.length > 0) {
      operationArea = this.analyzeOperationArea(positions, tripDistance);
    } else {
      // Sin posiciones intermedias, usar solo inicio/fin
      operationArea = this.analyzeOperationAreaFromEndpoints(
        startLat,
        startLon,
        endLat,
        endLon,
        tripDistance,
      );
    }

    // 3. Determinar quality flag y mensaje
    let qualityFlag: TripQualityFlag = TripQualityFlag.VALID;
    let message = 'Trip con calidad normal';

    if (operationArea.isSmallArea && tripRatio > this.THRESHOLDS.HIGH_RATIO_THRESHOLD) {
      qualityFlag = TripQualityFlag.ADJUSTED_SMALL_AREA;
      message = `Trip en área pequeña (${operationArea.boundingBoxDiameter.toFixed(0)}m) con ratio alto (${tripRatio.toFixed(2)})`;
    } else if (tripRatio > this.THRESHOLDS.HIGH_RATIO_THRESHOLD) {
      qualityFlag = TripQualityFlag.ADJUSTED_HIGH_RATIO;
      message = `Trip con ratio ruta/lineal alto: ${tripRatio.toFixed(2)}`;
    } else if (operationArea.recommendedCorrection < 1.0) {
      qualityFlag = TripQualityFlag.ANOMALOUS;
      message = `Anomalía detectada en trip, corrección recomendada: ${operationArea.recommendedCorrection.toFixed(2)}`;
    }

    return {
      operationArea,
      tripRatio,
      linearDistance,
      qualityFlag,
      message,
    };
  }

  /**
   * Analiza área de operación cuando solo se tienen los puntos de inicio y fin
   */
  private analyzeOperationAreaFromEndpoints(
    startLat: number,
    startLon: number,
    endLat: number,
    endLon: number,
    tripDistance: number,
  ): IOperationAreaAnalysis {
    const linearDistance = this.haversineDistance(startLat, startLon, endLat, endLon);
    const isSmallArea = linearDistance < this.THRESHOLDS.SMALL_AREA_METERS;
    const isVerySmallArea = linearDistance < this.THRESHOLDS.VERY_SMALL_AREA_METERS;

    const ratio = tripDistance / Math.max(linearDistance, this.THRESHOLDS.MIN_LINEAR_DISTANCE);
    let recommendedCorrection = 1.0;

    if (isVerySmallArea && ratio > this.THRESHOLDS.VERY_HIGH_RATIO_THRESHOLD) {
      recommendedCorrection = 0.5;
    } else if (isVerySmallArea && ratio > this.THRESHOLDS.HIGH_RATIO_THRESHOLD) {
      recommendedCorrection = 0.7;
    } else if (isSmallArea && ratio > this.THRESHOLDS.HIGH_RATIO_THRESHOLD) {
      recommendedCorrection = 0.85;
    }

    return {
      boundingBoxDiameter: linearDistance,
      isSmallArea,
      isVerySmallArea,
      recommendedCorrection,
      centerPoint: {
        lat: (startLat + endLat) / 2,
        lon: (startLon + endLon) / 2,
      },
      boundingBox: {
        minLat: Math.min(startLat, endLat),
        maxLat: Math.max(startLat, endLat),
        minLon: Math.min(startLon, endLon),
        maxLon: Math.max(startLon, endLon),
      },
    };
  }

  /**
   * Crea un análisis de área por defecto (cuando no hay datos)
   */
  private createDefaultAreaAnalysis(): IOperationAreaAnalysis {
    return {
      boundingBoxDiameter: 0,
      isSmallArea: false,
      isVerySmallArea: false,
      recommendedCorrection: 1.0,
      centerPoint: { lat: 0, lon: 0 },
      boundingBox: { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 },
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

  /**
   * Convierte grados a radianes
   */
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}
