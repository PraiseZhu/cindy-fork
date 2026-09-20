/**
 * Custom Library first-create: mkdir/open/meta stay on a held parent directory
 * fd. Darwin uses a fixed /usr/bin/perl mkdirat/openat helper (SYS_mkdirat=475,
 * SYS_openat=463 from MacOSX.sdk sys/syscall.h). Linux uses /proc/self/fd.
 * Windows and missing helpers fail closed before any mutation. No path mkdir
 * fallback. Segments are fixed/validated names, never concatenated user paths.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';

export type CustomTreeInitResult =
  | { ok: true; createdMeta: boolean }
  | { ok: false; code: 'UNSUPPORTED' | 'IO' | 'INVALID' };

export type CustomExistingMeta = { version: 1; ghostId: string; createdAt: number };
export type CustomExistingUsage = { files: number; bytes: number; updatedAt: number; mutations: number };
export type CustomExistingResult =
  | { ok: true; meta: CustomExistingMeta; usage: CustomExistingUsage | null }
  | { ok: false; code: 'UNSUPPORTED' | 'IO' | 'INVALID' | 'MISSING' | 'CORRUPT' };

const HELPER_TIMEOUT_MS = 15_000;
const SYS_OPENAT = 463;
const SYS_MKDIRAT = 475;
const SYS_FSYNC = 95;

function validSegment(segment: string): boolean {
  return (
    segment.length > 0 &&
    segment.length <= 255 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('\0') &&
    !segment.includes('/') &&
    !segment.includes('\\')
  );
}

const DARWIN_INIT_SCRIPT = String.raw`
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_WRONLY O_CREAT O_EXCL O_DIRECTORY O_NOFOLLOW :mode);
use POSIX qw(write close);
use Errno qw(EEXIST);

use constant SYS_openat => ${SYS_OPENAT};
use constant SYS_mkdirat => ${SYS_MKDIRAT};
use constant SYS_fsync => ${SYS_FSYNC};

sub fail_closed { exit 1; }

sub valid_segment {
  my ($segment) = @_;
  return 0 if !defined($segment) || $segment eq '' || length($segment) > 255;
  return 0 if $segment eq '.' || $segment eq '..';
  return 0 if index($segment, '/') >= 0 || index($segment, "\\") >= 0 || index($segment, "\0") >= 0;
  return 1;
}

sub mkdirat_seg {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $mode = 0700;
  my $rc = syscall(SYS_mkdirat, $parent + 0, $seg, $mode);
  if (!defined($rc) || $rc < 0) {
    fail_closed() unless $! == EEXIST;
  }
}

sub openat_dir {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $flags = O_RDONLY | O_NOFOLLOW | O_DIRECTORY;
  my $fd = syscall(SYS_openat, $parent + 0, $seg, $flags, 0);
  fail_closed() if !defined($fd) || $fd < 0;
  return $fd;
}

my $ghost = $ARGV[0];
fail_closed() unless valid_segment($ghost);
my $meta = $ENV{CINDY_LIBRARY_META_JSON} // '';
fail_closed() unless $meta =~ /^\{"version":1,"ghostId":"[A-Za-z0-9._-]{1,128}","createdAt":[0-9]{1,16}\}$/;

my $parent = fileno(STDIN);
fail_closed() unless defined $parent && $parent >= 0;
my @pst = stat(STDIN);
fail_closed() unless @pst && S_ISDIR($pst[2]);

mkdirat_seg($parent, $ghost);
my $root = openat_dir($parent, $ghost);
mkdirat_seg($root, '.cindy-library');
my $meta_dir = openat_dir($root, '.cindy-library');
mkdirat_seg($meta_dir, 'tmp');
mkdirat_seg($meta_dir, 'backups');

my $flags = O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW;
my $meta_name = 'meta.json';
my $meta_mode = 0600;
my $mfd = syscall(SYS_openat, $meta_dir + 0, $meta_name, $flags, $meta_mode);
my $created = 0;
if (defined($mfd) && $mfd >= 0) {
  $created = 1;
  my $w = POSIX::write($mfd, $meta, length($meta));
  fail_closed() unless defined($w) && $w == length($meta);
  syscall(SYS_fsync, $mfd);
  POSIX::close($mfd);
} else {
  fail_closed() unless $! == EEXIST;
}

POSIX::close($meta_dir);
POSIX::close($root);
print STDOUT ($created ? 'created' : 'exists');
`;

function runDarwinInit(parentFd: number, ghostId: string, metaJson: string): Promise<CustomTreeInitResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/usr/bin/perl', ['-e', DARWIN_INIT_SCRIPT, '--', ghostId], {
        stdio: [parentFd, 'pipe', 'pipe'],
        env: { CINDY_LIBRARY_META_JSON: metaJson },
      });
    } catch {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let settled = false;
    const finish = (value: CustomTreeInitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', () => finish({ ok: false, code: 'UNSUPPORTED' }));
    child.once('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (code === 0 && (text === 'created' || text === 'exists')) {
        finish({ ok: true, createdMeta: text === 'created' });
        return;
      }
      finish({ ok: false, code: 'IO' });
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'IO' });
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
  });
}

function linuxInit(parentFd: number, ghostId: string, metaJson: string): CustomTreeInitResult {
  const opened: number[] = [];
  try {
    const mkdirAt = (dirFd: number, name: string): void => {
      try {
        fs.mkdirSync(`/proc/self/fd/${dirFd}/${name}`, { recursive: false });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    };
    const openDirAt = (dirFd: number, name: string): number => {
      let flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      if (fs.constants.O_DIRECTORY) flags |= fs.constants.O_DIRECTORY;
      const fd = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
      opened.push(fd);
      const st = fs.fstatSync(fd);
      if (!st.isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
      return fd;
    };
    mkdirAt(parentFd, ghostId);
    const rootFd = openDirAt(parentFd, ghostId);
    mkdirAt(rootFd, '.cindy-library');
    const metaDirFd = openDirAt(rootFd, '.cindy-library');
    mkdirAt(metaDirFd, 'tmp');
    mkdirAt(metaDirFd, 'backups');
    let createdMeta = false;
    try {
      const flags =
        fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0);
      const metaFd = fs.openSync(`/proc/self/fd/${metaDirFd}/meta.json`, flags, 0o600);
      opened.push(metaFd);
      fs.writeSync(metaFd, metaJson);
      fs.fsyncSync(metaFd);
      createdMeta = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return { ok: true, createdMeta };
  } catch {
    return { ok: false, code: 'IO' };
  } finally {
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* always close helper fds */
      }
    }
  }
}

