import { CanActivate, createParamDecorator, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import { SupabaseAuthService } from './supabase-auth.service';

type AuthRequest = Request & { authUserId?: string };

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: SupabaseAuthService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length > 16384 || !/^Bearer [^\s]+$/i.test(header)) {
      throw new UnauthorizedException();
    }
    request.authUserId = await this.auth.verify(header.slice(7));
    return true;
  }
}

export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const id = context.switchToHttp().getRequest<AuthRequest>().authUserId;
  if (!id) throw new UnauthorizedException();
  return id;
});
