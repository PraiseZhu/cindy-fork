/**
 * libraryLegacyReattach.ts — 把裸 id 下遗留的旧作品库换回当前实例。
 * ---------------------------------------------------------------------------
 * namespace 实例键上线后，旧安装卸载再从企业市场重装，会得到新实例键和一个
 * 新的空库，旧库留在裸 id 下没人认领。用户在设置页确认后，这里只换作品库，
 * 插件安装、设置与私有数据都不动：
 *
 *   1. 当前实例的新库（及暂存区）移入作品库回收站（保留 30 天）；
 *   2. 旧库改名到当前实例键（自定义位置由 binding store 搬，它自带日志）；
 *   3. 改旧库与暂存区里记录的身份。
 *
 * 动手前先写日志，每一步都可以重跑：中途崩溃后，下次打开作品库前按日志做完。
 * 纯 Node + 依赖注入，单测拿 tmpdir 直测。
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

export interface LegacyLibraryReattachJournal {
  version: 1;
  /** 旧库所在的裸 id。 */
  fromId: string;
  /** 当前实例键。 */
  toId: string;
  oldLocation: 'default' | 'custom';
  /** 动手前当前实例新库的目录身份；只有身份仍一致的目录才会被移入回收站。 */
  newLibrary: DirectoryIdentity | null;
  newStaging: DirectoryIdentity | null;
  trashName: string;
}

export interface LegacyLibraryReattachDeps {
  journalFile(): string;
  defaultRoot(id: string): string;
  stagingRoot(id: string): string;
  trashRoot(): string;
  /** 自定义位置：把 binding 与目录一起从 fromId 搬到 toId（重跑时无记录即返回）。 */
  relocateCustomBinding(fromId: string, toId: string): Promise<void>;
  /** 自定义位置下 toId 的库根；没有 binding 时返回 null。 */
  customRoot(id: string): Promise<string | null>;
  relocateMeta(root: string, fromId: string, toId: string): Promise<void>;
  relocateStaging(root: string, fromId: string, toId: string): Promise<void>;
  assertCurrent(): void;
}

async function directoryIdentity(dir: string): Promise<DirectoryIdentity | null> {
  try {
    const stat = await fs.promises.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`not a real directory: ${dir}`);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function isIdentity(value: unknown): value is DirectoryIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as Partial<DirectoryIdentity>;
  return typeof identity.dev === 'number' && typeof identity.ino === 'number';
}

function isJournal(value: unknown): value is LegacyLibraryReattachJournal {
  if (!value || typeof value !== 'object') return false;
  const journal = value as Partial<LegacyLibraryReattachJournal>;
  return journal.version === 1 &&
    typeof journal.fromId === 'string' && typeof journal.toId === 'string' &&
    journal.fromId !== journal.toId &&
    (journal.oldLocation === 'default' || journal.oldLocation === 'custom') &&
    (journal.newLibrary === null || isIdentity(journal.newLibrary)) &&
    (journal.newStaging === null || isIdentity(journal.newStaging)) &&
    typeof journal.trashName === 'string' && /^[A-Za-z0-9_.-]+$/.test(journal.trashName);
}

export async function readLegacyLibraryReattachJournal(
  file: string,
): Promise<LegacyLibraryReattachJournal | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isJournal(parsed)) throw new Error('library reattach journal is invalid');
  return parsed;
}

async function writeJournal(file: string, journal: LegacyLibraryReattachJournal): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.promises.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(journal), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.promises.rename(temporary, file);
}

/** 记下要换的两边，然后执行。日志已存在时拒绝开始新的一次。 */
export async function startLegacyLibraryReattach(
  input: { fromId: string; toId: string; oldLocation: 'default' | 'custom'; now: number },
  deps: LegacyLibraryReattachDeps,
): Promise<void> {
  if (await readLegacyLibraryReattachJournal(deps.journalFile())) {
    throw new Error('another library reattach is unfinished');
  }
  deps.assertCurrent();
  const journal: LegacyLibraryReattachJournal = {
    version: 1,
    fromId: input.fromId,
    toId: input.toId,
    oldLocation: input.oldLocation,
    newLibrary: await directoryIdentity(deps.defaultRoot(input.toId)),
    newStaging: await directoryIdentity(deps.stagingRoot(input.toId)),
    trashName: `${input.toId}-${input.now}-replaced`,
  };
  deps.assertCurrent();
  await writeJournal(deps.journalFile(), journal);
  await finishLegacyLibraryReattach(journal, deps);
}

/** 只把仍是那个新库的目录移入回收站；已移走或换成别的目录都不动。 */
async function trashIfSame(dir: string, identity: DirectoryIdentity | null, target: string): Promise<void> {
  if (identity === null) return;
  if (!isDeepStrictEqual(await directoryIdentity(dir), identity)) return;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.rename(dir, target);
}

async function moveIfFree(fromDir: string, toDir: string): Promise<void> {
  if (await directoryIdentity(fromDir) === null) return;
  if (await directoryIdentity(toDir) !== null) {
    throw new Error(`library reattach destination already exists: ${toDir}`);
  }
  await fs.promises.rename(fromDir, toDir);
}

/** 按日志做完剩下的步骤；每一步重跑都安全。 */
export async function finishLegacyLibraryReattach(
  journal: LegacyLibraryReattachJournal,
  deps: LegacyLibraryReattachDeps,
): Promise<void> {
  const { fromId, toId } = journal;
  const trash = path.join(deps.trashRoot(), journal.trashName);
  deps.assertCurrent();
  await trashIfSame(deps.defaultRoot(toId), journal.newLibrary, trash);
  deps.assertCurrent();
  await trashIfSame(deps.stagingRoot(toId), journal.newStaging, `${trash}-staging`);
  deps.assertCurrent();
  if (journal.oldLocation === 'custom') {
    await deps.relocateCustomBinding(fromId, toId);
  } else {
    await moveIfFree(deps.defaultRoot(fromId), deps.defaultRoot(toId));
  }
  deps.assertCurrent();
  await moveIfFree(deps.stagingRoot(fromId), deps.stagingRoot(toId));
  deps.assertCurrent();
  const root = journal.oldLocation === 'custom' ? await deps.customRoot(toId) : deps.defaultRoot(toId);
  if (root === null) throw new Error('reattached custom library root is unavailable');
  await deps.relocateMeta(root, fromId, toId);
  deps.assertCurrent();
  await deps.relocateStaging(deps.stagingRoot(toId), fromId, toId);
  deps.assertCurrent();
  await fs.promises.rm(deps.journalFile(), { force: true });
}
