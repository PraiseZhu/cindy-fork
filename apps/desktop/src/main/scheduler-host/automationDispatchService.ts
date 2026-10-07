import { createHash, randomUUID } from 'node:crypto';

export type DispatchPrincipal = { kind: 'schedule' | 'orca_team'; id: string };
export type ReceiptStatus = 'reserved' | 'accepted' | 'queued' | 'running' | 'completed' | 'rejected_before_delivery' | 'unknown';
export interface AutomationReceipt {
  id: string;
  principalKind: DispatchPrincipal['kind'];
  principalId: string;
  requestKey: string;
  operation: 'session_dispatch' | 'create_worker' | 'create_worker_with_input';
  payloadHash: string;
  status: ReceiptStatus;
  sessionId: string;
  inputId: string;
  workerId: string | null;
  teamId: string | null;
  wakeKind: string | null;
  errorCode: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface AutomationReceiptStore {
  reserve(row: AutomationReceipt): Promise<{ row: AutomationReceipt; inserted: boolean }>;
  find(scope: DispatchPrincipal, key: string): Promise<AutomationReceipt | undefined>;
  save(row: AutomationReceipt): Promise<void>;
}
export class AutomationDispatchError extends Error {
  constructor(readonly code: string) { super(code); }
}
export const dispatchHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item,
)).digest('hex');
const beforeDelivery = new Set(['INVALID_ARGS', 'INVALID_PARAMS', 'CAPABILITY_DENIED', 'NOT_AUTHORIZED',
  'TARGET_BUSY', 'STATE_CHANGED', 'ARCHIVED', 'DELETED', 'NOT_FOUND', 'NO_PROVIDER_FOR_AGENT',
  'PROVIDER_ROUTE_UNAVAILABLE', 'BUDGET_MODEL_REQUIRES_API_MODE', 'DUPLICATE_LABEL', 'WORKER_LIMIT_HARD_EXCEEDED']);

/** A reservation has no expiry: absence of a reply never licenses a second send. */
export class AutomationDispatchService {
  constructor(private readonly store: AutomationReceiptStore, private readonly assertCurrent: () => void) {}

  async execute<T extends { ok: boolean; errorCode?: string }>(args: {
    scope: DispatchPrincipal;
    key: string;
    operation: AutomationReceipt['operation'];
    payload: unknown;
    targetSessionId?: string;
    teamId?: string;
  }, send: (receipt: AutomationReceipt) => Promise<T>): Promise<{ result: T; receipt: AutomationReceipt; reused: boolean }> {
    if (!/^[a-zA-Z0-9:._-]{1,180}$/.test(args.key)) throw new AutomationDispatchError('INVALID_REQUEST_KEY');
    this.assertCurrent();
    const now = Date.now();
    const candidate: AutomationReceipt = {
      id: randomUUID(), principalKind: args.scope.kind, principalId: args.scope.id, requestKey: args.key,
      operation: args.operation, payloadHash: dispatchHash([args.operation, args.payload]), status: 'reserved',
      sessionId: args.targetSessionId ?? randomUUID(), inputId: randomUUID(),
      workerId: args.operation !== 'session_dispatch' ? randomUUID() : null, teamId: args.teamId ?? null,
      wakeKind: null, errorCode: null, result: null, createdAt: now, updatedAt: now,
    };
    const { row, inserted } = await this.store.reserve(candidate);
    this.assertCurrent();
    if (row.payloadHash !== candidate.payloadHash) throw new AutomationDispatchError('IDEMPOTENCY_CONFLICT');
    if (!inserted) {
      if (!row.result || row.status === 'unknown' || row.status === 'reserved') throw new AutomationDispatchError('DISPATCH_UNKNOWN');
      return { result: JSON.parse(row.result) as T, receipt: row, reused: true };
    }
    let result: T;
    try {
      result = await send(row);
    } catch (error) {
      const code = error instanceof AutomationDispatchError ? error.code : 'DISPATCH_UNKNOWN';
      row.status = beforeDelivery.has(code) ? 'rejected_before_delivery' : 'unknown';
      row.errorCode = code;
      if (row.status === 'rejected_before_delivery') row.result = JSON.stringify({ ok: false, errorCode: code, message: code });
      row.updatedAt = Date.now();
      this.assertCurrent();
      await this.store.save(row);
      throw new AutomationDispatchError(code);
    }
    this.assertCurrent();
    row.status = result.ok ? 'accepted' : beforeDelivery.has(result.errorCode ?? '') ? 'rejected_before_delivery' : 'unknown';
    if (result.ok && 'wakeKind' in result && typeof result.wakeKind === 'string') {
      row.wakeKind = result.wakeKind;
      if (result.wakeKind === 'queued') row.status = 'queued';
    }
    row.errorCode = result.ok ? null : result.errorCode ?? 'DISPATCH_UNKNOWN';
    // Failure strings can contain provider payloads. Keep only the stable category.
    row.result = JSON.stringify(result.ok ? result : { ok: false, errorCode: row.errorCode, message: row.errorCode });
    row.updatedAt = Date.now();
    await this.store.save(row);
    return { result, receipt: row, reused: false };
  }
}
