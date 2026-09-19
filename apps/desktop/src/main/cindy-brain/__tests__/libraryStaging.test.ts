/**
 * Host H1 LibraryStagingStore 故障恢复单测。
 * 每条用例执行标题声称的完整序列(失败 → 保留原件 → 去掉故障 → 同实例/新实例恢复),
 * 禁止只断言初次失败。tmpdir 合成数据,零 Electron,不读真实 profile/Library。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import { LibraryStagingStore, DEFAULT_LIBRARY_STAGING_LIMITS } from '../libraryStaging.js';
import { LibraryVault, DEFAULT_LIBRARY_LIMITS } from '../libraryVault.js';

const sha256Of = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const HEX_A = 'a'.repeat(64);
const DEFAULT_READ_CHUNK = DEFAULT_LIBRARY_STAGING_LIMITS.maxChunkBytes;

describe('LibraryStagingStore 故障恢复', () => {
  let tmp: string;
  let scope: string | null = 'local:owner-a:1';
  const ghostId = 'mivo-canvas';
  const body = 'pixel-bytes';
  const sha = sha256Of(body);
  const recovery = { sceneId: 's1', nodeId: 'n1' };

  const makeStore = (
    root = path.join(tmp, 'library-staging', ghostId),
    extra: {
      maxTotalBytes?: number;
      maxConcurrentWrites?: number;
      maxChunkBytes?: number;
      listPageSize?: number;
    } = {},
  ): LibraryStagingStore =>
    new LibraryStagingStore({
      rootDir: root,
      ownerScopeKey: 'local:owner-a:1',
      ghostId,
      captureOwnerScope: () => scope,
      createVault: (deps) => new LibraryVault({
        ...deps,
        limits: {
          ...deps.limits,
          ...(extra.listPageSize !== undefined ? { listPageSize: extra.listPageSize } : {}),
        },
      }),
      getDiskFreeBytes: async () => 1024 ** 4,
      limits: {
        maxTotalBytes: extra.maxTotalBytes ?? 64,
        maxConcurrentWrites: extra.maxConcurrentWrites ?? 2,
        reserveBytes: 1,
        ...(extra.maxChunkBytes !== undefined ? { maxChunkBytes: extra.maxChunkBytes } : {}),
      },
    });

  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cindy-library-staging-'));
    scope = 'local:owner-a:1';
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  async function beginChunk(
    store: LibraryStagingStore,
    taskId: string,
    payload: string | Buffer,
    sourceRevision = 'rev-1',
  ) {
    const buf = typeof payload === 'string' ? Buffer.from(payload) : payload;
    const digest = sha256Of(buf);
    const begin = await store.begin({
      ghostId, taskId, sourceRevision,
      totalBytes: buf.byteLength, sha256: digest, mime: 'image/png', recovery,
    });
    if (!begin.ok) throw new Error(`begin ${taskId}: ${JSON.stringify(begin)}`);
    const chunk = await store.chunk({
      ghostId, stagingId: begin.stagingId, seq: 1,
      content: buf.toString('base64'), encoding: 'base64',
    });
    if (!chunk.ok) throw new Error(`chunk ${taskId}: ${JSON.stringify(chunk)}`);
    return { stagingId: begin.stagingId, digest, bytes: buf.byteLength };
  }

  async function commitOne(
    store = makeStore(),
    taskId = 'task-1',
    payload: string | Buffer = body,
    sourceRevision = 'rev-1',
  ) {
    const started = await beginChunk(store, taskId, payload, sourceRevision);
    const commit = await store.commit({ ghostId, stagingId: started.stagingId });
    if (!commit.ok) throw new Error(`commit ${taskId}: ${JSON.stringify(commit)}`);
    return { store, stagingId: started.stagingId, commit, digest: started.digest };
  }

  function blobAbs(root: string, stagingId: string): string {
    return path.join(root, 'tasks', stagingId, 'blob.bin');
  }
  function manifestAbs(root: string, stagingId: string): string {
    return path.join(root, 'tasks', stagingId, 'manifest.json');
  }
  function tombstoneAbs(root: string, stagingId: string): string {
    return path.join(root, 'tasks', stagingId, 'tombstone.json');
  }
  function matchingAck(commit: { sha256: string; bytes: number }) {
    return {
      ok: true as const,
      path: `assets/${commit.sha256.slice(0, 2)}/${commit.sha256}/blob.png`,
      sha256: commit.sha256,
      bytes: commit.bytes,
      libraryIdentity: HEX_A,
      libraryGeneration: 0,
    };
  }

  async function listAllPublic(store: LibraryStagingStore, limit = 2) {
    const items: Array<{ stagingId: string; bytes: number; taskId: string }> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await store.list({ ghostId, cursor, limit });
      if (!page.ok) throw new Error(`list: ${JSON.stringify(page)}`);
      items.push(...page.items.map((item) => ({
        stagingId: item.stagingId, bytes: item.bytes, taskId: item.taskId,
      })));
      if (!page.hasMore) {
        expect(page.nextCursor).toBeNull();
        return { items, last: page };
      }
      expect(typeof page.nextCursor).toBe('string');
      cursor = page.nextCursor ?? undefined;
    }
  }

  it('commit 后新实例 list/read 可恢复;未提交流不出现', async () => {
    const root = path.join(tmp, 'library-staging', ghostId);
    const live = makeStore(root);
    const uploading = await live.begin({
      ghostId, taskId: 'partial', sourceRevision: 'r',
      totalBytes: 8, sha256: '0'.repeat(64), mime: 'image/png', recovery,
    });
    if (!uploading.ok) throw new Error(JSON.stringify(uploading));
    const { stagingId } = await commitOne(live);
    const restored = makeStore(root);
    const listed = await restored.list({ ghostId });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.items.map((item) => item.stagingId)).toEqual([stagingId]);
    expect(listed.items[0]?.durable).toBe(true);
    expect(listed.items[0]?.recovery).toEqual(recovery);
    const read = await restored.read({ ghostId, stagingId });
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(Buffer.from(read.content, 'base64').toString('utf8')).toBe(body);
  });

  it('坏 manifest:list 失败非空,原件保留;修复后同一实例 list/read 成功且无重复', async () => {
    const root = path.join(tmp, 'library-staging', ghostId);
    const { stagingId: firstId } = await commitOne(makeStore(root, { maxTotalBytes: 1024 }), 'task-a', 'alpha');
    const { stagingId: secondId } = await commitOne(makeStore(root, { maxTotalBytes: 1024 }), 'task-b', 'bravo');
    const originalManifest = await fs.promises.readFile(manifestAbs(root, secondId), 'utf8');
    await fs.promises.writeFile(manifestAbs(root, secondId), '{not json');

    const same = makeStore(root, { maxTotalBytes: 1024 });
    const listed = await same.list({ ghostId });
    expect(listed).toMatchObject({ ok: false, errorCode: 'LIBRARY_UNAVAILABLE' });
    expect(fs.existsSync(blobAbs(root, firstId))).toBe(true);
    expect(fs.existsSync(blobAbs(root, secondId))).toBe(true);
    const blocked = await same.begin({
      ghostId, taskId: 'task-x', sourceRevision: 'rev-x',
      totalBytes: 1, sha256: '0'.repeat(64), mime: 'image/png', recovery,
    });
    expect(blocked).toMatchObject({ ok: false, errorCode: 'LIBRARY_UNAVAILABLE' });
    expect(blocked.ok).toBe(false);

    await fs.promises.writeFile(manifestAbs(root, secondId), originalManifest);
    const recovered = await same.list({ ghostId });
    if (!recovered.ok) throw new Error(`same-instance recover: ${JSON.stringify(recovered)}`);
    const ids = recovered.items.map((item) => item.stagingId).sort();
    expect(ids).toEqual([firstId, secondId].sort());
    expect(new Set(ids).size).toBe(2);
    const readFirst = await same.read({ ghostId, stagingId: firstId });
    const readSecond = await same.read({ ghostId, stagingId: secondId });
    if (!readFirst.ok || !readSecond.ok) throw new Error('same-instance read failed');
    expect(Buffer.from(readFirst.content, 'base64').toString('utf8')).toBe('alpha');
    expect(Buffer.from(readSecond.content, 'base64').toString('utf8')).toBe('bravo');
  });

  it('不可读 manifest(目录占位)同样 LIBRARY_UNAVAILABLE,修复后同一实例恢复', async () => {
    const root = path.join(tmp, 'library-staging', ghostId);
    const { stagingId } = await commitOne(makeStore(root));
    const original = await fs.promises.readFile(manifestAbs(root, stagingId), 'utf8');
    await fs.promises.rm(manifestAbs(root, stagingId));
    await fs.promises.mkdir(manifestAbs(root, stagingId));

    const same = makeStore(root);
    expect(await same.list({ ghostId })).toMatchObject({ ok: false, errorCode: 'LIBRARY_UNAVAILABLE' });
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);

    await fs.promises.rm(manifestAbs(root, stagingId), { recursive: true, force: true });
    await fs.promises.writeFile(manifestAbs(root, stagingId), original);
    const listed = await same.list({ ghostId });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.items.map((item) => item.stagingId)).toEqual([stagingId]);
    const read = await same.read({ ghostId, stagingId });
    if (!read.ok) throw new Error(JSON.stringify(read));
    expect(Buffer.from(read.content, 'base64').toString('utf8')).toBe(body);
  });

  it('无 manifest 的 blob 计入额度且不列为 committed,不卡住同 task', async () => {
    const root = path.join(tmp, 'library-staging', ghostId);
    const orphanId = randomUUID();
    await fs.promises.mkdir(path.join(root, 'tasks', orphanId), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'tasks', orphanId, 'blob.bin'), 'x'.repeat(60));
    const store = makeStore(root);
    const begin = await store.begin({
      ghostId, taskId: 'task-1', sourceRevision: 'rev-1',
      totalBytes: Buffer.byteLength(body), sha256: sha, mime: 'image/png', recovery,
    });
    expect(begin).toMatchObject({ ok: false, errorCode: 'STAGING_QUOTA' });
    expect(fs.existsSync(path.join(root, 'tasks', orphanId, 'blob.bin'))).toBe(true);
    const listed = await store.list({ ghostId });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.items).toEqual([]);
  });

  it('活跃预留+关闭 unlink 失败残片+orphan+committed-pending+durable 合计占额,不得双计活跃 tmp', async () => {
    const root = path.join(tmp, 'quota-mix', ghostId);
    const orphanId = randomUUID();
    await fs.promises.mkdir(path.join(root, 'tasks', orphanId), { recursive: true });
    await fs.promises.writeFile(path.join(root, 'tasks', orphanId, 'blob.bin'), 'O'.repeat(10));
    const store = makeStore(root, { maxTotalBytes: 50, maxConcurrentWrites: 4 });

    const durable = await commitOne(store, 'durable-task', 'D'.repeat(10));
    const small = await store.begin({
      ghostId, taskId: 'small-beside-orphan', sourceRevision: 'r',
      totalBytes: 8, sha256: sha256Of('s'.repeat(8)), mime: 'image/png', recovery,
    });
    if (!small.ok) throw new Error(`small begin beside orphan: ${JSON.stringify(small)}`);
    const smallChunk = await store.chunk({
      ghostId, stagingId: small.stagingId, seq: 1,
      content: Buffer.from('s'.repeat(8)).toString('base64'), encoding: 'base64',
    });
    if (!smallChunk.ok) throw new Error(JSON.stringify(smallChunk));

    const realUnlink = fs.promises.unlink.bind(fs.promises);
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (target, ...rest) => {
      if (String(target).includes(`${path.sep}.cindy-library${path.sep}tmp${path.sep}`)) {
        throw Object.assign(new Error('EACCES unlink tmp'), { code: 'EACCES' });
      }
      return realUnlink(target, ...rest);
    });
    const aborted = await store.abort({ ghostId, stagingId: small.stagingId });
    expect(aborted).toMatchObject({ ok: true, aborted: true });
    unlinkSpy.mockRestore();
    const tmpDir = path.join(root, '.cindy-library', 'tmp');
    const leftover = (await fs.promises.readdir(tmpDir)).filter((name) => name !== '.' && name !== '..');
    expect(leftover.length).toBeGreaterThan(0);
    const leftoverBytes = leftover.reduce((sum, name) => {
      const st = fs.statSync(path.join(tmpDir, name));
      return sum + (st.isFile() ? st.size : 0);
    }, 0);
    expect(leftoverBytes).toBeGreaterThan(0);

    const active = await store.begin({
      ghostId, taskId: 'still-active', sourceRevision: 'r',
      totalBytes: 5, sha256: sha256Of('A'.repeat(5)), mime: 'image/png', recovery,
    });
    if (!active.ok) throw new Error(`active reservation: ${JSON.stringify(active)}`);

    const origWrite = LibraryVault.prototype.write;
    const writeSpy = vi.spyOn(LibraryVault.prototype, 'write').mockImplementation(async function (this: LibraryVault, req) {
      if (typeof req.path === 'string' && req.path.endsWith('manifest.json')) {
        return { ok: false, errorCode: 'INTERNAL', message: 'manifest write failed' };
      }
      return origWrite.call(this, req);
    });
    let pendingId: string | undefined;
    try {
      const pending = await beginChunk(store, 'pending-task', 'P'.repeat(10));
      pendingId = pending.stagingId;
      const failedCommit = await store.commit({ ghostId, stagingId: pending.stagingId });
      expect(failedCommit.ok).toBe(false);
      expect(fs.existsSync(blobAbs(root, pending.stagingId))).toBe(true);
      expect(fs.existsSync(manifestAbs(root, pending.stagingId))).toBe(false);

      // durable 10 + orphan 10 + closed residue >=8 + active 5 + pending 10 >= 43; +8 exceeds 50.
      const extra = await store.begin({
        ghostId, taskId: 'extra-over-quota', sourceRevision: 'rev-1',
        totalBytes: 8, sha256: sha256Of('E'.repeat(8)), mime: 'image/png', recovery,
      });
      expect(extra).toMatchObject({ ok: false, errorCode: 'STAGING_QUOTA' });
    } finally {
      writeSpy.mockRestore();
    }

    if (!pendingId) throw new Error('pending stagingId missing');
    const chunkSpy = vi.spyOn(LibraryVault.prototype, 'writeChunk');
    const beginSpy = vi.spyOn(LibraryVault.prototype, 'writeBegin');
    try {
      const retried = await store.commit({ ghostId, stagingId: pendingId });
      if (!retried.ok) throw new Error(`retry commit after manifest fault removed: ${JSON.stringify(retried)}`);
      expect(retried.durable).toBe(true);
      expect(retried.bytes).toBe(10);
      expect(chunkSpy).not.toHaveBeenCalled();
      expect(beginSpy).not.toHaveBeenCalled();
    } finally {
      chunkSpy.mockRestore();
      beginSpy.mockRestore();
    }
    expect(fs.existsSync(manifestAbs(root, pendingId))).toBe(true);
    expect(fs.existsSync(blobAbs(root, durable.stagingId))).toBe(true);
    expect(fs.existsSync(path.join(root, 'tasks', orphanId, 'blob.bin'))).toBe(true);
  });

  it('abort 真正调用后关闭残片计入额度,不得与活跃预留重复计费', async () => {
    const root = path.join(tmp, 'abort-residue', ghostId);
    const store = makeStore(root, { maxTotalBytes: 20 });
    const begin = await store.begin({
      ghostId, taskId: 'abort-me', sourceRevision: 'r',
      totalBytes: 12, sha256: sha256Of('z'.repeat(12)), mime: 'image/png', recovery,
    });
    if (!begin.ok) throw new Error(JSON.stringify(begin));
    const chunked = await store.chunk({
      ghostId, stagingId: begin.stagingId, seq: 1,
      content: Buffer.from('z'.repeat(12)).toString('base64'), encoding: 'base64',
    });
    if (!chunked.ok) throw new Error(JSON.stringify(chunked));
    const realUnlink = fs.promises.unlink.bind(fs.promises);
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (target, ...rest) => {
      if (String(target).includes(`${path.sep}.cindy-library${path.sep}tmp${path.sep}`)) {
        throw Object.assign(new Error('EACCES unlink tmp'), { code: 'EACCES' });
      }
      return realUnlink(target, ...rest);
    });
    const aborted = await store.abort({ ghostId, stagingId: begin.stagingId });
    expect(aborted).toMatchObject({ ok: true, aborted: true });
    unlinkSpy.mockRestore();
    const tmpDir = path.join(root, '.cindy-library', 'tmp');
    const leftover = (await fs.promises.readdir(tmpDir)).filter((name) => {
      const st = fs.statSync(path.join(tmpDir, name));
      return st.isFile() && st.size > 0;
    });
    expect(leftover.length).toBeGreaterThan(0);

    const over = await store.begin({
      ghostId, taskId: 'task-over', sourceRevision: 'rev-1',
      totalBytes: 9, sha256: sha256Of('n'.repeat(9)), mime: 'image/png', recovery,
    });
    expect(over).toMatchObject({ ok: false, errorCode: 'STAGING_QUOTA' });

    const exact = await store.begin({
      ghostId, taskId: 'task-exact', sourceRevision: 'rev-1',
      totalBytes: 8, sha256: sha256Of('e'.repeat(8)), mime: 'image/png', recovery,
    });
    if (!exact.ok) throw new Error(`no-double-count exact fill: ${JSON.stringify(exact)}`);
    const abortExact = await store.abort({ ghostId, stagingId: exact.stagingId });
    expect(abortExact).toMatchObject({ ok: true, aborted: true });
  });

  it('writeCommit 成功但 manifest 失败后占额;去掉故障后同一 id 提交成功且不再重传字节', async () => {
    const root = path.join(tmp, 'pending-retry', ghostId);
    const store = makeStore(root, { maxTotalBytes: 40 });
    const origWrite = LibraryVault.prototype.write;
    const writeSpy = vi.spyOn(LibraryVault.prototype, 'write').mockImplementation(async function (this: LibraryVault, req) {
      if (typeof req.path === 'string' && req.path.endsWith('manifest.json')) {
        return { ok: false, errorCode: 'INTERNAL', message: 'manifest write failed' };
      }
      return origWrite.call(this, req);
    });
    const started = await beginChunk(store, 'pending', 'a'.repeat(20));
    const failedCommit = await store.commit({ ghostId, stagingId: started.stagingId });
    expect(failedCommit.ok).toBe(false);
    writeSpy.mockRestore();

    const extra = await store.begin({
      ghostId, taskId: 'extra', sourceRevision: 'rev-1',
      totalBytes: 21, sha256: sha256Of('b'.repeat(21)), mime: 'image/png', recovery,
    });
    expect(extra).toMatchObject({ ok: false, errorCode: 'STAGING_QUOTA' });

    const chunkSpy = vi.spyOn(LibraryVault.prototype, 'writeChunk');
    const beginSpy = vi.spyOn(LibraryVault.prototype, 'writeBegin');
    try {
      const retried = await store.commit({ ghostId, stagingId: started.stagingId });
      if (!retried.ok) throw new Error(`retry commit: ${JSON.stringify(retried)}`);
      expect(retried.durable).toBe(true);
      expect(chunkSpy).not.toHaveBeenCalled();
      expect(beginSpy).not.toHaveBeenCalled();
    } finally {
      chunkSpy.mockRestore();
      beginSpy.mockRestore();
    }
    const listed = await store.list({ ghostId });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.items.map((item) => item.stagingId)).toEqual([started.stagingId]);
  });

  it('任务目录、tasks 父目录、vault 根 fsync 失败均真正命中对应方法:初次不得 durable,去掉故障后同 id 提交成功且新 Store 可 list/read', async () => {
    const cases: Array<{
      label: string;
      failWhen: (relPath: unknown, stagingId: string) => boolean;
    }> = [
      {
        label: 'task-dir',
        failWhen: (relPath, stagingId) => relPath === `tasks/${stagingId}`,
      },
      {
        label: 'tasks-parent',
        failWhen: (relPath) => relPath === 'tasks',
      },
      {
        label: 'vault-root',
        failWhen: (relPath) => relPath === '',
      },
    ];

    for (const item of cases) {
      const root = path.join(tmp, `fsync-${item.label}`, ghostId);
      const store = makeStore(root, { maxTotalBytes: 1024 });
      const started = await beginChunk(store, `fsync-${item.label}`, body);
      const seen: unknown[] = [];
      const orig = LibraryVault.prototype.fsyncDir;
      const spy = vi.spyOn(LibraryVault.prototype, 'fsyncDir').mockImplementation(async function (this: LibraryVault, relPath?: unknown) {
        seen.push(relPath);
        if (item.failWhen(relPath, started.stagingId)) {
          return { ok: false, errorCode: 'INTERNAL', message: `${item.label} fsync 失败` };
        }
        return orig.call(this, relPath);
      });
      try {
        const commit = await store.commit({ ghostId, stagingId: started.stagingId });
        expect(commit.ok, `${item.label} 初次 commit 应失败`).toBe(false);
        if (!commit.ok) expect(commit.errorCode).toBe('INTERNAL');
        expect(commit).not.toHaveProperty('durable');
        expect(seen.some((rel) => item.failWhen(rel, started.stagingId)), `${item.label} 未命中 fsyncDir`).toBe(true);
        expect(fs.existsSync(blobAbs(root, started.stagingId))).toBe(true);
        const listed = await store.list({ ghostId });
        if (listed.ok) {
          expect(listed.items.every((row) => row.stagingId !== started.stagingId)).toBe(true);
        }
      } finally {
        spy.mockRestore();
      }

      const retried = await store.commit({ ghostId, stagingId: started.stagingId });
      if (!retried.ok) throw new Error(`${item.label} retry commit: ${JSON.stringify(retried)}`);
      expect(retried.durable).toBe(true);
      const restored = makeStore(root, { maxTotalBytes: 1024 });
      const listed = await restored.list({ ghostId });
      if (!listed.ok) throw new Error(`${item.label} new store list: ${JSON.stringify(listed)}`);
      expect(listed.items.map((row) => row.stagingId)).toEqual([started.stagingId]);
      const read = await restored.read({ ghostId, stagingId: started.stagingId });
      if (!read.ok) throw new Error(`${item.label} new store read: ${JSON.stringify(read)}`);
      expect(Buffer.from(read.content, 'base64').toString('utf8')).toBe(body);
    }
  });

  it('release:错误 ACK 保留原件;tombstone fsync 失败保留原件;manifest 删除失败后同实例与新 Store 收敛;损坏 tombstone 不得静默删原件;成功释放精确还额', async () => {
    const root = path.join(tmp, 'release', ghostId);
    const store = makeStore(root, { maxTotalBytes: 64 });
    const { stagingId, commit } = await commitOne(store);

    const mismatch = await store.release({
      ghostId, stagingId,
      ack: {
        ok: true,
        path: 'assets/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/blob.png',
        sha256: '1'.repeat(64), bytes: 1, libraryIdentity: HEX_A, libraryGeneration: 0,
      },
    });
    expect(mismatch).toMatchObject({ ok: false, errorCode: 'ACK_MISMATCH' });
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);
    const still = await store.list({ ghostId });
    if (!still.ok) throw new Error(JSON.stringify(still));
    expect(still.items.map((item) => item.stagingId)).toContain(stagingId);

    const origFsync = LibraryVault.prototype.fsyncDir;
    const tombFsync = vi.spyOn(LibraryVault.prototype, 'fsyncDir').mockImplementation(async function (this: LibraryVault, relPath?: unknown) {
      if (typeof relPath === 'string' && relPath === `tasks/${stagingId}` && fs.existsSync(tombstoneAbs(root, stagingId))) {
        return { ok: false, errorCode: 'INTERNAL', message: 'tombstone fsync 失败' };
      }
      return origFsync.call(this, relPath);
    });
    try {
      const blocked = await store.release({ ghostId, stagingId, ack: matchingAck(commit) });
      expect(blocked.ok).toBe(false);
      expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);
    } finally {
      tombFsync.mockRestore();
    }

    const origDelete = LibraryVault.prototype.delete;
    let blobDeleted = false;
    const deleteSpy = vi.spyOn(LibraryVault.prototype, 'delete').mockImplementation(async function (this: LibraryVault, req) {
      if (typeof req.path === 'string' && req.path.endsWith('manifest.json') && blobDeleted) {
        return { ok: false, errorCode: 'INTERNAL', message: 'manifest delete failed' };
      }
      const result = await origDelete.call(this, req);
      if (result.ok && typeof req.path === 'string' && req.path.endsWith('blob.bin')) blobDeleted = true;
      return result;
    });
    try {
      const failed = await store.release({ ghostId, stagingId, ack: matchingAck(commit) });
      expect(failed.ok).toBe(false);
      const retrySame = await store.release({ ghostId, stagingId, ack: matchingAck(commit) });
      expect(retrySame.ok).toBe(false);
      const midFault = makeStore(root, { maxTotalBytes: 64 });
      const midListed = await midFault.list({ ghostId });
      expect(midListed.ok).toBe(false);
      if (!midListed.ok) expect(['LIBRARY_UNAVAILABLE', 'INTERNAL']).toContain(midListed.errorCode);
      const occupied = await store.begin({
        ghostId, taskId: 'quota-while-cleanup-fails', sourceRevision: 'r',
        totalBytes: 55, sha256: sha256Of('q'.repeat(55)), mime: 'image/png', recovery,
      });
      expect(occupied).toMatchObject({ ok: false, errorCode: 'STAGING_QUOTA' });
    } finally {
      deleteSpy.mockRestore();
    }

    const converged = await store.release({ ghostId, stagingId, ack: matchingAck(commit) });
    expect(converged).toEqual({ ok: true, stagingId, released: true });
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(false);

    const restored = makeStore(root, { maxTotalBytes: 64 });
    const listed = await restored.list({ ghostId });
    if (!listed.ok) throw new Error(`new store after release: ${JSON.stringify(listed)}`);
    expect(listed.items).toEqual([]);
    const again = await restored.release({ ghostId, stagingId, ack: matchingAck(commit) });
    expect(again).toMatchObject({ ok: true, released: false });

    const { stagingId: liveId, commit: liveCommit } = await commitOne(restored, 'task-live', 'keep-me');
    await fs.promises.writeFile(tombstoneAbs(root, liveId), '{not a tombstone');
    const corruptStore = makeStore(root, { maxTotalBytes: 64 });
    const corruptList = await corruptStore.list({ ghostId });
    expect(corruptList).toMatchObject({ ok: false, errorCode: 'LIBRARY_UNAVAILABLE' });
    expect(fs.existsSync(blobAbs(root, liveId))).toBe(true);
    await fs.promises.rm(tombstoneAbs(root, liveId), { force: true });
    const repaired = await corruptStore.list({ ghostId });
    if (!repaired.ok) throw new Error(`tombstone repaired: ${JSON.stringify(repaired)}`);
    expect(repaired.items.map((item) => item.stagingId)).toEqual([liveId]);
    const liveRead = await corruptStore.read({ ghostId, stagingId: liveId });
    if (!liveRead.ok) throw new Error(JSON.stringify(liveRead));
    expect(Buffer.from(liveRead.content, 'base64').toString('utf8')).toBe('keep-me');

    const released = await corruptStore.release({ ghostId, stagingId: liveId, ack: matchingAck(liveCommit) });
    expect(released).toEqual({ ok: true, stagingId: liveId, released: true });
    const afterRelease = await corruptStore.begin({
      ghostId, taskId: 'after-release', sourceRevision: 'rev-1',
      totalBytes: Buffer.byteLength(body), sha256: sha, mime: 'image/png', recovery,
    });
    expect(afterRelease.ok).toBe(true);
  });

  it('有效 tombstone+残留 blob/manifest:新 Store 成功清理后立即归还全部 bytes,不得把已删除 leftover 计入 orphan', async () => {
    const root = path.join(tmp, 'tombstone-quota', ghostId);
    const maxTotalBytes = 40;
    const payload = 'T'.repeat(maxTotalBytes);
    const writer = makeStore(root, { maxTotalBytes });
    const { stagingId } = await commitOne(writer, 'crash-release', payload);
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);
    expect(fs.existsSync(manifestAbs(root, stagingId))).toBe(true);
    await fs.promises.writeFile(
      tombstoneAbs(root, stagingId),
      JSON.stringify({ version: 1, stagingId, released: true }),
    );
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);
    expect(fs.existsSync(manifestAbs(root, stagingId))).toBe(true);
    expect(fs.existsSync(tombstoneAbs(root, stagingId))).toBe(true);

    const restored = makeStore(root, { maxTotalBytes });
    const listed = await restored.list({ ghostId });
    if (!listed.ok) throw new Error(`loadJournal after valid tombstone: ${JSON.stringify(listed)}`);
    expect(listed.items).toEqual([]);
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(false);
    expect(fs.existsSync(manifestAbs(root, stagingId))).toBe(false);
    expect(fs.existsSync(tombstoneAbs(root, stagingId))).toBe(false);

    const reclaimed = await restored.begin({
      ghostId, taskId: 'reclaimed-after-tombstone-cleanup', sourceRevision: 'rev-1',
      totalBytes: maxTotalBytes, sha256: sha256Of(payload), mime: 'image/png', recovery,
    });
    expect(reclaimed, `quota not returned after successful tombstone cleanup: ${JSON.stringify(reclaimed)}`).toMatchObject({ ok: true });
    if (!reclaimed.ok) return;
    const aborted = await restored.abort({ ghostId, stagingId: reclaimed.stagingId });
    expect(aborted).toMatchObject({ ok: true, aborted: true });
  });

  it('manifest 写失败后 commitPending blob 已落地:拒 abort 且不调 writeAbort,超额 begin 必须 STAGING_QUOTA,同 id commit 重试成功', async () => {
    const root = path.join(tmp, 'commit-pending-abort', ghostId);
    const maxTotalBytes = 40;
    const store = makeStore(root, { maxTotalBytes });
    const started = await beginChunk(store, 'pending-abort', 'a'.repeat(20));
    const origWrite = LibraryVault.prototype.write;
    const writeSpy = vi.spyOn(LibraryVault.prototype, 'write').mockImplementation(async function (this: LibraryVault, req) {
      if (typeof req.path === 'string' && req.path.endsWith('manifest.json')) {
        return { ok: false, errorCode: 'INTERNAL', message: 'manifest write failed' };
      }
      return origWrite.call(this, req);
    });
    const failedCommit = await store.commit({ ghostId, stagingId: started.stagingId });
    writeSpy.mockRestore();
    expect(failedCommit.ok).toBe(false);
    expect(fs.existsSync(blobAbs(root, started.stagingId))).toBe(true);
    expect(fs.existsSync(manifestAbs(root, started.stagingId))).toBe(false);

    const writeAbort = vi.spyOn(LibraryVault.prototype, 'writeAbort');
    const aborted = await store.abort({ ghostId, stagingId: started.stagingId });
    expect(writeAbort).not.toHaveBeenCalled();
    writeAbort.mockRestore();
    expect(aborted).toMatchObject({ ok: false, errorCode: 'STREAM_INVALID' });
    expect(fs.existsSync(blobAbs(root, started.stagingId))).toBe(true);
    expect(fs.existsSync(manifestAbs(root, started.stagingId))).toBe(false);

    const over = await store.begin({
      ghostId, taskId: 'over-after-pending-abort', sourceRevision: 'rev-1',
      totalBytes: 21, sha256: sha256Of('b'.repeat(21)), mime: 'image/png', recovery,
    });
    expect(over, `abort dropped undeleted blob from quota: ${JSON.stringify(over)}`).toMatchObject({
      ok: false, errorCode: 'STAGING_QUOTA',
    });
    expect(fs.existsSync(blobAbs(root, started.stagingId))).toBe(true);

    const retried = await store.commit({ ghostId, stagingId: started.stagingId });
    expect(retried).toMatchObject({ ok: true, stagingId: started.stagingId, durable: true, bytes: 20 });
    expect(fs.existsSync(blobAbs(root, started.stagingId))).toBe(true);
    expect(fs.existsSync(manifestAbs(root, started.stagingId))).toBe(true);
  });

  it('abort 不得删除已提交原件;不存在 TTL 清掉 unique durable', async () => {
    const root = path.join(tmp, 'no-ttl', ghostId);
    const store = makeStore(root, { maxTotalBytes: 1024 });
    const { stagingId } = await commitOne(store);
    const abortDurable = await store.abort({ ghostId, stagingId });
    expect(abortDurable).toMatchObject({ ok: false, errorCode: 'STREAM_INVALID' });
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);

    const other = await beginChunk(store, 'other', 'other-bytes');
    const abortedOther = await store.abort({ ghostId, stagingId: other.stagingId });
    expect(abortedOther).toMatchObject({ ok: true, aborted: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listed = await store.list({ ghostId });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.items.map((item) => item.stagingId)).toEqual([stagingId]);
    expect(fs.existsSync(blobAbs(root, stagingId))).toBe(true);
  });

  it('超过 Vault.listPageSize 的恢复与公开 list 游标:每条 durable 恰好一次且跨页合计字节', async () => {
    const pageSize = 2;
    expect(pageSize).toBeLessThan(DEFAULT_LIBRARY_LIMITS.listPageSize);
    const root = path.join(tmp, 'pages', ghostId);
    const writer = makeStore(root, { maxTotalBytes: 4096, listPageSize: pageSize });
    const expected = new Map<string, number>();
    for (let i = 0; i < pageSize + 3; i += 1) {
      const payload = `page-item-${i}`;
      const committed = await commitOne(writer, `task-${i}`, payload, `rev-${i}`);
      expected.set(committed.stagingId, Buffer.byteLength(payload));
    }
    expect(expected.size).toBeGreaterThan(DEFAULT_LIBRARY_LIMITS.listPageSize > pageSize ? pageSize : 0);
    expect(expected.size).toBeGreaterThan(pageSize);

    const vaultList = vi.spyOn(LibraryVault.prototype, 'list');
    const restored = makeStore(root, { maxTotalBytes: 4096, listPageSize: pageSize });
    const walked = await listAllPublic(restored, pageSize);
    const taskDirPages = vaultList.mock.calls.filter((args) => args[0]?.path === 'tasks').length;
    vaultList.mockRestore();
    expect(taskDirPages).toBeGreaterThan(1);

    const seen = walked.items.map((item) => item.stagingId);
    expect(seen.sort()).toEqual([...expected.keys()].sort());
    expect(new Set(seen).size).toBe(expected.size);
    const totalBytes = walked.items.reduce((sum, item) => sum + item.bytes, 0);
    const expectedBytes = [...expected.values()].reduce((sum, n) => sum + n, 0);
    expect(totalBytes).toBe(expectedBytes);
    expect(walked.items.length).toBeGreaterThan(pageSize);
  });

  it('成功恢复后多次 list/read/chunk 不再对已保留原件全量 hash', async () => {
    const root = path.join(tmp, 'no-rehash', ghostId);
    const { stagingId } = await commitOne(makeStore(root, { maxTotalBytes: 1024 }), 'kept', 'kept-bytes');
    const origHash = LibraryVault.prototype.hashFile;
    const hashSpy = vi.spyOn(LibraryVault.prototype, 'hashFile').mockImplementation(function (this: LibraryVault, relPath: string) {
      return origHash.call(this, relPath);
    });
    const restored = makeStore(root, { maxTotalBytes: 1024 });
    const listed = await restored.list({ ghostId });
    if (!listed.ok) throw new Error(JSON.stringify(listed));
    expect(listed.items.map((item) => item.stagingId)).toEqual([stagingId]);
    const hashesDuringRecovery = hashSpy.mock.calls.filter((args) => args[0] === `tasks/${stagingId}/blob.bin`).length;
    expect(hashesDuringRecovery).toBeGreaterThan(0);
    hashSpy.mockClear();

    const listedAgain = await restored.list({ ghostId });
    if (!listedAgain.ok) throw new Error(JSON.stringify(listedAgain));
    const read1 = await restored.read({ ghostId, stagingId });
    const read2 = await restored.read({ ghostId, stagingId, offset: 0, length: 4 });
    if (!read1.ok || !read2.ok) throw new Error('read after recovery failed');
    const extra = await beginChunk(restored, 'extra-after-recovery', 'xy');
    const extraChunk = await restored.chunk({
      ghostId, stagingId: extra.stagingId, seq: 1,
      content: Buffer.from('xy').toString('base64'), encoding: 'base64',
    });
    expect(extraChunk.ok).toBe(true);
    const retainedHashCalls = hashSpy.mock.calls.filter((args) => args[0] === `tasks/${stagingId}/blob.bin`);
    expect(retainedHashCalls).toEqual([]);
  });

  it('省略 length 的 >16MiB 原件返回 <=maxChunkBytes 前缀;显式分段正确;非法 offset/length 为 PATH_INVALID', async () => {
    const root = path.join(tmp, 'read-16m', ghostId);
    const store = makeStore(root, { maxTotalBytes: 32 * 1024 * 1024 });
    const payload = Buffer.alloc(DEFAULT_READ_CHUNK + 64, 7);
    payload[0] = 11;
    payload[DEFAULT_READ_CHUNK] = 22;
    payload[payload.byteLength - 1] = 33;
    const digest = sha256Of(payload);
    const begin = await store.begin({
      ghostId, taskId: 'big-image', sourceRevision: 'rev-1',
      totalBytes: payload.byteLength, sha256: digest, mime: 'image/png', recovery,
    });
    if (!begin.ok) throw new Error(JSON.stringify(begin));
    const first = payload.subarray(0, DEFAULT_READ_CHUNK);
    const rest = payload.subarray(DEFAULT_READ_CHUNK);
    const chunk1 = await store.chunk({
      ghostId, stagingId: begin.stagingId, seq: 1,
      content: first.toString('base64'), encoding: 'base64',
    });
    if (!chunk1.ok) throw new Error(JSON.stringify(chunk1));
    const chunk2 = await store.chunk({
      ghostId, stagingId: begin.stagingId, seq: 2,
      content: rest.toString('base64'), encoding: 'base64',
    });
    if (!chunk2.ok) throw new Error(JSON.stringify(chunk2));
    const commit = await store.commit({ ghostId, stagingId: begin.stagingId });
    if (!commit.ok) throw new Error(JSON.stringify(commit));

    const omitted = await store.read({ ghostId, stagingId: begin.stagingId });
    if (!omitted.ok) throw new Error(JSON.stringify(omitted));
    expect(omitted.bytes).toBe(DEFAULT_READ_CHUNK);
    expect(omitted.bytes).toBeLessThanOrEqual(DEFAULT_READ_CHUNK);
    expect(Buffer.from(omitted.content, 'base64').equals(first)).toBe(true);
    expect(omitted.sha256).toBe(sha256Of(first));

    const tail = await store.read({
      ghostId, stagingId: begin.stagingId, offset: DEFAULT_READ_CHUNK, length: 64,
    });
    if (!tail.ok) throw new Error(JSON.stringify(tail));
    expect(tail.bytes).toBe(64);
    expect(Buffer.from(tail.content, 'base64').equals(rest)).toBe(true);
    expect(tail.sha256).toBe(sha256Of(rest));

    const mid = await store.read({ ghostId, stagingId: begin.stagingId, offset: 1, length: 3 });
    if (!mid.ok) throw new Error(JSON.stringify(mid));
    expect(Buffer.from(mid.content, 'base64').equals(payload.subarray(1, 4))).toBe(true);

    const smallRoot = path.join(tmp, 'read-small', ghostId);
    const small = makeStore(smallRoot, { maxTotalBytes: 1024 });
    const { stagingId } = await commitOne(small, 'small-1', 'abcdefghijklmnopqrst');
    const whole = await small.read({ ghostId, stagingId });
    if (!whole.ok) throw new Error(JSON.stringify(whole));
    expect(whole.bytes).toBe(Buffer.byteLength('abcdefghijklmnopqrst'));

    expect(await small.read({ ghostId, stagingId, offset: -1 })).toMatchObject({ ok: false, errorCode: 'PATH_INVALID' });
    expect(await small.read({ ghostId, stagingId, length: 1.5 })).toMatchObject({ ok: false, errorCode: 'PATH_INVALID' });
    expect(await small.read({ ghostId, stagingId, offset: Number.NaN })).toMatchObject({ ok: false, errorCode: 'PATH_INVALID' });
    expect(await small.read({ ghostId, stagingId, length: Number.POSITIVE_INFINITY })).toMatchObject({ ok: false, errorCode: 'PATH_INVALID' });
    expect(await small.read({ ghostId, stagingId, offset: Number.NEGATIVE_INFINITY })).toMatchObject({ ok: false, errorCode: 'PATH_INVALID' });
    expect(await small.read({ ghostId, stagingId, length: DEFAULT_READ_CHUNK + 1 })).toMatchObject({ ok: false, errorCode: 'TOO_LARGE' });
  }, 60_000);

  it('同一 task/revision/metadata 在活跃上传与 commit 后 begin 幂等;末块精确重复接受、冲突重复拒绝', async () => {
    const store = makeStore(path.join(tmp, 'idempotent', ghostId), { maxTotalBytes: 1024, maxConcurrentWrites: 2 });
    const payload = 'abcd';
    const digest = sha256Of(payload);
    const first = await store.begin({
      ghostId, taskId: 'same-task', sourceRevision: 'rev-1',
      totalBytes: 4, sha256: digest, mime: 'image/png', recovery,
    });
    if (!first.ok) throw new Error(JSON.stringify(first));
    const againActive = await store.begin({
      ghostId, taskId: 'same-task', sourceRevision: 'rev-1',
      totalBytes: 4, sha256: digest, mime: 'image/png', recovery,
    });
    expect(againActive).toEqual({ ok: true, stagingId: first.stagingId });
    const other = await store.begin({
      ghostId, taskId: 'other-task', sourceRevision: 'rev-1',
      totalBytes: 4, sha256: sha256Of('wxyz'), mime: 'image/png', recovery,
    });
    expect(other.ok).toBe(true);

    const chunk = await store.chunk({
      ghostId, stagingId: first.stagingId, seq: 1,
      content: Buffer.from(payload).toString('base64'), encoding: 'base64',
    });
    expect(chunk).toMatchObject({ ok: true, accepted: 4 });
    const dup = await store.chunk({
      ghostId, stagingId: first.stagingId, seq: 1,
      content: Buffer.from(payload).toString('base64'), encoding: 'base64',
    });
    expect(dup).toMatchObject({ ok: true, accepted: 4 });
    const conflict = await store.chunk({
      ghostId, stagingId: first.stagingId, seq: 1,
      content: Buffer.from('abce').toString('base64'), encoding: 'base64',
    });
    expect(conflict).toMatchObject({ ok: false, errorCode: 'STREAM_INVALID' });
    const gap = await store.chunk({
      ghostId, stagingId: first.stagingId, seq: 3,
      content: Buffer.from(payload).toString('base64'), encoding: 'base64',
    });
    expect(gap).toMatchObject({ ok: false, errorCode: 'STREAM_INVALID' });

    const commit = await store.commit({ ghostId, stagingId: first.stagingId });
    if (!commit.ok) throw new Error(JSON.stringify(commit));
    const againCommitted = await store.begin({
      ghostId, taskId: 'same-task', sourceRevision: 'rev-1',
      totalBytes: 4, sha256: digest, mime: 'image/png', recovery,
    });
    expect(againCommitted).toEqual({ ok: true, stagingId: first.stagingId });
    const conflictingMeta = await store.begin({
      ghostId, taskId: 'same-task', sourceRevision: 'rev-1',
      totalBytes: 4, sha256: sha256Of('abce'), mime: 'image/png', recovery,
    });
    expect(conflictingMeta).toMatchObject({ ok: false, errorCode: 'ALREADY_EXISTS' });
  });

  it('null owner 与切账号后不得写新文件或读旧数据', async () => {
    const { store, stagingId } = await commitOne();
    scope = null;
    const listed = await store.list({ ghostId });
    expect(listed).toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
    scope = 'local:owner-b:1';
    const crossed = await store.read({ ghostId, stagingId });
    expect(crossed).toMatchObject({ ok: false, errorCode: 'OWNER_CHANGED' });
  });
});
