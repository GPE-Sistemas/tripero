/**
 * Eventos de salida: trip:started, trip:completed, stop:started, stop:completed
 *
 * Canales: Redis PubSub
 * Consumers: Servicios de notificaciones, dashboards, analítica
 */

export interface ITripStartedEvent {
  tripId: string;
  deviceId: string;
  startTime: string; // ISO 8601
  startLocation: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  detectionMethod: 'ignition' | 'motion';
  currentState: 'STOPPED' | 'IDLE' | 'MOVING'; // Estado actual (siempre MOVING al iniciar)
  odometer: number; // Odómetro total en metros (incluye offset)
  metadata?: Record<string, any>; // Metadata personalizado (ej: tenant_id, fleet_id, etc.)
}

export interface ITripCompletedEvent {
  tripId: string;
  deviceId: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  duration: number; // Segundos
  distance: number; // Metros
  avgSpeed: number; // km/h
  maxSpeed: number; // km/h
  stopsCount: number;
  startLocation: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  endLocation: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  detectionMethod: 'ignition' | 'motion';
  currentState: 'STOPPED' | 'IDLE' | 'MOVING'; // Estado actual (puede ser STOPPED o IDLE)
  odometer: number; // Odómetro total en metros (incluye offset)
  metadata?: Record<string, any>; // Metadata personalizado (ej: tenant_id, fleet_id, etc.)
}

export interface IStopStartedEvent {
  stopId: string;
  tripId?: string;
  deviceId: string;
  startTime: string; // ISO 8601
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  reason: 'ignition_off' | 'no_movement' | 'parking';
  currentState: 'STOPPED' | 'IDLE' | 'MOVING'; // Estado actual (siempre IDLE)
  odometer: number; // Odómetro total en metros (incluye offset)
  metadata?: Record<string, any>; // Metadata personalizado (ej: tenant_id, fleet_id, etc.)
}

export interface IStopCompletedEvent {
  stopId: string;
  tripId?: string;
  deviceId: string;
  startTime: string; // ISO 8601
  endTime: string; // ISO 8601
  duration: number; // Segundos
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  reason: 'ignition_off' | 'no_movement' | 'parking';
  currentState: 'STOPPED' | 'IDLE' | 'MOVING'; // Estado actual (MOVING si retoma movimiento)
  odometer: number; // Odómetro total en metros (incluye offset)
  metadata?: Record<string, any>; // Metadata personalizado (ej: tenant_id, fleet_id, etc.)
}

/**
 * Evento emitido cuando un trip es descartado por no cumplir los mínimos
 * (duración < minTripDuration o distancia < minTripDistance)
 *
 * El trip ya fue creado en BD con trip:started, este evento indica
 * que debe ser eliminado.
 */
export interface ITripDiscardedEvent {
  tripId: string;
  deviceId: string;
  reason: 'too_short' | 'too_small_distance' | 'below_minimums';
  duration: number; // Duración del trip descartado (segundos)
  distance: number; // Distancia del trip descartado (metros)
}
