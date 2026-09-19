/**
 * libraryStaging.ts — LibraryVault adapter for owner-scoped upload staging.
 * File bytes/fsync/rename/hash go through LibraryVault. This layer only owns
 * task identity, hard quota, recovery manifests, tombstones, and release.
 */

import { randomUUID } from 'node:crypto';

import {
  LibraryVault,
  DEFAULT_LIBRARY_LIMITS,
  type LibraryVaultDeps,
} from './libraryVault.js';

export type LibraryStagingErrorCode =
  | 'PATH_INVALID'
  | 'TOO_LARGE'
  | 'STAGING_QUOTA'
  | 'STAGING_BUSY'
  | 'DISK_FULL'
  | 'STREAM_INVALID'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'OWNER_CHANGED'
  | 'ACK_MISMATCH'
  | 'LIBRARY_UNAVAILABLE'
  | 'INTERNAL';

export type LibraryStagingFailure = { ok: false; errorCode: LibraryStagingErrorCode; message: string };
export type LibraryStagingSuccess<T> = { ok: true } & T;
export type LibraryStagingResult<T> = LibraryStagingSuccess<T> | LibraryStagingFailure;

export interface LibraryStagingLimits {
  maxTaskBytes: number;
  maxTotalBytes: number;
  maxConcurrentWrites: number;
  maxChunkBytes: number;
  reserveBytes: number;
  maxRecoveryMetadataBytes: number;
  defaultListLimit: number;
  maxListLimit: number;
}

export const DEFAULT_LIBRARY_STAGING_LIMITS: LibraryStagingLimits = {
  maxTaskBytes: 8 * 1024 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxConcurrentWrites: 4,
  maxChunkBytes: 16 * 1024 * 1024,
  reserveBytes: 1024 * 1024 * 1024,
  maxRecoveryMetadataBytes: 64 * 1024,
  defaultListLimit: 100,
  maxListLimit: 500,
};

export const GHOST_LIBRARY_STAGING_OPS = [
  'staging.begin',
  'staging.chunk',
  'staging.commit',
  'staging.list',
  'staging.read',
  'staging.release',
  'staging.abort',
] as const;
export type GhostLibraryStagingOp = (typeof GHOST_LIBRARY_STAGING_OPS)[number];

export interface LibraryStagingReceipt {
  stagingId: string;
  taskId: string;
  sourceRevision: string;
  sha256: string;
  bytes: number;
  mime: string;
  durable: true;
}

export interface LibraryStagingListItem extends LibraryStagingReceipt {
  recovery: Record<string, unknown>;
}

export type LibraryStagingAck =
  | {
    ok: true;
    path: string;
    sha256: string;
    bytes: number;
    libraryIdentity: string;
    libraryGeneration: number;
  }
  | LibraryStagingFailure;

export interface LibraryStagingDeps {
  rootDir: string;
  ownerScopeKey: string;
  ghostId: string;
  captureOwnerScope(): string | null;
  createVault?(deps: LibraryVaultDeps): LibraryVault;
  getDiskFreeBytes?(root: string): Promise<number | null>;
  log?: LibraryVaultDeps['log'];
  limits?: Partial<LibraryStagingLimits>;
}

const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_ID_MAX = 128;
const MIME_MAX = 256;

const fail = (errorCode: LibraryStagingErrorCode, message: string): LibraryStagingFailure => ({
  ok: false, errorCode, message,
});

export function isGhostLibraryStagingOp(op: string): op is GhostLibraryStagingOp {
  return (GHOST_LIBRARY_STAGING_OPS as readonly string[]).includes(op);
}

function vaultFail(r: { errorCode: string; message: string }): LibraryStagingFailure {
  const code = r.errorCode as LibraryStagingErrorCode;
  const allowed: LibraryStagingErrorCode[] = [
    'PATH_INVALID', 'TOO_LARGE', 'DISK_FULL', 'STREAM_INVALID', 'NOT_FOUND',
    'ALREADY_EXISTS', 'LIBRARY_UNAVAILABLE', 'INTERNAL',
  ];
  return fail(allowed.includes(code) ? code : 'INTERNAL', r.message);
}

function parseBoundedString(value: unknown, field: string, max: number): string | LibraryStagingFailure {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    return fail('PATH_INVALID', `${field} 必须是 1..${max} 字符`);
  }
  return value;
}

