import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ApiError } from '../common/api-error';
import { OcrPage, OcrWord } from './ocr-page';

export function parseTsv(tsv: string): OcrPage {
  const rows=tsv.split(/\r?\n/);
  if (!rows[0]?.startsWith('level\tpage_num\t')) throw new Error('Invalid engine output');
  const paragraphs=new Map<string,Map<string,OcrWord[]>>();
  const confidences:number[]=[];
  for (const row of rows.slice(1)) {
    const cells=row.split('\t');
    if (cells[0]!=='5' || cells.length<12 || !cells.slice(11).join('\t').trim()) continue;
    const [x,y,width,height,confidence]=cells.slice(6,11).map(Number);
    if (![x,y,width,height,confidence].every(Number.isFinite) || width<=0 || height<=0) continue;
    const paragraphId=cells.slice(1,4).join(':'),lineId=cells[4];
    let lines=paragraphs.get(paragraphId);
    if (!lines) {lines=new Map();paragraphs.set(paragraphId,lines);}
    let words=lines.get(lineId);
    if (!words) {words=[];lines.set(lineId,words);}
    words.push({text:cells.slice(11).join('\t').trim(),confidence,bbox:{x0:x,y0:y,x1:x+width,y1:y+height}});
    confidences.push(confidence);
  }
  return {confidence:confidences.length?confidences.reduce((a,b)=>a+b,0)/confidences.length:0,
    blocks:[{paragraphs:[...paragraphs.values()].map(lines=>({lines:[...lines.values()].map(words=>({words}))}))}]};
}

// Only public model weights are materialized in this private temporary folder.
// Uploaded PNG bytes go to stdin; no shell, filenames, URLs, or image disk files.
export class NativeOcr {
  private directory?: string;
  private initializing?: Promise<void>;
  private closing=false;
  private readonly children=new Set<ReturnType<typeof spawn>>();
  async initialize(models: {code:string;bytes:Buffer;sourceHash:string}[]): Promise<void> {
    if (this.closing) throw new Error('OCR is shutting down');
    if (this.directory) return;
    if (!this.initializing) this.initializing=(async()=>{
      const directory=await mkdtemp(join(tmpdir(),'vocabulary-ocr-native-'));
      try {
        for (const {code,bytes,sourceHash} of models) {
          const raw=gunzipSync(bytes);
          if(createHash('sha256').update(raw).digest('hex')!==sourceHash)throw new Error('OCR model integrity check failed');
          await writeFile(join(directory,`${code}.traineddata`),raw);
        }
        await this.run(['--version']);
        this.directory=directory;
      } catch (error) {await this.remove(directory);throw error;}
    })().finally(()=>{this.initializing=undefined;});
    return this.initializing;
  }
  async recognize(image:Buffer): Promise<OcrPage> {
    if (!this.directory || this.closing) throw new Error('OCR is unavailable');
    const output=await this.run(['stdin','stdout','--tessdata-dir',this.directory,'-l','eng+vie','--psm','3',
      '-c','classify_enable_learning=0','-c','tessedit_create_tsv=1','-c','tessedit_create_txt=0'],image);
    return parseTsv(output);
  }
  private run(args:string[],image?:Buffer): Promise<string> {
    return new Promise((resolve,reject)=>{
      const child=spawn('tesseract',args,{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{
        PATH:process.env.PATH??process.env.Path,SystemRoot:process.env.SystemRoot,
        LANG:'C.UTF-8',OMP_THREAD_LIMIT:'1',OMP_NUM_THREADS:'1',
      }});
      this.children.add(child);
      const chunks:Buffer[]=[];let length=0;let failure:Error|undefined;
      const timer=setTimeout(()=>{failure=new Error('OCR timed out');child.kill('SIGKILL');},15000);
      child.stdout!.on('data',(chunk:Buffer)=>{
        length+=chunk.length;
        if (length>4*1024*1024) {failure=new ApiError(422,'IMAGE_TOO_COMPLEX','OCR output exceeds the page limit');child.kill('SIGKILL');}
        else chunks.push(chunk);
      });
      // Drain native diagnostics without forwarding text, paths or upload data.
      child.stderr!.on('data',()=>{});
      child.stdin!.on('error',()=>{});
      child.on('error',()=>{failure=new Error('OCR executable is unavailable');});
      child.on('close',code=>{
        clearTimeout(timer);this.children.delete(child);
        if (failure || code!==0) reject(failure??new Error('OCR executable failed'));
        else resolve(Buffer.concat(chunks).toString('utf8'));
      });
      child.stdin!.end(image);
    });
  }
  private async remove(directory:string) {
    await Promise.allSettled(['eng','vie'].map(code=>unlink(join(directory,`${code}.traineddata`))));
    await rmdir(directory).catch(()=>undefined);
  }
  async close(): Promise<void> {
    this.closing=true;
    const closed=[...this.children].map(child=>new Promise<void>(resolve=>child.once('close',()=>resolve())));
    for (const child of this.children) child.kill('SIGKILL');
    await Promise.allSettled(closed);
    await this.initializing?.catch(()=>undefined);
    if (this.directory) await this.remove(this.directory);
    this.directory=undefined;
  }
}
