import { IsNumber, IsString, IsOptional, Min } from 'class-validator';

/**
 * DTO para setear el odómetro inicial de un tracker
 * Permite ajustar el odómetro GPS para que coincida con el odómetro real del vehículo
 */
export class SetOdometerDto {
  /**
   * Valor del odómetro inicial en metros
   * Debe ser >= 0
   * Ejemplo: 125000 = 125 km
   */
  @IsNumber()
  @Min(0, { message: 'initialOdometer must be greater than or equal to 0' })
  initialOdometer: number;

  /**
   * Razón del ajuste (opcional)
   * Ejemplos: "vehicle_odometer_sync", "new_vehicle_registration", "device_replacement"
   */
  @IsString()
  @IsOptional()
  reason?: string;
}
