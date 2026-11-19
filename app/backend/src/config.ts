import type { PoolConfig } from 'pg';
import { readFileSync } from 'node:fs';

export interface AppConfig {
  port: number;
  corsOrigins?: string[];
  database: PoolConfig;
  auth?: { issuer: string; jwksUrl: string; publishableKey?: string };
  ocr?: { warmup: boolean; engine?: 'native'|'wasm' };
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number, max: number): number {
  const raw = env[key] ?? String(fallback);
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > max) {
    throw new Error(`Invalid ${key}`);
  }
  return Number(raw);
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const connectionString = env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');
  let parsed: URL;
  try { parsed = new URL(connectionString); } catch { throw new Error('Invalid DATABASE_URL'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('Invalid DATABASE_URL');
  }
  // URL SSL parameters override pg's SSL object. Reject rather than weaken TLS.
  if ([...parsed.searchParams.keys()].some(key => key.toLowerCase().startsWith('ssl'))) {
    throw new Error('Configure DATABASE_SSL separately from DATABASE_URL');
  }
  const ssl = env.DATABASE_SSL ?? 'true';
  if (!['true', 'false'].includes(ssl)) throw new Error('Invalid DATABASE_SSL');
  const local = ['localhost', '127.0.0.1', '[::1]', 'db'].includes(parsed.hostname);
  if (ssl === 'false' && (!local || env.NODE_ENV === 'production')) {
    throw new Error('TLS is required for non-local or production databases');
  }
  const timeout = integer(env, 'DATABASE_TIMEOUT_MS', 3000, 30000);
  let auth: AppConfig['auth'];
  if (env.SUPABASE_URL) {
    let url: URL;
    try { url = new URL(env.SUPABASE_URL); } catch { throw new Error('Invalid SUPABASE_URL'); }
    const localAuth = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && localAuth && ['test', 'development'].includes(env.NODE_ENV ?? '')))) {
      throw new Error('SUPABASE_URL must be a trusted HTTPS origin (local HTTP only in test/development)');
    }
    auth = { issuer: `${url.origin}/auth/v1`, jwksUrl: `${url.origin}/auth/v1/.well-known/jwks.json` };
  } else if (env.NODE_ENV === 'production') {
    throw new Error('SUPABASE_URL is required in production');
  }
  if(env.SUPABASE_PUBLISHABLE_KEY){
    if(!auth||!/^sb_publishable_[A-Za-z0-9_-]+$/.test(env.SUPABASE_PUBLISHABLE_KEY)||env.SUPABASE_PUBLISHABLE_KEY.length>2048)throw new Error('Invalid SUPABASE_PUBLISHABLE_KEY');
    auth.publishableKey=env.SUPABASE_PUBLISHABLE_KEY;
  }
  const ocrWarmup=env.OCR_WARMUP??(env.NODE_ENV==='test'?'false':'true');
  const corsOrigins=(env.CORS_ORIGINS??'').split(',').map(value=>value.trim()).filter(Boolean);
  for(const origin of corsOrigins){
    let url:URL;try{url=new URL(origin);}catch{throw new Error('Invalid CORS_ORIGINS');}
    if(url.origin!==origin||url.username||url.password||!['https:','http:'].includes(url.protocol)||(url.protocol==='http:'&&(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||env.NODE_ENV==='production')))throw new Error('Invalid CORS_ORIGINS');
  }
  if (!['true','false'].includes(ocrWarmup)) throw new Error('Invalid OCR_WARMUP');
  const ocrEngine=env.OCR_ENGINE??'wasm';
  if(!['native','wasm'].includes(ocrEngine))throw new Error('Invalid OCR_ENGINE');
  return {
    corsOrigins,
    ocr: {warmup:ocrWarmup==='true',engine:ocrEngine as 'native'|'wasm'},
    auth,
    port: integer(env, 'PORT', 3000, 65535),
    database: {
      connectionString,
      ssl: ssl === 'true' ? { rejectUnauthorized: true, ...(env.DATABASE_CA_FILE ? { ca: readFileSync(env.DATABASE_CA_FILE, 'utf8') } : {}) } : false,
      max: integer(env, 'DATABASE_POOL_MAX', 5, 20),
      connectionTimeoutMillis: timeout,
      idleTimeoutMillis: 30000,
      statement_timeout: timeout,
      query_timeout: timeout,
      application_name: 'vocabulary-backend',
    },
  };
}
