import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';
import { ProfilesRepository } from '../profiles/profiles.repository';
import { ApiError } from '../common/api-error';
import { historyQuery, reviewInput } from './progress-input';
import { dayBefore, localDay, replayReviews, streak } from './sm2';
import { encodeReviewCursor, reviewCursor } from './review-cursor';

export const PROGRESS_CLOCK=Symbol('PROGRESS_CLOCK');
const ok=(data:unknown,metadata:unknown={})=>({status:'ok',data,error:null,metadata});
@Injectable()
export class ProgressService {
  // Queue before borrowing a connection: a burst for one account must not fill
  // the pool with transactions waiting on the same PostgreSQL advisory lock.
  // The database lock is still required across multiple backend processes.
  private readonly queues=new Map<string,{tail:Promise<void>;pending:number}>();
  constructor(private readonly database:DatabaseService,private readonly profiles:ProfilesRepository,
    @Inject(PROGRESS_CLOCK) private readonly clock:()=>Date){}

  async review(user:string,body:unknown){
    const input=reviewInput(body);
    const queue=this.queues.get(user)??{tail:Promise.resolve(),pending:0};
    if(queue.pending>=64)throw new ApiError(503,'SERVICE_UNAVAILABLE','Review queue is busy; retry the same event');
    this.queues.set(user,queue);queue.pending++;
    const work=queue.tail.then(()=>this.record(user,input));
    queue.tail=work.then(()=>{},()=>{});
    try{return await work;}
    catch(error){
      if((error as {code?:string}).code==='57014')throw new ApiError(503,'SERVICE_UNAVAILABLE','Review transaction busy; retry the same event');
      throw error;
    }finally{if(--queue.pending===0)this.queues.delete(user);}
  }

