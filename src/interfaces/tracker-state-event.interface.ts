/**
 * Evento publicado cuando cambia el estado de movimiento de un tracker
 *
 * Canal Redis: tracker:state:changed
 *
 * Permite a IRIX recibir actualizaciones en tiempo real sin polling
 * Incluye información completa del tracker para evitar llamadas adicionales a la API
 */
export interface ITrackerStateChangedEvent {
  /**
   * ID del tracker/dispositivo
   */
  trackerId: string;

  /**
   * ID del dispositivo (igual a trackerId, incluido por compatibilidad)
   */
  deviceId: string;

  /**
   * Estado anterior de movimiento
   */
  previousState: 'STOPPED' | 'IDLE' | 'MOVING';

  /**
   * Nuevo estado de movimiento
   */
  currentState: 'STOPPED' | 'IDLE' | 'MOVING';

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
   * Información del odómetro
   */
  odometer: {
    /**
     * Odómetro total en metros (incluye offset)
     */
    total: number;
    /**
     * Odómetro total en kilómetros (total / 1000)
     */
    totalKm: number;
    /**
     * Distancia del trip actual en metros (si hay trip activo)
     */
    currentTrip?: number;
    /**
     * Distancia del trip actual en kilómetros
     */
    currentTripKm?: number;
  };

  /**
   * Última posición conocida del tracker
   */
  lastPosition: {
    timestamp: string;
    latitude: number;
    longitude: number;
    speed: number;
    ignition?: boolean;
    heading?: number;
    altitude?: number;
    /**
     * Edad de la última posición en segundos
     */
    age: number;
  };

  /**
   * Información del trip actual (si está en movimiento)
   */
  currentTrip?: {
    tripId: string;
    startTime: string;
    duration: number; // segundos
    distance: number; // metros
    avgSpeed: number; // km/h
    maxSpeed: number; // km/h
    odometerAtStart: number; // metros
  };
}
