import { and, asc, eq, gt } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import { automationDispatchReceipts, orcaTeams, orcaWorkers, orcaWorkerEvents, schedules } from './schema.js';
import { AutomationDispatchError } from '../scheduler-host/automationDispatchService.js';

export async function assertScheduleSession(db: DbClient, scheduleId: string, sessionId: string): Promise<void> {
  const t = automationDispatchReceipts;
  const [binding] = await db.drizzle.select({ target: schedules.targetSessionId }).from(schedules)
    .where(eq(schedules.id, scheduleId)).limit(1);
  if (binding?.target === sessionId) return;
  const [direct] = await db.drizzle.select({ id: t.id }).from(t).where(and(eq(t.principalKind, 'schedule'),
    eq(t.principalId, scheduleId), eq(t.sessionId, sessionId))).limit(1);
  if (direct) return;
  const [worker] = await db.drizzle.select({ lead: orcaTeams.leadSessionId }).from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaWorkers.teamId, orcaTeams.id)).where(eq(orcaWorkers.sessionId, sessionId)).limit(1);
  if (worker) {
    if (binding?.target === worker.lead) return;
    const [owner] = await db.drizzle.select({ id: t.id }).from(t).where(and(eq(t.principalKind, 'schedule'),
      eq(t.principalId, scheduleId), eq(t.sessionId, worker.lead))).limit(1);
    if (owner) return;
  }
  throw new AutomationDispatchError('NOT_AUTHORIZED');
}

export async function readScheduleEvents(db: DbClient, scheduleId: string, teamId: string, after: number, limit: number) {
  const [team] = await db.drizzle.select({ leadSessionId: orcaTeams.leadSessionId }).from(orcaTeams).where(eq(orcaTeams.id, teamId)).limit(1);
  if (!team) throw new AutomationDispatchError('NOT_AUTHORIZED');
  await assertScheduleSession(db, scheduleId, team.leadSessionId);
  const rows = await db.drizzle.select().from(orcaWorkerEvents).where(and(eq(orcaWorkerEvents.teamId, teamId),
    gt(orcaWorkerEvents.seq, after))).orderBy(asc(orcaWorkerEvents.seq)).limit(limit + 1);
  const events = [];
  let bytes = 0;
  for (const row of rows.slice(0, limit)) {
    const event = { seq: row.seq, event_id: row.eventId,
      logical_report_id: row.logicalReportId, team_id: row.teamId, worker_id: row.workerId,
      session_id: row.sessionId, turn_generation: row.turnGeneration, event_kind: row.eventKind,
      work_revision: row.workRevision, evidence_revision: row.evidenceRevision, report: JSON.parse(row.report) };
    const size = Buffer.byteLength(JSON.stringify(event));
    if (bytes + size > 128 * 1024) break;
    events.push(event); bytes += size;
  }
  if (rows.length && !events.length) throw new AutomationDispatchError('EVENT_TOO_LARGE');
  return { events, next_seq: events.at(-1)?.seq ?? after, has_more: rows.length > events.length };
}

export async function assertScheduleTeam(db: DbClient, scheduleId: string, teamId: string): Promise<void> {
  const [team] = await db.drizzle.select({ lead: orcaTeams.leadSessionId }).from(orcaTeams).where(eq(orcaTeams.id, teamId)).limit(1);
  if (!team) throw new AutomationDispatchError('NOT_AUTHORIZED');
  await assertScheduleSession(db, scheduleId, team.lead);
}
