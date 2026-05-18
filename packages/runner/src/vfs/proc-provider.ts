/**
 * /proc virtual provider.
 *
 * Top-level synthetic files:
 * - /proc/uptime    — seconds since VFS creation
 * - /proc/version   — sandbox version string
 * - /proc/cpuinfo   — processor entries
 * - /proc/meminfo   — synthetic memory info
 * - /proc/loadavg   — load averages + running/total + last_pid
 * - /proc/diskstats — VFS storage statistics (JSON)
 * - /proc/mounts    — fstab-style mount table; df/mount/getmntent
 *                    parse this to enumerate filesystems.
 *
 * Per-process directories: `/proc/<pid>/...` for every process the
 * kernel knows about.  The set is queried live via getProcessList,
 * so newly-spawned processes appear without any registration step.
 *   - stat    — Linux scheduler-style single line
 *               (pid, comm, state, ppid, then zeroes)
 *   - status  — multi-line human-readable summary
 *   - cmdline — argv NUL-separated, no trailing NUL (matches Linux)
 *   - comm    — basename of the executable, single line
 */

import { VfsError } from './inode.js';
import type { MountEntry, VirtualProvider } from './provider.js';
import { YURT_VERSION } from '../version.js';

/** Top-level (non-pid) entries served by /proc. */
const PROC_TOP_FILES = new Set([
  'uptime', 'version', 'cpuinfo', 'meminfo', 'loadavg', 'diskstats', 'mounts',
]);

/** Per-pid file names served under /proc/<pid>/. */
const PROC_PID_FILES = new Set(['stat', 'status', 'cmdline', 'comm']);
const PROC_PID_DIRS = new Set(['fd']);

/** /proc/version banner.  Sourced from version.ts so a single bump
 *  flows through to both the host-visible /proc and the guest-side
 *  uname (which reads YURT_VERSION_STR from yurt_abi.h —
 *  scripts/sync-version.sh keeps the two in lockstep). */
const VERSION_STRING = `yurt ${YURT_VERSION} (WASI sandbox)\n`;

export interface StorageStats {
  totalBytes: number;
  limitBytes: number | undefined;
  fileCount: number;
  fileCountLimit: number | undefined;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid?: number;
  sid?: number;
  state: string;
  exit_code: number;
  command: string;
  fds?: number[];
}

/** Parsed /proc subpath: either a top-level file, a pid root, or
 *  a per-pid file. */
type ProcPath =
  | { kind: 'root' }
  | { kind: 'top'; name: string }
  | { kind: 'pid_dir'; pid: number }
  | { kind: 'pid_file'; pid: number; name: string }
  | { kind: 'pid_fd_dir'; pid: number }
  | { kind: 'pid_fd'; pid: number; fd: number }
  | { kind: 'unknown'; subpath: string };

function parseProcSubpath(subpath: string): ProcPath {
  if (subpath === '') return { kind: 'root' };
  const slash = subpath.indexOf('/');
  if (slash === -1) {
    if (PROC_TOP_FILES.has(subpath)) return { kind: 'top', name: subpath };
    if (/^\d+$/.test(subpath)) return { kind: 'pid_dir', pid: parseInt(subpath, 10) };
    return { kind: 'unknown', subpath };
  }
  const head = subpath.slice(0, slash);
  const tail = subpath.slice(slash + 1);
  if (/^\d+$/.test(head)) {
    const pid = parseInt(head, 10);
    if (PROC_PID_FILES.has(tail)) return { kind: 'pid_file', pid, name: tail };
    if (PROC_PID_DIRS.has(tail)) return { kind: 'pid_fd_dir', pid };
    if (tail.startsWith('fd/')) {
      const fd = tail.slice('fd/'.length);
      if (/^\d+$/.test(fd)) return { kind: 'pid_fd', pid, fd: parseInt(fd, 10) };
    }
  }
  return { kind: 'unknown', subpath };
}

export class ProcProvider implements VirtualProvider {
  readonly fsType = 'proc';

  private readonly createdAt: number;
  private readonly getStorageStats?: () => StorageStats;
  private readonly getMountList?: () => MountEntry[];
  private readonly getProcessList?: () => ProcessInfo[];

  constructor(
    getStorageStats?: () => StorageStats,
    getMountList?: () => MountEntry[],
    getProcessList?: () => ProcessInfo[],
  ) {
    this.createdAt = Date.now();
    this.getStorageStats = getStorageStats;
    this.getMountList = getMountList;
    this.getProcessList = getProcessList;
  }

