/**
 * 远程 Agent 执行器的工作区(控制端)。
 *
 * Agent 跑在另一台电脑上，它对本机文件和命令的每个请求都在这里落地。路径一律按本机路径
 * 解析：相对路径以任务工作目录为基准。Agent 所在电脑上的影子目录(只放项目说明类小文件，
 * 让 Agent 照常加载项目说明与 Skill)在这里映射回本机真实目录，模型即使用了影子路径也落在
 * 本机项目里。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSensitiveCredentialPath } from '@cindy/maker-core';

export interface ExecutorPathAlias {
  /** Agent 所在电脑上的影子目录(绝对路径，按该电脑的路径写法)。 */
  from: string;
  /** 对应的本机真实目录。 */
  to: string;
}

export interface ExecutorWorkspaceRoots {
  /** 任务工作目录(本机绝对路径)。 */
  workingDir: string;
  /** 额外允许的目录(任务的附加目录)。 */
  extraDirs?: readonly string[];
  /** 影子目录映射。 */
  aliases?: readonly ExecutorPathAlias[];
}

export class ExecutorPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorPathError';
  }
}

/** 取一个路径的真实路径；不存在时按最近的已存在祖先解析，再拼回剩余部分。 */
export function realPathOrAncestor(target: string): string {
  let current = path.resolve(target);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return rest.length ? path.join(real, ...rest.reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 影子目录前缀匹配：只认完整路径段(`/a/b` 不匹配 `/a/bc`)，不区分分隔符写法。 */
function stripAliasPrefix(input: string, from: string): string | null {
  const normalizedInput = input.replace(/\\/g, '/');
  const normalizedFrom = from.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedFrom) return null;
  const windows = /^[A-Za-z]:|^\/\//.test(normalizedFrom);
  const comparedInput = windows ? normalizedInput.toLowerCase() : normalizedInput;
  const comparedFrom = windows ? normalizedFrom.toLowerCase() : normalizedFrom;
  if (comparedInput === comparedFrom) return '';
  if (comparedInput.startsWith(`${comparedFrom}/`)) return normalizedInput.slice(normalizedFrom.length + 1);
  return null;
}

/** 对已知目录做单次双向投影，最长前缀先匹配，防止替换结果再次被短祖先别名改写。 */
export function projectPathText(text: string, aliases: readonly ExecutorPathAlias[]): string {
  const entries = aliases.filter((alias) => alias.from.replace(/[\\/]+$/, '').length > 2)
    .sort((a, b) => b.from.length - a.from.length);
  if (!entries.length) return text;
  const patterns = entries.map((alias) => alias.from.replace(/[\\/]+$/, '').split(/[\\/]/)
    .map((part) => part.replace(/[.*+?^$()|[\]{}]/g, '\\$&')).join('[/\\\\]'));
  // 左右都要求路径段边界，避免修改 longer/project2 或文本里的同前缀标识符。
  // 这里的边界覆盖 shell 的 ;、反引号、?、& 等分隔符。
  const pattern = new RegExp('(^|[^A-Za-z0-9_])(' + patterns.join('|') + ')(?=$|[^A-Za-z0-9_])([/\\\\][^\\s\\x60;:|&)<>}\\]]*|)', 'gi');
  return text.replace(pattern, (match: string, left: string, prefix: string, suffix: string) => {
    const alias = entries.find((entry) => stripAliasPrefix(prefix, entry.from) === '');
    if (!alias) return match;
    const separator = alias.to.includes('\\') ? '\\' : '/';
    return left + alias.to.replace(/[\\/]+$/, '') + suffix.replace(/[\\/]/g, separator);
  });
}

export class ExecutorWorkspace {
  readonly workingDir: string;
  private roots: string[];
  private extraDirs: string[];
  private aliases: ExecutorPathAlias[];
  private virtualRoot?: string;
  private hostedEnvRoot?: string;
  private hostedHomeDir?: string;

  constructor(roots: ExecutorWorkspaceRoots) {
    if (!path.isAbsolute(roots.workingDir)) throw new ExecutorPathError('working directory must be absolute');
    this.workingDir = path.resolve(roots.workingDir);
    this.extraDirs = [];
    this.roots = [];
    this.aliases = [];
    this.setAliases(roots.aliases ?? []);
    this.setExtraDirs(roots.extraDirs ?? []);
  }

  /** Agent 启动后才知道它那边的影子目录，届时设置。 */
  setAliases(aliases: readonly ExecutorPathAlias[]): void {
    const expanded: ExecutorPathAlias[] = [];
    for (const alias of aliases) {
      if (!alias.from || !path.isAbsolute(alias.to)) continue;
      expanded.push(alias);
      const canonical = realPathOrAncestor(alias.to);
      if (path.resolve(canonical) !== path.resolve(alias.to)) expanded.push({ from: alias.from, to: canonical });
    }
    const seen = new Set<string>();
    this.aliases = expanded
      .filter((alias) => {
        const key = alias.from + '\\0' + path.resolve(alias.to);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => b.from.length - a.from.length);
  }

  setVirtualRoot(root?: string): void {
    this.virtualRoot = root;
  }

  /** 运行中新增的目录分配新的 opaque 别名，撤销授权不撤销路径身份。 */
  virtualizeDirs(dirs: readonly string[]): string[] {
    if (!this.virtualRoot) return [...dirs];
    const native = /^[A-Za-z]:|^\\\\/.test(this.virtualRoot) ? path.win32 : path.posix;
    return dirs.map((dir) => {
      const real = this.resolve(dir);
      const exact = this.aliases.find((alias) => path.resolve(alias.to) === real);
      if (exact) return exact.from;
      const virtual = native.join(this.virtualRoot!, 'additional', 'runtime-' + this.aliases.length);
      this.setAliases([...this.aliases, { from: virtual, to: real }]);
      return virtual;
    });
  }

  /** 任务运行中附加目录变化时更新。 */
  setExtraDirs(extraDirs: readonly string[]): void {
    this.extraDirs = extraDirs.filter((dir) => path.isAbsolute(dir)).map((dir) => path.resolve(dir));
    this.roots = [this.workingDir, ...this.extraDirs].map((dir) => realPathOrAncestor(dir));
  }

  /** 工作目录与附加目录(本机路径，未解析符号链接)。 */
  allRoots(): string[] {
    return [this.workingDir, ...this.extraDirs];
  }

  /** 影子路径映射回本机路径；不是影子路径时原样返回。 */
  mapAlias(input: string): string {
    for (const alias of this.aliases) {
      const rest = stripAliasPrefix(input, alias.from);
      if (rest !== null) return rest ? path.join(alias.to, ...rest.split('/')) : alias.to;
    }
    return input;
  }

  /** 本机真实路径投影到 Agent 主机上的路径；仅匹配完整路径段。 */
  toAgentPath(input: string): string {
    if (!this.virtualRoot) return input;
    const aliases = [...this.aliases].sort((a, b) => b.to.length - a.to.length);
    for (const alias of aliases) {
      const rest = stripAliasPrefix(input, alias.to);
      if (rest === null) continue;
      const native = /^[A-Za-z]:|^\\\\/.test(alias.from) ? path.win32 : path.posix;
      return rest ? native.join(alias.from, ...rest.split('/')) : alias.from;
    }
    return input;
  }

  /** 工具输出、诊断和可逆的 UTF-8 文本内容使用虚拟路径；二进制字节保持原样。 */
  mapTextForAgent(text: string): string {
    if (!this.virtualRoot) return text;
    const aliases = this.aliases.flatMap((alias) => {
      const real = alias.to.replace(/\\/g, '/');
      const entries = [{ from: real, to: alias.from }];
      // Git Bash / MSYS 的 pwd 和诊断使用 /c/...，而 Node 返回 C:\...。
      if (/^[A-Za-z]:\//.test(real)) entries.push({ from: '/' + real[0].toLowerCase() + real.slice(2), to: alias.from });
      if (process.platform === 'win32') {
        const temporary = os.tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
        const relative = stripAliasPrefix(real, temporary);
        if (relative !== null) entries.push({ from: '/tmp' + (relative ? '/' + relative : ''), to: alias.from });
      }
      return entries;
    });
    return projectPathText(text, aliases);
  }

  /** 把 Agent 虚拟路径还原成本机路径，用于文本文件写回。 */
  mapTextFromAgent(text: string): string {
    if (!this.virtualRoot) return text;
    return projectPathText(text, this.aliases.map((alias) => ({
      from: alias.from.replace(/\\/g, '/'),
      to: alias.to,
    })));
  }

  mapOutputForAgent(data: Buffer): Buffer {
    const text = data.toString('utf8');
    // 二进制 stdout 不做 UTF-8 往返，避免 exec.run / process/output 改变原始字节。
    if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) return data;
    const projected = this.mapTextForAgent(text);
    return projected === text ? data : Buffer.from(projected, 'utf8');
  }

  mapInputFromAgent(data: Buffer): Buffer {
    const text = data.toString('utf8');
    if (data.includes(0) || !Buffer.from(text, 'utf8').equals(data)) return data;
    const projected = this.mapTextFromAgent(text);
    return projected === text ? data : Buffer.from(projected, 'utf8');
  }

  /**
   * 为控制端执行器创建隔离环境。只保留运行 shell 所需的通用系统变量；用户目录、临时目录
   * 和凭证类变量都不从 Desktop 进程继承。目录仍在控制端落地，但会注册成虚拟别名，命令的
   * env / printenv 输出再经过 mapOutputForAgent 时只会看到 Agent 侧路径。
   */
  hostedProcessEnv(tempDir: string): NodeJS.ProcessEnv {
    const root = this.hostedEnvRoot ?? path.join(tempDir, 'env', randomUUID());
    if (this.hostedEnvRoot !== root) {
      this.hostedEnvRoot = root;
      fs.mkdirSync(path.join(root, 'home'), { recursive: true });
      fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    }
    const fakeHome = path.join(root, 'home');
    const fakeTemp = path.join(root, 'tmp');
    this.hostedHomeDir = fakeHome;
    this.virtualizeDirs([fakeHome, fakeTemp]);
    const env: NodeJS.ProcessEnv = {};
    const allowed = [
      'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'COMSPEC', 'SystemDrive', 'OS',
      'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
      'NUMBER_OF_PROCESSORS', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'CI',
      'NODE_ENV', 'FORCE_COLOR', 'NO_COLOR',
    ];
    for (const key of allowed) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    const pathValue = process.env.PATH ?? process.env.Path ?? '';
    // PATH 仍保留完整命令搜索能力；每个目录都登记成虚拟别名，printenv/env 的输出会投影回
    // Agent 侧路径。这样用户级 Node/pnpm、Git Bash 等不会因为隔离而失效。
    const pathEntries = pathValue.split(path.delimiter).filter(Boolean);
    if (pathEntries.length) {
      const pathRoot = path.join(root, 'path');
      fs.mkdirSync(pathRoot, { recursive: true });
      const hostedPathEntries: string[] = [];
      for (const [index, target] of pathEntries.entries()) {
        let stat: fs.Stats;
        try {
          stat = fs.statSync(target);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        const link = path.join(pathRoot, `entry-${index}`);
        try {
          if (!fs.existsSync(link)) {
            fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
          }
          hostedPathEntries.push(link);
          // Keep both sides addressable: child env uses the temporary link, while diagnostics such
          // as process.execPath may still report the linked target directory.
          this.virtualizeDirs([target, link]);
        } catch {
          // A PATH entry that cannot be linked is omitted rather than reintroducing a real path.
        }
      }
      if (hostedPathEntries.length) env.PATH = hostedPathEntries.join(path.delimiter);
    }
    env.HOME = fakeHome;
    env.USERPROFILE = fakeHome;
    env.TMP = fakeTemp;
    env.TEMP = fakeTemp;
    env.TMPDIR = fakeTemp;
    env.XDG_CONFIG_HOME = path.join(fakeHome, '.config');
    env.XDG_CACHE_HOME = path.join(fakeHome, '.cache');
    env.APPDATA = path.join(fakeHome, 'AppData', 'Roaming');
    env.LOCALAPPDATA = path.join(fakeHome, 'AppData', 'Local');
    env.USERNAME = 'agent';
    env.USER = 'agent';
    env.LOGNAME = 'agent';
    if (process.platform !== 'win32') env.SHELL = '/bin/bash';
    return env;
  }

  /** 任务结束后移除 fake HOME/TMP 与 PATH 链接，避免临时目录残留。 */
  async cleanupHostedProcessEnv(): Promise<void> {
    const root = this.hostedEnvRoot;
    this.hostedEnvRoot = undefined;
    this.hostedHomeDir = undefined;
    if (!root) return;
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }

  /** 命令文本里出现的影子目录前缀替换成本机目录(按 shell 语法安全引用)。 */
  mapCommand(command: string, dialect: 'bash' | 'cmd' = 'bash'): string {
    const aliases = this.aliases.map((alias) => ({
      from: alias.from,
      to: process.platform === 'win32' ? alias.to.replace(/\\/g, '/') : alias.to,
    })).filter((alias) => alias.from.replace(/[\\/]+$/, '').length > 2)
      .sort((a, b) => b.from.length - a.from.length);
    if (!aliases.length) return command;
    const patterns = aliases.map((alias) => alias.from.replace(/[\\/]+$/, '').split(/[\\/]/)
      .map((part) => part.replace(/[.*+?^$()|[\\]{}]/g, '\\$&')).join('[/\\\\]'));
    const pattern = new RegExp('(^|[^A-Za-z0-9_])(' + patterns.join('|') + ')(?=$|[^A-Za-z0-9_])([/\\\\][^\\s\\x60;:|&)<>}\\]]*|)', 'gi');
    const quoteContext = (input: string, end: number): 'none' | 'single' | 'double' => {
      let quote: 'none' | 'single' | 'double' = 'none';
      let escaped = false;
      for (let i = 0; i < end; i += 1) {
        const char = input[i];
        if (escaped) { escaped = false; continue; }
        if (char === '\\' && quote !== 'single') { escaped = true; continue; }
        if (quote === 'none' && char === "'") quote = 'single';
        else if (quote === 'none' && char === '"') quote = 'double';
        else if (quote === 'single' && char === "'") quote = 'none';
        else if (quote === 'double' && char === '"') quote = 'none';
      }
      return quote;
    };
    const quote = (value: string, context: 'none' | 'single' | 'double'): string => {
      if (dialect === 'cmd') {
        const safe = value.replace(/%/g, '%%');
        return context === 'double' ? safe : /[\s"&|<>^]/.test(safe) ? '"' + safe.replace(/"/g, '\\"') + '"' : safe;
      }
      if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
      if (context === 'single') return value.replace(/'/g, "'\\''");
      if (context === 'double') return value.replace(/[\\$\x60"]/g, '\\$&');
      return /[\s'"\x60$;&|<>()[\\]{}!*?]/.test(value)
        ? "'" + value.replace(/'/g, "'\\''") + "'"
        : value;
    };
    return command.replace(pattern, (match: string, left: string, prefix: string, suffix: string, offset: number, input: string) => {
      const alias = aliases.find((entry) => stripAliasPrefix(prefix, entry.from) === '');
      if (!alias) return match;
      const separator = alias.to.includes('\\') ? '\\' : '/';
      const target = alias.to.replace(/[\\/]+$/, '') + suffix.replace(/[\\/]/g, separator);
      return left + quote(target, quoteContext(input, offset + left.length));
    });
  }

  /** 把 Agent 给的路径解析成本机绝对路径(相对路径以 baseDir / 工作目录为基准)。 */
  resolve(input: string, baseDir = this.workingDir): string {
    if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
      throw new ExecutorPathError('path is empty or invalid');
    }
    const trimmed = input.startsWith('@') ? input.slice(1) : input;
    const expanded = trimmed === '~' || trimmed.startsWith('~/')
      ? path.join(this.hostedHomeDir ?? process.env.HOME ?? '', trimmed.slice(1))
      : trimmed;
    return path.resolve(this.mapAlias(baseDir), this.mapAlias(expanded));
  }

  /** 真实路径是否落在工作目录或附加目录内(防符号链接与 `..` 借道)。 */
  contains(absolutePath: string): boolean {
    const real = realPathOrAncestor(absolutePath);
    return this.roots.some((root) => isInside(real, root));
  }

  /**
   * 凭证类路径(与本机 harness 权限适配器同一份规则)。本机任务对这类路径是「每次都问」，
   * 执行器同样要求本机确认过才放行。
   */
  isSensitive(absolutePath: string): boolean {
    return isSensitiveCredentialPath(absolutePath) || isSensitiveCredentialPath(realPathOrAncestor(absolutePath));
  }
}
