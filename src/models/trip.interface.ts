export interface ITrip {
  _id?: string;

  // Identificadores
  idActivo: string;
  idVehiculo?: string;
  idTracker: string;
  idCliente: string;
  idsAncestros?: string[];

  // Tiempo
  startTime: Date;
  endTime: Date;
  duration: number; // segundos

  // Ubicación
  startLocation: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  endLocation: {
    type: 'Point';
    coordinates: [number, number];
  };
  startAddress?: string;
  endAddress?: string;

  // Distancia y velocidad
  distance: number; // metros
  odometerStart?: number;
  odometerEnd?: number;
  odometerDelta?: number;
  maxSpeed: number; // km/h
  avgSpeed: number; // km/h
  avgMovingSpeed: number; // km/h (solo tiempo en movimiento)

  // Combustible
  fuelStart?: number;
  fuelEnd?: number;
  fuelConsumption?: number;

  // Métricas adicionales
  idleTime: number; // segundos con ignición ON y velocidad = 0
  stopsCount: number; // cantidad de paradas > 1min
  pausesCount: number; // cantidad de pausas breves
  routeEfficiency?: number; // 0-1

  // Detección
  confidence: number; // 0-1
  detectionMethod: 'ignition' | 'speed' | 'ml' | 'mixed';
  detectionReasons: string[];

  // Metadata
  positionsCount: number;
  positionIds?: string[];

  // Estado
  status: 'in_progress' | 'completed' | 'invalid';

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateTrip extends Omit<ITrip, '_id' | 'createdAt' | 'updatedAt'> {}

export interface IUpdateTrip extends Partial<Omit<ITrip, '_id'>> {}
