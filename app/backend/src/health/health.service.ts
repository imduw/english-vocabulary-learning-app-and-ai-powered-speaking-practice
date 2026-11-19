import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';

@Injectable()
export class HealthService {
  constructor(private readonly database: DatabaseService) {}

  async readiness() {
    try {
      await this.database.ping();
      return { status: 'ok', data: { database: 'up' }, error: null, metadata: {} };
    } catch {
      throw new ServiceUnavailableException('Database unavailable');
    }
  }
}
