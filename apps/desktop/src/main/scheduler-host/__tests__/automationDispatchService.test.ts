import { describe, expect, it, vi } from 'vitest';
import { AutomationDispatchService, type AutomationReceipt, type AutomationReceiptStore } from '../automationDispatchService';

function fixture() {
  const rows = new Map<string, AutomationReceipt>();
  const store: AutomationReceiptStore = {
    reserve: async row => {
      const id = `${row.principalKind}/${row.principalId}/${row.requestKey}`;
      const prior = rows.get(id);
      if (prior) return { row: structuredClone(prior), inserted: false };
      rows.set(id, structuredClone(row));
      return { row, inserted: true };
    },
    find: async (scope, key) => rows.get(`${scope.kind}/${scope.id}/${key}`),
    save: async row => { rows.set(`${row.principalKind}/${row.principalId}/${row.requestKey}`, structuredClone(row)); },
  };
  const request = { scope: { kind: 'schedule' as const, id: 'schedule-a' }, key: 'incident-a:1', operation: 'session_dispatch' as const, payload: { message: 'Investigate one failure' } };
  return { rows, store, request, service: new AutomationDispatchService(store, () => {}) };
}
describe('durable automation dispatch', () => {
  it('replays the same receipt after a process restart without calling the model twice', async () => {
    const f = fixture();
    const send = vi.fn(async (row: AutomationReceipt) => ({ ok: true, sessionId: row.sessionId, inputId: row.inputId }));
    const first = await f.service.execute(f.request, send);
    const second = await new AutomationDispatchService(f.store, () => {}).execute(f.request, send);
    expect(second.result).toEqual(first.result);
    expect(second.reused).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not dispatch a concurrent request while the original is in flight', async () => {
    const f = fixture(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await pending; return { ok: true }; });
    const first = f.service.execute(f.request, send);
    await expect(f.service.execute(f.request, send)).rejects.toMatchObject({ code: 'DISPATCH_UNKNOWN' });
    release(); await first;
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retains an unknown reservation after a lost response instead of retrying', async () => {
    const f = fixture(); const send = vi.fn(async () => { throw Error('private upstream response'); });
    await expect(f.service.execute(f.request, send)).rejects.toMatchObject({ code: 'DISPATCH_UNKNOWN' });
    await expect(new AutomationDispatchService(f.store, () => {}).execute(f.request, send)).rejects.toMatchObject({ code: 'DISPATCH_UNKNOWN' });
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([...f.rows.values()])).not.toContain('private upstream');
  });
  it('rejects a different payload for the same logical request', async () => {
    const f = fixture(); const send = vi.fn(async () => ({ ok: true }));
    await f.service.execute(f.request, send);
    await expect(f.service.execute({ ...f.request, payload: { message: 'Other task' } }, send)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('does not confuse identical keys belonging to different schedules', async () => {
    const f = fixture(); const send = vi.fn(async (r: AutomationReceipt) => ({ ok: true, sessionId: r.sessionId }));
    const a = await f.service.execute(f.request, send);
    const b = await f.service.execute({ ...f.request, scope: { kind: 'schedule', id: 'schedule-b' } }, send);
    expect(a.result.sessionId).not.toBe(b.result.sessionId);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('fails closed on an account switch before sending', async () => {
    const f = fixture(); const assert = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw Error('ACCOUNT_CHANGED'); });
    const send = vi.fn(async () => ({ ok: true }));
    await expect(new AutomationDispatchService(f.store, assert).execute(f.request, send)).rejects.toThrow('ACCOUNT_CHANGED');
    expect(send).not.toHaveBeenCalled();
  });
});
