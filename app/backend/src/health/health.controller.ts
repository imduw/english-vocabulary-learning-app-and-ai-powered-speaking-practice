import { Controller, Get } from '@nestjs/common';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  ready() { return this.health.readiness(); }

  @Get('live')
  live() {
    return { status: 'ok', data: { application: 'up' }, error: null, metadata: {} };
  }
}
