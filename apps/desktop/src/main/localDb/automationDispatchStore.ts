import { and, eq, inArray } from 'drizzle-orm';
import { readInputDeliveryReceipts } from './agentInputQueueSnapshots.js';
import { getCurrentDbClientSnapshot } from './client/current.js';
import type { DbClient } from './client/DbClient.js';
import { automationDispatchReceipts, orcaWorkers, sessions } from './schema.js';
import { AutomationDispatchError } from '../scheduler-host/automationDispatchService.js';
import type { AutomationReceipt, AutomationReceiptStore, DispatchPrincipal } from '../scheduler-host/automationDispatchService.js';

export function createAutomationDispatchStore(client: DbClient): AutomationReceiptStore {
  const table = automationDispatchReceipts;
  const find = async (scope: DispatchPrincipal, key: string) => {
    const [row] = await client.drizzle.select().from(table).where(and(eq(table.principalKind, scope.kind),
      eq(table.principalId, scope.id), eq(table.requestKey, key))).limit(1);
    return row as AutomationReceipt | undefined;
  };
  return {
    find,
    reserve: async row => {
      const inserted = await client.drizzle.insert(table).values(row).onConflictDoNothing().returning({ id: table.id });
      if (inserted.length) return { row, inserted: true };
      const previous = await find({ kind: row.principalKind, id: row.principalId }, row.requestKey);
      if (!previous) throw new Error('DISPATCH_RECEIPT_UNAVAILABLE');
      return { row: previous, inserted: false };
    },
    save: async row => {
      const changed = await client.drizzle.update(table).set({ status: row.status, wakeKind: row.wakeKind,
        errorCode: row.errorCode, result: row.result, updatedAt: row.updatedAt })
        .where(and(eq(table.id, row.id), eq(table.payloadHash, row.payloadHash), inArray(table.status, row.status === 'accepted' || row.status === 'queued'
          ? ['reserved', 'unknown', 'accepted', 'queued'] : ['reserved', 'unknown'])))
        .returning({ id: table.id });
      if (changed.length !== 1) throw new Error('DISPATCH_RECEIPT_CHANGED');
    },
  };
}

export async function assertAutomationInputPersisted(client: DbClient, sessionId: string, inputId: string, assertCurrent: () => void): Promise<void> {
  assertCurrent();
  if (getCurrentDbClientSnapshot()?.client !== client) throw new AutomationDispatchError('HOST_NOT_READY');
  const [delivery] = await readInputDeliveryReceipts(sessionId, [inputId]);
  assertCurrent();
  if (!delivery || !['pending', 'accepted'].includes(delivery.state)) throw new AutomationDispatchError('DISPATCH_UNKNOWN');
}

/** Reconcile only a request-bound persisted input or Worker link, never a session's mere existence. */
export async function reconcileAutomationReceipt(client: DbClient, row: AutomationReceipt, assertCurrent: () => void): Promise<AutomationReceipt> {
  if (!['reserved', 'unknown'].includes(row.status)) return row;
  assertCurrent();
  let result: Record<string, unknown> | undefined;
  if (row.operation !== 'session_dispatch') {
    const [worker] = await client.drizzle.select({ id: orcaWorkers.id }).from(orcaWorkers).where(and(
      eq(orcaWorkers.id, row.workerId ?? ''), eq(orcaWorkers.teamId, row.teamId ?? ''), eq(orcaWorkers.sessionId, row.sessionId))).limit(1);
    if (worker && row.operation === 'create_worker_with_input') {
      try { await assertAutomationInputPersisted(client, row.sessionId, row.inputId, assertCurrent); }
      catch (error) { if (error instanceof AutomationDispatchError && error.code === 'DISPATCH_UNKNOWN') return row; throw error; }
    }
    if (worker) result = { ok: true, workerId: worker.id, workerSessionId: row.sessionId, dispatched: false };
  } else {
    // Use the same queue -> history transfer order and validation as recovery.
    if (getCurrentDbClientSnapshot()?.client !== client) throw new Error('HOST_NOT_READY');
    const [delivery] = await readInputDeliveryReceipts(row.sessionId, [row.inputId]);
    assertCurrent();
    const [session] = await client.drizzle.select({ agentKind: sessions.agentKind }).from(sessions)
      .where(eq(sessions.id, row.sessionId)).limit(1);
    if (session && (delivery.state === 'accepted' || delivery.state === 'pending')) {
      result = { ok: true, targetSessionId: row.sessionId,
        agentKind: session.agentKind === 'cc' ? 'claude-code' : session.agentKind,
        wakeKind: delivery.state === 'pending' ? 'queued' : null,
        targetTitle: null, targetLastUserSendAt: null };
    }
  }
  assertCurrent();
  if (!result) return row;
  const next = { status: result.wakeKind === 'queued' ? 'queued' as const : 'accepted' as const,
    wakeKind: result.wakeKind === 'queued' ? 'queued' : null, errorCode: null,
    result: JSON.stringify(result), updatedAt: Date.now() };
  const table = automationDispatchReceipts;
  await client.drizzle.update(table).set(next).where(and(eq(table.id, row.id), eq(table.payloadHash, row.payloadHash),
    inArray(table.status, ['reserved', 'unknown'])));
  assertCurrent();
  return (await createAutomationDispatchStore(client).find({ kind: row.principalKind, id: row.principalId }, row.requestKey)) ?? row;
}
