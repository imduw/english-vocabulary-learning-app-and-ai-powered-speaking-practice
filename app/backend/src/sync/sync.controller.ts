import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { SyncService } from './sync.service';

@Controller('api/v1/sync')
@UseGuards(AuthGuard)
export class SyncController {
  constructor(private readonly sync:SyncService){}
  @Post('batch') @HttpCode(200)
  batch(@CurrentUser() user:string,@Body() body:unknown){return this.sync.batch(user,body);}
  @Get('changes')
  changes(@CurrentUser() user:string,@Query() query:unknown){return this.sync.changes(user,query);}
}
