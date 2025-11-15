/**
 * DTO de respuesta para trips
 * Compatible con formato de Traccar API
 */
export class TripResponseDto {
  /**
   * ID del dispositivo
   */
  deviceId: string;

  /**
   * Nombre del dispositivo (opcional)
   */
  deviceName?: string;

  /**
   * Velocidad máxima alcanzada en el trip (km/h)
   */
  maxSpeed: number;

  /**
   * Velocidad promedio del trip (km/h)
   */
  averageSpeed: number;

  /**
   * Distancia total recorrida (metros)
   */
  distance: number;

  /**
   * Combustible consumido (opcional, no implementado)
   */
  spentFuel?: number;

  /**
   * Duración del trip en segundos
   */
  duration: number;

  /**
   * Timestamp de inicio (ISO 8601)
   */
  startTime: string;

  /**
   * Dirección de inicio (opcional)
   */
  startAddress?: string;

  /**
   * Latitud de inicio
   */
  startLat: number;

  /**
   * Longitud de inicio
   */
  startLon: number;

  /**
   * Timestamp de fin (ISO 8601)
   */
  endTime: string;

  /**
   * Dirección de fin (opcional)
   */
  endAddress?: string;

  /**
   * Latitud de fin
   */
  endLat: number;

  /**
   * Longitud de fin
   */
  endLon: number;

  /**
   * ID único del conductor (opcional, no implementado)
   */
  driverUniqueId?: string;

  /**
   * Nombre del conductor (opcional, no implementado)
   */
  driverName?: string;
}
