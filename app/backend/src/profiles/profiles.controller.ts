import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { parseProfileUpdate } from './profile-input';
import { ProfilesRepository } from './profiles.repository';

@Controller('api/v1/user/profile')
@UseGuards(AuthGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesRepository) {}

  @Get()
  async get(@CurrentUser() userId: string) {
    return { status: 'ok', data: await this.profiles.getOrCreate(userId), error: null, metadata: {} };
  }

  @Patch()
  async update(@CurrentUser() userId: string, @Body() body: unknown) {
    const input = parseProfileUpdate(body);
    return { status: 'ok', data: await this.profiles.update(userId, input), error: null, metadata: {} };
  }
}
