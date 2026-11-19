import {CanActivate,ExecutionContext,Injectable} from '@nestjs/common';
import {Request,Response} from 'express';
import {ApiError} from '../common/api-error';

@Injectable()
export class AuthRateGuard implements CanActivate {
  private readonly windows=new Map<string,{start:number;count:number}>();
  private readonly clock=()=>performance.now();
  canActivate(context:ExecutionContext){
    const http=context.switchToHttp(),request=http.getRequest<Request>(),response=http.getResponse<Response>();
    response.setHeader('Cache-Control','no-store');response.setHeader('Pragma','no-cache');
    // Forwarded headers are untrusted; proxy deployments need an edge limiter.
    const ip=request.socket.remoteAddress??'unknown',now=this.clock();
    for(const [key,value]of this.windows)if(now-value.start>=60000)this.windows.delete(key);
    let window=this.windows.get(ip);
    if(!window){
      if(this.windows.size>=10000){response.setHeader('Retry-After','60');throw new ApiError(503,'SERVICE_UNAVAILABLE','Authentication capacity unavailable');}
      window={start:now,count:0};this.windows.set(ip,window);
    }
    if(window.count>=30){response.setHeader('Retry-After',String(Math.max(1,Math.ceil((60000-now+window.start)/1000))));throw new ApiError(429,'RATE_LIMITED','Too many authentication requests');}
    window.count++;return true;
  }
}
