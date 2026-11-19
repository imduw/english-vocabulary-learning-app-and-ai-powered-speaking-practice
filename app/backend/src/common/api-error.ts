import { HttpException } from '@nestjs/common';

// Only static, application-owned messages should be used here, never driver errors.
export class ApiError extends HttpException {
  constructor(status: number, public readonly code: string, public readonly safeMessage: string, public readonly details?: Record<string, unknown>) {
    super(safeMessage, status);
  }
}
