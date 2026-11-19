import { ArgumentsHost, Catch, ExceptionFilter, HttpException, INestApplication, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';
import { ApiError } from './api-error';
import type { NestExpressApplication } from '@nestjs/platform-express';

@Catch()
export class HttpErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpErrorFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const oversized = (exception as {type?:string;status?:number})?.type==='entity.too.large' && (exception as {status?:number}).status===413;
    const status = exception instanceof HttpException ? exception.getStatus() : oversized ? 413 : 500;
    const codes: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION_ERROR', 503: 'SERVICE_UNAVAILABLE' };
    const code = status >= 500 ? (codes[status] ?? 'INTERNAL_ERROR') : exception instanceof ApiError ? exception.code : codes[status] ?? `HTTP_${status}`;
    if (status >= 500) this.logger.error({ event: 'request_failed', code, requestId: response.locals.requestId });
    response.status(status).json({
      status: 'error', data: null,
      error: { code, message: status >= 500 ? 'Service temporarily unavailable' : exception instanceof ApiError ? exception.safeMessage : 'Request rejected', ...(status < 500 && exception instanceof ApiError && exception.details ? { details: exception.details } : {}) },
      metadata: { requestId: response.locals.requestId },
    });
  }
}

export function configureHttp(app: INestApplication, options: {corsOrigins?:string[]} = {}): void {
  (app as NestExpressApplication).useBodyParser('json',{limit:'1mb'});
  if(options.corsOrigins?.length)app.enableCors({origin:options.corsOrigins,credentials:false,methods:['GET','POST','PUT','PATCH','DELETE','OPTIONS'],allowedHeaders:['authorization','content-type'],exposedHeaders:['x-request-id','Retry-After'],maxAge:600});
  const logger = new Logger('HTTP');
  app.use((req: Request, res: Response, next: NextFunction) => {
    const started = performance.now();
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('x-request-id', requestId);
    res.on('finish', () => logger.log({
      event: 'request_completed', requestId, method: req.method,
      // Route template only: never log URLs, tokens, body, headers or query parameters.
      route: req.route?.path ?? 'unmatched', statusCode: res.statusCode,
      durationMs: Math.round(performance.now() - started),
    }));
    next();
  });
  app.useGlobalFilters(new HttpErrorFilter());
}
