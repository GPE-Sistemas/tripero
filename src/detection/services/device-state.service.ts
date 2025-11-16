import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../../auxiliares/redis/redis.service';
import { IDeviceMotionState } from '../models';
import { DEVICE_STATE_TTL } from '../../env';

/**
 * Servicio para gestionar el estado de dispositivos en Redis
 */
@Injectable()
export class DeviceStateService {
  private readonly logger = new Logger(DeviceStateService.name);
  private readonly STATE_TTL = DEVICE_STATE_TTL; // Configurable via env, alineado con tracker_state

  constructor(private readonly redis: RedisService) {}

  /**
   * Obtiene el estado actual de un dispositivo
   */
  async getDeviceState(
    deviceId: string,
  ): Promise<IDeviceMotionState | null> {
    const key = this.getStateKey(deviceId);

    try {
      const data = await this.redis.get<IDeviceMotionState>(key);
      return data;
    } catch (error) {
      this.logger.error(
        `Error getting state for device ${deviceId}`,
        error.stack,
      );
      return null;
    }
  }

  /**
   * Guarda el estado de un dispositivo
   */
  async saveDeviceState(state: IDeviceMotionState): Promise<void> {
    const key = this.getStateKey(state.deviceId);

    try {
      await this.redis.set(key, state, this.STATE_TTL);
    } catch (error) {
      this.logger.error(
        `Error saving state for device ${state.deviceId}`,
        error.stack,
      );
      throw error;
    }
  }

  /**
   * Elimina el estado de un dispositivo
   */
  async deleteDeviceState(deviceId: string): Promise<void> {
    const key = this.getStateKey(deviceId);

    try {
      await this.redis.del(key);
    } catch (error) {
      this.logger.error(
        `Error deleting state for device ${deviceId}`,
        error.stack,
      );
    }
  }

  /**
   * Verifica si una posición ya fue procesada (throttling)
   */
  async isPositionThrottled(
    deviceId: string,
    timestamp: number,
  ): Promise<boolean> {
    const key = this.getThrottleKey(deviceId);

    try {
      const lastProcessed = await this.redis.get<number>(key);

      if (!lastProcessed) {
        // Primera posición, no está throttled
        await this.redis.set(key, timestamp, 5); // TTL corto
        return false;
      }

      // Si la posición es más antigua o igual, está throttled
      if (timestamp <= lastProcessed) {
        return true;
      }

      // Actualizar último timestamp procesado
      await this.redis.set(key, timestamp, 5);
      return false;
    } catch (error) {
      this.logger.error(
        `Error checking throttle for device ${deviceId}`,
        error.stack,
      );
      // En caso de error, no throttlear
      return false;
    }
  }

  /**
   * Obtiene todos los dispositivos con estado activo
   */
  async getAllActiveDevices(): Promise<string[]> {
    try {
      const pattern = this.getStateKey('*');
      const client = this.redis.getClient();
      const keys = await client.keys(pattern);

      return keys.map((key) => key.replace('device:state:', ''));
    } catch (error) {
      this.logger.error('Error getting all active devices', error.stack);
      return [];
    }
  }

  /**
   * Genera la clave de Redis para el estado del dispositivo
   */
  private getStateKey(deviceId: string): string {
    return `device:state:${deviceId}`;
  }

  /**
   * Genera la clave de Redis para throttling
   */
  private getThrottleKey(deviceId: string): string {
    return `device:throttle:${deviceId}`;
  }
}
