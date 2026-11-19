import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ApiError } from '../common/api-error';
import { ProfileUpdate } from './profile-input';

@Injectable()
export class ProfilesRepository {
  constructor(private readonly database: DatabaseService) {}

  async getOrCreate(userId: string) {
    try {
      return await this.database.withUser(userId, async client => {
        await client.query('INSERT INTO app.profiles(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
        const { rows } = await client.query('SELECT * FROM app.profiles WHERE user_id=$1 AND deleted_at IS NULL', [userId]);
        if (!rows[0]) throw new ApiError(403, 'FORBIDDEN', 'Profile unavailable');
        return rows[0];
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23503') throw new ApiError(401, 'UNAUTHORIZED', 'Account unavailable');
      throw error;
    }
  }

  async update(userId: string, update: ProfileUpdate) {
    return this.database.withUser(userId, async client => {
      if (update.timezone !== undefined) {
        const zone = await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1', [update.timezone]);
        if (!zone.rowCount) throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid timezone');
      }
      const fields: string[] = [];
      const values: unknown[] = [userId, update.base_version];
      for (const key of ['display_name', 'timezone'] as const) {
        if (Object.hasOwn(update, key)) { values.push(update[key]); fields.push(`${key}=$${values.length}`); }
      }
      const { rows } = await client.query(`UPDATE app.profiles SET ${fields.join(', ')} WHERE user_id=$1 AND version=$2::bigint AND deleted_at IS NULL RETURNING *`, values);
      if (!rows[0]) {
        const current = await client.query('SELECT 1 FROM app.profiles WHERE user_id=$1 AND deleted_at IS NULL', [userId]);
        if (!current.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Profile not found');
        throw new ApiError(409, 'CONFLICT', 'Profile version has changed; fetch it again');
      }
      return rows[0];
    });
  }
}
