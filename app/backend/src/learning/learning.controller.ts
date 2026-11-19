import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { AuthGuard, CurrentUser } from '../auth/auth.guard';
import { LearningService } from './learning.service';

@Controller('api/v1/decks')
@UseGuards(AuthGuard)
export class DecksController {
  constructor(private readonly learning:LearningService) {}
  @Get() list(@CurrentUser() user:string,@Query() query:unknown) {return this.learning.list(user,'deck',query);}
  @Post() create(@CurrentUser() user:string,@Body() body:unknown) {return this.learning.create(user,'deck',body);}
  @Get(':id') get(@CurrentUser() user:string,@Param('id') id:string) {return this.learning.get(user,'deck',id);}
  @Patch(':id') update(@CurrentUser() user:string,@Param('id') id:string,@Body() body:unknown) {return this.learning.update(user,'deck',id,body);}
  @Delete(':id') remove(@CurrentUser() user:string,@Param('id') id:string,@Query() query:unknown) {return this.learning.remove(user,'deck',id,query);}
}

@Controller('api/v1/vocabulary')
@UseGuards(AuthGuard)
export class VocabularyController {
  constructor(private readonly learning:LearningService) {}
  @Get() list(@CurrentUser() user:string,@Query() query:unknown) {return this.learning.list(user,'card',query);}
  @Post() create(@CurrentUser() user:string,@Body() body:unknown) {return this.learning.create(user,'card',body);}
  @Post('batch') batch(@CurrentUser() user:string,@Body() body:unknown) {return this.learning.batch(user,body);}
  @Get(':id') get(@CurrentUser() user:string,@Param('id') id:string) {return this.learning.get(user,'card',id);}
  @Put(':id') update(@CurrentUser() user:string,@Param('id') id:string,@Body() body:unknown) {return this.learning.update(user,'card',id,body);}
  @Delete(':id') remove(@CurrentUser() user:string,@Param('id') id:string,@Query() query:unknown) {return this.learning.remove(user,'card',id,query);}
}
