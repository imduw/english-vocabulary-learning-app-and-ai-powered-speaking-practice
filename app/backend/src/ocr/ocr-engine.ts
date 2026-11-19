import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createWorker, OEM, PSM, Worker } from 'tesseract.js';
import { APP_CONFIG } from '../database/database.service';
import { AppConfig } from '../config';
import { ApiError } from '../common/api-error';
import { NativeOcr } from './ocr-native';
import { OcrPage } from './ocr-page';

@Injectable()
export class OcrEngine implements OnModuleInit, OnModuleDestroy {
  private worker?: Worker;
  private initializing?: Promise<Worker>;
  private closing = false;
  private readonly native=new NativeOcr();
  private nativeReady?: Promise<void>;
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}
  async onModuleInit(): Promise<void> { if (this.config.ocr?.warmup) {if(this.isNative())await this.prepareNative();else await this.ready();} }
  private isNative() {return this.config.ocr?.engine==='native';}
  private async models() {
    const directory=join(__dirname,'../../../models');
    const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8')) as {models:Record<string,{sha256:string;source_sha256:string}>};
    const models=[];
    for (const code of ['eng','vie']) {
      const bytes=await readFile(join(directory,`${code}.traineddata.gz`));
      if(createHash('sha256').update(bytes).digest('hex')!==manifest.models[code]?.sha256)throw new Error('OCR model integrity check failed');
      models.push({code,bytes,sourceHash:manifest.models[code].source_sha256});
    }
    return {directory,models};
  }
  private prepareNative(): Promise<void> {
    if(!this.nativeReady)this.nativeReady=this.models().then(({models})=>this.native.initialize(models)).catch(error=>{this.nativeReady=undefined;throw error;});
    return this.nativeReady;
  }
  private async ready(): Promise<Worker> {
    if (this.closing) throw new Error('OCR is shutting down');
    if (this.worker) return this.worker;
    if (!this.initializing) {
      this.initializing = (async()=>{
        // Bundled, pinned tessdata_fast assets: no runtime download or disk cache.
        const {directory}=await this.models();
        // The string-language API avoids v7's broken Lang-object init path.
        const worker=await createWorker('eng+vie',OEM.LSTM_ONLY,{langPath:directory,cacheMethod:'none',logger:()=>{},errorHandler:()=>{}});
        try {
          await worker.setParameters({tessedit_pageseg_mode:PSM.AUTO,preserve_interword_spaces:'1',classify_enable_learning:'0'});
          if (this.closing) throw new Error('OCR is shutting down');
        } catch (error) {await worker.terminate();throw error;}
        this.worker = worker;
        return worker;
      })().finally(()=>{this.initializing=undefined;});
    }
    return this.initializing;
  }
  async recognize(image: Buffer): Promise<OcrPage> {
    if(this.isNative()) {
      try {await this.prepareNative();return await this.native.recognize(image);}
      catch(error) {if(error instanceof ApiError)throw error;throw new ApiError(503,'OCR_UNAVAILABLE','OCR is temporarily unavailable');}
    }
    let worker: Worker|undefined;
    let timer: NodeJS.Timeout|undefined;
    try {
      worker = await this.ready();
      const result = await Promise.race([
        worker.recognize(image,{}, {text:true,blocks:true}),
        new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('OCR timed out')),15000);}),
      ]);
      return result.data;
    } catch {
      if (worker) { if (this.worker===worker) this.worker=undefined; await worker.terminate(); }
      throw new ApiError(503,'OCR_UNAVAILABLE','OCR is temporarily unavailable');
    } finally { if (timer) clearTimeout(timer); }
  }
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await this.native.close();
    await this.initializing?.catch(()=>undefined);
    await this.worker?.terminate();
    this.worker = undefined;
  }
}
