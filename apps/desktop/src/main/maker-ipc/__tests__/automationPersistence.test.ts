import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { fileURLToPath } from 'node:url';
import { runMigrationReplay } from '../../localDb/migrationRunner.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import { createAutomationDispatchStore, reconcileAutomationReceipt } from '../../localDb/automationDispatchStore.js';
import { assertScheduleSession, readScheduleEvents } from '../../localDb/automationSessionAccess.js';
import { AutomationDispatchService } from '../../scheduler-host/automationDispatchService.js';
import { submitOrcaWorkerReport } from '../orcaReportService.js';

describe('automation persistence boundaries', () => {
  let sqlite: Database.Database;
  let client: DbClient;
  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.exec(`CREATE TABLE migration_meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE migration_history(seq INTEGER PRIMARY KEY,file_name TEXT,content_hash TEXT,applied_at INTEGER);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL,agent_kind TEXT NOT NULL DEFAULT 'codex');
      CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,client_id TEXT,role TEXT,rewind_at INTEGER);
      CREATE TABLE agent_input_queue_snapshots(session_id TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE orca_teams(id TEXT PRIMARY KEY,lead_session_id TEXT,status TEXT);
      CREATE TABLE orca_workers(id TEXT PRIMARY KEY,team_id TEXT,session_id TEXT);
      INSERT INTO sessions(id,status) VALUES ('lead','active'),('worker','active'),('other','active');
      INSERT INTO orca_teams VALUES ('team','lead','active');
      INSERT INTO orca_workers VALUES ('worker-id','team','worker');`);
    runMigrationReplay(sqlite, { drizzleDir: fileURLToPath(new URL('../../../../drizzle/', import.meta.url)), currentVersion: 123 });
    sqlite.exec("UPDATE orca_teams SET result_policy='event-only'");
    client = { drizzle: drizzle(sqlite) } as unknown as DbClient;
    setCurrentDbClient(client, 'test-owner');
  });
  afterEach(() => { clearCurrentDbClient(client); sqlite.close(); });

  const report = (kind: 'progress' | 'decision_required' | 'handed_off' | 'failed') => ({ event_kind: kind,
    work_revision: 'work-1', evidence_revision: 'evidence-1', payload: { workId: 'work-1', generation: 1 } });
  const input = { workerSessionId: 'worker', workerId: 'worker-id', turnGeneration: 1, sessionInstanceId: 'instance-a' };

  it('retains progress then decision then handoff in one turn and folds only final duplicates', async () => {
    await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('progress') });
    await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('decision_required') });
    const final = await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('handed_off') });
    const duplicate = await submitOrcaWorkerReport({ ...input, source: 'auto', report: report('handed_off') });
    expect(duplicate.event_id).toBe(final.event_id);
    expect(sqlite.prepare('SELECT event_kind FROM orca_worker_events ORDER BY seq').all()).toEqual([
      { event_kind: 'progress' }, { event_kind: 'decision_required' }, { event_kind: 'handed_off' },
    ]);
  });
  it('rejects changed content under a reused report identity instead of silently losing a decision', async () => {
    await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('decision_required') });
    await expect(submitOrcaWorkerReport({ ...input, source: 'manual', report: {
      ...report('decision_required'), payload: { workId: 'work-1', generation: 2 },
    } })).rejects.toMatchObject({ code: 'REPORT_ID_CONFLICT' });
    expect(sqlite.prepare('SELECT count(*) AS count FROM orca_worker_events').get()).toEqual({ count: 1 });
  });

  it('persists a terminal failure after progress, without retaining raw model output', async () => {
    await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('progress') });
    await submitOrcaWorkerReport({ ...input, source: 'auto', failed: true, report: 'private provider text' });
    const rows = sqlite.prepare('SELECT event_kind,report FROM orca_worker_events ORDER BY seq').all();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ event_kind: 'failed' });
    expect(JSON.stringify(rows)).not.toContain('private provider');
  });
  it('keeps restored-session reports separate even when generation and report revisions repeat', async () => {
    const first = await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('handed_off') });
    const resumed = { ...input, sessionInstanceId: 'instance-b' };
    const checkpoint = await submitOrcaWorkerReport({ ...resumed, source: 'auto' });
    expect(checkpoint.event_id).not.toBe(first.event_id);
    const final = await submitOrcaWorkerReport({ ...resumed, source: 'manual', report: report('handed_off') });
    expect(final.event_id).not.toBe(first.event_id);
    expect((await submitOrcaWorkerReport({ ...resumed, source: 'auto' })).event_id).toBe(final.event_id);
    expect(sqlite.prepare('SELECT count(*) AS count FROM orca_worker_events').get()).toEqual({ count: 3 });
  });
  it.each(['progress', 'handed_off'] as const)('records Host failure despite valid %s final JSON', async kind => {
    await submitOrcaWorkerReport({ ...input, source: 'manual', report: report(kind) });
    await submitOrcaWorkerReport({ ...input, source: 'auto', failed: true, report: report(kind) });
    const rows = sqlite.prepare('SELECT event_kind,report FROM orca_worker_events ORDER BY seq').all();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ event_kind: 'failed' });
    expect(JSON.stringify(rows[1])).toContain('WORKER_TURN_FAILED');
  });

  it('does not allow a report to impersonate another worker', async () => {
    await expect(submitOrcaWorkerReport({ ...input, workerId: 'other-worker', source: 'manual', report: report('handed_off') }))
      .rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    expect(sqlite.prepare('SELECT count(*) AS count FROM orca_worker_events').get()).toEqual({ count: 0 });
  });
  it('grants inspection only from a persisted schedule receipt and the real Orca relationship', async () => {
    const store = createAutomationDispatchStore(client);
    const service = new AutomationDispatchService(store, () => {});
    await service.execute({ scope: { kind: 'schedule', id: 'schedule-a' }, key: 'a', operation: 'session_dispatch',
      targetSessionId: 'lead', payload: { message: 'work' } }, async () => ({ ok: true }));
    await expect(assertScheduleSession(client, 'schedule-a', 'worker')).resolves.toBeUndefined();
    await expect(assertScheduleSession(client, 'schedule-b', 'worker')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await expect(assertScheduleSession(client, 'schedule-a', 'other')).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
    await submitOrcaWorkerReport({ ...input, source: 'manual', report: report('progress') });
    const page = await readScheduleEvents(client, 'schedule-a', 'team', 0, 1);
    expect(page.events).toHaveLength(1);
    expect(page.next_seq).toBe(1);
    expect((await readScheduleEvents(client, 'schedule-a', 'team', page.next_seq, 1)).events).toEqual([]);
    await expect(readScheduleEvents(client, 'schedule-b', 'team', 0, 10)).rejects.toMatchObject({ code: 'NOT_AUTHORIZED' });
  });
  it('requires the exact persisted input rather than session existence to reconcile a lost receipt', async () => {
    const store = createAutomationDispatchStore(client);
    const service = new AutomationDispatchService(store, () => {});
    const scope = { kind: 'schedule' as const, id: 'schedule-a' };
    await expect(service.execute({ scope, key: 'lost', operation: 'session_dispatch', targetSessionId: 'lead', payload: { message: 'task' } },
      async () => { throw Error('response lost'); })).rejects.toMatchObject({ code: 'DISPATCH_UNKNOWN' });
    const row = (await store.find(scope, 'lost'))!;
    expect((await reconcileAutomationReceipt(client, row, () => {})).status).toBe('unknown');
    sqlite.prepare('INSERT INTO messages(id,session_id,client_id,role) VALUES (?,?,?,?)').run('wrong', 'other', row.inputId, 'user');
    expect((await reconcileAutomationReceipt(client, row, () => {})).status).toBe('unknown');
    sqlite.prepare('INSERT INTO messages(id,session_id,client_id,role) VALUES (?,?,?,?)').run('right', 'lead', row.inputId, 'user');
    const reconciled = await reconcileAutomationReceipt(client, row, () => {});
    expect(reconciled.status).toBe('accepted');
    expect(reconciled.wakeKind).toBeNull();
    expect(JSON.parse(reconciled.result!)).toMatchObject({ ok: true, targetSessionId: 'lead' });
  });

  it.each([false, true])('completes a send whose receipt was reconciled concurrently (queued=%s)', async queued => {
    const store = createAutomationDispatchStore(client);
    const service = new AutomationDispatchService(store, () => {});
    const args = { scope: { kind: 'schedule' as const, id: 'schedule-a' }, key: 'race',
      operation: 'session_dispatch' as const, targetSessionId: 'lead', payload: { message: 'task' } };
    let sends = 0;
    const sent = await service.execute(args, async row => {
      sends++;
      if (queued) sqlite.prepare('INSERT INTO agent_input_queue_snapshots VALUES (?,?)').run('lead', JSON.stringify([{
        clientId: row.inputId, text: 'task', persistedContent: 'task', chatMessage: {}, createOpts: { agentKind: 'codex' },
      }]));
      else sqlite.prepare('INSERT INTO messages(id,session_id,client_id,role) VALUES (?,?,?,?)').run('msg', 'lead', row.inputId, 'user');
      const reconciled = await reconcileAutomationReceipt(client, row, () => {});
      expect(reconciled.status).toBe(queued ? 'queued' : 'accepted');
      const replay = await service.execute(args, async () => { throw Error('must not send twice'); });
      expect(replay.reused).toBe(true);
      return { ok: true, targetSessionId: 'lead', wakeKind: queued ? 'queued' : 'resumed', targetTitle: 'original title' };
    });
    expect(sends).toBe(1);
    expect((await service.execute(args, async () => { throw Error('duplicate'); })).result).toEqual(sent.result);
  });

  it('bounds event pages by encoded bytes so valid reports cannot overflow the script protocol', async () => {
    const service = new AutomationDispatchService(createAutomationDispatchStore(client), () => {});
    await service.execute({ scope: { kind: 'schedule', id: 'schedule-a' }, key: 'a', operation: 'session_dispatch', targetSessionId: 'lead', payload: {} }, async () => ({ ok: true }));
    for (let i = 0; i < 32; i++) await submitOrcaWorkerReport({ ...input, turnGeneration: i, source: 'manual', report: {
      ...report('progress'), payload: { workId: 'work-1', evidenceRefs: Array.from({ length: 4 }, (_, n) => ({ path: '/' + 'x'.repeat(3000) + n, sha256: 'a'.repeat(64) })) },
    } });
    const page = await readScheduleEvents(client, 'schedule-a', 'team', 0, 50);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
    expect(page.has_more).toBe(true);
    expect(page.events.length).toBeGreaterThan(0);
    const ids = new Set(page.events.map(e => e.event_id));
    let current = page;
    while (current.has_more) {
      const next = await readScheduleEvents(client, 'schedule-a', 'team', current.next_seq, 50);
      expect(next.next_seq).toBeGreaterThan(current.next_seq);
      expect(Buffer.byteLength(JSON.stringify(next))).toBeLessThan(256 * 1024);
      for (const event of next.events) ids.add(event.event_id);
      current = next;
    }
    expect(ids.size).toBe(32);
  });

  it('replays durable receipt data after constructing a new store instance', async () => {
    const args = { scope: { kind: 'schedule' as const, id: 'a' }, key: 'key', operation: 'session_dispatch' as const, payload: { message: 'work' } };
    const original = await new AutomationDispatchService(createAutomationDispatchStore(client), () => {}).execute(args,
      async row => ({ ok: true, sessionId: row.sessionId, inputId: row.inputId }));
    const repeated = await new AutomationDispatchService(createAutomationDispatchStore(client), () => {}).execute(args,
      async () => { throw Error('duplicate model call'); });
    expect(repeated.result).toEqual(original.result);
    expect(sqlite.prepare('SELECT count(*) AS count FROM automation_dispatch_receipts').get()).toEqual({ count: 1 });
  });
});
