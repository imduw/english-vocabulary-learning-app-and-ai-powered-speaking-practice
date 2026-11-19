import {Body,Controller,HttpCode,Post,Query,Res,UseGuards} from '@nestjs/common';
import {Response} from 'express';
import {ApiError} from '../common/api-error';
import {AuthSessionService} from './auth-session.service';
import {AuthRateGuard} from './auth-rate.guard';
import {AuthAction} from './auth-input';

@Controller('api/v1/auth')
@UseGuards(AuthRateGuard)
export class AuthController {
  constructor(private readonly sessions:AuthSessionService){}
  @Post('register') @HttpCode(200)
  register(@Body()body:unknown,@Query()query:unknown,@Res({passthrough:true})response:Response){return this.call('register',body,query,response);}
  @Post('login') @HttpCode(200)
  login(@Body()body:unknown,@Query()query:unknown,@Res({passthrough:true})response:Response){return this.call('login',body,query,response);}
  @Post('refresh') @HttpCode(200)
  refresh(@Body()body:unknown,@Query()query:unknown,@Res({passthrough:true})response:Response){return this.call('refresh',body,query,response);}
  private async call(action:AuthAction,body:unknown,query:unknown,response:Response){
    try{return await this.sessions.exchange(action,body,query);}
    catch(error){if(error instanceof ApiError&&[429,503].includes(error.getStatus()))response.setHeader('Retry-After','60');throw error;}
  }
}
