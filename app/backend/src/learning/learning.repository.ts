import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { ApiError } from '../common/api-error';
import { Fields, ListQuery } from './learning-input';
import { substringMatch } from './substring-match';

type Kind = 'deck' | 'card';
const table = (kind: Kind) => kind === 'deck' ? 'app.decks' : 'app.cards';
const visible = (kind: Kind, alias = 'r') => `${alias}.user_id=$1 AND ${alias}.deleted_at IS NULL${kind === 'card' ? ` AND EXISTS (SELECT 1 FROM app.decks d WHERE d.id=${alias}.deck_id AND d.user_id=$1 AND d.deleted_at IS NULL)` : ''}`;

@Injectable()
export class LearningRepository {
  constructor(private readonly database: DatabaseService) {}

  private async write<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withUser(userId, async client => {
        // Serialize this owner's learning writes: parent soft-delete cannot race
        // card creation/moves or a batch. Other owners can still write concurrently.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[userId]);
        return work(client);
      });
    } catch (error) {
      const code = (error as {code?:string}).code;
      if (code === '23505') throw new ApiError(409,'CONFLICT','An ID is already in use');
      if (code === '23503') throw new ApiError(409,'CONFLICT','Related data changed; refresh and retry');
      if (code === '23514' || code === '22003') throw new ApiError(422,'VALIDATION_ERROR','Invalid data');
      throw error;
    }
  }

  async list(userId: string, kind: Kind, query: ListQuery) {
    return this.database.withUser(userId, async client => {
      const values: unknown[] = [userId];
      let where = visible(kind);
      if (kind === 'card') {
        if (query.deck_id) { values.push(query.deck_id); where += ` AND r.deck_id=$${values.length}`; }
        if (query.is_favorite !== undefined) { values.push(query.is_favorite); where += ` AND r.is_favorite=$${values.length}`; }
        if (query.tag !== undefined) {
          values.push(query.tag);
          where += ` AND r.id IN (SELECT ct.card_id FROM app.tags t JOIN app.card_tags ct ON ct.user_id=t.user_id AND ct.tag_id=t.id
            WHERE t.user_id=$1 AND ct.user_id=$1 AND t.normalized_name=lower($${values.length}::text))`;
        }
        if (query.q) {
          // Treat wildcard characters as literal input, not ILIKE operators.
          values.push('%'+query.q.replace(/[\\%_]/g, '\\$&')+'%');
          where += ` AND (${substringMatch('r.word', values.length)} OR ${substringMatch('r.meaning', values.length)}
            OR r.id IN (SELECT ct.card_id FROM app.tags t JOIN app.card_tags ct ON ct.user_id=t.user_id AND ct.tag_id=t.id
              WHERE t.user_id=$1 AND ct.user_id=$1 AND t.name ILIKE $${values.length}::text))`;
        }
      }
      values.push(query.limit+1,query.offset);
      const sort = kind==='card' && query.sort==='word' ? 'lower(r.word)' : kind==='card' && query.sort==='created_at' ? 'r.created_at' : 'r.updated_at';
      const direction = kind==='card' && query.order==='asc' ? 'ASC' : 'DESC';
      const {rows} = await client.query(`SELECT r.* FROM ${table(kind)} r WHERE ${where} ORDER BY ${sort} ${direction},r.id ASC LIMIT $${values.length-1} OFFSET $${values.length}`,values);
      return { items: rows.slice(0,query.limit), pagination:{limit:query.limit,offset:query.offset,has_more:rows.length>query.limit} };
    });
  }

  async get(userId: string, kind: Kind, id: string) {
    return this.database.withUser(userId, client=>this.find(client,userId,kind,id));
  }
  private async find(client: PoolClient,userId:string,kind:Kind,id:string) {
    const {rows}=await client.query(`SELECT r.* FROM ${table(kind)} r WHERE ${visible(kind)} AND r.id=$2`,[userId,id]);
    if (!rows[0]) throw new ApiError(404,'NOT_FOUND','Resource not found');
    return rows[0];
  }
  private async parent(client:PoolClient,userId:string,kind:'deck'|'source',id:unknown) {
    const name=kind==='deck'?'app.decks':'app.source_documents';
    const {rowCount}=await client.query(`SELECT 1 FROM ${name} WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`,[userId,id]);
    if (!rowCount) throw new ApiError(404,'NOT_FOUND','Related resource not found');
  }
  async insert(client:PoolClient,userId:string,kind:Kind,input:Fields) {
    if (kind==='card') {
      await this.parent(client,userId,'deck',input.deck_id);
      if (input.source_document_id) await this.parent(client,userId,'source',input.source_document_id);
    }
    // Keys come only from the validated whitelist, never arbitrary request keys.
    const keys=Object.keys(input);
    const values=[userId,...keys.map(key=>input[key])];
    const {rows}=await client.query(`INSERT INTO ${table(kind)} (user_id,${keys.join(',')}) VALUES (${values.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING *`,values);
    return rows[0];
  }
  create(userId:string,kind:Kind,input:Fields) {
    return this.write(userId,client=>this.insert(client,userId,kind,input));
  }
  createBatch(userId:string,items:Fields[]) {
    return this.write(userId,async client=>{
      const rows=[];
      for (const item of items) rows.push(await this.insert(client,userId,'card',item));
      return rows;
    });
  }
  update(userId:string,kind:Kind,id:string,input:Fields) {
    return this.write(userId, client=>this.updateInTransaction(client,userId,kind,id,input));
  }
  async updateInTransaction(client:PoolClient,userId:string,kind:Kind,id:string,input:Fields) {
      const existing=await this.find(client,userId,kind,id);
      if (existing.version!==input.base_version) throw new ApiError(409,'CONFLICT','Version changed; fetch the resource again');
      if (kind==='card') {
        if (input.deck_id) await this.parent(client,userId,'deck',input.deck_id);
        if (input.source_document_id) await this.parent(client,userId,'source',input.source_document_id);
      }
      const keys=Object.keys(input).filter(key=>key!=='base_version');
      const values=[userId,id,input.base_version,...keys.map(key=>input[key])];
      const {rows}=await client.query(`UPDATE ${table(kind)} SET ${keys.map((key,i)=>`${key}=$${i+4}`).join(',')} WHERE user_id=$1 AND id=$2 AND version=$3::bigint AND deleted_at IS NULL RETURNING *`,values);
      if (!rows[0]) throw new ApiError(409,'CONFLICT','Version changed; fetch the resource again');
      return rows[0];
  }
  remove(userId:string,kind:Kind,id:string,baseVersion:string) {
    return this.write(userId,client=>this.removeInTransaction(client,userId,kind,id,baseVersion));
  }
  async removeInTransaction(client:PoolClient,userId:string,kind:Kind,id:string,baseVersion:string) {
      const existing=await this.find(client,userId,kind,id);
      if (existing.version!==baseVersion) throw new ApiError(409,'CONFLICT','Version changed; fetch the resource again');
      const {rows}=await client.query(`UPDATE ${table(kind)} SET deleted_at=clock_timestamp() WHERE user_id=$1 AND id=$2 AND version=$3::bigint AND deleted_at IS NULL RETURNING id,version,deleted_at`,[userId,id,baseVersion]);
      if (!rows[0]) throw new ApiError(409,'CONFLICT','Version changed; fetch the resource again');
      if (kind==='deck') await client.query('UPDATE app.cards SET deleted_at=$3 WHERE user_id=$1 AND deck_id=$2 AND deleted_at IS NULL',[userId,id,rows[0].deleted_at]);
      return rows[0];
  }
}
