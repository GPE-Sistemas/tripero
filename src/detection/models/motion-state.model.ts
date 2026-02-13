/**
 * Estados de la máquina de estados para detección de trips
 */
export enum MotionState {
  /**
   * Vehículo detenido - No hay movimiento ni ignición
   */
  STOPPED = 'STOPPED',

  /**
   * Vehículo en movimiento - Ignición ON y/o velocidad > umbral
   */
  MOVING = 'MOVING',

  /**
   * Vehículo en ralentí - Ignición ON pero sin movimiento
   * (motor encendido pero vehículo quieto)
   */
  IDLE = 'IDLE',

  /**
   * Estado desconocido - Primer posición o datos insuficientes
   */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Razón de detección de trip/stop
 */
export enum DetectionReason {
  IGNITION_ON = 'ignition_on',
  IGNITION_OFF = 'ignition_off',
  MOTION_DETECTED = 'motion_detected',
  MOTION_STOPPED = 'motion_stopped',
  THRESHOLD_REACHED = 'threshold_reached',
}

/**
 * Estado de movimiento almacenado en Redis para cada dispositivo
 */
export interface IDeviceMotionState {
  deviceId: string;
  state: MotionState;
  stateStartTime: number; // timestamp cuando inició este estado

  // Trip actual (si existe)
  currentTripId?: string;
  tripStartTime?: number;
  tripStartLat?: number;
  tripStartLon?: number;
  tripDistance?: number; // metros acumulados
  tripMaxSpeed?: number; // km/h
  tripStopsCount?: number;
  tripConfirmed?: boolean; // true si el trip ya fue publicado a BD (cumplió mínimos)
  tripMetadata?: Record<string, any>; // Metadata del trip (se propaga del position event)

  // === Contexto para detección de ruido GPS ===
  tripMaxDistanceFromOrigin?: number; // Distancia máxima alcanzada desde el origen
  tripBoundingBox?: {
    // Bounding box del trip
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  };
  tripSpeedSum?: number; // Suma de velocidades (para calcular promedio)
  tripPositionCount?: number; // Cantidad de posiciones procesadas

  tripQualityMetrics?: {
    // Metadata de calidad para el trip actual
    segmentsTotal: number; // Total de segmentos GPS procesados
    segmentsAdjusted: number; // Segmentos que fueron ajustados (ruido GPS)
    originalDistance: number; // Distancia total sin ajustes
    adjustedDistance: number; // Distancia total con ajustes
    gpsNoiseSegments: number; // Cantidad de segmentos descartados por ruido GPS
  };

  // Stop actual (si existe)
  currentStopId?: string;
  stopStartTime?: number;
  stopStartLat?: number;
  stopStartLon?: number;
  stopReason?: 'ignition_off' | 'no_movement' | 'parking';
  stopMetadata?: Record<string, any>; // Metadata del stop (se propaga del position event)

  // Última posición
  lastTimestamp: number;
  lastLat: number;
  lastLon: number;
  lastSpeed: number;
  lastIgnition: boolean;

  // Promedios de velocidad (para detección más precisa)
  speedAvg30s?: number; // promedio últimos 30 segundos
  speedAvg1min?: number; // promedio último minuto
  speedAvg5min?: number; // promedio últimos 5 minutos

  // Buffer de posiciones recientes (para cálculos)
  recentPositions?: Array<{
    timestamp: number;
    lat: number;
    lon: number;
    speed: number;
    ignition: boolean;
  }>;

  // Metadata
  lastUpdate: number; // timestamp de última actualización
  version: number; // para optimistic locking
}

/**
 * Configuración de umbrales para detección
 */
export interface IDetectionThresholds {
  // Velocidad mínima para considerar "en movimiento" (km/h)
  minMovingSpeed: number;

  // Distancia mínima para considerar un trip válido (metros)
  minTripDistance: number;

  // Duración mínima para considerar un trip válido (segundos)
  minTripDuration: number;

  // Duración mínima de parada para cerrar un trip (segundos)
  minStopDuration: number;

  // Tiempo máximo sin datos para cerrar trip automáticamente (segundos)
  maxGapDuration: number;

  // Gap máximo que fuerza cierre de trip sin importar si hay stop activo (segundos)
  // Usado para detectar gaps nocturnos donde el tracker se apaga
  maxOvernightGapDuration: number;

  // Tamaño del buffer de posiciones recientes
  positionBufferSize: number;

  // Tiempo de inactividad para considerar un trip huérfano (segundos)
  // Trips sin posiciones por más de este tiempo serán cerrados por el cleanup job
  orphanTripTimeout: number;

  // Duración máxima en estado IDLE antes de cerrar el trip (segundos)
  // Si el vehículo está en IDLE (motor encendido, sin movimiento) por más de este tiempo,
  // se cierra el trip automáticamente para evitar trips "fantasma" de larga duración
  maxIdleDuration: number;
}

/**
 * Umbrales por defecto
 */
export const DEFAULT_THRESHOLDS: IDetectionThresholds = {
  minMovingSpeed: 5, // km/h
  minTripDistance: 100, // metros
  minTripDuration: 60, // 1 minuto
  minStopDuration: 300, // 5 minutos (igual que Traccar) - duración mínima para segmentar trips
  maxGapDuration: 600, // 10 minutos
  maxOvernightGapDuration: 1800, // 30 minutos - fuerza cierre de trip sin importar stop (reducido de 2h)
  positionBufferSize: 300, // últimas 300 posiciones (~5 minutos a 1 pos/seg)
  orphanTripTimeout: 1800, // 30 minutos - tiempo para considerar trip huérfano (reducido de 4h)
  maxIdleDuration: 1800, // 30 minutos - cierra trip si está en IDLE por más de este tiempo
};
