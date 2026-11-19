import { Injectable } from '@nestjs/common';
import { ProfilesRepository } from '../profiles/profiles.repository';
import { LearningRepository } from './learning.repository';
import { batch, deleteVersion, fields, listQuery, uuid } from './learning-input';

@Injectable()
export class LearningService {
  constructor(private readonly repository:LearningRepository,private readonly profiles:ProfilesRepository) {}
  private async ready(userId:string) { await this.profiles.getOrCreate(userId); }
  async list(userId:string,kind:'deck'|'card',query:unknown) {
    const parsed=listQuery(query,kind); await this.ready(userId);
    const result=await this.repository.list(userId,kind,parsed);
    return {status:'ok',data:result.items,error:null,metadata:{pagination:result.pagination}};
  }
  async get(userId:string,kind:'deck'|'card',id:string) {
    const parsed=uuid(id); await this.ready(userId);
    return this.ok(await this.repository.get(userId,kind,parsed));
  }
  async create(userId:string,kind:'deck'|'card',body:unknown) {
    const input=fields(kind,body); await this.ready(userId);
    return this.ok(await this.repository.create(userId,kind,input));
  }
  async update(userId:string,kind:'deck'|'card',id:string,body:unknown) {
    const parsed=uuid(id),input=fields(kind,body,true); await this.ready(userId);
    return this.ok(await this.repository.update(userId,kind,parsed,input));
  }
  async remove(userId:string,kind:'deck'|'card',id:string,query:unknown) {
    const parsed=uuid(id),base=deleteVersion(query); await this.ready(userId);
    return this.ok(await this.repository.remove(userId,kind,parsed,base));
  }
  async batch(userId:string,body:unknown) {
    const items=batch(body); await this.ready(userId);
    return this.ok(await this.repository.createBatch(userId,items));
  }
  private ok(data:unknown) {return {status:'ok',data,error:null,metadata:{}};}
}