  readFile(subpath: string): Uint8Array {
    return new TextEncoder().encode(this.generateContent(subpath));
  }

  writeFile(subpath: string, _data: Uint8Array): void {
    if (subpath === '') {
      throw new VfsError('EISDIR', 'is a directory: /proc');
    }
    if (this.exists(subpath)) {
      throw new VfsError('EROFS', `read-only file system: /proc/${subpath}`);
    }
    throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
  }

  exists(subpath: string): boolean {
    const p = parseProcSubpath(subpath);
    switch (p.kind) {
      case 'root': return true;
      case 'top': return true;
      case 'pid_dir': return this.findProcess(p.pid) !== undefined;
      case 'pid_file': return this.findProcess(p.pid) !== undefined;
      case 'pid_fd_dir': return this.findProcess(p.pid) !== undefined;
      case 'pid_fd': return this.findProcess(p.pid)?.fds?.includes(p.fd) ?? false;
      case 'unknown': return false;
    }
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    const p = parseProcSubpath(subpath);
    switch (p.kind) {
      case 'root': {
        // Size of a directory is conventionally entry count; not
        // semantically meaningful but stable enough for ls / find.
        const procs = this.getProcessList?.() ?? [];
        return { type: 'dir', size: PROC_TOP_FILES.size + procs.length };
      }
      case 'top': {
        const content = this.generateContent(subpath);
        return { type: 'file', size: new TextEncoder().encode(content).byteLength };
      }
      case 'pid_dir':
        if (!this.findProcess(p.pid)) {
          throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
        }
        return { type: 'dir', size: PROC_PID_FILES.size + PROC_PID_DIRS.size };
      case 'pid_fd_dir': {
        const proc = this.findProcess(p.pid);
        if (!proc) {
          throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
        }
        return { type: 'dir', size: proc.fds?.length ?? 0 };
      }
      case 'pid_file': {
        if (!this.findProcess(p.pid)) {
          throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
        }
        const content = this.generateContent(subpath);
        return { type: 'file', size: new TextEncoder().encode(content).byteLength };
      }
      case 'pid_fd': {
        const proc = this.findProcess(p.pid);
        if (!proc?.fds?.includes(p.fd)) {
          throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
        }
        return { type: 'file', size: 0 };
      }
      case 'unknown':
        throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
    }
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    const p = parseProcSubpath(subpath);
    if (p.kind === 'root') {
      const entries: Array<{ name: string; type: 'file' | 'dir' }> = [];
      for (const name of PROC_TOP_FILES) entries.push({ name, type: 'file' });
      const procs = this.getProcessList?.() ?? [];
      for (const proc of procs) {
        entries.push({ name: String(proc.pid), type: 'dir' });
      }
      return entries;
    }
    if (p.kind === 'pid_dir') {
      if (!this.findProcess(p.pid)) {
        throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
      }
      return [
        ...Array.from(PROC_PID_FILES).map(name => ({ name, type: 'file' as const })),
        ...Array.from(PROC_PID_DIRS).map(name => ({ name, type: 'dir' as const })),
      ];
    }
    if (p.kind === 'pid_fd_dir') {
      const proc = this.findProcess(p.pid);
      if (!proc) {
        throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
      }
      return (proc.fds ?? []).sort((a, b) => a - b).map(fd => ({ name: String(fd), type: 'file' as const }));
    }
    throw new VfsError('ENOTDIR', `not a directory: /proc/${subpath}`);
  }

  private findProcess(pid: number): ProcessInfo | undefined {
    return this.getProcessList?.().find(p => p.pid === pid);
  }

  /** Map kernel state strings to Linux /proc/<pid>/stat single-char
   *  process-state codes.  We don't model stopped/traced/zombie
   *  states distinctly (a zombie is a process that's exited but
   *  not yet reaped — we surface that as 'Z'). */
  private procState(p: ProcessInfo): string {
    if (p.state === 'exited') return 'Z'; // zombie until reaped
    return 'R'; // running (we don't track sleep states)
  }

  /** Extract the program name (the first whitespace-delimited word
   *  of `command`) and truncate to 16 chars to match Linux comm. */
  private procComm(p: ProcessInfo): string {
    const tok = (p.command ?? '').trim().split(/\s+/)[0] ?? '';
    const base = tok.includes('/') ? tok.slice(tok.lastIndexOf('/') + 1) : tok;
    return base.slice(0, 15);
  }

