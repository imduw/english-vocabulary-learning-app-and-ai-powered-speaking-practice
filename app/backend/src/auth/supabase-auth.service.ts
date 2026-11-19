import { Inject, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { AppConfig } from '../config';
import { APP_CONFIG } from '../database/database.service';

@Injectable()
export class SupabaseAuthService {
  private readonly keys?: ReturnType<typeof createRemoteJWKSet>;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    if (config.auth) this.keys = createRemoteJWKSet(new URL(config.auth.jwksUrl), {
      timeoutDuration: 3000, cooldownDuration: 30000, cacheMaxAge: 600000,
    });
  }

  async verify(token: string): Promise<string> {
    if (!this.keys || !this.config.auth) throw new ServiceUnavailableException('Authentication is not configured');
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        issuer: this.config.auth.issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256'],
        requiredClaims: ['sub', 'exp', 'iat', 'role', 'aud', 'iss'], clockTolerance: 5,
      });
      if (payload.role !== 'authenticated' || payload.is_anonymous === true
        || typeof payload.sub !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.sub)
        || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 5) {
        throw new UnauthorizedException();
      }
      return payload.sub.toLowerCase();
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      if (error instanceof errors.JOSEError && !['ERR_JWKS_TIMEOUT', 'ERR_JWKS_INVALID'].includes(error.code)) {
        throw new UnauthorizedException();
      }
      throw new ServiceUnavailableException('Authentication keys unavailable');
    }
  }
}
