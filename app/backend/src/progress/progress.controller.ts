import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { ProgressService } from './progress.service';
@Controller('api/v1/progress')
@UseGuards(AuthGuard)
export class ProgressController {
  constructor(private readonly progress:ProgressService){}
  @Post('review') @HttpCode(200)
  review(@CurrentUser() user:string,@Body() body:unknown){return this.progress.review(user,body);}
  @Get('summary')
  summary(@CurrentUser() user:string,@Query() query:unknown){return this.progress.summary(user,query);}
  @Get('history')
  history(@CurrentUser() user:string,@Query() query:unknown){return this.progress.history(user,query);}
  @Get('changes')
  changes(@CurrentUser() user:string,@Query() query:unknown){return this.progress.changes(user,query);}
}
