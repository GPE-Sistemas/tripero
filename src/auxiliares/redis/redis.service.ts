import { Injectable, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import Redlock, { ExecutionResult, Lock } from 'redlock';
import {
  REDIS_DB,
  REDIS_HOST,
  REDIS_PORT,
  REDIS_PASSWORD,
  REDIS_KEY_PREFIX,
} from '../../env';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class RedisService implements OnModuleInit {
  private logger = new LoggerService('RedisService');
  private client: Redis;
  private redlock: Redlock;
  public ready = false;
  private readonly prefix = REDIS_KEY_PREFIX;

  /**
   * Aplica el prefijo a una key
   */
  private prefixKey(key: string): string {
    return `${this.prefix}${key}`;
  }

  /**
   * Aplica el prefijo a un canal pub/sub
   */
  private prefixChannel(channel: string): string {
    return `${this.prefix}${channel}`;
  }

  /**
   * Obtiene el prefijo configurado (para uso externo si es necesario)
   */
  getPrefix(): string {
    return this.prefix;
  }

  async onModuleInit() {
    this.createClient();
  }

  private createClient() {
    this.client = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      db: REDIS_DB,
      password: REDIS_PASSWORD,
      retryStrategy: (times) => {
        const delay = Math.min(times * 1000, 30000);
        this.logger.log(`Intentando reconectar a Redis en ${delay / 1000}s...`);
        return delay;
      },
    });

    this.client.on('connect', () => {
      this.logger.log(
        `Redis conectado ${REDIS_HOST}:${REDIS_PORT} db ${REDIS_DB} prefix "${this.prefix}"`,
      );
      this.redlock = new Redlock([this.client]);
      this.ready = true;
    });

    this.client.on('error', (err) => {
      this.logger.error('Error de Redis', err.message);
      this.ready = false;
    });

    this.client.on('close', () => {
      this.logger.error('Redis cerrado');
      this.ready = false;
      setTimeout(() => {
        if (!this.ready) {
          this.logger.log('Intentando reconectar a Redis (manual)...');
          this.createClient();
        }
      }, 5000);
    });
  }

  private async waitForConnection(): Promise<void> {
    if (this.ready) return;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout'));
      }, 10000);

      const checkConnection = () => {
        if (this.ready) {
          clearTimeout(timeout);
          resolve();
        } else {
          setTimeout(checkConnection, 100);
        }
      };

      checkConnection();
    });
  }

  // Lock methods
  async lockKey(key: string, time = 300000): Promise<Lock | false> {
    try {
      await this.waitForConnection();
      const prefixedKey = this.prefixKey(key);
      return await this.redlock.acquire([prefixedKey], time, { retryCount: 0 });
    } catch (error) {
      return false;
    }
  }

  async releaseKey(lock: Lock): Promise<ExecutionResult | false> {
    try {
      await this.waitForConnection();
      return await this.redlock.release(lock);
    } catch (error) {
      return false;
    }
  }

  // Basic operations
  async set(key: string, value: any, ttlInSeconds?: number): Promise<'OK'> {
    await this.waitForConnection();
    const prefixedKey = this.prefixKey(key);
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlInSeconds) {
      return this.client.set(prefixedKey, stringValue, 'EX', ttlInSeconds);
    }
    return this.client.set(prefixedKey, stringValue);
  }

  async get<T = any>(key: string): Promise<T | null> {
    await this.waitForConnection();
    const prefixedKey = this.prefixKey(key);
    const result = await this.client.get(prefixedKey);
    if (!result) return null;

    try {
      return JSON.parse(result) as T;
    } catch {
      return result as any;
    }
  }

  async del(key: string | string[]): Promise<number> {
    await this.waitForConnection();
    if (Array.isArray(key)) {
      const prefixedKeys = key.map((k) => this.prefixKey(k));
      return this.client.del(...prefixedKeys);
    }
    return this.client.del(this.prefixKey(key));
  }

  async exists(key: string): Promise<number> {
    await this.waitForConnection();
    return this.client.exists(this.prefixKey(key));
  }

  async expire(key: string, ttlInSeconds: number): Promise<number> {
    await this.waitForConnection();
    return this.client.expire(this.prefixKey(key), ttlInSeconds);
  }

  async ttl(key: string): Promise<number> {
    await this.waitForConnection();
    return this.client.ttl(this.prefixKey(key));
  }

  async incr(key: string): Promise<number> {
    await this.waitForConnection();
    return this.client.incr(this.prefixKey(key));
  }

  // Set operations
  async sAdd(key: string, value: any, ttlInSeconds?: number): Promise<number> {
    await this.waitForConnection();
    const prefixedKey = this.prefixKey(key);
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.client.sadd(prefixedKey, stringValue);
    if (ttlInSeconds) {
      await this.client.expire(prefixedKey, ttlInSeconds);
    }
    return result;
  }

  async sRem(key: string, value: any): Promise<number> {
    await this.waitForConnection();
    const prefixedKey = this.prefixKey(key);
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    return this.client.srem(prefixedKey, stringValue);
  }

  async sMembers<T = any>(key: string): Promise<T[]> {
    await this.waitForConnection();
    const prefixedKey = this.prefixKey(key);
    const result = await this.client.smembers(prefixedKey);
    return result.map((item) => {
      try {
        return JSON.parse(item) as T;
      } catch {
        return item as any;
      }
    });
  }

  async sIsMember(key: string, value: any): Promise<number> {
    await this.waitForConnection();
    const prefixedKey = this.prefixKey(key);
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    return this.client.sismember(prefixedKey, stringValue);
  }

  // Publish/Subscribe
  async publish(channel: string, message: any): Promise<number> {
    await this.waitForConnection();
    const prefixedChannel = this.prefixChannel(channel);
    const stringMessage =
      typeof message === 'string' ? message : JSON.stringify(message);
    return this.client.publish(prefixedChannel, stringMessage);
  }

  /**
   * Crea un subscriber para un canal (aplica prefijo automáticamente)
   * @param channel Canal a suscribir
   * @param onMessage Callback para mensajes recibidos
   * @returns Cliente Redis configurado como subscriber
   */
  async subscribe(
    channel: string,
    onMessage: (channel: string, message: string) => void,
  ): Promise<Redis> {
    const subscriber = this.createSubscriber();
    const prefixedChannel = this.prefixChannel(channel);

    subscriber.on('message', (ch, msg) => {
      // Remover el prefijo del canal antes de pasar al callback
      const originalChannel = ch.replace(this.prefix, '');
      onMessage(originalChannel, msg);
    });

    await subscriber.subscribe(prefixedChannel);
    return subscriber;
  }

  /**
   * Crea un subscriber raw (sin prefijo automático)
   * Útil para casos donde se necesita control manual del prefijo
   */
  createSubscriber(): Redis {
    return new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      db: REDIS_DB,
      password: REDIS_PASSWORD,
    });
  }

  /**
   * Obtiene el canal con prefijo aplicado
   * Útil para subscribers manuales
   */
  getPrefixedChannel(channel: string): string {
    return this.prefixChannel(channel);
  }

  /**
   * Busca keys por patrón (aplica prefijo)
   */
  async keys(pattern: string): Promise<string[]> {
    await this.waitForConnection();
    const prefixedPattern = this.prefixKey(pattern);
    const keys = await this.client.keys(prefixedPattern);
    // Retornar keys sin prefijo para consistencia
    return keys.map((k) => k.replace(this.prefix, ''));
  }

  // Pipeline for batch operations
  getPipeline() {
    return this.client.pipeline();
  }

  // Get raw client
  getClient(): Redis {
    return this.client;
  }
}
