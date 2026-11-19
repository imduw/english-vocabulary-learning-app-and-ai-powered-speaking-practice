import { detectAll } from 'tinyld';
import type { OcrPage, OcrWord } from './ocr-page';
import type { OcrImage } from './ocr-image';
import { ApiError } from '../common/api-error';

const clamp = (n: number,min=0,max=1) => Number.isFinite(n) ? Math.min(max,Math.max(min,n)) : min;
export function ocrResult(page: OcrPage,image: OcrImage) {
  const words: {index:number;text:string;confidence:number;bbox:{x:number;y:number;width:number;height:number};sentence_index:number;context:string}[]=[];
  const sentences: {index:number;text:string;word_indices:number[]}[]=[];
  const paragraphs: string[]=[];
  let contextCharacters=0;
  const segmenter = new Intl.Segmenter('en',{granularity:'sentence'});
  for (const block of page.blocks??[]) for (const paragraph of block.paragraphs) {
    const accepted: {raw:OcrWord;text:string;start:number;bbox:{x:number;y:number;width:number;height:number}}[]=[];
    let text='';
    for (const line of paragraph.lines) for (const raw of line.words) {
      const word=raw.text.trim(),box=raw.bbox;
      if (!word || ![box.x0,box.y0,box.x1,box.y1].every(Number.isFinite) || box.x1<=box.x0 || box.y1<=box.y0) continue;
      const x0=clamp(Math.round(box.x0*image.width/image.processed_width),0,image.width);
      const y0=clamp(Math.round(box.y0*image.height/image.processed_height),0,image.height);
      const x1=clamp(Math.round(box.x1*image.width/image.processed_width),x0,image.width);
      const y1=clamp(Math.round(box.y1*image.height/image.processed_height),y0,image.height);
      if (x1<=x0 || y1<=y0) continue;
      const start=text.length+(text.length?1:0); text+=(text.length?' ':'')+word;
      accepted.push({raw,text:word,start,bbox:{x:x0,y:y0,width:x1-x0,height:y1-y0}});
    }
    if (!accepted.length) continue;
    paragraphs.push(text);
    // Do not split a single OCR token/bounding box across sentence boundaries
    // (e.g. "Hello.World" when OCR did not recover the space).
    const wordStarts=new Set(accepted.map(item=>item.start));
    const starts=[...segmenter.segment(text)].map(segment=>segment.index).filter(index=>wordStarts.has(index));
    const groups=starts.map((index,i)=>({index,segment:text.slice(index,starts[i+1]??text.length)}));
    const offset=sentences.length;
    for (const segment of groups) sentences.push({index:sentences.length,text:segment.segment.trim(),word_indices:[]});
    let group=0;
    for (const item of accepted) {
      while (group+1<groups.length && item.start>=groups[group+1].index) group++;
      const sentence=sentences[offset+group];
      contextCharacters+=sentence.text.length;
      if(contextCharacters>2000000)throw new ApiError(422,'IMAGE_TOO_COMPLEX','Sentence contexts exceed the page limit');
      sentence.word_indices.push(words.length);
      words.push({index:words.length,text:item.text,confidence:clamp(item.raw.confidence/100),bbox:item.bbox,sentence_index:sentence.index,context:sentence.text});
      if (words.length>20000) throw new ApiError(422,'IMAGE_TOO_COMPLEX','Image contains too many words');
    }
  }
  const text=paragraphs.join('\n\n');
  const top=(text.match(/\p{L}/gu)?.length??0)>=20 ? detectAll(text.slice(0,10000))[0] : undefined;
  const language=top && top.accuracy>=0.5 ? {code:top.lang,confidence:clamp(top.accuracy),method:'tinyld_text'} : {code:'und',confidence:0,method:'tinyld_text'};
  return {text,confidence:clamp(page.confidence/100),language,
    image:{width:image.width,height:image.height,processed_width:image.processed_width,processed_height:image.processed_height,coordinate_space:'upright_original_pixels'},words,sentences};
}
