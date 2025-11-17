/**
 * Evento publicado cuando cambia el estado de movimiento de un tracker
 *
 * Canal Redis: tracker:state:changed
 *
 * Permite a IRIX recibir actualizaciones en tiempo real sin polling
 */
export interface ITrackerStateChangedEvent {
  /**
   * ID del tracker/dispositivo
   */
  trackerId: string;

  /**
   * Estado anterior de movimiento
   */
  previousState: 'STOPPED' | 'IDLE' | 'MOVING';

  /**
   * Nuevo estado de movimiento
   */
  newState: 'STOPPED' | 'IDLE' | 'MOVING';

  /**
   * Timestamp del evento en formato ISO 8601
   */
  timestamp: string;

  /**
   * Razón del cambio de estado
   * Ejemplos: "threshold_reached", "ignition_on", "ignition_off"
   */
  reason: string;

  /**
   * Ubicación actual del tracker
   */
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };

  /**
   * Velocidad actual en km/h
   */
  speed: number;

  /**
   * Odómetro total del tracker en metros (incluye offset si está configurado)
   */
  odometer: number;
}
