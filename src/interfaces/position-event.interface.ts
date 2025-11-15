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

  // Validar timestamp (no futuro, máximo 24 horas en el pasado para permitir delays)
  const now = Date.now();
  const oneDayAgo = now - 86400000; // 24 horas
  if (event.timestamp > now + 60000) return false; // +1 min tolerancia de clock skew
  if (event.timestamp < oneDayAgo) return false;

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
