import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request, Response } from 'express';
import { ApiError } from '../common/api-error';

export interface OcrLease {
  processing: boolean;
  begin(): void;
  release(): void;
}
export type OcrRequest = Request & { authUserId?: string; ocrLease?: OcrLease };

@Injectable()
export class OcrBudget {
  private active?: OcrLease;
  private readonly windows = new Map<string, { start: number; count: number }>();
  acquire(user: string, now = performance.now()): OcrLease {
    const prior = this.windows.get(user);
    if (prior && now - prior.start < 60000 && prior.count >= 10) {
      throw new ApiError(429, 'OCR_RATE_LIMITED', 'At most 10 OCR uploads per minute', { retry_after_seconds: Math.max(1,Math.ceil((prior.start+60000-now)/1000)) });
    }
    if (this.active) throw new ApiError(503, 'OCR_BUSY', 'OCR is busy; retry shortly');
    if (!prior && this.windows.size >= 10000) {
      for (const [id, window] of this.windows) if (now-window.start >= 60000) this.windows.delete(id);
      if (this.windows.size >= 10000) throw new ApiError(503, 'OCR_BUSY', 'OCR is busy; retry shortly');
    }
    const window = prior && now-prior.start < 60000 ? prior : { start: now, count: 0 };
    window.count++; this.windows.set(user, window);
    let released = false;
    const lease: OcrLease = {
      processing: false,
      begin: () => {
        if (released || this.active !== lease) throw new ApiError(400,'UPLOAD_CANCELLED','Upload was cancelled');
        lease.processing = true;
      },
      release: () => { if (!released) { released = true; if (this.active === lease) this.active = undefined; } },
    };
    this.active = lease;
    return lease;
  }
}

@Injectable()
export class OcrRequestGuard implements CanActivate {
  constructor(private readonly budget: OcrBudget) {}
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<OcrRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    if (!request.authUserId) throw new ApiError(401,'UNAUTHORIZED','Authentication is required');
    let lease: OcrLease;
    try { lease = this.budget.acquire(request.authUserId); }
    catch (error) {
      if (error instanceof ApiError) {
        const seconds=error.details?.retry_after_seconds;
        response.setHeader('Retry-After',typeof seconds==='number'?seconds:1);
      }
      throw error;
    }
    request.ocrLease = lease;
    const uploadDeadline=setTimeout(()=>{if(!lease.processing){lease.release();request.destroy();}},15000);
    uploadDeadline.unref();
    const releaseUpload = () => {clearTimeout(uploadDeadline);if (!lease.processing) lease.release();};
    response.once('finish', releaseUpload);
    response.once('close', releaseUpload);
    return true;
  }
}
