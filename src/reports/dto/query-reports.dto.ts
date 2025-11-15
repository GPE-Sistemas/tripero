import { IsString, IsOptional, IsDateString, IsArray } from 'class-validator';
import { Transform } from 'class-transformer';

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
}
