import { POSITION_MAX_AGE_HOURS } from '../env';

/**
 * Evento de entrada: position:new
 *
 * Canal: Redis PubSub 'position:new'
 *
 * Este evento contiene SOLO los datos GPS necesarios para la detección de trips.
 * Tripero es agnóstico del sistema que genera las posiciones.
 */

export interface IPositionEvent {
  // === REQUERIDOS ===

  /**
   * Identificador único del dispositivo/vehículo
   * Puede ser IMEI, serial number, UUID, etc.
   */
  deviceId: string;

  /**
   * Timestamp de la posición GPS en milisegundos (Unix epoch)
   */
  timestamp: number;

  /**
   * Latitud en grados decimales (-90 a 90)
   */
  latitude: number;

  /**
   * Longitud en grados decimales (-180 a 180)
   */
  longitude: number;

  /**
   * Velocidad en km/h (>= 0)
   */
  speed: number;

  /**
   * Estado de ignición del vehículo
   * CRÍTICO para detección de trips
   * Si no se proporciona, se asume false
   */
  ignition?: boolean;

  // === OPCIONALES (mejoran precisión) ===

  /**
   * Altitud en metros sobre nivel del mar
   * Mejora cálculo de distancias en terreno montañoso
   */
  altitude?: number;

  /**
   * Rumbo en grados (0-360, donde 0=Norte, 90=Este, 180=Sur, 270=Oeste)
   * Útil para detectar cambios de dirección
   */
  heading?: number;

  /**
   * Precisión horizontal en metros
   * Permite filtrar posiciones con GPS malo
   */
  accuracy?: number;

  /**
   * Número de satélites GPS visibles
   * Indicador de calidad de señal
   */
  satellites?: number;

  /**
   * Metadata adicional del sistema integrador
   * Tripero NO usa estos datos para detección, solo los persiste para trazabilidad
   */
  metadata?: {
    [key: string]: any;
  };
}

/**
 * Resultado de validación con motivo de rechazo
 */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * Valida que un objeto cumple con la interfaz IPositionEvent
 * Retorna el motivo específico del rechazo para facilitar debugging
 */
export const validatePositionEventWithReason = (event: any): ValidationResult => {
  // Campos requeridos
  if (!event.deviceId || typeof event.deviceId !== 'string') {
    return { valid: false, reason: 'deviceId missing or invalid type' };
  }
  if (!event.timestamp || typeof event.timestamp !== 'number') {
    return { valid: false, reason: 'timestamp missing or invalid type' };
  }
  if (typeof event.latitude !== 'number') {
    return { valid: false, reason: 'latitude missing or invalid type' };
  }
  if (typeof event.longitude !== 'number') {
    return { valid: false, reason: 'longitude missing or invalid type' };
  }
  if (typeof event.speed !== 'number') {
    return { valid: false, reason: 'speed missing or invalid type' };
  }
  // ignition es opcional - si no viene, se asume false
  if (event.ignition !== undefined && typeof event.ignition !== 'boolean') {
    return { valid: false, reason: 'ignition invalid type (expected boolean)' };
  }

  // Validar rangos de latitud/longitud
  if (event.latitude < -90 || event.latitude > 90) {
    return { valid: false, reason: `latitude out of range: ${event.latitude}` };
  }
  if (event.longitude < -180 || event.longitude > 180) {
    return { valid: false, reason: `longitude out of range: ${event.longitude}` };
  }

  // Validar velocidad
  if (event.speed < 0) {
    return { valid: false, reason: `speed negative: ${event.speed}` };
  }

  // Validar timestamp (no futuro, máximo N horas en el pasado - configurable)
  const now = Date.now();
  const maxAgeMs = POSITION_MAX_AGE_HOURS * 60 * 60 * 1000;
  const oldestAllowed = now - maxAgeMs;
  if (event.timestamp > now + 60000) {
    const futureMs = event.timestamp - now;
    return { valid: false, reason: `timestamp in future by ${Math.round(futureMs / 1000)}s` };
  }
  if (event.timestamp < oldestAllowed) {
    const ageHours = Math.round((now - event.timestamp) / (60 * 60 * 1000));
    return { valid: false, reason: `timestamp too old: ${ageHours}h (max ${POSITION_MAX_AGE_HOURS}h)` };
  }

  // Validar opcionales si están presentes
  if (event.altitude !== undefined && typeof event.altitude !== 'number') {
    return { valid: false, reason: 'altitude invalid type (expected number)' };
  }
  if (event.heading !== undefined) {
    if (typeof event.heading !== 'number') {
      return { valid: false, reason: 'heading invalid type (expected number or null)' };
    }
    if (event.heading < 0 || event.heading > 360) {
      return { valid: false, reason: `heading out of range: ${event.heading}` };
    }
  }
  if (event.accuracy !== undefined) {
    if (typeof event.accuracy !== 'number') {
      return { valid: false, reason: 'accuracy invalid type (expected number)' };
    }
    if (event.accuracy < 0) {
      return { valid: false, reason: `accuracy negative: ${event.accuracy}` };
    }
  }
  if (event.satellites !== undefined) {
    if (typeof event.satellites !== 'number') {
      return { valid: false, reason: 'satellites invalid type (expected number)' };
    }
    if (event.satellites < 0) {
      return { valid: false, reason: `satellites negative: ${event.satellites}` };
    }
  }

  return { valid: true };
};

