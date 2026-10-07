import { isAbsolute } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { orcaTeams, orcaWorkers, orcaWorkerEvents, sessions } from '../localDb/schema.js';
import { AutomationDispatchError, dispatchHash } from '../scheduler-host/automationDispatchService.js';

export const WORKER_EVENT_KINDS = ['progress', 'checkpoint', 'waiting', 'decision_required', 'verification_required', 'handed_off', 'failed'] as const;
export interface WorkerReport {
  event_kind: typeof WORKER_EVENT_KINDS[number];
  work_revision: string;
  evidence_revision: string;
  payload: Record<string, unknown>;
}
export function parseWorkerReport(input: unknown): WorkerReport {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  const r = input as Record<string, unknown>;
  if (!WORKER_EVENT_KINDS.includes(r.event_kind as WorkerReport['event_kind'])
    || typeof r.work_revision !== 'string' || !/^[a-zA-Z0-9:._-]{1,180}$/.test(r.work_revision)
    || typeof r.evidence_revision !== 'string' || !/^[a-zA-Z0-9:._-]{1,180}$/.test(r.evidence_revision)
    || !r.payload || typeof r.payload !== 'object' || Array.isArray(r.payload)
    || JSON.stringify(r.payload).length > 32768) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  const payload = r.payload as Record<string, unknown>;
  const allowed = new Set(['workId', 'controlEpoch', 'generation', 'headSha', 'keelRunId', 'nextAction', 'evidenceRefs', 'reasonCode']);
  if (Object.keys(payload).some(key => !allowed.has(key))) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  for (const key of ['workId', 'controlEpoch', 'keelRunId', 'nextAction']) {
    if (payload[key] !== undefined && (typeof payload[key] !== 'string' || !/^[a-zA-Z0-9:._-]{1,180}$/.test(payload[key]))) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  }
  if (payload.generation !== undefined && (!Number.isSafeInteger(payload.generation) || Number(payload.generation) < 0)) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  if (payload.reasonCode !== undefined && (typeof payload.reasonCode !== 'string' || !/^[A-Z0-9_:-]{1,100}$/.test(payload.reasonCode))) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  if (payload.headSha !== undefined && (typeof payload.headSha !== 'string' || !/^[a-f0-9]{40}$/.test(payload.headSha))) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  if (payload.evidenceRefs !== undefined) {
    if (!Array.isArray(payload.evidenceRefs) || payload.evidenceRefs.length > 16 || payload.evidenceRefs.some(ref => !ref
      || typeof ref !== 'object' || Object.keys(ref).some(key => !['path', 'sha256'].includes(key))
      || typeof ref.path !== 'string' || !isAbsolute(ref.path) || ref.path.length > 4096 || /[\r\n\0]/.test(ref.path)
      || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  }

  return { event_kind: r.event_kind as WorkerReport['event_kind'], work_revision: r.work_revision,
    evidence_revision: r.evidence_revision, payload };
}

/** This sink never resolves or resumes the Lead. Identity comes from the worker bridge. */
export async function submitOrcaWorkerReport(input: {
  workerSessionId: string;
  workerId?: string;
  turnGeneration: number;
  sessionInstanceId: string;
  source: 'manual' | 'auto';
  report?: unknown;
  failed?: boolean;
}): Promise<{ handled: boolean; event_id?: string }> {
  const owner = getCurrentDbClientSnapshot();
  if (!owner) throw new AutomationDispatchError('HOST_NOT_READY');
  const db = owner.client.drizzle;
  const [link] = await db.select({ workerId: orcaWorkers.id, teamId: orcaTeams.id,
    policy: orcaTeams.resultPolicy, teamStatus: orcaTeams.status, sessionStatus: sessions.status }).from(orcaWorkers)
    .innerJoin(orcaTeams, eq(orcaTeams.id, orcaWorkers.teamId))
    .innerJoin(sessions, eq(sessions.id, orcaWorkers.sessionId))
    .where(eq(orcaWorkers.sessionId, input.workerSessionId)).limit(1);
  if (!link || link.policy !== 'event-only') return { handled: false };
  if (link.teamStatus !== 'active' || link.sessionStatus !== 'active'
    || (input.workerId && input.workerId !== link.workerId)) throw new AutomationDispatchError('NOT_AUTHORIZED');
  if (!input.sessionInstanceId || !Number.isSafeInteger(input.turnGeneration) || input.turnGeneration < 0) throw new AutomationDispatchError('REPORT_SCHEMA_MISSING');
  // The in-memory generation restarts at zero whenever this session is restored.
  const turnId = dispatchHash([link.teamId, link.workerId, input.sessionInstanceId, input.turnGeneration]);
  let report: WorkerReport;
  try { report = parseWorkerReport(input.report); }
  catch (error) {
    if (input.source === 'manual') throw error;
    const [final] = await db.select({ id: orcaWorkerEvents.eventId }).from(orcaWorkerEvents).where(and(
      eq(orcaWorkerEvents.logicalReportId, turnId),
      eq(orcaWorkerEvents.eventKind, 'handed_off'))).limit(1);
    if (final && !input.failed) return { handled: true, event_id: final.id };
    report = { event_kind: input.failed ? 'failed' : 'checkpoint',
      work_revision: 'unreported', evidence_revision: `turn-${input.turnGeneration}`,
      payload: { reasonCode: input.failed ? 'WORKER_TURN_FAILED' : 'REPORT_SCHEMA_MISSING' } };
  }
  // Host terminal failure is authoritative even when the final text is valid JSON.
  if (input.source === 'auto' && input.failed) report = { ...report, event_kind: 'failed',
    payload: { ...report.payload, reasonCode: 'WORKER_TURN_FAILED' } };
  const logical = dispatchHash([turnId,
    report.event_kind, report.work_revision, report.evidence_revision]);
  if (getCurrentDbClientSnapshot() !== owner) throw new AutomationDispatchError('HOST_NOT_READY');
  await db.insert(orcaWorkerEvents).values({ eventId: logical, logicalReportId: turnId,
    teamId: link.teamId, workerId: link.workerId, sessionId: input.workerSessionId,
    turnGeneration: input.turnGeneration, eventKind: report.event_kind,
    workRevision: report.work_revision, evidenceRevision: report.evidence_revision,
    source: input.source, report: JSON.stringify(report.payload), createdAt: Date.now(),
  }).onConflictDoNothing();
  if (getCurrentDbClientSnapshot() !== owner) throw new AutomationDispatchError('HOST_NOT_READY');
  const [saved] = await db.select({ report: orcaWorkerEvents.report }).from(orcaWorkerEvents).where(eq(orcaWorkerEvents.eventId, logical)).limit(1);
  if (!saved || dispatchHash(JSON.parse(saved.report)) !== dispatchHash(report.payload)) throw new AutomationDispatchError('REPORT_ID_CONFLICT');
  return { handled: true, event_id: logical };
}

export function autoReport(finalText: string): unknown {
  if (finalText.length > 40000) return undefined;
  try { return JSON.parse(finalText.trim()); } catch { return undefined; }
}
