// Original public synthetic documents. Run intentionally to regenerate assets;
// the benchmark reads the committed PNGs, so host fonts cannot alter its input.
import sharp from 'sharp';
import { mkdir,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory=new URL('../fixtures/ocr/',import.meta.url);
await mkdir(directory,{recursive:true});
const repeated='Learning English every day builds confidence and opens new opportunities.';
const paragraphs=[
  'Learning a new language begins with small actions that become familiar habits. A student can read a short story, write a few useful words, and listen to a friendly conversation. These activities create several ways to remember the same idea. Reading connects spelling with meaning. Listening connects sounds with words. Speaking gives the learner a chance to use the language for a real purpose. Each small activity supports the others and makes the next lesson easier.',
  'A useful vocabulary notebook includes more than a translation. It can contain an example sentence, a simple definition, and a personal connection. For example, someone who enjoys cooking may remember a new word by describing a favorite meal. Another person may connect the word with a recent journey. Personal examples give new language a place in everyday life. Reviewing these examples over several days helps the learner recognize the word in different situations and use it with confidence.',
  'Speaking practice works best when the goal is clear and manageable. A learner might explain a picture, describe a plan for the weekend, or ask for directions. The first attempt does not need to be perfect. After speaking, the learner can notice one useful improvement and try again. This approach gives attention to progress instead of mistakes. A patient conversation partner can ask questions and offer examples without interrupting every sentence. Regular practice gradually makes the language more natural.',
  'Good learning materials offer both familiar language and a small challenge. If every word is unknown, the reader may lose the main idea. If everything is already easy, there is little opportunity to learn. A short article about a familiar subject can provide the right balance. The reader can understand the situation while discovering several useful expressions. Context also helps explain why a word has a particular meaning. The same word may express a different idea in another sentence.',
  'A flexible study plan makes room for real life. Some days allow time for a full lesson, while other days permit only a quick review. Both kinds of practice can be useful. Keeping a record of completed activities makes progress visible and helps the learner choose the next step. Rest is part of learning too. Returning to a topic after a break can reveal which words are familiar and which need another example. Consistent attention matters more than a perfect schedule.',
];
const wrap=(text,max=80)=>{const lines=[];let line='';for(const word of text.split(/\s+/)){if(line&&line.length+word.length+1>max){lines.push(line);line=word;}else line+=(line?' ':'')+word;}if(line)lines.push(line);return lines;};
const escape=text=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const cases=[
  {id:'standard-page',width:2480,height:3508,font:44,step:82,paragraphs:[Array.from({length:36},()=>repeated).join('\n')],explicit:true},
  {id:'varied-page',width:2480,height:3508,font:44,step:76,paragraphs},
  {id:'english-small',width:1600,height:620,font:48,step:80,paragraphs:['Learning English is useful. Practice speaking every day!','A careful reader connects each new word with a complete sentence.'],explicit:true},
  {id:'vietnamese-small',width:1700,height:650,font:48,step:86,paragraphs:['Tôi đang học tiếng Việt mỗi ngày để giao tiếp tốt hơn.','Mỗi từ mới cần một câu ví dụ rõ ràng và dễ hiểu.','Học đều đặn giúp chúng ta ghi nhớ kiến thức lâu hơn.'],explicit:true},
];
const manifest={description:'Original synthetic, non-personal OCR fixtures. Frozen PNG inputs; no third-party scans.',cases:[]};
for(const item of cases){
 let y=item.height>1000?200:110;const lines=[];
 for(const paragraph of item.paragraphs){for(const line of item.explicit?paragraph.split('\n'):wrap(paragraph)){lines.push({text:line,y});y+=item.step;}if(!item.explicit)y+=20;}
 if(y>item.height-50)throw Error(`Fixture does not fit: ${item.id}`);
 const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${item.width}" height="${item.height}"><rect width="100%" height="100%" fill="white"/>${lines.map(line=>`<text x="${item.height>1000?170:60}" y="${line.y}" font-family="Arial,DejaVu Sans,sans-serif" font-size="${item.font}">${escape(line.text)}</text>`).join('')}</svg>`;
 const bytes=await sharp(Buffer.from(svg)).png().toBuffer();
 await writeFile(new URL(`${item.id}.svg`,directory),svg+'\n');await writeFile(new URL(`${item.id}.png`,directory),bytes);
 const text=item.paragraphs.join('\n\n');
 manifest.cases.push({id:item.id,file:`${item.id}.png`,width:item.width,height:item.height,text,word_count:text.match(/[\p{L}\p{N}]+/gu).length,line_count:lines.length,sha256:createHash('sha256').update(bytes).digest('hex')});
 console.log(JSON.stringify({id:item.id,words:manifest.cases.at(-1).word_count,lines:lines.length,bytes:bytes.length}));
}
await writeFile(new URL('manifest.json',directory),JSON.stringify(manifest,null,2)+'\n');
