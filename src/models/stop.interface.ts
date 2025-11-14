export interface IStop {
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
  location: {
    type: 'Point';
    coordinates: [number, number]; // [lon, lat]
  };
  address?: string;

  // Contexto
  zone?: 'depot' | 'client' | 'route' | 'unknown';
  zoneName?: string;

  // Relación con trip
  isInTrip: boolean;
  relatedTripId?: string;

  // Detección
  confidence: number; // 0-1
  detectionMethod: 'ignition' | 'speed' | 'ml' | 'mixed';
  stopReason?: 'ignition_off' | 'no_movement' | 'gap' | 'parking';

  // Estado
  status: 'ongoing' | 'completed';

  // Timestamps
  createdAt: Date;
  updatedAt: Date;
}

export interface ICreateStop extends Omit<IStop, '_id' | 'createdAt' | 'updatedAt'> {}

export interface IUpdateStop extends Partial<Omit<IStop, '_id'>> {}
