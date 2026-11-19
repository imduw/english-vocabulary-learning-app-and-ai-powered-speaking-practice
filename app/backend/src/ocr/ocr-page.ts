export interface OcrWord {text:string;confidence:number;bbox:{x0:number;y0:number;x1:number;y1:number}}
export interface OcrPage {confidence:number;blocks:{paragraphs:{lines:{words:OcrWord[]}[]}[]}[]|null}