export async function initCustomLibraryTree(req: {
  parentFd: number;
  ghostId: string;
  metaJson: string;
}): Promise<CustomTreeInitResult> {
  if (!validSegment(req.ghostId) || !Number.isInteger(req.parentFd) || req.parentFd < 0) {
    return { ok: false, code: 'INVALID' };
  }
  if (!/^\{"version":1,"ghostId":"[A-Za-z0-9._-]{1,128}","createdAt":[0-9]{1,16}\}$/.test(req.metaJson)) {
    return { ok: false, code: 'INVALID' };
  }
  if (process.platform === 'darwin') return runDarwinInit(req.parentFd, req.ghostId, req.metaJson);
  if (process.platform === 'linux') return linuxInit(req.parentFd, req.ghostId, req.metaJson);
  return { ok: false, code: 'UNSUPPORTED' };
}

const DARWIN_OPEN_EXISTING_SCRIPT = String.raw`
use strict;
use warnings;
use Fcntl qw(O_RDONLY O_DIRECTORY O_NOFOLLOW :mode);
use POSIX qw(read close);

use constant SYS_openat => ${SYS_OPENAT};

sub fail_closed { exit 1; }
sub missing { print STDOUT 'MISSING'; exit 0; }

sub valid_segment {
  my ($segment) = @_;
  return 0 if !defined($segment) || $segment eq '' || length($segment) > 255;
  return 0 if $segment eq '.' || $segment eq '..';
  return 0 if index($segment, '/') >= 0 || index($segment, "\\") >= 0 || index($segment, "\0") >= 0;
  return 1;
}

sub openat_dir {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $flags = O_RDONLY | O_NOFOLLOW | O_DIRECTORY;
  my $fd = syscall(SYS_openat, $parent + 0, $seg, $flags, 0);
  missing() if !defined($fd) || $fd < 0;
  return $fd;
}

sub openat_file {
  my ($parent, $name) = @_;
  fail_closed() unless valid_segment($name);
  my $seg = "$name";
  my $flags = O_RDONLY | O_NOFOLLOW;
  my $fd = syscall(SYS_openat, $parent + 0, $seg, $flags, 0);
  return undef if !defined($fd) || $fd < 0;
  return $fd;
}

sub read_all {
  my ($fd) = @_;
  my $buf = '';
  while (1) {
    my $chunk = '';
    my $n = POSIX::read($fd, $chunk, 8192);
    last if !defined($n) || $n == 0;
    $buf .= $chunk;
  }
  return $buf;
}

my $ghost = $ARGV[0];
fail_closed() unless valid_segment($ghost);
my $parent = fileno(STDIN);
fail_closed() unless defined $parent && $parent >= 0;
my @pst = stat(STDIN);
fail_closed() unless @pst && S_ISDIR($pst[2]);

my $root = openat_dir($parent, $ghost);
my $meta_dir = openat_dir($root, '.cindy-library');
openat_dir($meta_dir, 'tmp');
openat_dir($meta_dir, 'backups');
my $mfd = openat_file($meta_dir, 'meta.json');
missing() unless defined $mfd;
my $meta_raw = read_all($mfd);
POSIX::close($mfd);
my $ufd = openat_file($meta_dir, 'usage.json');
my $usage_raw = '';
if (defined $ufd) {
  $usage_raw = read_all($ufd);
  POSIX::close($ufd);
}
POSIX::close($meta_dir);
POSIX::close($root);
print STDOUT "OK\n$meta_raw\n";
print STDOUT $usage_raw;
`;

