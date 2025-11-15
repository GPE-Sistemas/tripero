import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/typeorm';
import { Connection } from 'typeorm';

/**
 * Servicio de inicialización automática de base de datos
 *
 * Se ejecuta al arrancar el servicio y se encarga de:
 * 1. Verificar si TimescaleDB está disponible
 * 2. Convertir tablas trips y stops en hypertables (si no lo son ya)
 * 3. Configurar políticas de compresión y retención
 *
 * NOTA: TypeORM ya creó las tablas con synchronize:true
 * Este servicio solo configura las extensiones de TimescaleDB
 */
@Injectable()
export class DatabaseInitService implements OnModuleInit {
  private readonly logger = new Logger(DatabaseInitService.name);

  constructor(
    @InjectConnection()
    private readonly connection: Connection,
  ) {}

  async onModuleInit() {
    this.logger.log('Initializing database with TimescaleDB extensions...');

    try {
      // 1. Verificar si TimescaleDB está disponible
      const hasTimescaleDB = await this.checkTimescaleDB();

      if (!hasTimescaleDB) {
        this.logger.warn(
          'TimescaleDB extension not available. Running without time-series optimizations.',
        );
        return;
      }

      this.logger.log('TimescaleDB extension detected');

      // 2. Convertir trips y stops en hypertables (si no lo son ya)
      await this.setupHypertables();

      // 3. Configurar compresión y retención
      await this.setupPolicies();

      this.logger.log('Database initialization completed successfully');
    } catch (error) {
      this.logger.error('Error during database initialization:', error.message);
      // No lanzamos error para permitir que el servicio arranque
      // Solo logueamos el problema
    }
  }

  /**
   * Verifica si TimescaleDB está disponible
   */
  private async checkTimescaleDB(): Promise<boolean> {
    try {
      const result = await this.connection.query(
        "SELECT default_version FROM pg_available_extensions WHERE name = 'timescaledb'"
      );
      return result.length > 0;
    } catch (error) {
      this.logger.warn('Could not check TimescaleDB availability:', error.message);
      return false;
    }
  }

  /**
   * Configura hypertables para trips y stops
   */
  private async setupHypertables(): Promise<void> {
    await this.setupHypertable('trips', 'start_time');
    await this.setupHypertable('stops', 'start_time');
  }

  /**
   * Convierte una tabla en hypertable si aún no lo es
   */
  private async setupHypertable(
    tableName: string,
    timeColumn: string,
  ): Promise<void> {
    try {
      // Verificar si ya es hypertable
      const checkQuery = `
        SELECT * FROM timescaledb_information.hypertables
        WHERE hypertable_name = $1
      `;
      const existing = await this.connection.query(checkQuery, [tableName]);

      if (existing.length > 0) {
        this.logger.log(`Table "${tableName}" is already a hypertable`);
        return;
      }

      // Convertir en hypertable
      this.logger.log(`Converting "${tableName}" to hypertable...`);
      await this.connection.query(
        `SELECT create_hypertable($1, $2, if_not_exists => TRUE)`,
        [tableName, timeColumn],
      );
      this.logger.log(`Table "${tableName}" converted to hypertable successfully`);
    } catch (error) {
      this.logger.warn(
        `Could not convert "${tableName}" to hypertable: ${error.message}`,
      );
    }
  }

  /**
   * Configura políticas de compresión y retención
   */
  private async setupPolicies(): Promise<void> {
    await this.setupCompressionPolicy('trips');
    await this.setupCompressionPolicy('stops');
    await this.setupRetentionPolicy('trips');
    await this.setupRetentionPolicy('stops');
  }

  /**
   * Configura política de compresión para una tabla
   * Comprime datos más viejos de 7 días
   */
  private async setupCompressionPolicy(tableName: string): Promise<void> {
    try {
      // Verificar si ya tiene política de compresión
      const checkQuery = `
        SELECT * FROM timescaledb_information.jobs
        WHERE hypertable_name = $1 AND proc_name = 'policy_compression'
      `;
      const existing = await this.connection.query(checkQuery, [tableName]);

      if (existing.length > 0) {
        this.logger.log(`Table "${tableName}" already has compression policy`);
        return;
      }

      // Configurar compresión
      this.logger.log(`Setting up compression for "${tableName}"...`);

      await this.connection.query(`
        ALTER TABLE ${tableName} SET (
          timescaledb.compress,
          timescaledb.compress_segmentby = 'id_activo',
          timescaledb.compress_orderby = 'start_time DESC'
        )
      `);

      await this.connection.query(
        `SELECT add_compression_policy($1, INTERVAL '7 days')`,
        [tableName],
      );

      this.logger.log(`Compression policy set for "${tableName}"`);
    } catch (error) {
      this.logger.warn(
        `Could not set compression policy for "${tableName}": ${error.message}`,
      );
    }
  }

  /**
   * Configura política de retención para una tabla
   * Elimina datos más viejos de 365 días
   */
  private async setupRetentionPolicy(tableName: string): Promise<void> {
    try {
      // Verificar si ya tiene política de retención
      const checkQuery = `
        SELECT * FROM timescaledb_information.jobs
        WHERE hypertable_name = $1 AND proc_name = 'policy_retention'
      `;
      const existing = await this.connection.query(checkQuery, [tableName]);

      if (existing.length > 0) {
        this.logger.log(`Table "${tableName}" already has retention policy`);
        return;
      }

      // Configurar retención
      this.logger.log(`Setting up retention for "${tableName}"...`);
      await this.connection.query(
        `SELECT add_retention_policy($1, INTERVAL '365 days')`,
        [tableName],
      );
      this.logger.log(`Retention policy set for "${tableName}"`);
    } catch (error) {
      this.logger.warn(
        `Could not set retention policy for "${tableName}": ${error.message}`,
      );
    }
  }
}
