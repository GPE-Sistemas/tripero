/**
 * DTO de respuesta para stops
 * Compatible con formato de Traccar API
 */
export class StopResponseDto {
  /**
   * ID del dispositivo
   */
  deviceId: string;

  /**
   * Nombre del dispositivo (opcional)
   */
  deviceName?: string;

  /**
   * Duración del stop en segundos
   */
  duration: number;

  /**
   * Timestamp de inicio del stop (ISO 8601)
   */
  startTime: string;

  /**
   * Timestamp de fin del stop (ISO 8601)
   */
  endTime: string;

  /**
   * Latitud del stop
   */
  latitude: number;

  /**
   * Longitud del stop
   */
  longitude: number;

  /**
   * Dirección del stop (opcional)
   */
  address?: string;

  /**
   * Horas de motor (opcional, no implementado)
   */
  engineHours?: number;
}
