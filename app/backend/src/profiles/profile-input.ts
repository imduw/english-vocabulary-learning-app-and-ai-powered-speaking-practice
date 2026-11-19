import { ApiError } from '../common/api-error';

export interface ProfileUpdate { base_version: string; display_name?: string | null; timezone?: string }

export function parseProfileUpdate(body: unknown): ProfileUpdate {
  const invalid = () => new ApiError(422, 'VALIDATION_ERROR', 'Provide base_version and valid profile fields only');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(k => !['base_version', 'display_name', 'timezone'].includes(k))
    || typeof value.base_version !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value.base_version)
    || BigInt(value.base_version) > 9223372036854775807n
    || (!Object.hasOwn(value, 'display_name') && !Object.hasOwn(value, 'timezone'))) throw invalid();
  const result: ProfileUpdate = { base_version: value.base_version };
  if (Object.hasOwn(value, 'display_name')) {
    if (value.display_name === null) result.display_name = null;
    else if (typeof value.display_name === 'string' && value.display_name.trim().length >= 1 && value.display_name.trim().length <= 120) result.display_name = value.display_name.trim();
    else throw invalid();
  }
  if (Object.hasOwn(value, 'timezone')) {
    if (typeof value.timezone !== 'string' || value.timezone.length < 1 || value.timezone.length > 100) throw invalid();
    result.timezone = value.timezone;
  }
  return result;
}
