import { Module } from '@nestjs/common';
import { RedisService } from './redis/redis.service';

@Module({
  imports: [],
  providers: [RedisService],
  exports: [RedisService],
})
export class AuxiliaresModule {}
