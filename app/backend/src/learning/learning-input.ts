import { ApiError } from '../common/api-error';

export const invalid = (message = 'Invalid request fields') => new ApiError(422, 'VALIDATION_ERROR', message);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw invalid('Expected a UUID');
  return value.toLowerCase();
}
export function version(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) throw invalid('Expected a positive bigint version string');
  return value;
}
function text(value: unknown, max: number, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string') throw invalid();
  const result = value.trim();
  if ((!nullable && !result) || Array.from(result).length > max) throw invalid();
  return result;
}
export type Fields = Record<string, string | boolean | string[] | null>;
const deckFields = ['name', 'description'];
const cardFields = ['deck_id','source_document_id','word','meaning','phonetic','source_sentence','ai_example','is_favorite','tags'];

export function tagNames(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20) throw invalid('Expected at most 20 tag names');
  const names = value.map(item => {
    if (typeof item !== 'string') throw invalid('Tag names must be strings');
    return text(item.normalize('NFC'),50) as string;
  });
  if (new Set(names.map(name=>name.toLowerCase())).size !== names.length) throw invalid('Duplicate tag names');
  return names.sort((a,b)=>a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0);
}

export function fields(kind: 'deck' | 'card', value: unknown, update = false): Fields {
  const input = object(value);
  const allowed = kind === 'deck' ? deckFields : cardFields;
  if (Object.keys(input).some(k => ![...allowed, update ? 'base_version' : 'id'].includes(k))) throw invalid('Unknown or server-owned fields are not allowed');
  const result: Fields = update ? { base_version: version(input.base_version) } : { id: uuid(input.id) };
  if (update && !allowed.some(k => Object.hasOwn(input,k))) throw invalid('Provide at least one editable field');
  if (!update && (kind === 'deck' ? !Object.hasOwn(input,'name') : ['deck_id','word','meaning'].some(k => !Object.hasOwn(input,k)))) throw invalid('Missing required fields');
  for (const key of allowed) {
    if (!Object.hasOwn(input,key)) continue;
    if (key === 'deck_id') result[key] = uuid(input[key]);
    else if (key === 'source_document_id') result[key] = input[key] === null ? null : uuid(input[key]);
    else if (key === 'tags') result[key] = tagNames(input[key]);
    else if (key === 'is_favorite') {
      if (typeof input[key] !== 'boolean') throw invalid();
      result[key] = input[key];
    } else {
      const limits: Record<string,number> = { name:200,description:4000,word:300,meaning:4000,phonetic:300,source_sentence:10000,ai_example:10000 };
      result[key] = text(input[key], limits[key], !['name','word','meaning'].includes(key));
    }
  }
  return result;
}

export interface ListQuery { limit: number; offset: number; deck_id?: string; q?: string; tag?: string; is_favorite?: boolean; sort?: 'updated_at'|'created_at'|'word'; order?: 'asc'|'desc' }
export function listQuery(value: unknown, kind: 'deck' | 'card'): ListQuery {
  const input = object(value);
  const allowed = kind === 'deck' ? ['limit','offset'] : ['limit','offset','deck_id','q','tag','is_favorite','sort','order'];
  if (Object.keys(input).some(k=>!allowed.includes(k))) throw invalid('Unknown query parameter');
  const number = (key: string, fallback: number, min: number, max: number) => {
    if (input[key] === undefined) return fallback;
    if (typeof input[key] !== 'string' || !/^\d+$/.test(input[key] as string)) throw invalid();
    const n = Number(input[key]);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw invalid();
    return n;
  };
  const result: ListQuery = { limit: number('limit',20,1,100), offset: number('offset',0,0,2147483647) };
  if (input.deck_id !== undefined) result.deck_id = uuid(input.deck_id);
  if (input.q !== undefined) result.q = text(input.q,300) as string;
  if (input.tag !== undefined) result.tag = text(typeof input.tag==='string'?input.tag.normalize('NFC'):input.tag,50) as string;
  if (input.sort !== undefined) {
    if (!['updated_at','created_at','word'].includes(input.sort as string)) throw invalid('Invalid sort field');
    result.sort = input.sort as ListQuery['sort'];
  }
  if (input.order !== undefined) {
    if (!['asc','desc'].includes(input.order as string)) throw invalid('Invalid sort order');
    result.order = input.order as ListQuery['order'];
  }
  if (input.is_favorite !== undefined) {
    if (!['true','false'].includes(input.is_favorite as string)) throw invalid();
    result.is_favorite = input.is_favorite === 'true';
  }
  return result;
}
export function deleteVersion(query: unknown): string {
  const input = object(query);
  if (Object.keys(input).some(k=>k !== 'base_version')) throw invalid();
  return version(input.base_version);
}
export function batch(value: unknown): Fields[] {
  const input = object(value);
  if (Object.keys(input).some(k=>k !== 'items') || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) throw invalid('Batch requires 1 to 100 cards');
  const result = input.items.map(item=>fields('card',item));
  if (new Set(result.map(item=>item.id)).size !== result.length) throw new ApiError(409,'CONFLICT','Duplicate card IDs in batch');
  return result;
}
