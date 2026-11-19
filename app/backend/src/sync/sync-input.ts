import { createHash } from 'node:crypto';
import { fields, invalid, object, uuid, version } from '../learning/learning-input';

export interface Mutation {
  operation_id:string; entity_type:'deck'|'card'; entity_id:string;
  action:'create'|'update'|'delete'; base_version:string|null;
  payload:Record<string,unknown>;
}
export function mutations(body:unknown):Mutation[] {
  const root=object(body);
  if(Object.keys(root).some(k=>k!=='items')||!Array.isArray(root.items)||root.items.length<1||root.items.length>100)throw invalid('Expected 1 to 100 sync mutations');
  const result=root.items.map(raw=>{
    const item=object(raw);
    if(Object.keys(item).some(k=>!['operation_id','entity_type','entity_id','action','base_version','payload'].includes(k))
      ||!['deck','card'].includes(item.entity_type as string)||!['create','update','delete'].includes(item.action as string))throw invalid();
    const entity_type=item.entity_type as Mutation['entity_type'], action=item.action as Mutation['action'];
    const entity_id=uuid(item.entity_id),operation_id=uuid(item.operation_id);
    const payload=object(item.payload);
    if(Object.hasOwn(payload,'id')||Object.hasOwn(payload,'base_version'))throw invalid('Sync identity/version belong in the envelope');
    let normalized:Record<string,unknown>;
    let base_version:string|null=null;
    if(action==='create') {
      if(item.base_version!=null)throw invalid('Create cannot have a base version');
      normalized=fields(entity_type,{id:entity_id,...payload});delete normalized.id;
    } else {
      base_version=version(item.base_version);
      if(action==='delete') {
        if(Object.keys(payload).length)throw invalid('Delete payload must be empty');
        normalized={};
      } else {
        normalized=fields(entity_type,{base_version,...payload},true);delete normalized.base_version;
      }
    }
    return {operation_id,entity_type,entity_id,action,base_version,payload:normalized};
  });
  if(new Set(result.map(r=>r.operation_id)).size!==result.length)throw invalid('Duplicate operation IDs');
  return result;
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)]));
  return value;
}
export function mutationHash(item:Mutation):string {
  return createHash('sha256').update(JSON.stringify(canonical(item))).digest('hex');
}
export interface Cursor { v:1; user:string; after:string; until:string|null }
export function encodeCursor(cursor:Cursor):string {return Buffer.from(JSON.stringify(cursor)).toString('base64url');}
function sequence(value:unknown):string {
  if(typeof value!=='string'||!/^\d{1,19}$/.test(value)||BigInt(value)>9223372036854775807n)throw invalid('Invalid sync position');
  return BigInt(value).toString();
}
export function pullQuery(user:string,raw:unknown):{cursor:Cursor;limit:number} {
  const input=object(raw);
  if(Object.keys(input).some(k=>!['cursor','limit'].includes(k)))throw invalid();
  const limit=input.limit===undefined?100:Number(input.limit);
  if((input.limit!==undefined&&(typeof input.limit!=='string'||!/^\d+$/.test(input.limit)))||!Number.isInteger(limit)||limit<1||limit>100)throw invalid();
  let cursor:Cursor={v:1,user,after:'0',until:null};
  if(input.cursor!==undefined) {
    if(typeof input.cursor!=='string'||input.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(input.cursor))throw invalid('Invalid sync cursor');
    let decoded:Record<string,unknown>;
    try {decoded=object(JSON.parse(Buffer.from(input.cursor,'base64url').toString()));}catch{throw invalid('Invalid sync cursor');}
    if(decoded.v!==1||decoded.user!==user||Object.keys(decoded).some(k=>!['v','user','after','until'].includes(k)))throw invalid('Cursor belongs to another account or version');
    cursor={v:1,user,after:sequence(decoded.after),until:decoded.until===null?null:sequence(decoded.until)};
    if(cursor.until!==null&&BigInt(cursor.after)>BigInt(cursor.until))throw invalid('Invalid sync range');
  }
  return {cursor,limit};
}
