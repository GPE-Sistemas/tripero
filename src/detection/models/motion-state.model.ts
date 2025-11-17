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
  tripMetadata?: Record<string, any>; // Metadata del trip (se propaga del position event)

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

  // Tamaño del buffer de posiciones recientes
  positionBufferSize: number;
}

/**
 * Umbrales por defecto
 */
export const DEFAULT_THRESHOLDS: IDetectionThresholds = {
  minMovingSpeed: 5, // km/h
  minTripDistance: 100, // metros
  minTripDuration: 60, // 1 minuto
  minStopDuration: 180, // 3 minutos
  maxGapDuration: 600, // 10 minutos
  positionBufferSize: 300, // últimas 300 posiciones (~5 minutos a 1 pos/seg)
};
