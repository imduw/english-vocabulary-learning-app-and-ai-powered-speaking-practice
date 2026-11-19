import { invalid, object, uuid } from '../learning/learning-input';
import { ALGORITHM } from './sm2';
export function reviewInput(value:unknown) {
  const input=object(value);
  const keys=['id','card_id','quality','score','reviewed_at','timezone_at_review','algorithm_version'];
  if(Object.keys(input).some(k=>!keys.includes(k)))throw invalid('Unknown or server-owned fields');
  const id=uuid(input.id),card_id=uuid(input.card_id);
  if(!Number.isInteger(input.quality)||(input.quality as number)<0||(input.quality as number)>5)throw invalid('Quality must be an integer from 0 to 5');
  if(input.score!==undefined&&input.score!==null&&(!Number.isInteger(input.score)||(input.score as number)<0||(input.score as number)>100))throw invalid('Score must be an integer from 0 to 100');
  if(typeof input.reviewed_at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.reviewed_at)||!Number.isFinite(Date.parse(input.reviewed_at))||new Date(input.reviewed_at).toISOString()!==input.reviewed_at||input.reviewed_at<'2000-01-01')throw invalid('Use a valid UTC timestamp with milliseconds, from year 2000');
  if(typeof input.timezone_at_review!=='string'||input.timezone_at_review.length>100)throw invalid('Timezone required');
  try{new Intl.DateTimeFormat('en-US',{timeZone:input.timezone_at_review});}catch{throw invalid('Invalid timezone');}
  if(input.algorithm_version!==ALGORITHM)throw invalid('Unsupported algorithm version');
  return {id,card_id,quality:input.quality as number,score:input.score as number|null|undefined??null,
    reviewed_at:input.reviewed_at,timezone_at_review:input.timezone_at_review,algorithm_version:ALGORITHM};
}
export function historyQuery(value:unknown) {
  const input=object(value);
  if(Object.keys(input).some(k=>!['limit','offset','card_id'].includes(k)))throw invalid();
  const integer=(key:string,fallback:number,max:number)=>{
    if(input[key]===undefined)return fallback;
    if(typeof input[key]!=='string'||!/^\d+$/.test(input[key] as string))throw invalid();
    const n=Number(input[key]);if(!Number.isSafeInteger(n)||n<(key==='limit'?1:0)||n>max)throw invalid();return n;
  };
  return {limit:integer('limit',20,100),offset:integer('offset',0,2147483647),card_id:input.card_id===undefined?null:uuid(input.card_id)};
}
