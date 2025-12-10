import { IsArray, IsString, ArrayNotEmpty } from 'class-validator';

/**
 * DTO para obtener el status de múltiples trackers
 */
export class BulkStatusDto {
  /**
   * Array de IDs de trackers
   * Ejemplo: ["TRACKER001", "TRACKER002", "TRACKER003"]
   */
  @IsArray()
  @ArrayNotEmpty({ message: 'trackerIds must not be empty' })
  @IsString({ each: true })
  trackerIds: string[];
}