  private generateContent(subpath: string): string {
    const p = parseProcSubpath(subpath);

    // Per-pid files
    if (p.kind === 'pid_file') {
      const proc = this.findProcess(p.pid);
      if (!proc) {
        throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
      }
      switch (p.name) {
        case 'stat': {
          // pid (comm) state ppid pgrp session ...
          // Most fields beyond ppid are irrelevant in the sandbox;
          // emit zeroes so parsers that walk the line don't choke.
          const comm = this.procComm(proc);
          const state = this.procState(proc);
          const ppid = proc.ppid;
          const pgrp = proc.pgid ?? proc.pid;
          const session = proc.sid ?? proc.pid;
          const zeros = Array(40).fill('0').join(' ');
          return `${proc.pid} (${comm}) ${state} ${ppid} ${pgrp} ${session} ${zeros}\n`;
        }
        case 'status': {
          const comm = this.procComm(proc);
          const state = this.procState(proc);
          const stateName = state === 'R' ? 'R (running)' : 'Z (zombie)';
          return (
            `Name:\t${comm}\n` +
            `State:\t${stateName}\n` +
            `Pid:\t${proc.pid}\n` +
            `PPid:\t${proc.ppid}\n` +
            `Uid:\t1000\t1000\t1000\t1000\n` +
            `Gid:\t1000\t1000\t1000\t1000\n` +
            `SigIgn:\t0000000000000000\n` +
            `Threads:\t1\n`
          );
        }
        case 'cmdline':
          // NUL-separated argv, no trailing NUL — matches Linux.
          // The ProcessKernel keeps `command` as a space-joined string
          // (it's what the spawn caller hands in for diagnostic
          // tracking); split on whitespace to recover argv.
          return (proc.command ?? '').trim().split(/\s+/).filter(Boolean).join('\0');
        case 'comm':
          return this.procComm(proc) + '\n';
      }
    }

    // Top-level files
    switch (subpath) {
      case 'uptime': {
        const seconds = (Date.now() - this.createdAt) / 1000;
        return `${seconds.toFixed(2)} ${seconds.toFixed(2)}\n`;
      }
      case 'version':
        return VERSION_STRING;
      case 'cpuinfo': {
        const cpuCount = this.getCpuCount();
        const entries: string[] = [];
        for (let i = 0; i < cpuCount; i++) {
          entries.push(
            `processor\t: ${i}\n` +
            `model name\t: WASI Virtual CPU\n` +
            `cpu MHz\t\t: 0.000\n` +
            ''
          );
        }
        return entries.join('\n');
      }
      case 'meminfo':
        return (
          'MemTotal:       2097152 kB\n' +
          'MemFree:        1048576 kB\n' +
          'MemAvailable:   1572864 kB\n' +
          'Buffers:          65536 kB\n' +
          'Cached:          524288 kB\n'
        );
      case 'loadavg': {
        // Format: "<1m> <5m> <15m> <runnable>/<total> <last_pid>"
        const procs = this.getProcessList?.() ?? [];
        const running = procs.filter(p => p.state === 'running').length;
        const total = procs.length;
        const lastPid = procs.reduce((max, p) => Math.max(max, p.pid), 1);
        return `0.00 0.00 0.00 ${running || 1}/${total || 1} ${lastPid}\n`;
      }
      case 'mounts': {
        // fstab(5) columns: fsname mountpoint fstype options dump pass.
        // Source the mount list from the VFS itself (it owns the
        // provider registry) so user-added mounts via vfs.mount() are
        // visible alongside the built-in /proc and /dev — this is what
        // df, mount(8), and getmntent expect.
        const entries = this.getMountList ? this.getMountList() : [];
        const lines = entries.map(e =>
          `${e.fsname} ${e.mountPath} ${e.fsType} ${e.options} 0 0`
        );
        return lines.length ? lines.join('\n') + '\n' : '';
      }
      case 'diskstats': {
        const stats = this.getStorageStats
          ? this.getStorageStats()
          : { totalBytes: 0, limitBytes: undefined, fileCount: 0, fileCountLimit: undefined };
        return JSON.stringify({
          totalBytes: stats.totalBytes,
          limitBytes: stats.limitBytes ?? 0,
          fileCount: stats.fileCount,
          fileCountLimit: stats.fileCountLimit ?? 0,
        }) + '\n';
      }
      default:
        throw new VfsError('ENOENT', `no such file or directory: /proc/${subpath}`);
    }
  }

  private getCpuCount(): number {
    if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
      return navigator.hardwareConcurrency;
    }
    return 1;
  }
}