function parseExistingStdout(text: string): CustomExistingResult {
  if (text === 'MISSING') return { ok: false, code: 'MISSING' };
  if (!text.startsWith('OK\n')) return { ok: false, code: 'IO' };
  const rest = text.slice(3);
  const nl = rest.indexOf('\n');
  const metaRaw = nl === -1 ? rest : rest.slice(0, nl);
  const usageRaw = nl === -1 ? '' : rest.slice(nl + 1);
  let meta: CustomExistingMeta;
  try {
    const parsed = JSON.parse(metaRaw) as CustomExistingMeta;
    if (
      typeof parsed !== 'object' || parsed === null || parsed.version !== 1 ||
      typeof parsed.ghostId !== 'string' || typeof parsed.createdAt !== 'number'
    ) {
      return { ok: false, code: 'CORRUPT' };
    }
    meta = parsed;
  } catch {
    return { ok: false, code: 'CORRUPT' };
  }
  let usage: CustomExistingUsage | null = null;
  if (usageRaw.trim()) {
    try {
      const parsed = JSON.parse(usageRaw) as CustomExistingUsage;
      if (
        typeof parsed === 'object' && parsed !== null &&
        typeof parsed.files === 'number' && typeof parsed.bytes === 'number'
      ) {
        usage = {
          files: parsed.files,
          bytes: parsed.bytes,
          updatedAt: parsed.updatedAt ?? 0,
          mutations: parsed.mutations ?? 0,
        };
      }
    } catch {
      usage = null;
    }
  }
  return { ok: true, meta, usage };
}

function runDarwinOpenExisting(parentFd: number, ghostId: string): Promise<CustomExistingResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn('/usr/bin/perl', ['-e', DARWIN_OPEN_EXISTING_SCRIPT, '--', ghostId], {
        stdio: [parentFd, 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin' },
      });
    } catch {
      resolve({ ok: false, code: 'UNSUPPORTED' });
      return;
    }
    let settled = false;
    const finish = (value: CustomExistingResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const chunks: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.once('error', () => finish({ ok: false, code: 'UNSUPPORTED' }));
    child.once('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (code !== 0) {
        finish({ ok: false, code: text === 'MISSING' ? 'MISSING' : 'IO' });
        return;
      }
      finish(parseExistingStdout(text));
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, code: 'IO' });
    }, HELPER_TIMEOUT_MS);
    timer.unref?.();
  });
}

function linuxOpenExisting(parentFd: number, ghostId: string): CustomExistingResult {
  const opened: number[] = [];
  try {
    const openDirAt = (dirFd: number, name: string): number => {
      let flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
      if (fs.constants.O_DIRECTORY) flags |= fs.constants.O_DIRECTORY;
      const fd = fs.openSync(`/proc/self/fd/${dirFd}/${name}`, flags);
      opened.push(fd);
      if (!fs.fstatSync(fd).isDirectory()) throw Object.assign(new Error('not dir'), { code: 'ENOTDIR' });
      return fd;
    };
    const rootFd = openDirAt(parentFd, ghostId);
    const metaDirFd = openDirAt(rootFd, '.cindy-library');
    openDirAt(metaDirFd, 'tmp');
    openDirAt(metaDirFd, 'backups');
    const metaFd = fs.openSync(`/proc/self/fd/${metaDirFd}/meta.json`, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    opened.push(metaFd);
    const metaRaw = fs.readFileSync(metaFd, 'utf8');
    let usageRaw = '';
    try {
      const usageFd = fs.openSync(`/proc/self/fd/${metaDirFd}/usage.json`, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      opened.push(usageFd);
      usageRaw = fs.readFileSync(usageFd, 'utf8');
    } catch {
      usageRaw = '';
    }
    return parseExistingStdout(`OK\n${metaRaw}\n${usageRaw}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'MISSING' };
    return { ok: false, code: 'IO' };
  } finally {
    for (const fd of opened.reverse()) {
      try {
        fs.closeSync(fd);
      } catch {
        /* always close */
      }
    }
  }
}

/** Read an already-initialized custom library from the held parent fd. Never mkdir. */
export async function openExistingCustomLibrary(req: {
  parentFd: number;
  ghostId: string;
}): Promise<CustomExistingResult> {
  if (!validSegment(req.ghostId) || !Number.isInteger(req.parentFd) || req.parentFd < 0) {
    return { ok: false, code: 'INVALID' };
  }
  if (process.platform === 'darwin') return runDarwinOpenExisting(req.parentFd, req.ghostId);
  if (process.platform === 'linux') return linuxOpenExisting(req.parentFd, req.ghostId);
  return { ok: false, code: 'UNSUPPORTED' };
}
