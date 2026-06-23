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

  /**
   * Odómetro al inicio del stop (metros)
   */
  startOdometer?: number;

  /**
   * Odómetro al final del stop (metros)
   */
  endOdometer?: number;

  /**
   * Razón del stop: 'ignition_off' (motor apagado) | 'no_movement' (encendido sin movimiento) | 'gap' | 'parking'
   */
  reason?: string;

  /**
   * true si la parada está EN CURSO (sin cerrar) al momento de la consulta.
   * En ese caso endTime/duration se calcularon hasta el fin del período (o ahora),
   * no representan un cierre real.
   */
  isActive?: boolean;
}
