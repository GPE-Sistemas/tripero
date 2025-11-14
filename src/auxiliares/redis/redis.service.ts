import { Injectable, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import Redlock, { ExecutionResult, Lock } from 'redlock';
import { REDIS_DB, REDIS_HOST, REDIS_PORT, REDIS_PASSWORD } from '../../env';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class RedisService implements OnModuleInit {
  private logger = new LoggerService('RedisService');
  private client: Redis;
  private redlock: Redlock;
  public ready = false;

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
        `Redis conectado ${REDIS_HOST}:${REDIS_PORT} db ${REDIS_DB}`,
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
      return await this.redlock.acquire([key], time, { retryCount: 0 });
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
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlInSeconds) {
      return this.client.set(key, stringValue, 'EX', ttlInSeconds);
    }
    return this.client.set(key, stringValue);
  }

  async get<T = any>(key: string): Promise<T | null> {
    await this.waitForConnection();
    const result = await this.client.get(key);
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
      return this.client.del(...key);
    }
    return this.client.del(key);
  }

  async exists(key: string): Promise<number> {
    await this.waitForConnection();
    return this.client.exists(key);
  }

  async expire(key: string, ttlInSeconds: number): Promise<number> {
    await this.waitForConnection();
    return this.client.expire(key, ttlInSeconds);
  }

  async ttl(key: string): Promise<number> {
    await this.waitForConnection();
    return this.client.ttl(key);
  }

  // Set operations
  async sAdd(key: string, value: any, ttlInSeconds?: number): Promise<number> {
    await this.waitForConnection();
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    const result = await this.client.sadd(key, stringValue);
    if (ttlInSeconds) {
      await this.client.expire(key, ttlInSeconds);
    }
    return result;
  }

  async sRem(key: string, value: any): Promise<number> {
    await this.waitForConnection();
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    return this.client.srem(key, stringValue);
  }

  async sMembers<T = any>(key: string): Promise<T[]> {
    await this.waitForConnection();
    const result = await this.client.smembers(key);
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
    const stringValue =
      typeof value === 'string' ? value : JSON.stringify(value);
    return this.client.sismember(key, stringValue);
  }

  // Publish/Subscribe
  async publish(channel: string, message: any): Promise<number> {
    await this.waitForConnection();
    const stringMessage =
      typeof message === 'string' ? message : JSON.stringify(message);
    return this.client.publish(channel, stringMessage);
  }

  createSubscriber(): Redis {
    return new Redis({
      host: REDIS_HOST,
      port: REDIS_PORT,
      db: REDIS_DB,
      password: REDIS_PASSWORD,
    });
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
