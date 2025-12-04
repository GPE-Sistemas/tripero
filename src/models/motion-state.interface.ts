export type MotionStateType =
  | 'STOPPED'
  | 'STARTING'
  | 'MOVING'
  | 'IDLE'
  | 'STOPPING';

export interface PositionSnapshot {
  time: number; // timestamp
  speed: number; // km/h
  location: [number, number]; // [lon, lat]
  ignition?: boolean;
}

export interface MotionState {
  trackerId: string;
  activoId: string;

  // Estado actual
  state: MotionStateType;
  stateStartTime: number; // timestamp

  // Trip actual (si existe)
  currentTripId?: string;
  tripStartTime?: number;
  tripStartLocation?: [number, number];
  tripAccumulatedDistance?: number;
  tripMaxSpeed?: number;
  tripPositionsCount?: number;

  // Features calculados
  avgSpeed30s: number;
  avgSpeed1min: number;
  avgSpeed5min: number;
  lastIgnitionState?: boolean;
  lastSpeed: number;
  lastPosition: [number, number];
  lastPositionTime: number;

  // Buffer de posiciones recientes (para cálculos)
  // Últimas 300 posiciones (~5 min @ 1 pos/seg)
  recentPositions: PositionSnapshot[];

  // Metadata
  lastUpdate: number; // timestamp
  version: number; // para optimistic locking
}

export interface TripInProgress {
  _id: string;
  idActivo: string;
  idTracker: string;
  idCliente: string;

  startTime: number;
  startLocation: [number, number];

  // Stats actualizados en tiempo real
  accumulatedDistance: number;
  maxSpeed: number;
  positionsCount: number;
  idleTime: number;
  stopsCount: number;

  lastUpdate: number;
}
