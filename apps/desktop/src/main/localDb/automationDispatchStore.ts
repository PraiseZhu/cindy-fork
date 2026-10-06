import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from './client/DbClient.js';
import { automationDispatchReceipts, messages, orcaWorkers, sessions } from './schema.js';
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
        .where(and(eq(table.id, row.id), eq(table.payloadHash, row.payloadHash), eq(table.status, 'reserved')))
        .returning({ id: table.id });
      if (changed.length !== 1) throw new Error('DISPATCH_RECEIPT_CHANGED');
    },
  };
}

/** Reconcile only a request-bound persisted input or Worker link, never a session's mere existence. */
export async function reconcileAutomationReceipt(client: DbClient, row: AutomationReceipt, assertCurrent: () => void): Promise<AutomationReceipt> {
  if (!['reserved', 'unknown'].includes(row.status)) return row;
  assertCurrent();
  let result: Record<string, unknown> | undefined;
  if (row.operation === 'create_worker') {
    const [worker] = await client.drizzle.select({ id: orcaWorkers.id }).from(orcaWorkers).where(and(
      eq(orcaWorkers.id, row.workerId ?? ''), eq(orcaWorkers.teamId, row.teamId ?? ''), eq(orcaWorkers.sessionId, row.sessionId))).limit(1);
    if (worker) result = { ok: true, workerId: worker.id, workerSessionId: row.sessionId, dispatched: false };
  } else {
    const [input] = await client.drizzle.select({ id: messages.id, agentKind: sessions.agentKind }).from(messages)
      .innerJoin(sessions, eq(sessions.id, messages.sessionId)).where(and(eq(messages.sessionId, row.sessionId),
        eq(messages.clientId, row.inputId), eq(messages.role, 'user'))).limit(1);
    if (input) result = { ok: true, targetSessionId: row.sessionId,
      agentKind: input.agentKind === 'cc' ? 'claude-code' : input.agentKind, wakeKind: null,
      targetTitle: null, targetLastUserSendAt: null };
  }
  assertCurrent();
  if (!result) return row;
  const next = { status: 'accepted' as const, wakeKind: null,
    result: row.operation === 'session_dispatch' ? null : JSON.stringify(result), updatedAt: Date.now() };
  const table = automationDispatchReceipts;
  await client.drizzle.update(table).set(next).where(and(eq(table.id, row.id), eq(table.payloadHash, row.payloadHash),
    inArray(table.status, ['reserved', 'unknown'])));
  assertCurrent();
  return (await createAutomationDispatchStore(client).find({ kind: row.principalKind, id: row.principalId }, row.requestKey)) ?? row;
}