function parseSha256(value: unknown): string | LibraryStagingFailure {
  if (typeof value !== 'string' || !HEX64.test(value)) return fail('PATH_INVALID', 'sha256 必须是 64 位小写十六进制');
  return value;
}

function parseStagingId(value: unknown): string | LibraryStagingFailure {
  if (typeof value !== 'string' || !UUID.test(value)) return fail('PATH_INVALID', 'stagingId 必须是 UUID');
  return value;
}

function parseRecovery(value: unknown, maxBytes: number): LibraryStagingResult<{ recovery: Record<string, unknown> }> {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return fail('PATH_INVALID', 'recovery 必须是 JSON 对象');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return fail('PATH_INVALID', 'recovery 不是合法 JSON');
  }
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    return fail('TOO_LARGE', `recovery 超上限(${maxBytes} 字节)`);
  }
  return { ok: true, recovery: JSON.parse(serialized) as Record<string, unknown> };
}

function decodeStrictBase64(content: unknown, maxBytes: number): Buffer | LibraryStagingFailure {
  if (typeof content !== 'string') return fail('PATH_INVALID', 'content 必须是 base64 字符串');
  const compact = content.replace(/[\r\n]/g, '');
  if (compact.length === 0) return Buffer.alloc(0);
  const maxChars = Math.floor((maxBytes * 4) / 3) + 8;
  if (compact.length > maxChars) return fail('TOO_LARGE', `单块超上限(${maxBytes} 字节)`);
  if (compact.length % 4 !== 0) return fail('PATH_INVALID', 'content 不是合法 base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) return fail('PATH_INVALID', 'content 不是合法 base64');
  const decoded = Buffer.from(compact, 'base64');
  if (decoded.toString('base64') !== compact) return fail('PATH_INVALID', 'content 不是合法 base64');
  if (decoded.byteLength > maxBytes) return fail('TOO_LARGE', `单块超上限(${maxBytes} 字节)`);
  return decoded;
}

function taskKey(taskId: string, sourceRevision: string): string {
  return `${taskId}\0${sourceRevision}`;
}

function sameRecovery(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function blobPath(id: string): string {
  return `tasks/${id}/blob.bin`;
}
function manifestPath(id: string): string {
  return `tasks/${id}/manifest.json`;
}
function tombstonePath(id: string): string {
  return `tasks/${id}/tombstone.json`;
}

interface UploadRecord {
  stagingId: string;
  streamId: string;
  taskId: string;
  sourceRevision: string;
  totalBytes: number;
  sha256Declared: string;
  mime: string;
  recovery: Record<string, unknown>;
  nextSeq: number;
  lastChunk: Buffer | null;
  /** writeCommit succeeded; keep mapping until manifest+dirsync durable. */
  commitPending: boolean;
}

interface DurableRecord {
  stagingId: string;
  taskId: string;
  sourceRevision: string;
  sha256: string;
  bytes: number;
  mime: string;
  recovery: Record<string, unknown>;
}

interface DurableManifest {
  version: 1;
  stagingId: string;
  ghostId: string;
  taskId: string;
  sourceRevision: string;
  sha256: string;
  bytes: number;
  mime: string;
  recovery: Record<string, unknown>;
  durable: true;
}

function receiptOf(record: DurableRecord): LibraryStagingReceipt {
  return {
    stagingId: record.stagingId,
    taskId: record.taskId,
    sourceRevision: record.sourceRevision,
    sha256: record.sha256,
    bytes: record.bytes,
    mime: record.mime,
    durable: true,
  };
}

function parseManifest(raw: string, stagingId: string, ghostId: string): DurableManifest | LibraryStagingFailure {
  if (Buffer.byteLength(raw, 'utf8') > 256 * 1024) return fail('LIBRARY_UNAVAILABLE', 'staging manifest 过大');
  let parsed: DurableManifest;
  try {
    parsed = JSON.parse(raw) as DurableManifest;
  } catch {
    return fail('LIBRARY_UNAVAILABLE', 'staging manifest 不可读');
  }
  if (
    parsed?.version !== 1
    || parsed.durable !== true
    || parsed.stagingId !== stagingId
    || parsed.ghostId !== ghostId
    || typeof parsed.taskId !== 'string' || parsed.taskId.length === 0 || parsed.taskId.length > TASK_ID_MAX
    || typeof parsed.sourceRevision !== 'string' || parsed.sourceRevision.length === 0 || parsed.sourceRevision.length > TASK_ID_MAX
    || typeof parsed.sha256 !== 'string' || !HEX64.test(parsed.sha256)
    || typeof parsed.bytes !== 'number' || !Number.isInteger(parsed.bytes) || parsed.bytes < 0
    || typeof parsed.mime !== 'string' || parsed.mime.length === 0 || parsed.mime.length > MIME_MAX
    || typeof parsed.recovery !== 'object' || parsed.recovery === null || Array.isArray(parsed.recovery)
  ) {
    return fail('LIBRARY_UNAVAILABLE', 'staging manifest 字段非法');
  }
  return parsed;
}

export class LibraryStagingStore {
  private readonly limits: LibraryStagingLimits;
  private readonly ownerScopeKey: string;
  private readonly ghostId: string;
  private readonly vault: LibraryVault;
  private readonly uploads = new Map<string, UploadRecord>();
  private readonly byTask = new Map<string, string>();
  private durables = new Map<string, DurableRecord>();
  private durableBytes = 0;
  private orphanBlobBytes = 0;
  private closedTmpBytes = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private opened = false;
  private journalReady = false;
  private closedTmpStale = false;

  constructor(private readonly deps: LibraryStagingDeps) {
    this.limits = { ...DEFAULT_LIBRARY_STAGING_LIMITS, ...(deps.limits ?? {}) };
    this.ownerScopeKey = deps.ownerScopeKey;
    this.ghostId = deps.ghostId;
    const capturedRoot = deps.rootDir;
    const createVault = deps.createVault ?? ((vaultDeps: LibraryVaultDeps) => new LibraryVault(vaultDeps));
    this.vault = createVault({
      rootDir: () => capturedRoot,
      ghostId: deps.ghostId,
      getDiskFreeBytes: deps.getDiskFreeBytes,
      log: deps.log,
      limits: {
        writeMaxBytes: this.limits.maxChunkBytes,
        readMaxBytes: this.limits.maxChunkBytes,
        streamMaxTotalBytes: this.limits.maxTaskBytes,
        diskReserveBytes: this.limits.reserveBytes,
        softLimitBytes: this.limits.maxTotalBytes,
      },
      onStreamClosed: (streamId) => {
        for (const [id, upload] of this.uploads) {
          if (upload.streamId !== streamId || upload.commitPending) continue;
          this.uploads.delete(id);
          this.byTask.delete(taskKey(upload.taskId, upload.sourceRevision));
          this.closedTmpStale = true;
        }
      },
    });
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }

  private requireOwner(): LibraryStagingFailure | null {
    const live = this.deps.captureOwnerScope();
    if (live === null || live !== this.ownerScopeKey) {
      return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
    }
    return null;
  }

  private async ensureOpen(): Promise<LibraryStagingFailure | null> {
    const opened = await this.vault.open();
    if (!opened.ok) return vaultFail(opened);
    if (opened.state === 'unavailable') {
      return fail('LIBRARY_UNAVAILABLE', `staging 不可用(${opened.reason ?? 'io'})`);
    }
    this.opened = true;
    return null;
  }

  private async listAll(rel: string): Promise<LibraryStagingResult<{ entries: Array<{ path: string; kind: 'file' | 'dir'; bytes: number }> }>> {
    const entries: Array<{ path: string; kind: 'file' | 'dir'; bytes: number }> = [];
    let cursor: string | null = null;
    for (;;) {
      const page = await this.vault.list({
        path: rel,
        recursive: false,
        cursor,
        limit: DEFAULT_LIBRARY_LIMITS.listPageSize,
        strict: true,
      });
      if (!page.ok) {
        if (page.errorCode === 'NOT_FOUND' && entries.length === 0) {
          return { ok: true, entries: [] };
        }
        return vaultFail(page);
      }
      entries.push(...page.entries.map((item) => ({ path: item.path, kind: item.kind, bytes: item.bytes })));
      if (!page.hasMore || page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { ok: true, entries };
  }

  private async loadJournal(): Promise<LibraryStagingFailure | null> {
    if (this.journalReady) return null;
    const openFail = await this.ensureOpen();
    if (openFail) return openFail;
    const residue = await this.vault.tmpResidueBytes();
    if (!residue.ok) return vaultFail(residue);
    const listed = await this.listAll('tasks');
    if (!listed.ok) return listed;
    const next = new Map<string, DurableRecord>();
    let durableBytes = 0;
    let orphanBlobBytes = 0;
    for (const entry of listed.entries) {
      if (entry.kind !== 'dir' || !UUID.test(entry.path.slice('tasks/'.length))) continue;
      const stagingId = entry.path.slice('tasks/'.length);
      const inner = await this.listAll(entry.path);
      if (!inner.ok) return inner;
      const names = new Set(inner.entries.map((item) => item.path.split('/').pop()));
      if (names.has('tombstone.json')) {
        const marker = await this.readTombstone(stagingId);
        if (!marker.ok) return marker;
        const cleaned = await this.finishReleaseUnlocked(stagingId);
        if (cleaned) {
          // Fail closed without installing a partial journal. Retry after repair
          // must not see a half-loaded durables map. Do not count the pre-delete
          // leftover size as orphan quota: cleanup already removed those bytes.
          return cleaned;
        }
        continue;
      }
      if (!names.has('manifest.json')) {
        const blob = inner.entries.find((item) => item.path.endsWith('/blob.bin') && item.kind === 'file');
        if (blob) orphanBlobBytes += blob.bytes;
        continue;
      }
      const raw = await this.vault.read({ path: manifestPath(stagingId), encoding: 'utf8' });
      if (!raw.ok) return fail('LIBRARY_UNAVAILABLE', 'staging manifest 不可读');
      const parsed = parseManifest(raw.content, stagingId, this.ghostId);
      if ('errorCode' in parsed) return parsed;
      const hashed = await this.vault.hashFile(blobPath(stagingId));
      if (!hashed.ok) return fail('LIBRARY_UNAVAILABLE', 'staging 原件缺失或不可读');
      if (hashed.sha256 !== parsed.sha256 || hashed.bytes !== parsed.bytes) {
        return fail('LIBRARY_UNAVAILABLE', 'staging 原件与 manifest 不一致');
      }
      next.set(stagingId, {
        stagingId,
        taskId: parsed.taskId,
        sourceRevision: parsed.sourceRevision,
        sha256: parsed.sha256,
        bytes: parsed.bytes,
        mime: parsed.mime,
        recovery: parsed.recovery,
      });
      durableBytes += parsed.bytes;
    }
    this.durables = next;
    this.durableBytes = durableBytes;
    this.orphanBlobBytes = orphanBlobBytes;
    this.closedTmpBytes = residue.bytes;
    for (const record of next.values()) {
      this.byTask.set(taskKey(record.taskId, record.sourceRevision), record.stagingId);
    }
    for (const upload of this.uploads.values()) {
      this.byTask.set(taskKey(upload.taskId, upload.sourceRevision), upload.stagingId);
    }
    this.journalReady = true;
    return null;
  }

  /** In-memory uploads already reserve their declared size; do not also add vault stream bytes. */
  private trackedUploadBytes(): number {
    let total = 0;
    for (const upload of this.uploads.values()) total += upload.totalBytes;
    return total;
  }

  private quotaBytes(): number {
    return this.durableBytes
      + this.orphanBlobBytes
      + this.closedTmpBytes
      + this.trackedUploadBytes();
  }

  private async requireReady(): Promise<LibraryStagingFailure | null> {
    const denied = this.requireOwner();
    if (denied) return denied;
    const loaded = await this.loadJournal();
    if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
    if (loaded) return loaded;
    if (this.closedTmpStale) {
      const residue = await this.refreshClosedTmp();
      if (residue) return residue;
      this.closedTmpStale = false;
    }
    return null;
  }

  private async refreshClosedTmp(): Promise<LibraryStagingFailure | null> {
    const residue = await this.vault.tmpResidueBytes();
    if (!residue.ok) return vaultFail(residue);
    this.closedTmpBytes = residue.bytes;
    return null;
  }

  /** New tasks/<id> is not durable until the parent tasks dir, vault root, and any newly created root ancestors are fsynced. */
  private async fsyncDurablePath(stagingId: string): Promise<LibraryStagingFailure | null> {
    for (const rel of [`tasks/${stagingId}`, 'tasks', ''] as const) {
      const synced = await this.vault.fsyncDir(rel);
      if (!synced.ok) return vaultFail(synced);
      if (process.platform !== 'win32' && synced.fsynced !== true) {
        return fail('INTERNAL', '目录 fsync 失败');
      }
    }
    const ancestors = await this.vault.fsyncCreatedAncestors();
    if (!ancestors.ok) return vaultFail(ancestors);
    if (process.platform !== 'win32' && ancestors.fsynced !== true) {
      return fail('INTERNAL', '根目录项 fsync 失败');
    }
    return null;
  }

  private async readTombstone(stagingId: string): Promise<LibraryStagingResult<{ stagingId: string }>> {
    const raw = await this.vault.read({ path: tombstonePath(stagingId), encoding: 'utf8' });
    if (!raw.ok) {
      return raw.errorCode === 'NOT_FOUND'
        ? fail('NOT_FOUND', 'stagingId 无效')
        : fail('LIBRARY_UNAVAILABLE', 'staging tombstone 不可读');
    }
    let parsed: { version?: unknown; stagingId?: unknown; released?: unknown };
    try {
      parsed = JSON.parse(raw.content) as { version?: unknown; stagingId?: unknown; released?: unknown };
    } catch {
      return fail('LIBRARY_UNAVAILABLE', 'staging tombstone 不可读');
    }
    if (parsed.version !== 1 || parsed.stagingId !== stagingId || parsed.released !== true) {
      return fail('LIBRARY_UNAVAILABLE', 'staging tombstone 字段非法');
    }
    return { ok: true, stagingId };
  }

  private findByTask(taskId: string, sourceRevision: string): DurableRecord | UploadRecord | undefined {
    const id = this.byTask.get(taskKey(taskId, sourceRevision));
    if (!id) return undefined;
    return this.durables.get(id) ?? this.uploads.get(id);
  }

  private async finishReleaseUnlocked(stagingId: string): Promise<LibraryStagingFailure | null> {
    const blob = await this.vault.delete({ path: blobPath(stagingId) });
    if (!blob.ok && blob.errorCode !== 'NOT_FOUND') return vaultFail(blob);
    const manifest = await this.vault.delete({ path: manifestPath(stagingId) });
    if (!manifest.ok && manifest.errorCode !== 'NOT_FOUND') return vaultFail(manifest);
    await this.vault.delete({ path: tombstonePath(stagingId) }).catch(() => {});
    return null;
  }

  async begin(req: {
    ghostId: string;
    taskId: unknown;
    sourceRevision: unknown;
    totalBytes: unknown;
    sha256: unknown;
    mime: unknown;
    recovery: unknown;
  }): Promise<LibraryStagingResult<{ stagingId: string }>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const taskId = parseBoundedString(req.taskId, 'taskId', TASK_ID_MAX);
      if (typeof taskId !== 'string') return taskId;
      const sourceRevision = parseBoundedString(req.sourceRevision, 'sourceRevision', TASK_ID_MAX);
      if (typeof sourceRevision !== 'string') return sourceRevision;
      const mime = parseBoundedString(req.mime, 'mime', MIME_MAX);
      if (typeof mime !== 'string') return mime;
      const sha256 = parseSha256(req.sha256);
      if (typeof sha256 !== 'string') return sha256;
      if (typeof req.totalBytes !== 'number' || !Number.isInteger(req.totalBytes) || req.totalBytes < 0) {
        return fail('PATH_INVALID', 'totalBytes 必须是非负整数');
      }
      if (req.totalBytes > this.limits.maxTaskBytes) {
        return fail('TOO_LARGE', `分块流总大小超上限(${this.limits.maxTaskBytes} 字节)`);
      }
      const parsedRecovery = parseRecovery(req.recovery, this.limits.maxRecoveryMetadataBytes);
      if (!parsedRecovery.ok) return parsedRecovery;
      const existing = this.findByTask(taskId, sourceRevision);
      if (existing) {
        const same = 'durable' in existing === false
          && 'streamId' in existing
          && existing.mime === mime
          && existing.totalBytes === req.totalBytes
          && existing.sha256Declared === sha256
          && sameRecovery(existing.recovery, parsedRecovery.recovery);
        const sameDurable = this.durables.get((existing as DurableRecord).stagingId)
          && (existing as DurableRecord).mime === mime
          && (existing as DurableRecord).bytes === req.totalBytes
          && (existing as DurableRecord).sha256 === sha256
          && sameRecovery((existing as DurableRecord).recovery, parsedRecovery.recovery);
        if (same || sameDurable) {
          if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
          return { ok: true as const, stagingId: existing.stagingId };
        }
        return fail('ALREADY_EXISTS', '同一 task/revision 已有不同元数据的原件');
      }
      if (this.uploads.size >= this.limits.maxConcurrentWrites) {
        return fail('STAGING_BUSY', '并发上传已达上限,请稍后重试');
      }
      if (this.quotaBytes() + req.totalBytes > this.limits.maxTotalBytes) {
        return fail('STAGING_QUOTA', 'staging 总容量不足,请在确认归档后释放再试');
      }
      const stagingId = randomUUID();
      const begin = await this.vault.writeBegin({
        path: blobPath(stagingId),
        totalBytes: req.totalBytes,
        sha256,
      });
      if (this.requireOwner()) {
        if (begin.ok) await this.vault.writeAbort({ streamId: begin.streamId }).catch(() => {});
        return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
      }
      if (!begin.ok) return vaultFail(begin);
      this.uploads.set(stagingId, {
        stagingId,
        streamId: begin.streamId,
        taskId,
        sourceRevision,
        totalBytes: req.totalBytes,
        sha256Declared: sha256,
        mime,
        recovery: parsedRecovery.recovery,
        nextSeq: 1,
        lastChunk: null,
        commitPending: false,
      });
      this.byTask.set(taskKey(taskId, sourceRevision), stagingId);
      return { ok: true as const, stagingId };
    });
  }

  async chunk(req: {
    ghostId: string;
    stagingId: unknown;
    seq: unknown;
    content: unknown;
    encoding?: unknown;
  }): Promise<LibraryStagingResult<{ accepted: number }>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const stagingId = parseStagingId(req.stagingId);
      if (typeof stagingId !== 'string') return stagingId;
      if (req.encoding !== undefined && req.encoding !== 'base64') {
        return fail('PATH_INVALID', 'encoding 只支持 "base64"');
      }
      const upload = this.uploads.get(stagingId);
      if (!upload) {
        if (this.durables.has(stagingId)) return fail('STREAM_INVALID', '已提交的原件不能再写分块');
        return fail('NOT_FOUND', 'stagingId 无效');
      }
      if (typeof req.seq !== 'number' || !Number.isInteger(req.seq) || req.seq < 1) {
        return fail('STREAM_INVALID', 'seq 必须从 1 起连续');
      }
      const decoded = decodeStrictBase64(req.content, this.limits.maxChunkBytes);
      if (!Buffer.isBuffer(decoded)) return decoded;
      if (req.seq === upload.nextSeq - 1 && upload.lastChunk && upload.lastChunk.equals(decoded)) {
        if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
        return { ok: true as const, accepted: decoded.byteLength };
      }
      const chunk = await this.vault.writeChunk({
        streamId: upload.streamId,
        seq: req.seq,
        content: decoded.toString('base64'),
        encoding: 'base64',
      });
      if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
      if (!chunk.ok) return vaultFail(chunk);
      upload.nextSeq = req.seq + 1;
      upload.lastChunk = decoded;
      return { ok: true as const, accepted: chunk.accepted };
    });
  }

  async commit(req: { ghostId: string; stagingId: unknown }): Promise<LibraryStagingResult<LibraryStagingReceipt>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const stagingId = parseStagingId(req.stagingId);
      if (typeof stagingId !== 'string') return stagingId;
      const durable = this.durables.get(stagingId);
      if (durable) {
        if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
        return { ok: true as const, ...receiptOf(durable) };
      }
      const upload = this.uploads.get(stagingId);
      if (!upload) return fail('NOT_FOUND', 'stagingId 无效');
      if (!upload.commitPending) {
        upload.commitPending = true;
        const committed = await this.vault.writeCommit({ streamId: upload.streamId });
        if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
        if (!committed.ok) {
          this.uploads.delete(stagingId);
          this.byTask.delete(taskKey(upload.taskId, upload.sourceRevision));
          const residue = await this.refreshClosedTmp();
          const leftover = await this.vault.stat({ path: blobPath(stagingId) });
          if (leftover.ok && leftover.kind === 'file') this.orphanBlobBytes += leftover.bytes;
          if (residue) return residue;
          return vaultFail(committed);
        }
      }
      const hashed = await this.vault.hashFile(blobPath(stagingId));
      if (!hashed.ok || hashed.sha256 !== upload.sha256Declared || hashed.bytes !== upload.totalBytes) {
        return fail('STREAM_INVALID', 'sha256 校验失败(声明值与实际字节不一致)');
      }
      const blobSync = await this.fsyncDurablePath(stagingId);
      if (blobSync) return blobSync;
      const manifest: DurableManifest = {
        version: 1,
        stagingId,
        ghostId: this.ghostId,
        taskId: upload.taskId,
        sourceRevision: upload.sourceRevision,
        sha256: hashed.sha256,
        bytes: hashed.bytes,
        mime: upload.mime,
        recovery: upload.recovery,
        durable: true,
      };
      const written = await this.vault.write({
        path: manifestPath(stagingId),
        content: JSON.stringify(manifest),
        ifNotExists: true,
      });
      if (!written.ok) return vaultFail(written);
      const journalSync = await this.fsyncDurablePath(stagingId);
      if (journalSync) {
        await this.vault.delete({ path: manifestPath(stagingId) }).catch(() => {});
        return journalSync;
      }
      if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
      const record: DurableRecord = {
        stagingId,
        taskId: upload.taskId,
        sourceRevision: upload.sourceRevision,
        sha256: hashed.sha256,
        bytes: hashed.bytes,
        mime: upload.mime,
        recovery: upload.recovery,
      };
      this.uploads.delete(stagingId);
      this.durables.set(stagingId, record);
      this.durableBytes += hashed.bytes;
      return { ok: true as const, ...receiptOf(record) };
    });
  }

  async list(req: {
    ghostId: string;
    cursor?: unknown;
    limit?: unknown;
  }): Promise<LibraryStagingResult<{ items: LibraryStagingListItem[]; hasMore: boolean; nextCursor: string | null }>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const limit = req.limit === undefined
        ? this.limits.defaultListLimit
        : (typeof req.limit === 'number' && Number.isInteger(req.limit) && req.limit >= 1 && req.limit <= this.limits.maxListLimit
          ? req.limit
          : null);
      if (limit === null) return fail('PATH_INVALID', `limit 必须是 1..${this.limits.maxListLimit}`);
      if (req.cursor !== undefined && (typeof req.cursor !== 'string' || req.cursor.length === 0)) {
        return fail('PATH_INVALID', 'cursor 必须是非空字符串');
      }
      const committed = [...this.durables.values()].sort((a, b) => a.stagingId.localeCompare(b.stagingId));
      let start = 0;
      if (typeof req.cursor === 'string') {
        const cursor = req.cursor;
        start = committed.findIndex((record) => record.stagingId > cursor);
        if (start < 0) start = committed.length;
      }
      const slice = committed.slice(start, start + limit);
      const hasMore = start + slice.length < committed.length;
      if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
      return {
        ok: true as const,
        items: slice.map((record) => ({ ...receiptOf(record), recovery: record.recovery })),
        hasMore,
        nextCursor: hasMore ? slice[slice.length - 1]!.stagingId : null,
      };
    });
  }

  async read(req: {
    ghostId: string;
    stagingId: unknown;
    offset?: unknown;
    length?: unknown;
  }): Promise<LibraryStagingResult<{ stagingId: string; content: string; encoding: 'base64'; bytes: number; sha256: string }>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const stagingId = parseStagingId(req.stagingId);
      if (typeof stagingId !== 'string') return stagingId;
      if (!this.durables.has(stagingId)) return fail('NOT_FOUND', 'stagingId 无效');
      const offset = req.offset === undefined ? 0 : req.offset;
      const length = req.length === undefined ? this.limits.maxChunkBytes : req.length;
      if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
        return fail('PATH_INVALID', 'offset 必须是非负整数');
      }
      if (typeof length !== 'number' || !Number.isInteger(length) || length < 0) {
        return fail('PATH_INVALID', 'length 必须是非负整数');
      }
      if (length > this.limits.maxChunkBytes) {
        return fail('TOO_LARGE', `读取长度超上限(${this.limits.maxChunkBytes} 字节)`);
      }
      const read = await this.vault.read({
        path: blobPath(stagingId),
        encoding: 'base64',
        offset,
        length,
      });
      if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
      if (!read.ok) return vaultFail(read);
      return {
        ok: true as const,
        stagingId,
        content: read.content,
        encoding: 'base64' as const,
        bytes: read.bytes,
        sha256: read.sha256,
      };
    });
  }

  async abort(req: { ghostId: string; stagingId: unknown }): Promise<LibraryStagingResult<{ aborted: boolean }>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const stagingId = parseStagingId(req.stagingId);
      if (typeof stagingId !== 'string') return stagingId;
      const upload = this.uploads.get(stagingId);
      if (!upload) {
        if (this.durables.has(stagingId)) return fail('STREAM_INVALID', '已提交的原件不能 abort');
        return { ok: true as const, aborted: false };
      }
      if (upload.commitPending) {
        return fail('STREAM_INVALID', '已提交的原件不能 abort');
      }
      const aborted = await this.vault.writeAbort({ streamId: upload.streamId });
      this.uploads.delete(stagingId);
      this.byTask.delete(taskKey(upload.taskId, upload.sourceRevision));
      const residue = await this.refreshClosedTmp();
      if (this.requireOwner()) return fail('OWNER_CHANGED', '账号已切换,staging 操作已取消');
      if (!aborted.ok) return vaultFail(aborted);
      if (residue) return residue;
      return { ok: true as const, aborted: aborted.aborted };
    });
  }

  async release(req: {
    ghostId: string;
    stagingId: unknown;
    ack: LibraryStagingAck;
    /** Sync recheck of the current Library session/epoch/migrating gate. */
    confirmLibrary?: () => LibraryStagingFailure | null;
  }): Promise<LibraryStagingResult<{ stagingId: string; released: boolean }>> {
    return this.runSerialized(async () => {
      const ready = await this.requireReady();
      if (ready) return ready;
      if (req.ghostId !== this.ghostId) return fail('PATH_INVALID', 'ghostId 与当前 staging 根不一致');
      const stagingId = parseStagingId(req.stagingId);
      if (typeof stagingId !== 'string') return stagingId;
      if (req.ack.ok !== true) return req.ack;
      const confirm = (): LibraryStagingFailure | null => {
        const owner = this.requireOwner();
        if (owner) return owner;
        return req.confirmLibrary?.() ?? null;
      };
      const rollbackTombstone = async (): Promise<LibraryStagingFailure | null> => {
        const deleted = await this.vault.delete({ path: tombstonePath(stagingId) });
        if (!deleted.ok && deleted.errorCode !== 'NOT_FOUND') return vaultFail(deleted);
        return null;
      };
      const record = this.durables.get(stagingId);
      if (!record) {
        const blocked = confirm();
        if (blocked) return blocked;
        const tomb = await this.readTombstone(stagingId);
        const blockedAfter = confirm();
        if (blockedAfter) return blockedAfter;
        if (!tomb.ok) {
          return tomb.errorCode === 'NOT_FOUND'
            ? { ok: true as const, stagingId, released: false }
            : tomb;
        }
        const cleaned = await this.finishReleaseUnlocked(stagingId);
        if (cleaned) return cleaned;
        return { ok: true as const, stagingId, released: false };
      }
      if (req.ack.sha256 !== record.sha256 || req.ack.bytes !== record.bytes) {
        return fail('ACK_MISMATCH', 'Library ACK 与 staging 原件不一致,原件已保留');
      }
      const blocked = confirm();
      if (blocked) return blocked;
      const stone = await this.vault.write({
        path: tombstonePath(stagingId),
        content: JSON.stringify({ version: 1, stagingId, released: true }),
        ifNotExists: true,
      });
      const blockedAfterWrite = confirm();
      if (blockedAfterWrite) {
        return await rollbackTombstone() ?? blockedAfterWrite;
      }
      if (!stone.ok && stone.errorCode !== 'ALREADY_EXISTS') return vaultFail(stone);
      const markerSync = await this.fsyncDurablePath(stagingId);
      if (markerSync) {
        return await rollbackTombstone() ?? markerSync;
      }
      const blockedAfterSync = confirm();
      if (blockedAfterSync) {
        return await rollbackTombstone() ?? blockedAfterSync;
      }
      const cleaned = await this.finishReleaseUnlocked(stagingId);
      if (cleaned) return cleaned;
      this.durables.delete(stagingId);
      this.byTask.delete(taskKey(record.taskId, record.sourceRevision));
      this.durableBytes = Math.max(0, this.durableBytes - record.bytes);
      return { ok: true as const, stagingId, released: true };
    });
  }
}
