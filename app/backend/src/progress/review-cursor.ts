import { invalid, object } from '../learning/learning-input';
interface ReviewCursor {v:1;stream:'reviews';user:string;after:string;until:string|null}
export const encodeReviewCursor=(c:ReviewCursor)=>Buffer.from(JSON.stringify(c)).toString('base64url');
const position=(n:unknown)=>{
  if(typeof n!=='string'||!/^\d{1,19}$/.test(n)||BigInt(n)>9223372036854775807n)throw invalid('Invalid review position');
  return BigInt(n).toString();
};
export function reviewCursor(user:string,raw:unknown){
  const input=object(raw);
  if(Object.keys(input).some(k=>!['cursor','limit'].includes(k)))throw invalid();
  const limit=input.limit===undefined?100:Number(input.limit);
  if((input.limit!==undefined&&(typeof input.limit!=='string'||!/^\d+$/.test(input.limit)))||!Number.isInteger(limit)||limit<1||limit>100)throw invalid();
  let cursor:ReviewCursor={v:1,stream:'reviews',user,after:'0',until:null};
  if(input.cursor!==undefined){
    if(typeof input.cursor!=='string'||input.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw invalid();
    let value:Record<string,unknown>;
    try{value=object(JSON.parse(Buffer.from(input.cursor,'base64url').toString()));}catch{throw invalid();}
    if(value.v!==1||value.stream!=='reviews'||value.user!==user||Object.keys(value).some(k=>!['v','stream','user','after','until'].includes(k)))throw invalid('Cursor belongs to another account or feed');
    cursor={v:1,stream:'reviews',user,after:position(value.after),until:value.until===null?null:position(value.until)};
    if(cursor.until!==null&&BigInt(cursor.after)>BigInt(cursor.until))throw invalid();
  }
  return {cursor,limit};
}
