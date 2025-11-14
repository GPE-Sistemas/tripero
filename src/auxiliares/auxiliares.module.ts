import { Module } from '@nestjs/common';
import { HttpModule as NestHttpModule } from '@nestjs/axios';
import { RedisService } from './redis/redis.service';
import { HttpService } from './http/http.service';

@Module({
  imports: [NestHttpModule],
  providers: [RedisService, HttpService],
  exports: [RedisService, HttpService],
})
export class AuxiliaresModule {}
