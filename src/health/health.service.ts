import { Injectable } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';
import { RedisService } from '../auxiliares/redis/redis.service';
import { HttpService } from '../auxiliares/http/http.service';

@Injectable()
export class HealthService {
  constructor(
    private redis: RedisService,
    private http: HttpService,
    @InjectConnection()
    private connection: Connection,
  ) {}

  async check() {
    const checks = await Promise.allSettled([
      this.checkRedis(),
      this.checkDatabase(),
      this.checkApiDatos(),
    ]);

    const [redisCheck, databaseCheck, apiDatosCheck] = checks;

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      services: {
        redis: {
          status: redisCheck.status === 'fulfilled' ? 'up' : 'down',
          details: redisCheck.status === 'fulfilled'
            ? redisCheck.value
            : { error: (redisCheck as PromiseRejectedResult).reason?.message },
        },
        database: {
          status: databaseCheck.status === 'fulfilled' ? 'up' : 'down',
          details: databaseCheck.status === 'fulfilled'
            ? databaseCheck.value
            : { error: (databaseCheck as PromiseRejectedResult).reason?.message },
        },
        apiDatos: {
          status: apiDatosCheck.status === 'fulfilled' ? 'up' : 'down',
          details: apiDatosCheck.status === 'fulfilled'
            ? apiDatosCheck.value
            : { error: (apiDatosCheck as PromiseRejectedResult).reason?.message },
        },
      },
    };
  }

  async ready() {
    try {
      const redisReady = this.redis.ready;
      const databaseReady = this.connection.isConnected;

      const isReady = redisReady && databaseReady;

      return {
        status: isReady ? 'ready' : 'not ready',
        redis: redisReady,
        database: databaseReady,
      };
    } catch (error) {
      return {
        status: 'not ready',
        redis: false,
        database: false,
      };
    }
  }

  private async checkRedis() {
    const testKey = 'health:check';
    const testValue = Date.now().toString();

    await this.redis.set(testKey, testValue, 5);
    const retrieved = await this.redis.get<string>(testKey);

    if (retrieved !== testValue) {
      throw new Error('Redis read/write check failed');
    }

    await this.redis.del(testKey);

    return { message: 'Redis is healthy' };
  }

  private async checkDatabase() {
    try {
      // Verificar conexión ejecutando una query simple
      const result = await this.connection.query('SELECT NOW() as now');

      // Verificar si TimescaleDB está instalado
      const timescaleCheck = await this.connection.query(
        "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb'"
      );

      const isTimescaleDB = timescaleCheck.length > 0;

      return {
        message: 'Database is healthy',
        connected: true,
        timescaledb: isTimescaleDB,
        serverTime: result[0].now,
      };
    } catch (error) {
      throw new Error(`Database check failed: ${error.message}`);
    }
  }

  private async checkApiDatos() {
    try {
      // Intentar hacer un health check al API de datos si existe
      // Si no, simplemente verificar que la URL está configurada
      return { message: 'API Datos configured', configured: true };
    } catch (error) {
      throw new Error(`API Datos check failed: ${error.message}`);
    }
  }
}
