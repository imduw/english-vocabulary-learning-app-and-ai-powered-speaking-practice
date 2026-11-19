import { CallHandler, Controller, ExecutionContext, HttpException, HttpCode, Injectable, NestInterceptor, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { catchError, throwError } from 'rxjs';
import { AuthGuard } from '../auth/auth.guard';
import { ApiError } from '../common/api-error';
import { OcrRequest, OcrRequestGuard } from './ocr-budget';
import { OcrService, OcrUpload } from './ocr.service';
import { MAX_IMAGE_BYTES } from './ocr-image';

@Injectable()
export class OcrUploadErrors implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(catchError(error => {
      if (error instanceof ApiError) return throwError(() => error);
      if (error instanceof HttpException && error.getStatus() === 413) return throwError(() => new ApiError(413,'IMAGE_TOO_LARGE','Image must not exceed 10 MiB'));
      if (error instanceof HttpException && error.getStatus() === 400) return throwError(() => new ApiError(400,'INVALID_MULTIPART','Send exactly one image file in field image, with no text fields'));
      return throwError(() => error);
    }));
  }
}

@Controller('api/v1/ocr')
@UseGuards(AuthGuard, OcrRequestGuard)
export class OcrController {
  constructor(private readonly ocr: OcrService) {}
  @Post('process')
  @HttpCode(200)
  @UseInterceptors(OcrUploadErrors, FileInterceptor('image', {
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 32 },
    fileFilter: (_req,file,callback) => callback(['image/jpeg','image/png','image/webp'].includes(file.mimetype) ? null : new ApiError(400,'UNSUPPORTED_IMAGE','Only JPEG, PNG and WebP images are accepted'), true),
  }))
  process(@Req() request: OcrRequest, @UploadedFile() file: OcrUpload|undefined, @Query() query: Record<string,unknown>) {
    if (Object.keys(query).length) throw new ApiError(400,'INVALID_OCR_QUERY','OCR does not accept query parameters');
    if (!file) throw new ApiError(400,'MISSING_IMAGE','Send one image file in field image');
    return this.ocr.process(file, request.ocrLease!);
  }
}
