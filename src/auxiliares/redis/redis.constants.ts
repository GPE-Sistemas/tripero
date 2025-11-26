import { REDIS_KEY_PREFIX } from '../../env';

/**
 * Helper para generar keys con prefijo
 * Permite usar un Redis compartido sin colisiones
 */
export const prefixKey = (key: string): string => `${REDIS_KEY_PREFIX}${key}`;

/**
 * Helper para generar canales con prefijo
 */
export const prefixChannel = (channel: string): string =>
  `${REDIS_KEY_PREFIX}${channel}`;

/**
 * Keys de almacenamiento Redis (sin prefijo - se aplica en RedisService)
 */
export const REDIS_KEYS = {
  // TrackerStateService
  TRACKER_STATE: (trackerId: string) => `tracker:state:${trackerId}`,
  TRACKER_PERSIST_COUNTER: (trackerId: string) =>
    `tracker:state:${trackerId}:persist_counter`,

  // DeviceStateService
  DEVICE_STATE: (deviceId: string) => `device:state:${deviceId}`,
  DEVICE_THROTTLE: (deviceId: string) => `device:throttle:${deviceId}`,
} as const;

/**
 * Canales Pub/Sub Redis (sin prefijo - se aplica en publish/subscribe)
 */
export const REDIS_CHANNELS = {
  // Posiciones
  POSITION_NEW: 'position:new',
  POSITION_REJECTED: 'position:rejected',

  // Ignición
  IGNITION_CHANGED: 'ignition:changed',

  // Eventos de trips
  TRIP_STARTED: 'trip:started',
  TRIP_COMPLETED: 'trip:completed',

  // Eventos de stops
  STOP_STARTED: 'stop:started',
  STOP_COMPLETED: 'stop:completed',

  // Estado del tracker
  TRACKER_STATE_CHANGED: 'tracker:state:changed',
} as const;

/**
 * Patrones para búsqueda de keys (con wildcard)
 */
export const REDIS_PATTERNS = {
  ALL_DEVICE_STATES: 'device:state:*',
  ALL_TRACKER_STATES: 'tracker:state:*',
} as const;
