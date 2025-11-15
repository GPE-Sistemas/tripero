import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private healthService: HealthService) {}

  @Get()
  async check() {
    return await this.healthService.check();
  }

  @Get('ready')
  async ready() {
    return await this.healthService.ready();
  }

  @Get('live')
  async live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
