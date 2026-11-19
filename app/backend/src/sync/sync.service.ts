import { Injectable, Logger } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.service';
import { LearningRepository } from '../learning/learning.repository';
import { ProfilesRepository } from '../profiles/profiles.repository';
import { ApiError } from '../common/api-error';
import { Fields, invalid } from '../learning/learning-input';
import { encodeCursor, Mutation, mutationHash, mutations, pullQuery } from './sync-input';

@Injectable()
export class SyncService {
  private readonly logger=new Logger(SyncService.name);
  constructor(private readonly database:DatabaseService,private readonly learning:LearningRepository,private readonly profiles:ProfilesRepository){}

  private async snapshot(client:PoolClient,user:string,item:Mutation) {
    const table=item.entity_type==='deck'?'app.decks':'app.cards';
    const {rows}=await client.query(`SELECT * FROM ${table} WHERE user_id=$1 AND id=$2`,[user,item.entity_id]);
    return rows[0]??null;
  }
  private conflict(item:Mutation,reason:string,server:unknown):never {
    this.audit(item,reason);
    throw new ApiError(409,'SYNC_CONFLICT','Sync requires explicit conflict resolution',{
      operation_id:item.operation_id,entity_type:item.entity_type,entity_id:item.entity_id,reason,server,
    });
  }
  private audit(item:Mutation,reason:string){this.logger.warn({event:'sync_conflict',operation_id:item.operation_id,entity_type:item.entity_type,reason});}
  async batch(user:string,body:unknown) {
    const items=mutations(body);
    await this.profiles.getOrCreate(user);
    const results=await this.database.withUser(user,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user]);
      const results=[];
      for(const item of items) {
        const hash=mutationHash(item);
        const prior=await client.query('SELECT request_hash,result FROM app.sync_receipts WHERE user_id=$1 AND operation_id=$2',[user,item.operation_id]);
        if(prior.rows[0]) {
          if(prior.rows[0].request_hash!==hash)this.conflict(item,'operation_reused',await this.snapshot(client,user,item));
          results.push(prior.rows[0].result);continue;
        }
        const current=await this.snapshot(client,user,item);
        if(item.action==='create') {
          if(current)this.conflict(item,current.deleted_at?'deleted':'id_exists',current);
        } else {
          if(!current)this.conflict(item,'missing',null);
          if(current.deleted_at)this.conflict(item,'deleted',current);
          if(String(current.version)!==item.base_version)this.conflict(item,'version_mismatch',current);
        }
        try {
          if(item.action==='create')await this.learning.insert(client,user,item.entity_type,{id:item.entity_id,...item.payload} as Fields);
          else if(item.action==='update')await this.learning.updateInTransaction(client,user,item.entity_type,item.entity_id,{base_version:item.base_version,...item.payload} as Fields);
          else await this.learning.removeInTransaction(client,user,item.entity_type,item.entity_id,item.base_version!);
        } catch(error) {
          if(error instanceof ApiError&&(error.getStatus()===404||error.getStatus()===409))this.conflict(item,'missing_parent',current);
          // SQL failures abort the transaction; do not query again until rollback.
          if(['23505','23503','23514'].includes((error as {code?:string}).code??'')){this.audit(item,'constraint');throw new ApiError(409,'SYNC_CONFLICT','Mutation rejected; no new operations committed',{
            operation_id:item.operation_id,entity_type:item.entity_type,entity_id:item.entity_id,reason:'constraint',server:current,
          });}
          throw error;
        }
        const result={operation_id:item.operation_id,entity_type:item.entity_type,entity_id:item.entity_id,record:await this.snapshot(client,user,item)};
        await client.query('INSERT INTO app.sync_receipts(user_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4::jsonb)',[user,item.operation_id,hash,JSON.stringify(result)]);
        results.push(result);
      }
      return results;
    });
    return {status:'ok',data:{results},error:null,metadata:{}};
  }

  async changes(user:string,query:unknown) {
    const {cursor,limit}=pullQuery(user,query);
    await this.profiles.getOrCreate(user);
    const data=await this.database.withUser(user,async client=>{
      const head=String((await client.query('SELECT last_sequence FROM app.sync_heads WHERE user_id=$1',[user])).rows[0]?.last_sequence??'0');
      const upper=cursor.until??head;
      if(BigInt(upper)>BigInt(head)||BigInt(cursor.after)>BigInt(head))throw invalid('Cursor exceeds this account change history');
      // Qualify the numeric source column: the output alias sequence is text
      // for JSON precision, so ORDER BY sequence alone sorts 1,10,100,11,... .
      const {rows}=await client.query('SELECT sequence::text,entity_type,entity_id,snapshot AS record FROM app.sync_changes WHERE user_id=$1 AND sequence>$2::bigint AND sequence<=$3::bigint ORDER BY app.sync_changes.sequence LIMIT $4',[user,cursor.after,upper,limit+1]);
      const has_more=rows.length>limit;
      const changes=rows.slice(0,limit);
      return {changes,has_more,next_cursor:encodeCursor({v:1,user,after:has_more?String(changes.at(-1).sequence):upper,until:has_more?upper:null})};
    });
    return {status:'ok',data,error:null,metadata:{}};
  }
}
