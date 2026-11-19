export const ALGORITHM = 'sm2-v1';
export interface Review { id: string; quality: number; reviewed_at: string | Date }
export interface ReviewState {
  algorithm_version: string; repetitions: number; interval_days: number;
  ease_factor: number; total_reviews: number; last_reviewed_at: string; due_at: string;
}

/** Versioned SM-2 scheduler: integer milli-EF avoids cross-client float drift.
 * Elapsed 24h days; interval ceiling, operational ceiling 100 years.
 * Same-day practice is a distinct review, not silently discarded.
 */
export function replayReviews(events: Review[]): ReviewState {
  if (!events.length) throw new Error('Reviews required');
  let repetitions = 0, interval = 0, ease = 2500;
  const ordered = [...events].sort((a,b) =>
    new Date(a.reviewed_at).getTime()-new Date(b.reviewed_at).getTime() || a.id.localeCompare(b.id));
  for (const event of ordered) {
    const q = event.quality;
    if (!Number.isInteger(q) || q<0 || q>5) throw new Error('Invalid quality');
    if (q<3) { repetitions=0; interval=1; }
    else { interval=repetitions===0?1:repetitions===1?6:Math.min(36500,Math.ceil(interval*ease/1000)); repetitions++; }
    ease=Math.max(1300,ease+100-(5-q)*(80+(5-q)*20));
  }
  const last = new Date(ordered.at(-1)!.reviewed_at);
  return {algorithm_version:ALGORITHM,repetitions,interval_days:interval,ease_factor:ease/1000,
    total_reviews:events.length,last_reviewed_at:last.toISOString(),due_at:new Date(last.getTime()+interval*86400000).toISOString()};
}

/** YYYY-MM-DD from Intl parts; no assumption about host timezone or DST length. */
export function localDay(instant: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(instant);
  const get = (type:string) => parts.find(p=>p.type===type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function dayBefore(day: string): string {
  return new Date(Date.parse(day+'T12:00:00.000Z')-86400000).toISOString().slice(0,10);
}
export function streak(days: string[], today: string): number {
  const set = new Set(days);
  let day = set.has(today)?today:dayBefore(today), count = 0;
  while (set.has(day)) {count++;day=dayBefore(day);}
  return count;
}
