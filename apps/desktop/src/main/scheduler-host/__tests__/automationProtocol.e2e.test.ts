import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import type { Schedule } from '@cindy/maker-scheduler';
import type { DbClient } from '../../localDb/client/DbClient.js';
import { setCurrentDbClient, clearCurrentDbClient } from '../../localDb/client/current.js';
import { runMigrationReplay } from '../../localDb/migrationRunner.js';
import { submitOrcaWorkerReport } from '../../maker-ipc/orcaReportService.js';
import { SchedulerScriptCapabilityBroker } from '../script-capability-broker.js';
import { ScriptScheduleRunner } from '../script-runner.js';

const launch = vi.hoisted(() => vi.fn());
vi.mock('../../maker-ipc/register.js', () => ({ tryGetOrcaCollabService: () => ({
  sendAutomationInput: launch,
  inspectAutomationSession: async (id: string) => ({ session_id: id, record_status: 'active', active: false, queued_count: 0 }),
}) }));
vi.mock('../../cindy-brain/index.js', () => ({ getGhostCardService: vi.fn(), getGhostPipeDispatcher: vi.fn() }));

// Real OS child -> production JSONL runner -> capability broker -> file SQLite.
// Only the provider/session-launch boundary is substituted; no live profile/model.
it('replays a keyed script input across database reopen and enforces scope through the real process protocol', async () => {
  const root = mkdtempSync(join(tmpdir(), 'automation-protocol-'));
  const dbPath = join(root, 'fixture.sqlite'), script = join(root, 'fixture.mjs');
  let sqlite = new Database(dbPath);
  let client: DbClient;
  const connect = () => {
    client = { drizzle: drizzle(sqlite) } as unknown as DbClient;
    setCurrentDbClient(client, 'fixture-owner');
  };
  try {
    sqlite.exec(`CREATE TABLE migration_meta(key TEXT PRIMARY KEY,value TEXT);
      CREATE TABLE migration_history(seq INTEGER PRIMARY KEY,file_name TEXT,content_hash TEXT,applied_at INTEGER);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT NOT NULL,agent_kind TEXT NOT NULL DEFAULT 'codex');
      CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT,client_id TEXT,role TEXT,rewind_at INTEGER);
      CREATE TABLE agent_input_queue_snapshots(session_id TEXT PRIMARY KEY,payload TEXT);
      CREATE TABLE orca_teams(id TEXT PRIMARY KEY,lead_session_id TEXT,status TEXT);
      CREATE TABLE orca_workers(id TEXT PRIMARY KEY,team_id TEXT,session_id TEXT);
      INSERT INTO sessions(id,status) VALUES ('foreign','active');`);
    runMigrationReplay(sqlite, { drizzleDir: fileURLToPath(new URL('../../../../drizzle/', import.meta.url)), currentVersion: 123 });
    connect(); launch.mockReset();
    launch.mockImplementation(async params => {
      const id = params.reservedSessionId;
      sqlite.prepare('INSERT INTO sessions(id,status) VALUES (?,?)').run(id, 'active');
      sqlite.prepare('INSERT INTO messages(id,session_id,client_id,role) VALUES (?,?,?,?)').run('input-row', id, params.clientId, 'user');
      sqlite.prepare('INSERT INTO sessions(id,status) VALUES (?,?)').run('worker', 'active');
      sqlite.prepare('INSERT INTO orca_teams(id,lead_session_id,status,result_policy) VALUES (?,?,?,?)').run('team', id, 'active', 'event-only');
      sqlite.prepare('INSERT INTO orca_workers VALUES (?,?,?)').run('worker-id', 'team', 'worker');
      await submitOrcaWorkerReport({ workerSessionId: 'worker', sessionInstanceId: 'fixture-instance', turnGeneration: 1,
        source: 'manual', report: { event_kind: 'progress', work_revision: 'work-1', evidence_revision: 'proof-1', payload: {} } });
      return { ok: true, targetSessionId: id, agentKind: 'codex', wakeKind: 'created', targetTitle: null, targetLastUserSendAt: null };
    });
    writeFileSync(script, `import { createInterface } from 'node:readline';
import assert from 'node:assert/strict';
const lines = createInterface({input: process.stdin})[Symbol.asyncIterator]();
const read = async () => JSON.parse((await lines.next()).value);
const write = value => process.stdout.write(JSON.stringify({protocol:'cindy-script/1',...value})+'\\n');
assert.equal((await read()).type,'start');
let id=0;
async function call(method,params={}) {
  const key=String(++id); write({type:'call',id:key,method,params});
  const r=await read(); assert.equal(r.id,key); return r;
}
const cap=await call('host.capabilities'); assert.ok(cap.result.features.includes('lifeline-v2'));
const params={request_key:'one-input',message:'synthetic task'};
const first=await call('sessions.dispatch',params); assert.equal(first.ok,true);
const again=await call('sessions.dispatch',params); assert.equal(again.ok,true);
assert.equal(first.result.target_session_id,again.result.target_session_id);
const conflict=await call('sessions.dispatch',{...params,message:'different'}); assert.equal(conflict.error.code,'IDEMPOTENCY_CONFLICT');
const guards=await call('sessions.dispatch',{...params,if_idle:true,expected_generation:99}); assert.equal(guards.ok,true);
assert.equal(guards.result.target_session_id,first.result.target_session_id);
const receipt=await call('sessions.dispatch_status',{request_key:'one-input'}); assert.equal(receipt.result.status,'accepted');
const owner=await call('sessions.inspect',{session_id:first.result.target_session_id}); assert.equal(owner.ok,true);
const foreign=await call('sessions.inspect',{session_id:'foreign'}); assert.equal(foreign.error.code,'NOT_AUTHORIZED');
const events=await call('sessions.events',{team_id:'team',after_seq:0}); assert.equal(events.result.events.length,1);
const empty=await call('sessions.events',{team_id:'team',after_seq:events.result.next_seq}); assert.equal(empty.result.events.length,0);
write({type:'complete',resultText:'protocol-persistence-scope-pass'}); process.exit(0);
`);
    const schedule = { id: 'fixture-schedule', name: 'fixture', prompt: '', executionMode: 'script',
      scriptConfig: { command: `"${process.execPath}" "${script}"`, timeoutMs: 10000,
        capabilities: ['sessions.dispatch', 'sessions.inspect', 'sessions.dispatch_status', 'sessions.events'] },
      kind: 'cron', cronExpr: '0 * * * *', timezone: 'UTC', recurring: true, manual: false,
      agentKind: 'codex', model: 'gpt-6.1-sol', providerId: 'art-cindy', effort: 'xhigh',
      workingDir: root, workspaceKind: 'project', useWorktree: false, persistentSession: false,
      silentWhenIdle: true, notify: { desktop: false, feishu: false }, status: 'active', createdAt: 1, updatedAt: 1 } as Schedule;
    for (let i = 0; i < 2; i++) {
      if (i) { clearCurrentDbClient(client!); sqlite.close(); sqlite = new Database(dbPath); connect(); }
      const runner = new ScriptScheduleRunner({ broker: new SchedulerScriptCapabilityBroker(), logger: {} });
      const result = await runner.fire(schedule, { runId: `fixture-${i}`, firedAt: Date.now(), signal: new AbortController().signal });
      expect(result).toMatchObject({ resultText: 'protocol-persistence-scope-pass' });
      expect(launch).toHaveBeenCalledTimes(1);
    }
    expect(sqlite.prepare('SELECT count(*) AS count FROM automation_dispatch_receipts').get()).toEqual({ count: 1 });
  } finally { clearCurrentDbClient(client!); sqlite.close(); rmSync(root, { recursive: true, force: true }); }
}, 30000);
