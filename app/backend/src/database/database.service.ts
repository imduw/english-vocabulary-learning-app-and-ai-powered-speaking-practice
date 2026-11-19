import { Inject, Injectable, Logger, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { AppConfig } from '../config';

export const APP_CONFIG = Symbol('APP_CONFIG');

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly pool: Pool;
  private readonly brokenClients = new WeakSet<PoolClient>();
  private readonly logger = new Logger(DatabaseService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.pool = new Pool(config.database);
    // Pool error events cover idle clients only. A borrowed client can also emit
    // a socket error; leaving that event unhandled would terminate the process.
    this.pool.on('connect', client => {
      client.on('error', () => {
        this.brokenClients.add(client);
        this.logger.error('database_connection_error');
      });
    });
    // Do not log pg errors: they can contain SQL, identifiers or connection details.
    this.pool.on('error', () => this.logger.error('database_idle_connection_error'));
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async withUser<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    let client: PoolClient;
    try { client = await this.pool.connect(); }
    catch { throw new ServiceUnavailableException('Database unavailable'); }
    let broken = false;
    try {
      const role = await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
      if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) {
        throw new ServiceUnavailableException('Unsafe runtime database role');
      }
      await client.query('BEGIN');
      // Transaction-local: identity cannot leak to the next pool borrower.
      await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { broken = true; }
      if (broken || this.brokenClients.has(client)) {
        throw new ServiceUnavailableException('Database connection unavailable');
      }
      throw error;
    } finally {
      client.release(broken || this.brokenClients.has(client));
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
