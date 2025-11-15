/**
 * Evento de entrada: ignition:changed
 *
 * Canal: Redis PubSub 'ignition:changed'
 *
 * Este evento se genera cuando un tracker reporta un cambio de estado de ignición
 * de manera separada (no como campo en posiciones). Es común en trackers como GPS103.
 *
 * Los eventos de ignición se usan para actualizar el estado persistente del tracker
 * en TrackerState, para que posiciones posteriores sin campo ignition puedan
 * usar el último estado conocido.
 */

export interface IIgnitionEvent {
  /**
   * Identificador único del dispositivo/vehículo
   * Puede ser IMEI, serial number, UUID, etc.
   */
  deviceId: string;

  /**
   * Timestamp del evento de ignición en milisegundos (Unix epoch)
   */
  timestamp: number;

  /**
   * Estado de ignición del vehículo
   * true = ignición encendida (motor encendido)
   * false = ignición apagada (motor apagado)
   */
  ignition: boolean;

  /**
   * Latitud en grados decimales (-90 a 90)
   * Opcional: algunos eventos de ignición incluyen posición
   */
  latitude?: number;

  /**
   * Longitud en grados decimales (-180 a 180)
   * Opcional: algunos eventos de ignición incluyen posición
   */
  longitude?: number;
}

/**
 * Validaciones del evento de ignición
 */
export const validateIgnitionEvent = (
  event: any,
): event is IIgnitionEvent => {
  // Campos requeridos
  if (!event.deviceId || typeof event.deviceId !== 'string') return false;
  if (!event.timestamp || typeof event.timestamp !== 'number') return false;
  if (typeof event.ignition !== 'boolean') return false;

  // Validar timestamp (no futuro, máximo 24 horas en el pasado)
  const now = Date.now();
  const oneDayAgo = now - 86400000; // 24 horas
  if (event.timestamp > now + 60000) return false; // +1 min tolerancia de clock skew
  if (event.timestamp < oneDayAgo) return false;

  // Validar coordenadas opcionales
  if (event.latitude !== undefined) {
    if (typeof event.latitude !== 'number') return false;
    if (event.latitude < -90 || event.latitude > 90) return false;
  }

  if (event.longitude !== undefined) {
    if (typeof event.longitude !== 'number') return false;
    if (event.longitude < -180 || event.longitude > 180) return false;
  }

  return true;
};