  private async record(user:string,input:ReturnType<typeof reviewInput>){
    const hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    await this.profiles.getOrCreate(user);
    return this.database.withUser(user,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user]);
      const prior=(await client.query('SELECT request_hash,result FROM app.review_events WHERE user_id=$1 AND id=$2',[user,input.id])).rows[0];
      if(prior){
        if(prior.request_hash!==hash)throw new ApiError(409,'REVIEW_ID_REUSED','Review ID already used with different content');
        return ok(prior.result);
      }
      if(Date.parse(input.reviewed_at)>this.clock().getTime()+300000)throw new ApiError(422,'VALIDATION_ERROR','Review time exceeds allowed five-minute clock skew');
      const card=await client.query('SELECT c.id FROM app.cards c JOIN app.decks d ON d.user_id=c.user_id AND d.id=c.deck_id WHERE c.user_id=$1 AND c.id=$2 AND c.deleted_at IS NULL AND d.deleted_at IS NULL',[user,input.card_id]);
      if(!card.rows.length)throw new ApiError(404,'NOT_FOUND','Card not found');
      const zone=await client.query('SELECT 1 FROM pg_timezone_names WHERE name=$1',[input.timezone_at_review]);
      if(!zone.rows.length)throw new ApiError(422,'VALIDATION_ERROR','Invalid timezone');
      const events=(await client.query('SELECT id,quality,reviewed_at FROM app.review_events WHERE user_id=$1 AND card_id=$2',[user,input.card_id])).rows;
      const state={card_id:input.card_id,...replayReviews([...events,input])};
      const result={event:input,state};
      await client.query(`INSERT INTO app.review_events(user_id,id,card_id,quality,score,reviewed_at,timezone_at_review,algorithm_version,request_hash,result)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,[user,input.id,input.card_id,input.quality,input.score,input.reviewed_at,input.timezone_at_review,input.algorithm_version,hash,JSON.stringify(result)]);
      await client.query(`INSERT INTO app.review_states(user_id,card_id,algorithm_version,repetitions,interval_days,ease_factor,total_reviews,last_reviewed_at,due_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(user_id,card_id) DO UPDATE SET
        algorithm_version=EXCLUDED.algorithm_version,repetitions=EXCLUDED.repetitions,interval_days=EXCLUDED.interval_days,ease_factor=EXCLUDED.ease_factor,
        total_reviews=EXCLUDED.total_reviews,last_reviewed_at=EXCLUDED.last_reviewed_at,due_at=EXCLUDED.due_at`,
        [user,state.card_id,state.algorithm_version,state.repetitions,state.interval_days,state.ease_factor,state.total_reviews,state.last_reviewed_at,state.due_at]);
      return ok(result);
    });
  }

  async summary(user:string,query:unknown){
    historyQuery(query); // Explicitly reject query fields; summary uses profile timezone.
    if(Object.keys(query as object).length)throw new ApiError(422,'VALIDATION_ERROR','Summary takes no query parameters');
    await this.profiles.getOrCreate(user);
    return this.database.withUser(user,async client=>{
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[user]);
      const timezone=(await client.query('SELECT timezone FROM app.profiles WHERE user_id=$1',[user])).rows[0].timezone as string;
      const now=this.clock();
      const today=localDay(now,timezone);
      // Calendar boundaries are converted by PostgreSQL, including 23/25h DST days.
      const counts=(await client.query(`SELECT count(*)::int AS total_cards,
        count(*) FILTER(WHERE s.card_id IS NULL)::int AS new_count,
        count(*) FILTER(WHERE s.repetitions=0)::int AS relearning_count,
        count(*) FILTER(WHERE s.repetitions BETWEEN 1 AND 2)::int AS learning_count,
        count(*) FILTER(WHERE s.repetitions>=3)::int AS mastered_count,
        count(*) FILTER(WHERE s.due_at < (($2::date+1)::timestamp AT TIME ZONE $3))::int AS due_today_count
        FROM app.cards c JOIN app.decks d ON d.user_id=c.user_id AND d.id=c.deck_id
        LEFT JOIN app.review_states s ON s.user_id=c.user_id AND s.card_id=c.id
        WHERE c.user_id=$1 AND c.deleted_at IS NULL AND d.deleted_at IS NULL`,[user,today,timezone])).rows[0];
      const activity=(await client.query(`SELECT to_char(reviewed_at AT TIME ZONE $2,'YYYY-MM-DD') AS day,
        count(*)::int AS reviews,count(*) FILTER(WHERE quality>=3)::int AS successful_reviews
        FROM app.review_events WHERE user_id=$1 AND reviewed_at <= $3::timestamptz
        GROUP BY 1 ORDER BY 1 DESC`,[user,timezone,now.toISOString()])).rows;
      const days=activity.map(row=>row.day as string);
      let first=today;for(let i=0;i<29;i++)first=dayBefore(first);
      return ok({timezone,today,...counts,current_streak:streak(days,today),
        total_reviews:activity.reduce((sum,row)=>sum+row.reviews,0),activity:activity.filter(row=>row.day>=first)});
    });
  }

  async changes(user:string,query:unknown){
    const {cursor,limit}=reviewCursor(user,query);
    await this.profiles.getOrCreate(user);
    return this.database.withUser(user,async client=>{
      const head=String((await client.query('SELECT last_sequence FROM app.review_heads WHERE user_id=$1',[user])).rows[0]?.last_sequence??'0');
      const upper=cursor.until??head;
      if(BigInt(upper)>BigInt(head)||BigInt(cursor.after)>BigInt(head))throw new ApiError(422,'VALIDATION_ERROR','Review cursor exceeds history');
      const {rows}=await client.query(`SELECT sequence::text,user_id,id,card_id,quality,score,reviewed_at,received_at,timezone_at_review,algorithm_version
        FROM app.review_events WHERE user_id=$1 AND sequence>$2::bigint AND sequence<=$3::bigint
        ORDER BY app.review_events.sequence LIMIT $4`,[user,cursor.after,upper,limit+1]);
      const has_more=rows.length>limit,events=rows.slice(0,limit);
      return ok({events,has_more,next_cursor:encodeReviewCursor({v:1,stream:'reviews',user,
        after:has_more?String(events.at(-1).sequence):upper,until:has_more?upper:null})});
    });
  }

  async history(user:string,query:unknown){
    const {limit,offset,card_id}=historyQuery(query);
    await this.profiles.getOrCreate(user);
    return this.database.withUser(user,async client=>{
      const {rows}=await client.query(`SELECT id,card_id,quality,score,reviewed_at,received_at,timezone_at_review,algorithm_version
        FROM app.review_events WHERE user_id=$1 AND ($2::uuid IS NULL OR card_id=$2::uuid)
        ORDER BY reviewed_at DESC,id ASC LIMIT $3 OFFSET $4`,[user,card_id,limit+1,offset]);
      return ok(rows.slice(0,limit),{pagination:{limit,offset,has_more:rows.length>limit}});
    });
  }
}
