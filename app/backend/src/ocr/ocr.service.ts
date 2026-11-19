import { Injectable } from '@nestjs/common';
import { OcrLease } from './ocr-budget';
import { OcrEngine } from './ocr-engine';
import { OcrImageProcessor, OcrUpload } from './ocr-image';
import { ocrResult } from './ocr-result';
export type { OcrUpload } from './ocr-image';

@Injectable()
export class OcrService {
  constructor(private readonly images: OcrImageProcessor,private readonly engine: OcrEngine) {}
  async process(file: OcrUpload,lease: OcrLease) {
    lease.begin();
    const start=performance.now();
    try {
      const image=await this.images.prepare(file);
      const page=await this.engine.recognize(image.buffer);
      return {status:'ok',data:ocrResult(page,image),error:null,metadata:{processing_ms:Math.round((performance.now()-start)*100)/100}};
    } finally {lease.release();}
  }
}
