import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { RedisService } from './redis/redis.service';
import { GeocodeClientService } from './geocode/geocode-client.service';

@Module({
  imports: [HttpModule],
  providers: [RedisService, GeocodeClientService],
  exports: [RedisService, GeocodeClientService],
})
export class AuxiliaresModule {}
