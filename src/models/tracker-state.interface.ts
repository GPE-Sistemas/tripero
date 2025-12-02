/**
 * Estado en tiempo real de un tracker
 * Incluye odómetro acumulativo, última posición, trip actual, etc.
 */
export interface ITrackerState {
  _id?: string;

  // Identificadores
  trackerId: string; // IMEI, serial, UUID, etc.
  deviceId: string; // Mismo que trackerId (compatibilidad)

  // Odómetro (en metros)
  totalOdometer: number; // Odómetro acumulativo total (GPS-based)
  odometerOffset: number; // Offset para sincronizar con odómetro real del vehículo
  tripOdometerStart?: number; // Odómetro cuando empezó el trip actual

  // Última posición conocida
  lastPositionTime?: Date;
  lastLatitude?: number;
  lastLongitude?: number;
  lastSpeed?: number;
  lastIgnition?: boolean;
  lastHeading?: number;
  lastAltitude?: number;

  // Estado de movimiento
  currentState?: 'STOPPED' | 'MOVING' | 'PAUSED' | 'UNKNOWN';
  stateSince?: Date;

  // Trip actual
  currentTripId?: string;
  tripStartTime?: Date;
  tripStartLat?: number;
  tripStartLon?: number;

  // Estadísticas acumulativas
  totalTripsCount: number;
  totalDrivingTime: number; // segundos
  totalIdleTime: number; // segundos
  totalStopsCount: number;

  // Tracking de conexión eléctrica (inferido de overnight gaps)
  overnightGapCount: number; // Cantidad de gaps nocturnos detectados
  lastOvernightGapAt?: Date; // Fecha del último gap nocturno
  /**
   * Tipo de conexión eléctrica del tracker (inferido del comportamiento):
   *
   * - 'permanent': Conectado a batería permanente (BAT+/12V directo)
   *   → El tracker siempre tiene energía, no presenta gaps nocturnos
   *   → Comportamiento esperado: reporta 24/7
   *
   * - 'switched': Conectado a alimentación conmutada (ACC/contacto)
   *   → El tracker pierde energía cuando se apaga el vehículo
   *   → Comportamiento: gaps nocturnos frecuentes (>= 3 detectados)
   *   → Puede o no tener batería interna (si la tiene, reporta ignition_off antes de morir)
   *
   * - 'unknown': Sin datos suficientes para determinar
   *   → Tracker nuevo o con pocos días de operación
   */
  powerType: 'permanent' | 'switched' | 'unknown';

  // Metadata
  firstSeenAt: Date;
  lastSeenAt: Date;

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateTrackerState
  extends Omit<ITrackerState, '_id' | 'createdAt' | 'updatedAt'> {}

export interface IUpdateTrackerState
  extends Partial<Omit<ITrackerState, '_id'>> {}

/**
 * DTO para respuesta de API /trackers/:id/status
 */
export interface ITrackerStatus {
  trackerId: string;
  deviceId: string;

  odometer: {
    total: number; // metros
    totalKm: number; // convertido a km
    currentTrip: number; // metros del trip actual
    currentTripKm: number; // km del trip actual
  };

  currentState: {
    state: 'STOPPED' | 'MOVING' | 'PAUSED' | 'UNKNOWN' | 'OFFLINE';
    since: Date;
    duration: number; // segundos en este estado
  };

  lastPosition?: {
    timestamp: Date;
    latitude: number;
    longitude: number;
    speed: number;
    ignition: boolean;
    heading?: number;
    altitude?: number;
    age: number; // segundos desde última posición
  };

  currentTrip?: {
    tripId: string;
    startTime: Date;
    duration: number; // segundos
    distance: number; // metros
    avgSpeed: number;
    maxSpeed: number;
    odometerAtStart: number;
    startLat?: number;
    startLon?: number;
  };

  statistics: {
    totalTrips: number;
    totalDrivingTime: number; // segundos
    totalDrivingHours: number;
    totalIdleTime: number;
    totalIdleHours: number;
    totalStops: number;
    firstSeen: Date;
    lastSeen: Date;
    daysActive: number;
  };

  health: {
    status: 'online' | 'offline' | 'stale';
    lastSeenAgo: number; // segundos
    positionsToday?: number;
  };

  /**
   * Diagnóstico de conexión eléctrica del tracker
   * Inferido del análisis de gaps nocturnos
   */
  powerDiagnostic?: {
    /**
     * Tipo de conexión eléctrica inferido:
     * - 'permanent': BAT+ (siempre con energía)
     * - 'switched': ACC/contacto (pierde energía al apagar)
     * - 'unknown': sin datos suficientes
     */
    powerType: 'permanent' | 'switched' | 'unknown';
    /** Cantidad de gaps nocturnos (>2h) detectados */
    overnightGapCount: number;
    /** Fecha del último gap nocturno detectado */
    lastOvernightGapAt?: Date;
    /** true si se detectó conexión conmutada (switched) - requiere atención */
    hasPowerIssue: boolean;
    /** Recomendación de acción si hay problema */
    recommendation?: string;
  };
}

/**
 * DTO para resetear odómetro
 */
export interface IResetOdometer {
  newValue: number; // nuevo valor en metros
  reason: string; // motivo del reset
}

/**
 * DTO para setear odómetro inicial (con offset)
 */
export interface ISetOdometer {
  initialOdometer: number; // valor del odómetro real del vehículo en metros
  reason?: string; // motivo del ajuste
}
