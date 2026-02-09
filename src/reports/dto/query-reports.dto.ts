import {
  IsString,
  IsOptional,
  IsDateString,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * DTO para query params de reportes
 * Compatible con API de Traccar
 */
export class QueryReportsDto {
  /**
   * ID de dispositivo(s)
   * Puede ser un string o array de strings separados por coma
   * Ejemplo: "TEST-001" o "TEST-001,TEST-002"
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((id) => id.trim());
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  deviceId?: string[];

  /**
   * ID de grupo(s) - Opcional, no implementado aún
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      return value.split(',').map((id) => id.trim());
    }
    return Array.isArray(value) ? value : [value];
  })
  @IsArray()
  groupId?: string[];

  /**
   * Fecha de inicio en formato ISO 8601
   * Ejemplo: "2024-01-01T00:00:00Z"
   */
  @IsDateString()
  from: string;

  /**
   * Fecha de fin en formato ISO 8601
   * Ejemplo: "2024-01-31T23:59:59Z"
   */
  @IsDateString()
  to: string;

  /**
   * Tenant ID - Filtro optimizado para multi-tenancy
   * Utiliza índice B-tree para queries rápidas (~1-2ms)
   * Ejemplo: "acme-corp"
   */
  @IsOptional()
  @IsString()
  tenantId?: string;

  /**
   * Client ID - Filtro optimizado para clientes
   * Utiliza índice B-tree para queries rápidas (~1-2ms)
   * Ejemplo: "client-123"
   */
  @IsOptional()
  @IsString()
  clientId?: string;

  /**
   * Fleet ID - Filtro optimizado para flotas
   * Utiliza índice B-tree para queries rápidas (~1-2ms)
   * Ejemplo: "delivery-trucks"
   */
  @IsOptional()
  @IsString()
  fleetId?: string;

  /**
   * Filtro genérico de metadata (JSONB)
   * Permite filtrar por cualquier campo personalizado
   * Utiliza índice GIN para queries flexibles (~5-10ms)
   *
   * Ejemplo como query param:
   * ?metadata={"driver_id":"driver-123","region":"north"}
   *
   * O en formato JSON cuando se envía como body
   */
  @IsOptional()
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  metadata?: Record<string, any>;

  /**
   * Límite de resultados
   * Trae los últimos x registros ordenados por fecha de inicio DESC
   * Ejemplo: ?limit=100
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