/**
 * Validaciones del evento
 */
export const validatePositionEvent = (event: any): event is IPositionEvent => {
  // Campos requeridos
  if (!event.deviceId || typeof event.deviceId !== 'string') return false;
  if (!event.timestamp || typeof event.timestamp !== 'number') return false;
  if (typeof event.latitude !== 'number') return false;
  if (typeof event.longitude !== 'number') return false;
  if (typeof event.speed !== 'number') return false;
  // ignition es opcional - si no viene, se asume false
  if (event.ignition !== undefined && typeof event.ignition !== 'boolean') return false;

  // Validar rangos de latitud/longitud
  if (event.latitude < -90 || event.latitude > 90) return false;
  if (event.longitude < -180 || event.longitude > 180) return false;

  // Validar velocidad
  if (event.speed < 0) return false;

  // Validar timestamp (no futuro, máximo N horas en el pasado - configurable)
  const now = Date.now();
  const maxAgeMs = POSITION_MAX_AGE_HOURS * 60 * 60 * 1000;
  const oldestAllowed = now - maxAgeMs;
  if (event.timestamp > now + 60000) return false; // +1 min tolerancia de clock skew
  if (event.timestamp < oldestAllowed) return false;

  // Validar opcionales si están presentes
  if (event.altitude !== undefined && typeof event.altitude !== 'number') return false;
  if (event.heading !== undefined) {
    if (typeof event.heading !== 'number') return false;
    if (event.heading < 0 || event.heading > 360) return false;
  }
  if (event.accuracy !== undefined) {
    if (typeof event.accuracy !== 'number') return false;
    if (event.accuracy < 0) return false;
  }
  if (event.satellites !== undefined) {
    if (typeof event.satellites !== 'number') return false;
    if (event.satellites < 0) return false;
  }

  return true;
};

/**
 * Evento de salida: position:rejected
 *
 * Canal: Redis PubSub 'position:rejected'
 *
 * Este evento se publica cuando una posición es rechazada por validación.
 * Permite al sistema emisor (ej: gestion-api-trackers) enterarse de errores
 * y tomar acciones correctivas (logging, alertas, etc.)
 */
export interface IPositionRejectedEvent {
  /**
   * Identificador del dispositivo que envió la posición inválida
   */
  deviceId: string;

  /**
   * Motivo del rechazo (mensaje descriptivo)
   */
  reason: string;

  /**
   * Timestamp del rechazo en milisegundos (Unix epoch)
   */
  rejectedAt: number;

  /**
   * Posición original que fue rechazada (puede contener campos inválidos)
   */
  originalEvent: any;
};
