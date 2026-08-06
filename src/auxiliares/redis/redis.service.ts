import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
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
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private logger = new LoggerService('RedisService');
  private client: Redis;
  private redlock: Redlock;
  private ultimoError?: string;
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

  constructor() {
    // Conectar acá y no sólo en onModuleInit: otros providers pueden pedir
    // Redis antes de que Nest corra los hooks del módulo, y ahí this.client
    // todavía era undefined (TypeError en waitForConnection).
    this.createClient();
  }

  async onModuleInit() {
    this.createClient();
  }

  async onModuleDestroy() {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }

  private createClient() {
    // Idempotente: una sola conexión por proceso, la llame el constructor,
    // onModuleInit o el primer uso.
    if (this.client) return;
    // La reconexión la maneja ioredis con retryStrategy. No crear clientes
    // nuevos a mano: cada cliente extra queda vivo reintentando por su cuenta,
    // reinicia el contador de backoff en 1s y pisa el flag `ready` compartido.
    this.client = new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      db: REDIS_DB,
      password: REDIS_PASSWORD,
      enableOfflineQueue: true, // los comandos se encolan durante el corte
      maxRetriesPerRequest: 3, // la request falla rápido en vez de colgarse
      connectTimeout: 10000,
      retryStrategy: (times) => {
        // Backoff exponencial con jitter, techo 30s
        const base = Math.min(1000 * 2 ** Math.min(times, 5), 30000);
        const delay = Math.round(base / 2 + Math.random() * (base / 2));
        if (times === 1 || times % 10 === 0) {
          this.logger.warn(
            `Redis reconectando (intento ${times}), próximo en ${delay}ms`,
          );
        }
        return delay;
      },
    });

    // Un solo Redlock por cliente: si se creaba dentro de 'connect' quedaba
    // undefined mientras Redis estuviera caído y lockKey fallaba en silencio.
    this.redlock = new Redlock([this.client], { retryCount: 0 });

    // 'ready' (no 'connect'): recién ahí terminaron AUTH y SELECT de la db.
    this.client.on('ready', () => {
      this.ultimoError = undefined;
      this.ready = true;
      this.logger.log(
        `Redis listo ${REDIS_HOST}:${REDIS_PORT} db ${REDIS_DB} prefix "${this.prefix}"`,
      );
    });

    this.client.on('error', (err) => {
      this.ready = false;
      // El mismo error se repite en cada intento: loguear sólo los cambios.
      if (err.message !== this.ultimoError) {
        this.ultimoError = err.message;
        this.logger.error('Error de Redis', err.message);
      }
    });

    this.client.on('close', () => {
      this.ready = false;
    });

    this.client.on('end', () => {
      this.ready = false;
      this.logger.error('Redis terminó sin más reintentos');
    });
  }

  private async waitForConnection(timeoutMs = 5000): Promise<void> {
    if (!this.client) this.createClient();
    if (this.client.status === 'ready') return;

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.client.off('ready', onReady);
      };
      const onReady = () => {
        cleanup();
        resolve();
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Redis connection timeout'));
      }, timeoutMs);

      this.client.once('ready', onReady);
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

  async mget<T = any>(keys: string[]): Promise<(T | null)[]> {
    await this.waitForConnection();
    if (keys.length === 0) return [];

    const prefixedKeys = keys.map((k) => this.prefixKey(k));
    const results = await this.client.mget(...prefixedKeys);

    return results.map((result) => {
      if (!result) return null;
      try {
        return JSON.parse(result) as T;
      } catch {
        return result as any;
      }
    });
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
    // ioredis re-suscribe los canales por su cuenta al reconectar, así que el
    // llamador NO debe crear otro subscriber cuando la conexión se cierra:
    // cada subscriber extra recibe una copia de cada mensaje.
    return new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      db: REDIS_DB,
      password: REDIS_PASSWORD,
      retryStrategy: (times) => {
        const base = Math.min(1000 * 2 ** Math.min(times, 5), 30000);
        return Math.round(base / 2 + Math.random() * (base / 2));
      },
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
    // SCAN en vez de KEYS: KEYS bloquea el server entero mientras recorre todo
    // el keyspace.
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, encontradas] = await this.client.scan(
        cursor,
        'MATCH',
        prefixedPattern,
        'COUNT',
        1000,
      );
      cursor = nextCursor;
      keys.push(...encontradas);
    } while (cursor !== '0');
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
