/// <reference path="../jspi.d.ts" />
/**
 * WASI Preview 1 host implementation backed by VFS.
 *
 * Implements the ~40 wasi_snapshot_preview1 import functions that WASI
 * binaries expect. Each function reads/writes from WebAssembly linear
 * memory via DataView and delegates to the VFS and FdTable.
 */

import { FdTable } from "../vfs/fd-table.js";
import type { OpenMode, SeekWhence } from "../vfs/fd-table.js";
import { KERNEL_FD_BASE, type ProcessKernel } from "../process/kernel.ts";
import { VfsError } from "../vfs/inode.js";
import type { InodeType } from "../vfs/inode.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import type { ListenerRegistry } from "../network/listener-registry.js";
import { fdErrorToWasi, vfsErrnoToWasi } from "./errors.js";
import type { FdTarget } from "./fd-target.js";
import {
  bufferToString,
  createBufferTarget,
  createNullTarget,
  createStaticTarget,
  createTtySlaveTarget,
  createVfsDirTarget,
  createVfsFileTarget,
} from "./fd-target.js";
import {
  WASI_CLOCK_MONOTONIC,
  WASI_CLOCK_REALTIME,
  WASI_EAGAIN,
  WASI_EBADF,
  WASI_EEXIST,
  WASI_EINVAL,
  WASI_EIO,
  WASI_EMFILE,
  WASI_ENOENT,
  WASI_ENOSYS,
  WASI_ENOTSOCK,
  WASI_ENOTSUP,
  WASI_EPIPE,
  WASI_ESUCCESS,
  WASI_EVENTRWFLAGS_FD_READWRITE_HANGUP,
  WASI_EVENTTYPE_CLOCK,
  WASI_EVENTTYPE_FD_READ,
  WASI_EVENTTYPE_FD_WRITE,
  WASI_FDFLAGS_APPEND,
  WASI_FDFLAGS_NONBLOCK,
  WASI_FILETYPE_CHARACTER_DEVICE,
  WASI_FILETYPE_DIRECTORY,
  WASI_FILETYPE_REGULAR_FILE,
  WASI_FILETYPE_SOCKET_STREAM,
  WASI_FILETYPE_SYMBOLIC_LINK,
  WASI_FSTFLAGS_ATIM,
  WASI_FSTFLAGS_ATIM_NOW,
  WASI_FSTFLAGS_MTIM,
  WASI_FSTFLAGS_MTIM_NOW,
  WASI_OFLAGS_CREAT,
  WASI_OFLAGS_DIRECTORY,
  WASI_OFLAGS_EXCL,
  WASI_OFLAGS_TRUNC,
  WASI_PREOPENTYPE_DIR,
  WASI_RIGHTS_ALL,
  WASI_RIGHTS_FD_READ,
  WASI_RIGHTS_FD_WRITE,
  WASI_SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
  WASI_WHENCE_CUR,
  WASI_WHENCE_END,
  WASI_WHENCE_SET,
} from "./types.js";

const SIGPIPE = 13;
const YURT_STAT_MODE_BITS = 16n;
const YURT_STAT_UID_BITS = 24n;
const YURT_STAT_MODE_MASK = (1n << YURT_STAT_MODE_BITS) - 1n;
const YURT_STAT_ID_MASK = (1n << YURT_STAT_UID_BITS) - 1n;

function closeFdTarget(target: FdTarget): void {
  if (target.type === "pipe_write") target.pipe.close();
  if (target.type === "pipe_read") target.pipe.close();
  if (target.type === "vfs_file") {
    if (target.fdTable.isOpen(target.fd)) target.fdTable.close(target.fd);
    target.refs = Math.max(0, target.refs - 1);
  }
  if (target.type === "socket") {
    target.refs--;
    if (target.refs <= 0) {
      if (target.listener != null && target.closeListener) {
        target.closeListener(target.listener);
        target.listener = null;
      }
      if (target.socket !== null) {
        target.close(target.socket);
        target.socket = null;
      }
    }
  }
  if (target.type === "tty_master") {
    target.state.masterClosed = true;
    for (const waiter of target.state.toSlaveWaiters.splice(0)) waiter();
  }
}

function retainFdTarget(target: FdTarget): void {
  if (target.type === "pipe_write") target.pipe.addRef();
  if (target.type === "pipe_read") target.pipe.addRef();
  if (target.type === "vfs_file") {
    target.fdTable.retain(target.fd);
    target.refs++;
  }
  if (target.type === "socket") target.refs++;
}

function stablePathInode(path: string): bigint {
  let hash = BigInt("0xcbf29ce484222325");
  const prime = BigInt("0x100000001b3");
  const mask = BigInt("0xffffffffffffffff");
  for (let i = 0; i < path.length; i++) {
    hash ^= BigInt(path.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash === BigInt(0) ? BigInt(1) : hash;
}

function yurtStatDevice(
  stat: { permissions: number; uid: number; gid: number },
): bigint {
  const mode = BigInt(stat.permissions & 0xffff);
  const uid = BigInt(stat.uid >>> 0) & YURT_STAT_ID_MASK;
  const gid = BigInt(stat.gid >>> 0) & YURT_STAT_ID_MASK;
  return mode | (uid << YURT_STAT_MODE_BITS) |
    (gid << (YURT_STAT_MODE_BITS + YURT_STAT_UID_BITS));
}

function wasiTimestampToDate(timestamp: bigint): Date {
  return new Date(Number(timestamp / BigInt(1_000_000)));
}

function dirnameOfVfsPath(path: string): string {
  const normalized = normalizeVfsPath(path);
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

function splitVfsPath(path: string): string[] {
  const normalized = normalizeVfsPath(path);
  return normalized === "/" ? [] : normalized.slice(1).split("/");
}

function canonicalStatPath(vfs: VfsLike, absPath: string): string {
  let queue = splitVfsPath(absPath);
  const resolved: string[] = [];
  let symlinkDepth = 0;

  while (queue.length > 0) {
    const part = queue.shift()!;
    const candidate = "/" + [...resolved, part].join("/");
    const stat = vfs.lstat(candidate);
    if (stat.type !== "symlink") {
      resolved.push(part);
      continue;
    }
    if (++symlinkDepth > 40) throw new Error("ELOOP: too many symlink levels");
    const target = vfs.readlink(candidate);
    const targetPath = target.startsWith("/")
      ? target
      : `${dirnameOfVfsPath(candidate)}/${target}`;
    queue = [...splitVfsPath(targetPath), ...queue];
    resolved.length = 0;
  }

  const canonical = "/" + resolved.join("/");
  vfs.stat(canonical);
  return canonical === "" ? "/" : canonical;
}

export class WasiExitError extends Error {
  code: number;

  constructor(code: number) {
    super(`WASI exit: ${code}`);
    this.name = "WasiExitError";
    this.code = code;
  }
}

export interface WasiHostOptions {
  vfs: VfsLike;
  args: string[];
  env: Record<string, string>;
  preopens: Record<string, string>;
  cwd?: string;
  stdin?: Uint8Array;
  stdoutLimit?: number;
  stderrLimit?: number;
  deadlineMs?: number;
  /** Per-fd I/O targets. If provided, overrides stdin/stdoutLimit/stderrLimit. */
  ioFds?: Map<number, FdTarget>;
  /** Optional process kernel for WASI fd_close over kernel-managed descriptors. */
  kernel?: ProcessKernel;
  pid?: number;
  /**
   * Allow pipe reads to return a Promise when the current module has a
   * suspension mechanism. JSPI makes this true for every module; without JSPI,
   * the loader enables it for modules that are Asyncify-instrumented.
   */
  canSuspendPipeReads?: boolean;
  /**
   * Optional listener registry. When provided, unlinking a socket inode
   * automatically closes the corresponding AF_UNIX path listener so that
   * subsequent connect() attempts fail as expected.
   */
  socketRegistry?: ListenerRegistry;
}

export interface PreopenEntry {
  vfsPath: string;
  label: string;
  fd: number;
}

export interface WasiHostForkSnapshot {
  fdTable: FdTable;
  dirFds: Map<number, string>;
  preopens: PreopenEntry[];
  cwd: string;
  canSuspendPipeReads: boolean;
  nextDirFdCounter: number;
}

function bytesToBase64(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.byteLength; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Decode an iovec array from Wasm linear memory.
 * Each iovec is 8 bytes: u32 buf_ptr + u32 buf_len.
 */
function readIovecs(
  view: DataView,
  ptr: number,
  count: number,
): Array<{ buf: number; len: number }> {
  const iovecs: Array<{ buf: number; len: number }> = [];
  for (let i = 0; i < count; i++) {
    iovecs.push({
      buf: view.getUint32(ptr + i * 8, true),
      len: view.getUint32(ptr + i * 8 + 4, true),
    });
  }
  return iovecs;
}

function inodeTypeToWasiFiletype(type: InodeType): number {
  switch (type) {
    case "file":
      return WASI_FILETYPE_REGULAR_FILE;
    case "dir":
      return WASI_FILETYPE_DIRECTORY;
    case "symlink":
      return WASI_FILETYPE_SYMBOLIC_LINK;
    case "char":
      return WASI_FILETYPE_CHARACTER_DEVICE;
    case "socket":
      return WASI_FILETYPE_SOCKET_STREAM;
    default:
      return 0;
  }
}

function wasiWhenceToVfs(whence: number): SeekWhence {
  switch (whence) {
    case WASI_WHENCE_SET:
      return "set";
    case WASI_WHENCE_CUR:
      return "cur";
    case WASI_WHENCE_END:
      return "end";
    default:
      return "set";
  }
}

function normalizeVfsPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function joinVfsPath(base: string, relativePath: string): string {
  if (relativePath.startsWith("/")) {
    return normalizeVfsPath(relativePath);
  }
  if (relativePath === "" || relativePath === ".") {
    return base;
  }
  return normalizeVfsPath(
    base === "/" ? `/${relativePath}` : `${base}/${relativePath}`,
  );
}

function parentPath(path: string): string {
  const normalized = normalizeVfsPath(path);
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

export class WasiHost {
  private vfs: VfsLike;
  private fdTable: FdTable;
  private args: string[];
  private envPairs: string[];
  private cwd: string;
  private preopens: PreopenEntry[];
  private memory: WebAssembly.Memory | null = null;
  private exitCode: number | null = null;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  /** Map from fd number to the directory path it represents (for preopens + opened dirs). */
  private dirFds: Map<number, string> = new Map();

  /** Per-fd I/O targets (stdin=0, stdout=1, stderr=2, or any custom fd). */
  private ioFds: Map<number, FdTarget>;

  private cancelled = false;
  private cancelSignal: number | null = null;
  private deadlineMs: number = Infinity;
  private kernel?: ProcessKernel;
  private pid?: number;
  private canSuspendPipeReads = false;
  private socketRegistry?: ListenerRegistry;
  private signalDeliverer: ((sig: number) => void) | null = null;
  private pendingSignals: number[] = [];
  private signalWaiters: Array<() => void> = [];
  private drainingSignals = false;

  constructor(options: WasiHostOptions) {
    this.vfs = options.vfs;
    this.fdTable = new FdTable(options.vfs);
    this.args = options.args;
    this.envPairs = Object.entries(options.env).map(
      ([k, v]) => `${k}=${v}`,
    );
    this.cwd = normalizeVfsPath(options.cwd ?? "/");
    this.deadlineMs = options.deadlineMs ?? Infinity;
    this.kernel = options.kernel;
    this.pid = options.pid;
    this.canSuspendPipeReads = options.canSuspendPipeReads ?? false;
    this.socketRegistry = options.socketRegistry;
    this.preopens = [];

    // Build I/O fd table: use provided ioFds or build from legacy options.
    if (options.ioFds) {
      this.ioFds = options.ioFds;
    } else {
      this.ioFds = new Map<number, FdTarget>();
      // fd 0 — stdin
      if (options.stdin) {
        this.ioFds.set(0, createStaticTarget(options.stdin));
      } else {
        this.ioFds.set(0, createNullTarget());
      }
      // fd 1 — stdout
      this.ioFds.set(1, createBufferTarget(options.stdoutLimit ?? Infinity));
      // fd 2 — stderr
      this.ioFds.set(2, createBufferTarget(options.stderrLimit ?? Infinity));
    }

    // Set up preopened directories starting at fd 3.
    // We must also reserve these fd numbers in the FdTable so it
    // doesn't allocate them for regular file opens. We do this by
    // opening a sentinel file for each preopen slot and immediately
    // recording the fd. The sentinel file is never read/written.
    const sentinelPath = "/.wasi-preopen-sentinel";
    this.vfs.withWriteAccess(() => {
      this.vfs.writeFile(sentinelPath, new Uint8Array(0));

      for (const [vfsPath, label] of Object.entries(options.preopens)) {
        const fd = this.fdTable.open(sentinelPath, "r");
        this.preopens.push({ vfsPath, label, fd });
        this.dirFds.set(fd, vfsPath);
        if (this.kernel && this.pid !== undefined) {
          this.kernel.setFdTarget(this.pid, fd, createVfsDirTarget(vfsPath));
        }
      }

      this.vfs.unlink(sentinelPath);
    });
  }

  setMemory(memory: WebAssembly.Memory): void {
    this.memory = memory;
  }

  getCwd(): string {
    return this.cwd;
  }

  setCwd(cwd: string): void {
    this.cwd = normalizeVfsPath(cwd);
  }

  getDirectoryFdPath(fd: number): string | null {
    return this.dirFds.get(fd) ?? null;
  }

  isPreopenFd(fd: number): boolean {
    return this.preopens.some((entry) => entry.fd === fd);
  }

  duplicateFdTo(
    srcFd: number,
    dstFd: number,
    includeIo = true,
  ): FdTarget | null {
    if (srcFd === dstFd) {
      const kernelTarget = this.kernelFdTarget(srcFd);
      if (kernelTarget) return kernelTarget;
      if (this.fdTable.isOpen(srcFd)) {
        return createVfsFileTarget(this.fdTable, srcFd);
      }
      const dirPath = this.dirFds.get(srcFd);
      if (dirPath !== undefined) return createVfsDirTarget(dirPath);
      return includeIo ? this.ioFds.get(srcFd) ?? null : null;
    }

    if (
      this.kernel && this.pid !== undefined &&
      this.kernel.getFdTarget(this.pid, srcFd)
    ) {
      try {
        this.kernel.dup2(this.pid, srcFd, dstFd);
        if (this.dirFds.has(srcFd)) {
          this.dirFds.set(dstFd, this.dirFds.get(srcFd)!);
        } else this.dirFds.delete(dstFd);
        return this.kernel.getFdTarget(this.pid, dstFd);
      } catch {
        return null;
      }
    }

    if (this.fdTable.isOpen(srcFd)) {
      if (!this.isPreopenFd(dstFd)) this.dirFds.delete(dstFd);
      const oldIoTarget = this.ioFds.get(dstFd);
      if (oldIoTarget) closeFdTarget(oldIoTarget);
      this.ioFds.delete(dstFd);
      this.fdTable.dupToShared(srcFd, dstFd);
      return createVfsFileTarget(this.fdTable, dstFd);
    }

    const dirPath = this.dirFds.get(srcFd);
    if (dirPath !== undefined) {
      const oldIoTarget = this.ioFds.get(dstFd);
      if (oldIoTarget) closeFdTarget(oldIoTarget);
      this.ioFds.delete(dstFd);
      if (this.fdTable.isOpen(dstFd)) {
        try {
          this.fdTable.close(dstFd);
        } catch { /* ignore */ }
      }
      this.dirFds.set(dstFd, dirPath);
      return createVfsDirTarget(dirPath);
    }

    const ioTarget = includeIo ? this.ioFds.get(srcFd) : undefined;
    if (ioTarget) {
      this.dirFds.delete(dstFd);
      if (this.fdTable.isOpen(dstFd)) {
        try {
          this.fdTable.close(dstFd);
        } catch { /* ignore */ }
      }
      const oldIoTarget = this.ioFds.get(dstFd);
      if (oldIoTarget && oldIoTarget !== ioTarget) closeFdTarget(oldIoTarget);
      retainFdTarget(ioTarget);
      this.ioFds.set(dstFd, ioTarget);
      return ioTarget;
    }

    return null;
  }

  duplicateFdMin(
    srcFd: number,
    minFd: number,
    includeIo = true,
  ): number | null {
    if (minFd < 0) return null;
    if (
      this.kernel && this.pid !== undefined &&
      this.kernel.getFdTarget(this.pid, srcFd)
    ) {
      try {
        const newFd = this.kernel.dupMin(this.pid, srcFd, minFd);
        const dirPath = this.dirFds.get(srcFd);
        if (dirPath !== undefined) this.dirFds.set(newFd, dirPath);
        return newFd;
      } catch {
        return null;
      }
    }
    const hasSource = this.fdTable.isOpen(srcFd) ||
      this.dirFds.has(srcFd) ||
      (includeIo && this.ioFds.has(srcFd));
    if (!hasSource) return null;

    let dstFd = minFd;
    while (
      this.fdTable.isOpen(dstFd) ||
      this.dirFds.has(dstFd) ||
      this.ioFds.has(dstFd)
    ) {
      dstFd++;
    }

    return this.duplicateFdTo(srcFd, dstFd, includeIo) ? dstFd : null;
  }

  getStdout(): string {
    const target = this.ioFds.get(1);
    if (target?.type === "buffer") return bufferToString(target);
    return "";
  }

  getStderr(): string {
    const target = this.ioFds.get(2);
    if (target?.type === "buffer") return bufferToString(target);
    return "";
  }

  isStdoutTruncated(): boolean {
    const target = this.ioFds.get(1);
    if (target?.type === "buffer") return target.truncated;
    return false;
  }

  isStderrTruncated(): boolean {
    const target = this.ioFds.get(2);
    if (target?.type === "buffer") return target.truncated;
    return false;
  }

  /** Reset stdout and stderr buffer targets for per-command output capture. */
  resetOutputBuffers(): void {
    const stdout = this.ioFds.get(1);
    if (stdout?.type === "buffer") {
      stdout.buf.length = 0;
      stdout.total = 0;
      stdout.truncated = false;
    }
    const stderr = this.ioFds.get(2);
    if (stderr?.type === "buffer") {
      stderr.buf.length = 0;
      stderr.total = 0;
      stderr.truncated = false;
    }
  }

  /** Expose the I/O fd table for external inspection / manipulation. */
  getIoFds(): Map<number, FdTarget> {
    return this.ioFds;
  }

  private kernelFdTarget(fd: number): FdTarget | null {
    return this.kernel && this.pid !== undefined
      ? this.kernel.getFdTarget(this.pid, fd)
      : null;
  }

  private fdTarget(fd: number): FdTarget | undefined {
    return this.kernelFdTarget(fd) ?? this.ioFds.get(fd);
  }

  private hasKernelFd(fd: number): boolean {
    return this.kernelFdTarget(fd) !== null;
  }

  private hasOpenFd(fd: number): boolean {
    return this.hasKernelFd(fd) || this.ioFds.has(fd) ||
      this.dirFds.has(fd) || this.fdTable.isOpen(fd);
  }

  snapshotForFork(): WasiHostForkSnapshot {
    return {
      fdTable: this.fdTable.clone(),
      dirFds: new Map(this.dirFds),
      preopens: this.preopens.map((entry) => ({ ...entry })),
      cwd: this.cwd,
      canSuspendPipeReads: this.canSuspendPipeReads,
      nextDirFdCounter: this._nextDirFdCounter,
    };
  }

  restoreForkSnapshot(snapshot: WasiHostForkSnapshot): void {
    this.fdTable = snapshot.fdTable;
    this.dirFds = new Map(snapshot.dirFds);
    this.preopens = snapshot.preopens.map((entry) => ({ ...entry }));
    this.cwd = snapshot.cwd;
    this.canSuspendPipeReads = snapshot.canSuspendPipeReads;
    this._nextDirFdCounter = snapshot.nextDirFdCounter;
  }

  bindKernelFileTargets(): void {
    if (!this.kernel || this.pid === undefined) return;
    // Regular file descriptors are owned by ProcessKernel. Fork builds the
    // child's kernel fd table directly; rebinding from this WASI-side cache
    // would replace the inherited open file descriptions with stale mirrors.
  }

  setCanSuspendPipeReads(enabled: boolean): void {
    this.canSuspendPipeReads = enabled;
  }

  setSignalDeliverer(deliverer: ((sig: number) => void) | null): void {
    this.signalDeliverer = deliverer;
  }

  queueSignal(sig: number): boolean {
    if (!this.signalDeliverer) return false;
    this.pendingSignals.push(sig);
    const waiters = this.signalWaiters.splice(0);
    for (const wake of waiters) wake();
    return true;
  }

  waitForSignalDelivery(): { promise: Promise<void>; cancel: () => void } {
    let wake: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
      this.signalWaiters.push(wake);
    });
    return {
      promise,
      cancel: () => {
        const index = this.signalWaiters.indexOf(wake);
        if (index >= 0) this.signalWaiters.splice(index, 1);
      },
    };
  }

  drainPendingSignals(): void {
    if (!this.signalDeliverer || this.drainingSignals) return;
    this.drainingSignals = true;
    try {
      while (this.pendingSignals.length > 0) {
        const sig = this.pendingSignals.shift();
        if (sig !== undefined) {
          try {
            this.signalDeliverer(sig);
          } catch (e) {
            if (e instanceof WasiExitError && e.code === 128 + sig) {
              this.cancelSignal = sig;
            }
            throw e;
          }
        }
      }
    } finally {
      this.drainingSignals = false;
    }
  }

  /** Signal cancellation — next syscall check will throw WasiExitError. */
  cancelExecution(signal?: number): void {
    this.cancelled = true;
    if (signal !== undefined) this.cancelSignal = signal;
    const waiters = this.signalWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  /** Throw WasiExitError(124) if cancelled or past deadline. */
  private checkDeadline(): void {
    this.drainPendingSignals();
    if (this.cancelled || Date.now() > this.deadlineMs) {
      throw new WasiExitError(
        this.cancelSignal !== null ? 128 + this.cancelSignal : 124,
      );
    }
  }

  getExitCode(): number | null {
    return this.exitCode;
  }

  getExitSignal(): number {
    return this.cancelSignal ?? 0;
  }

  /**
   * Run a WASI instance's _start export.
   *
   * Handles the two possible outcomes:
   * - _start returns normally (exit code 0)
   * - _start calls proc_exit which throws WasiExitError
   *
   * Non-zero exit codes are returned without throwing. Other errors
   * (e.g. traps) are re-thrown to the caller.
   */
  start(instance: WebAssembly.Instance, startFn?: () => unknown): number {
    this.setMemory(instance.exports.memory as WebAssembly.Memory);
    try {
      (startFn ?? (instance.exports._start as Function))();
      // Normal return from _start means exit code 0
      this.exitCode = 0;
      return 0;
    } catch (e: unknown) {
      if (e instanceof WasiExitError) {
        this.exitCode = e.code;
        return e.code;
      }
      // WASM trap (RuntimeError: unreachable) from a Rust panic.
      // If stderr mentions "Broken pipe", treat as SIGPIPE (exit 141 = 128+13)
      // instead of crashing — matches POSIX behavior.
      if (e instanceof WebAssembly.RuntimeError) {
        const stderr = this.getStderr();
        if (stderr.includes("Broken pipe")) {
          this.exitCode = 141;
          return 141;
        }
      }
      throw e;
    }
  }

  /**
   * Async variant of start() for Asyncify/JSPI-driven process entrypoints.
   * Keeps the same exit-code and trap handling while allowing WASI imports
   * such as fd_read to suspend and resume.
   */
  async startAsync(
    instance: WebAssembly.Instance,
    startFn?: () => unknown | Promise<unknown>,
  ): Promise<number> {
    this.setMemory(instance.exports.memory as WebAssembly.Memory);
    try {
      await (startFn ?? (instance.exports._start as Function))();
      // Normal return from _start means exit code 0
      this.exitCode = 0;
      return 0;
    } catch (e: unknown) {
      if (e instanceof WasiExitError) {
        this.exitCode = e.code;
        return e.code;
      }
      // WASM trap (RuntimeError: unreachable) from a Rust panic.
      // If stderr mentions "Broken pipe", treat as SIGPIPE (exit 141 = 128+13)
      // instead of crashing — matches POSIX behavior.
      if (e instanceof WebAssembly.RuntimeError) {
        const stderr = this.getStderr();
        if (stderr.includes("Broken pipe")) {
          this.exitCode = 141;
          return 141;
        }
      }
      throw e;
    }
  }

  /** Return the import object to pass to WebAssembly.instantiate(). */
  getImports(): { wasi_snapshot_preview1: Record<string, Function> } {
    return {
      wasi_snapshot_preview1: {
        args_get: this.argsGet.bind(this),
        args_sizes_get: this.argsSizesGet.bind(this),
        environ_get: this.environGet.bind(this),
        environ_sizes_get: this.environSizesGet.bind(this),
        fd_write: this.fdWrite.bind(this),
        fd_read: this.fdRead.bind(this),
        fd_close: this.fdClose.bind(this),
        fd_seek: this.fdSeek.bind(this),
        fd_tell: this.fdTell.bind(this),
        fd_prestat_get: this.fdPrestatGet.bind(this),
        fd_prestat_dir_name: this.fdPrestatDirName.bind(this),
        fd_fdstat_get: this.fdFdstatGet.bind(this),
        fd_filestat_get: this.fdFilestatGet.bind(this),
        fd_readdir: this.fdReaddir.bind(this),
        path_open: this.pathOpen.bind(this),
        path_filestat_get: this.pathFilestatGet.bind(this),
        path_create_directory: this.pathCreateDirectory.bind(this),
        path_remove_directory: this.pathRemoveDirectory.bind(this),
        path_unlink_file: this.pathUnlinkFile.bind(this),
        path_rename: this.pathRename.bind(this),
        clock_time_get: this.clockTimeGet.bind(this),
        random_get: this.randomGet.bind(this),
        proc_exit: this.procExit.bind(this),
        sched_yield: this.schedYield.bind(this),
        // Safe no-op stubs (single-threaded sandbox — sync/timestamps/flags are harmless to skip)
        fd_advise: this.fdNoOp.bind(this),
        fd_allocate: this.fdNoOp.bind(this),
        fd_datasync: this.fdNoOp.bind(this),
        fd_sync: this.fdNoOp.bind(this),
        fd_fdstat_set_flags: this.fdFdstatSetFlags.bind(this),
        fd_fdstat_set_rights: this.fdNoOp.bind(this),
        fd_filestat_set_size: this.fdFilestatSetSize.bind(this),
        fd_filestat_set_times: this.fdFilestatSetTimes.bind(this),
        path_filestat_set_times: this.pathFilestatSetTimes.bind(this),
        fd_pread: this.fdPread.bind(this),
        fd_pwrite: this.fdPwrite.bind(this),
        // Stubs that must remain ENOSYS (masking bugs or unimplemented semantics)
        fd_renumber: this.fdRenumber.bind(this),
        path_link: this.pathLink.bind(this),
        path_readlink: this.pathReadlink.bind(this),
        path_symlink: this.pathSymlink.bind(this),
        poll_oneoff: this.pollOneoff.bind(this),
        proc_raise: this.stub.bind(this),
        sock_accept: this.stub.bind(this),
        sock_recv: this.stub.bind(this),
        sock_send: this.stub.bind(this),
        sock_shutdown: this.sockShutdown.bind(this),
        clock_res_get: this.clockResGet.bind(this),
      },
    };
  }

  // ---- Memory helpers ----

  private getView(): DataView {
    return new DataView(this.memory!.buffer);
  }

  private getBytes(): Uint8Array {
    return new Uint8Array(this.memory!.buffer);
  }

  private readString(ptr: number, len: number): string {
    return this.decoder.decode(
      new Uint8Array(this.memory!.buffer, ptr, len),
    );
  }

  private encodePathName(name: string): Uint8Array {
    if (!name.includes("\ufffd")) return this.encoder.encode(name);
    const bytes = new Uint8Array(name.length);
    for (let i = 0; i < name.length; i++) {
      const code = name.charCodeAt(i);
      if (code === 0xfffd) {
        bytes[i] = 0x81;
      } else if (code <= 0x7f) {
        bytes[i] = code;
      } else {
        return this.encoder.encode(name);
      }
    }
    return bytes;
  }

  // ---- Path resolution ----

  /**
   * Resolve a relative path from a directory fd to an absolute VFS path.
   * Handles both preopened dirs and opened directory fds.
   */
  private resolvePath(dirFd: number, relativePath: string): string {
    const dirPath = this.dirFds.get(dirFd);
    if (dirPath === undefined) {
      throw new Error(`EBADF: not a directory fd: ${dirFd}`);
    }

    if (dirPath !== "/") {
      return this.resolveProcSelf(joinVfsPath(dirPath, relativePath));
    }
    const cwd = this.currentCwd();
    if (cwd === "/" || relativePath.startsWith("/")) {
      return this.resolveProcSelf(joinVfsPath("/", relativePath));
    }
    if (relativePath === "") {
      return this.resolveProcSelf("/");
    }
    if (relativePath === ".") {
      return this.resolveProcSelf(cwd);
    }

    const cwdCandidate = joinVfsPath(cwd, relativePath);
    const rootCandidate = joinVfsPath("/", relativePath);
    if (this.pathExists(cwdCandidate)) {
      return this.resolveProcSelf(cwdCandidate);
    }
    if (this.pathExists(rootCandidate)) {
      return this.resolveProcSelf(rootCandidate);
    }
    if (this.pathExists(parentPath(cwdCandidate))) {
      return this.resolveProcSelf(cwdCandidate);
    }
    return this.resolveProcSelf(rootCandidate);
  }

  private resolveProcSelf(path: string): string {
    if (this.pid !== undefined) {
      const visiblePid = this.kernel?.getVisiblePid(this.pid) ?? this.pid;
      if (path === "/dev/fd") return `/proc/${this.pid}/fd`;
      if (path.startsWith("/dev/fd/")) {
        return `/proc/${this.pid}/fd${path.slice("/dev/fd".length)}`;
      }
      if (path === "/proc/self") return `/proc/${visiblePid}`;
      if (path.startsWith("/proc/self/")) {
        return `/proc/${visiblePid}${path.slice("/proc/self".length)}`;
      }
    }
    return path;
  }

  private resolveProcFdAlias(path: string): { pid: number; fd: number } | null {
    const selfFd = path.match(/^\/dev\/fd\/(\d+)$/);
    if (selfFd && this.pid !== undefined) {
      return { pid: this.pid, fd: Number(selfFd[1]) };
    }
    const match = path.match(/^\/proc\/(\d+)\/fd\/(\d+)$/);
    if (!match) return null;
    const visiblePid = Number(match[1]);
    const pid = this.kernel?.resolveVisiblePid(visiblePid) ?? visiblePid;
    return { pid, fd: Number(match[2]) };
  }

  private pathExists(path: string): boolean {
    try {
      this.vfs.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private currentCwd(): string {
    return this.kernel && this.pid !== undefined
      ? this.kernel.getCwd(this.pid)
      : this.cwd;
  }

  // ---- Syscall implementations ----

  private argsSizesGet(argcPtr: number, argvBufSizePtr: number): number {
    const view = this.getView();
    view.setUint32(argcPtr, this.args.length, true);

    let bufSize = 0;
    for (const arg of this.args) {
      bufSize += this.encoder.encode(arg).byteLength + 1; // +1 for null terminator
    }
    view.setUint32(argvBufSizePtr, bufSize, true);
    return WASI_ESUCCESS;
  }

  private argsGet(argvPtr: number, argvBufPtr: number): number {
    const view = this.getView();
    const bytes = this.getBytes();
    let bufOffset = argvBufPtr;

    for (let i = 0; i < this.args.length; i++) {
      view.setUint32(argvPtr + i * 4, bufOffset, true);
      const encoded = this.encoder.encode(this.args[i]);
      bytes.set(encoded, bufOffset);
      bytes[bufOffset + encoded.byteLength] = 0; // null terminator
      bufOffset += encoded.byteLength + 1;
    }

    return WASI_ESUCCESS;
  }

  private environSizesGet(
    environCountPtr: number,
    environBufSizePtr: number,
  ): number {
    const view = this.getView();
    view.setUint32(environCountPtr, this.envPairs.length, true);

    let bufSize = 0;
    for (const pair of this.envPairs) {
      bufSize += this.encoder.encode(pair).byteLength + 1;
    }
    view.setUint32(environBufSizePtr, bufSize, true);
    return WASI_ESUCCESS;
  }

  private environGet(environPtr: number, environBufPtr: number): number {
    const view = this.getView();
    const bytes = this.getBytes();
    let bufOffset = environBufPtr;

    for (let i = 0; i < this.envPairs.length; i++) {
      view.setUint32(environPtr + i * 4, bufOffset, true);
      const encoded = this.encoder.encode(this.envPairs[i]);
      bytes.set(encoded, bufOffset);
      bytes[bufOffset + encoded.byteLength] = 0;
      bufOffset += encoded.byteLength + 1;
    }

    return WASI_ESUCCESS;
  }

  private fdWrite(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nwrittenPtr: number,
  ): number | Promise<number> {
    this.checkDeadline();
    const view = this.getView();
    const bytes = this.getBytes();
    const iovecs = readIovecs(view, iovsPtr, iovsLen);

    let totalWritten = 0;
    const target = this.fdTarget(fd);
    if (target?.type === "pipe_write") {
      const canSuspend = this.canSuspendPipeReads ||
        typeof WebAssembly.Suspending === "function";
      if (canSuspend) {
        return this.fdWritePipe(target, iovecs, nwrittenPtr);
      }
    }
    for (const iov of iovecs) {
      const data = bytes.slice(iov.buf, iov.buf + iov.len);

      if (!target && this.dirFds.has(fd)) {
        return WASI_EBADF;
      }

      if (target) {
        switch (target.type) {
          case "buffer": {
            if (target.total < target.limit) {
              const remaining = target.limit - target.total;
              const slice = data.byteLength <= remaining
                ? data
                : data.slice(0, remaining);
              target.buf.push(slice);
              target.onChunk?.(slice);
              if (data.byteLength > remaining) target.truncated = true;
            } else {
              target.truncated = true;
            }
            target.total += data.byteLength;
            totalWritten += data.byteLength;
            break;
          }
          case "pipe_write": {
            const n = target.pipe.write(data);
            if (n === -1) {
              // EPIPE — read end closed
              const viewAfter = this.getView();
              viewAfter.setUint32(nwrittenPtr, totalWritten, true);
              this.deliverSigpipe();
              return WASI_EPIPE;
            }
            totalWritten += n;
            break;
          }
          case "null": {
            // Discard data, report full write
            totalWritten += data.byteLength;
            break;
          }
          case "vfs_file": {
            try {
              totalWritten += this.kernel && this.pid !== undefined
                ? this.kernel.writeVfsFile(this.pid, fd, data)
                : target.fdTable.write(target.fd, data);
            } catch (err) {
              return fdErrorToWasi(err);
            }
            break;
          }
          case "socket": {
            if (target.socket === null) return WASI_EBADF;
            if (target.writeShutdown) {
              this.deliverSigpipe();
              return WASI_EPIPE;
            }
            const result = target.send(target.socket, bytesToBase64(data));
            if (!result.ok) return WASI_EIO;
            totalWritten += result.bytes_sent ?? data.byteLength;
            break;
          }
          case "tty_slave": {
            target.state.toMaster.push(data.slice());
            for (const w of target.state.toMasterWaiters.splice(0)) w();
            totalWritten += data.byteLength;
            break;
          }
          case "tty_master": {
            if (target.state.masterClosed) {
              const viewAfter = this.getView();
              viewAfter.setUint32(nwrittenPtr, totalWritten, true);
              return WASI_EIO;
            }
            target.state.toSlave.push(data.slice());
            for (const w of target.state.toSlaveWaiters.splice(0)) w();
            totalWritten += data.byteLength;
            break;
          }
          case "static":
          case "pipe_read": {
            // Cannot write to a read-only target
            return WASI_EBADF;
          }
        }
      } else {
        // No I/O target — fall through to VFS file write
        try {
          totalWritten += this.fdTable.write(fd, data);
        } catch (err) {
          return fdErrorToWasi(err);
        }
      }
    }

    // Re-fetch view in case writes caused memory growth
    const viewAfter = this.getView();
    viewAfter.setUint32(nwrittenPtr, totalWritten, true);
    return WASI_ESUCCESS;
  }

  private async fdWritePipe(
    target: Extract<import("./fd-target.js").FdTarget, { type: "pipe_write" }>,
    iovecs: Array<{ buf: number; len: number }>,
    nwrittenPtr: number,
  ): Promise<number> {
    let totalWritten = 0;
    for (const iov of iovecs) {
      let offset = 0;
      while (offset < iov.len) {
        this.checkDeadline();
        const bytes = this.getBytes();
        const data = bytes.slice(iov.buf + offset, iov.buf + iov.len);
        let n = target.pipe.write(data);
        if (n === -1) {
          const viewAfter = this.getView();
          viewAfter.setUint32(nwrittenPtr, totalWritten, true);
          this.deliverSigpipe();
          return WASI_EPIPE;
        }
        if (n === 0) {
          n = await target.pipe.writeAsync(data);
          if (n === -1) {
            const viewAfter = this.getView();
            viewAfter.setUint32(nwrittenPtr, totalWritten, true);
            this.deliverSigpipe();
            return WASI_EPIPE;
          }
        }
        offset += n;
        totalWritten += n;
      }
    }
    const viewAfter = this.getView();
    viewAfter.setUint32(nwrittenPtr, totalWritten, true);
    return WASI_ESUCCESS;
  }

  private deliverSigpipe(): void {
    if (!this.queueSignal(SIGPIPE)) return;
    this.drainPendingSignals();
  }

  private fdRead(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    nreadPtr: number,
  ): number | Promise<number> {
    this.checkDeadline();
    const view = this.getView();
    const iovecs = readIovecs(view, iovsPtr, iovsLen);

    let totalRead = 0;
    const target = this.fdTarget(fd);
    // Async-capable targets (pipe_read, tty_slave): suspend until data arrives when
    // JSPI or Asyncify is available; otherwise read synchronously from buffered data.
    if (
      target && (target.type === "pipe_read" || target.type === "tty_slave")
    ) {
      const canSuspend = this.canSuspendPipeReads ||
        typeof WebAssembly.Suspending === "function";
      if (target.type === "pipe_read") {
        return canSuspend
          ? this.fdReadPipe(target, iovecs, nreadPtr)
          : this.fdReadPipeSync(target, iovecs, nreadPtr);
      }
      return canSuspend
        ? this.fdReadTtySlave(target, iovecs, nreadPtr)
        : this.fdReadTtySlaveSync(target, iovecs, nreadPtr);
    }
    if (
      target?.type === "null" &&
      (this.canSuspendPipeReads || typeof WebAssembly.Suspending === "function")
    ) {
      return this.fdReadNull(nreadPtr);
    }

    for (const iov of iovecs) {
      if (target) {
        switch (target.type) {
          case "static": {
            if (target.offset >= target.data.byteLength) {
              // EOF
              break;
            }
            const remaining = target.data.byteLength - target.offset;
            const toRead = Math.min(iov.len, remaining);
            const bytes = this.getBytes();
            bytes.set(
              target.data.subarray(target.offset, target.offset + toRead),
              iov.buf,
            );
            target.offset += toRead;
            totalRead += toRead;
            if (toRead < iov.len) {
              // EOF reached mid-iovec — stop processing further iovecs
              const viewAfter = this.getView();
              viewAfter.setUint32(nreadPtr, totalRead, true);
              return WASI_ESUCCESS;
            }
            continue;
          }
          case "null": {
            // /dev/null reads return EOF immediately
            break;
          }
          case "vfs_file": {
            const buf = new Uint8Array(iov.len);
            let n: number;
            try {
              n = this.kernel && this.pid !== undefined
                ? this.kernel.readVfsFile(this.pid, fd, buf)
                : target.fdTable.read(target.fd, buf);
            } catch (err) {
              return fdErrorToWasi(err);
            }
            if (n > 0) {
              const bytes = this.getBytes();
              bytes.set(buf.subarray(0, n), iov.buf);
              totalRead += n;
            }
            if (n < iov.len) {
              const viewAfter = this.getView();
              viewAfter.setUint32(nreadPtr, totalRead, true);
              return WASI_ESUCCESS;
            }
            continue;
          }
          case "socket": {
            if (target.socket === null) return WASI_EBADF;
            if (target.readShutdown) break;
            if (target.peekBuffer && target.peekBuffer.byteLength > 0) {
              const toRead = Math.min(iov.len, target.peekBuffer.byteLength);
              const bytes = this.getBytes();
              bytes.set(target.peekBuffer.subarray(0, toRead), iov.buf);
              target.peekBuffer = target.peekBuffer.slice(toRead);
              totalRead += toRead;
              if (toRead < iov.len) {
                const viewAfter = this.getView();
                viewAfter.setUint32(nreadPtr, totalRead, true);
                return WASI_ESUCCESS;
              }
              continue;
            }
            const nonblocking =
              ((target.fdFlags ?? 0) & WASI_FDFLAGS_NONBLOCK) !== 0;
            if (nonblocking) {
              // peekBuffer was empty (drained above). Poll the backend
              // with the nonblocking flag — if data is queued, deliver
              // it; if the backend signals EAGAIN, surface it; on EOF
              // (ok with no bytes) return success with totalRead=0.
              const result = target.recv(target.socket, iov.len, {
                nonblocking: true,
              });
              if (!result.ok) {
                return result.error === "EAGAIN" ? WASI_EAGAIN : WASI_EIO;
              }
              const data = result.data_b64 !== undefined
                ? base64ToBytes(result.data_b64)
                : this.encoder.encode(result.data ?? "");
              const toRead = Math.min(iov.len, data.byteLength);
              if (toRead > 0) {
                const bytes = this.getBytes();
                bytes.set(data.subarray(0, toRead), iov.buf);
                totalRead += toRead;
              }
              if (toRead < iov.len) {
                const viewAfter = this.getView();
                viewAfter.setUint32(nreadPtr, totalRead, true);
                return WASI_ESUCCESS;
              }
              continue;
            }
            // Blocking socket read — suspend the WASM stack via JSPI/Asyncify
            // until at least one byte (or EOF) is available.
            return this.fdReadSocketBlocking(
              target,
              iov,
              totalRead,
              nreadPtr,
            );
          }
          case "buffer":
          case "pipe_write": {
            // Cannot read from a write-only target
            return WASI_EBADF;
          }
          default:
            break;
        }
        // If we got here via break (EOF from static or null), stop iovecs
        break;
      } else {
        if (this.dirFds.has(fd)) {
          return WASI_EBADF;
        }
        // No I/O target — fall through to VFS file read
        try {
          const buf = new Uint8Array(iov.len);
          const n = this.fdTable.read(fd, buf);
          if (n > 0) {
            const bytes = this.getBytes();
            bytes.set(buf.subarray(0, n), iov.buf);
            totalRead += n;
          }
          if (n < iov.len) {
            break; // EOF or short read
          }
        } catch (err) {
          return fdErrorToWasi(err);
        }
      }
    }

    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  /**
   * Suspending socket read — used by fdRead when a blocking socket fd
   * has no peeked bytes ready. Awaits target.recvAsync, which returns
   * an empty payload on EOF. Only consumes one iovec because socket
   * reads typically return less than the requested length.
   */
  private async fdReadSocketBlocking(
    target: FdTarget & { type: "socket" },
    iov: { buf: number; len: number },
    totalRead: number,
    nreadPtr: number,
  ): Promise<number> {
    if (target.socket === null) return WASI_EBADF;
    const result = await target.recvAsync(target.socket, iov.len);
    if (!result.ok) {
      return result.error === "EAGAIN" ? WASI_EAGAIN : WASI_EIO;
    }
    const data = result.data_b64 !== undefined
      ? base64ToBytes(result.data_b64)
      : this.encoder.encode(result.data ?? "");
    const toRead = Math.min(iov.len, data.byteLength);
    if (toRead > 0) {
      const bytes = this.getBytes();
      bytes.set(data.subarray(0, toRead), iov.buf);
      totalRead += toRead;
    }
    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  private async fdReadNull(nreadPtr: number): Promise<number> {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    this.checkDeadline();
    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, 0, true);
    return WASI_ESUCCESS;
  }

  /**
   * Synchronous pipe read — for non-JSPI environments (Safari, Bun, older browsers).
   * Reads whatever is already buffered in the pipe.  Returns WASI_ESUCCESS with
   * totalRead=0 when the buffer is empty (write end closed or not yet written).
   * For typical pipelines the upstream stage writes all its output before the
   * downstream reader executes, so the buffer is full by the time this is called.
   */
  private fdReadPipeSync(
    target: Extract<import("./fd-target.js").FdTarget, { type: "pipe_read" }>,
    iovecs: Array<{ buf: number; len: number }>,
    nreadPtr: number,
  ): number {
    let totalRead = 0;
    for (const iov of iovecs) {
      if (iov.len === 0) continue;
      const readBuf = new Uint8Array(iov.len);
      const n = target.pipe.readSync(readBuf);
      if (n > 0) {
        const bytes = this.getBytes();
        bytes.set(readBuf.subarray(0, n), iov.buf);
        totalRead += n;
      }
      if (n < iov.len) break; // EOF or no more data available
    }
    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  /** Async pipe read — returns a Promise so JSPI can suspend the WASM stack. */
  private async fdReadPipe(
    target: Extract<import("./fd-target.js").FdTarget, { type: "pipe_read" }>,
    iovecs: Array<{ buf: number; len: number }>,
    nreadPtr: number,
  ): Promise<number> {
    let totalRead = 0;
    for (const iov of iovecs) {
      const readBuf = new Uint8Array(iov.len);
      const n = await target.pipe.read(readBuf);
      if (n > 0) {
        const bytes = this.getBytes();
        bytes.set(readBuf.subarray(0, n), iov.buf);
        totalRead += n;
      }
      if (n < iov.len) {
        // EOF or short read — stop
        break;
      }
    }
    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  /** Async TTY slave read — suspends until data arrives in the master→slave queue. */
  private async fdReadTtySlave(
    target: Extract<import("./fd-target.js").FdTarget, { type: "tty_slave" }>,
    iovecs: Array<{ buf: number; len: number }>,
    nreadPtr: number,
  ): Promise<number> {
    let totalRead = 0;
    for (const iov of iovecs) {
      if (iov.len === 0) continue;
      while (target.state.toSlave.length === 0 && !target.state.masterClosed) {
        await new Promise<void>((resolve) => {
          target.state.toSlaveWaiters.push(resolve);
        });
      }
      if (target.state.toSlave.length === 0) break; // EOF — master closed
      const chunk = target.state.toSlave[0];
      const toRead = Math.min(iov.len, chunk.byteLength);
      const bytes = this.getBytes();
      bytes.set(chunk.subarray(0, toRead), iov.buf);
      totalRead += toRead;
      if (toRead < chunk.byteLength) {
        target.state.toSlave[0] = chunk.subarray(toRead);
      } else {
        target.state.toSlave.shift();
      }
      if (toRead < iov.len) break; // short read
    }
    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  /** Sync TTY slave read — returns whatever is already buffered (may be 0 bytes). */
  private fdReadTtySlaveSync(
    target: Extract<import("./fd-target.js").FdTarget, { type: "tty_slave" }>,
    iovecs: Array<{ buf: number; len: number }>,
    nreadPtr: number,
  ): number {
    let totalRead = 0;
    for (const iov of iovecs) {
      if (iov.len === 0) continue;
      if (target.state.toSlave.length === 0) break;
      const chunk = target.state.toSlave[0];
      const toRead = Math.min(iov.len, chunk.byteLength);
      const bytes = this.getBytes();
      bytes.set(chunk.subarray(0, toRead), iov.buf);
      totalRead += toRead;
      if (toRead < chunk.byteLength) {
        target.state.toSlave[0] = chunk.subarray(toRead);
      } else {
        target.state.toSlave.shift();
      }
      if (toRead < iov.len) break;
    }
    const viewAfter = this.getView();
    viewAfter.setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  private fdClose(fd: number): number {
    fd = this.resolveDisplayedProcDirFd(fd) ?? fd;

    if (this.isPreopenFd(fd)) return WASI_ESUCCESS;

    if (this.kernel && this.pid !== undefined) {
      const target = this.kernel.getFdTarget(this.pid, fd);
      if (target) {
        if (target.type === "vfs_dir") this.dirFds.delete(fd);
        try {
          if (target.type === "vfs_dir" && this.fdTable.isOpen(fd)) {
            this.fdTable.close(fd);
          }
          const closed = this.kernel.closeFd(this.pid, fd);
          if (closed) this.ioFds.delete(fd);
          return closed ? WASI_ESUCCESS : WASI_EBADF;
        } catch (err) {
          return fdErrorToWasi(err);
        }
      }
    }

    if (this.ioFds.has(fd)) {
      this.ioFds.delete(fd);
      return WASI_ESUCCESS;
    }

    try {
      this.fdTable.close(fd);
      this.dirFds.delete(fd);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdSeek(
    fd: number,
    offset: bigint,
    whence: number,
    newOffsetPtr: number,
  ): number {
    try {
      const target = this.fdTarget(fd);
      const vfsWhence = wasiWhenceToVfs(whence);
      const newOffset = target?.type === "vfs_file" &&
          this.kernel && this.pid !== undefined
        ? this.kernel.seekVfsFile(this.pid, fd, Number(offset), vfsWhence)
        : (target?.type === "vfs_file" ? target.fdTable : this.fdTable).seek(
          target?.type === "vfs_file" ? target.fd : fd,
          Number(offset),
          vfsWhence,
        );
      const view = this.getView();
      view.setBigUint64(newOffsetPtr, BigInt(newOffset), true);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdTell(fd: number, offsetPtr: number): number {
    try {
      const target = this.fdTarget(fd);
      const offset = target?.type === "vfs_file" &&
          this.kernel && this.pid !== undefined
        ? this.kernel.tellVfsFile(this.pid, fd)
        : (target?.type === "vfs_file" ? target.fdTable : this.fdTable).tell(
          target?.type === "vfs_file" ? target.fd : fd,
        );
      const view = this.getView();
      view.setBigUint64(offsetPtr, BigInt(offset), true);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdPrestatGet(fd: number, bufPtr: number): number {
    const preopen = this.preopens.find((p) => p.fd === fd);
    if (preopen === undefined) {
      return WASI_EBADF;
    }

    const view = this.getView();
    // prestat: u8 tag (0 = dir), 3 bytes padding, u32 name_len
    view.setUint8(bufPtr, WASI_PREOPENTYPE_DIR);
    view.setUint8(bufPtr + 1, 0);
    view.setUint8(bufPtr + 2, 0);
    view.setUint8(bufPtr + 3, 0);
    const nameBytes = this.encoder.encode(preopen.vfsPath);
    view.setUint32(bufPtr + 4, nameBytes.byteLength, true);
    return WASI_ESUCCESS;
  }

  private fdPrestatDirName(
    fd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    const preopen = this.preopens.find((p) => p.fd === fd);
    if (preopen === undefined) {
      return WASI_EBADF;
    }

    const bytes = this.getBytes();
    const encoded = this.encoder.encode(preopen.vfsPath);
    bytes.set(encoded.subarray(0, pathLen), pathPtr);
    return WASI_ESUCCESS;
  }

  private fdFdstatGet(fd: number, bufPtr: number): number {
    const view = this.getView();

    // fdstat layout: u8 filetype, u16 flags (at +2), u64 rights_base (+8), u64 rights_inheriting (+16)
    // Total: 24 bytes

    let filetype: number;

    // I/O target fds (stdio or custom) are character devices, except sockets.
    const target = this.fdTarget(fd);
    if (target) {
      filetype = target.type === "socket"
        ? WASI_FILETYPE_SOCKET_STREAM
        : target.type === "vfs_dir"
        ? WASI_FILETYPE_DIRECTORY
        : target.type === "vfs_file"
        ? WASI_FILETYPE_REGULAR_FILE
        : WASI_FILETYPE_CHARACTER_DEVICE;
    } else if (this.dirFds.has(fd)) {
      filetype = WASI_FILETYPE_DIRECTORY;
    } else if (this.fdTable.isOpen(fd)) {
      filetype = WASI_FILETYPE_REGULAR_FILE;
    } else {
      return WASI_EBADF;
    }

    view.setUint8(bufPtr, filetype);
    view.setUint8(bufPtr + 1, 0); // padding
    view.setUint16(
      bufPtr + 2,
      target?.type === "socket" ? (target.fdFlags ?? 0) : 0,
      true,
    ); // fdflags
    // 4 bytes padding
    view.setUint32(bufPtr + 4, 0, true);
    view.setBigUint64(bufPtr + 8, this.fdRightsBase(fd), true); // rights_base
    view.setBigUint64(bufPtr + 16, WASI_RIGHTS_ALL, true); // rights_inheriting
    return WASI_ESUCCESS;
  }

  private fdRightsBase(fd: number): bigint {
    const mode = this.kernel && this.pid !== undefined
      ? this.kernel.vfsFileMode(this.pid, fd) ?? this.fdTable.getMode(fd)
      : this.fdTable.getMode(fd);
    if (!mode) return WASI_RIGHTS_ALL;
    let rights = WASI_RIGHTS_ALL & ~WASI_RIGHTS_FD_READ & ~WASI_RIGHTS_FD_WRITE;
    if (mode === "r" || mode === "rw") rights |= WASI_RIGHTS_FD_READ;
    if (mode === "w" || mode === "a" || mode === "rw") {
      rights |= WASI_RIGHTS_FD_WRITE;
    }
    return rights;
  }

  private fdFdstatSetFlags(fd: number, flags: number): number {
    const target = this.fdTarget(fd);
    if (!target) {
      return (this.dirFds.has(fd) || this.fdTable.isOpen(fd))
        ? WASI_ESUCCESS
        : WASI_EBADF;
    }
    if (target.type === "socket") {
      target.fdFlags = flags;
    }
    return WASI_ESUCCESS;
  }

  private fdFilestatGet(fd: number, bufPtr: number): number {
    this.checkDeadline();
    // For preopened / directory fds, stat the directory path
    const dirPath = this.dirFds.get(fd);
    if (dirPath !== undefined) {
      return this.writeFilestat(bufPtr, dirPath);
    }

    const target = this.fdTarget(fd);
    // For non-file I/O target fds (stdio, pipes, sockets, ttys), return a
    // minimal character device stat. Regular files are handled by path below.
    if (target && target.type !== "vfs_file" && target.type !== "vfs_dir") {
      return this.writeCharDeviceStat(bufPtr);
    }

    // For regular file fds opened via path_open
    const filePath = this.kernel && this.pid !== undefined
      ? this.kernel.vfsFilePath(this.pid, fd) ?? this.fdTable.getPath(fd)
      : this.fdTable.getPath(fd);
    if (filePath !== undefined) {
      return this.writeFilestat(bufPtr, filePath);
    }

    return WASI_EBADF;
  }

  private fdReaddir(
    fd: number,
    bufPtr: number,
    bufLen: number,
    cookie: bigint,
    bufUsedPtr: number,
  ): number {
    this.checkDeadline();
    const dirPath = this.dirFds.get(fd);
    if (dirPath === undefined) {
      return WASI_EBADF;
    }

    try {
      const entries = [
        { name: ".", type: "dir" as const },
        { name: "..", type: "dir" as const },
        ...this.vfs.readdir(dirPath),
      ];
      const view = this.getView();
      const bytes = this.getBytes();

      let offset = 0;
      const startIndex = Number(cookie);

      for (let i = startIndex; i < entries.length; i++) {
        const entry = entries[i];
        const nameBytes = this.encodePathName(entry.name);

        // dirent layout: u64 d_next, u64 d_ino, u32 d_namlen, u8 d_type, padding
        // Total header: 24 bytes, followed by name
        const entrySize = 24 + nameBytes.byteLength;

        if (offset + entrySize > bufLen) {
          // Per WASI spec: write as much of the entry as fits so that
          // bufUsed == bufLen, signaling that there are more entries.
          const remaining = bufLen - offset;
          if (remaining > 0) {
            // Build the full entry in a temp buffer, then copy what fits
            const tmp = new Uint8Array(entrySize);
            const tmpView = new DataView(tmp.buffer);
            tmpView.setBigUint64(0, BigInt(i + 1), true); // d_next
            tmpView.setBigUint64(8, BigInt(i + 1), true); // d_ino
            tmpView.setUint32(16, nameBytes.byteLength, true); // d_namlen
            tmpView.setUint8(20, inodeTypeToWasiFiletype(entry.type)); // d_type
            tmp.set(nameBytes, 24); // name
            bytes.set(tmp.subarray(0, remaining), bufPtr + offset);
            offset += remaining;
          }
          break;
        }

        // d_next: cookie value for next entry
        view.setBigUint64(bufPtr + offset, BigInt(i + 1), true);
        offset += 8;

        // d_ino: we don't track real inodes, use index
        view.setBigUint64(bufPtr + offset, BigInt(i + 1), true);
        offset += 8;

        // d_namlen
        view.setUint32(bufPtr + offset, nameBytes.byteLength, true);
        offset += 4;

        // d_type
        view.setUint8(bufPtr + offset, inodeTypeToWasiFiletype(entry.type));
        offset += 1;

        // 3 bytes padding to align to 8 bytes
        view.setUint8(bufPtr + offset, 0);
        view.setUint8(bufPtr + offset + 1, 0);
        view.setUint8(bufPtr + offset + 2, 0);
        offset += 3;

        // name (not null-terminated)
        bytes.set(nameBytes, bufPtr + offset);
        offset += nameBytes.byteLength;
      }

      const viewAfter = this.getView();
      viewAfter.setUint32(bufUsedPtr, offset, true);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathOpen(
    dirFd: number,
    _dirflags: number,
    pathPtr: number,
    pathLen: number,
    oflags: number,
    _rightsBase: bigint,
    _rightsInheriting: bigint,
    fdflags: number,
    fdPtr: number,
  ): number {
    this.checkDeadline();
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      let absPath = this.resolvePath(dirFd, relativePath);

      const wantCreate = (oflags & WASI_OFLAGS_CREAT) !== 0;
      const wantTrunc = (oflags & WASI_OFLAGS_TRUNC) !== 0;
      const wantExcl = (oflags & WASI_OFLAGS_EXCL) !== 0;
      const wantDir = (oflags & WASI_OFLAGS_DIRECTORY) !== 0;
      const wantAppend = (fdflags & WASI_FDFLAGS_APPEND) !== 0;

      if (absPath === "/dev/tty") {
        if (wantDir || wantCreate || wantTrunc) return WASI_EINVAL;
        if (!this.kernel || this.pid === undefined) return WASI_ENOENT;
        const state = this.kernel.getControllingTtyState(this.pid);
        if (!state) return WASI_ENOENT;
        if (this.openFdCount() >= this.nofileSoftLimit()) return WASI_EMFILE;

        const fd = this.allocateIoFd(createTtySlaveTarget(state));
        const view = this.getView();
        view.setUint32(fdPtr, fd, true);
        return WASI_ESUCCESS;
      }

      const procFd = this.resolveProcFdAlias(absPath);
      if (procFd !== null) {
        if (wantDir) return WASI_EINVAL;
        if (!this.kernel || this.pid === undefined) return WASI_ENOENT;
        try {
          const fd = this.kernel.dupFromProcess(
            this.pid,
            procFd.pid,
            procFd.fd,
          );
          const view = this.getView();
          view.setUint32(fdPtr, fd, true);
          return WASI_ESUCCESS;
        } catch {
          return WASI_EBADF;
        }
      }

      return this.withVfsCredentials(() => {
        // If opening a directory, just register it and return
        if (wantDir) {
          // Verify the path is actually a directory
          const stat = this.vfs.stat(absPath);
          if (stat.type !== "dir") {
            return WASI_EINVAL;
          }
          const fakeFd = this.allocateDirFd(absPath);
          const view = this.getView();
          view.setUint32(fdPtr, fakeFd, true);
          return WASI_ESUCCESS;
        }

        // Determine open mode
        let mode: OpenMode;
        if (wantAppend) {
          if (!wantCreate && !this.pathExists(absPath)) return WASI_ENOENT;
          mode = "a";
        } else if (wantCreate && wantTrunc) {
          if (wantExcl && this.pathExists(absPath)) return WASI_EEXIST;
          mode = "w";
        } else if (wantCreate) {
          // Create if not exists, but don't truncate
          if (wantExcl && this.pathExists(absPath)) return WASI_EEXIST;
          mode = "rw";
          // Ensure parent dirs exist and file is created if missing
          try {
            this.vfs.stat(absPath);
          } catch {
            this.vfs.writeFile(
              absPath,
              new Uint8Array(0),
              this.creationMode(0o666),
            );
          }
        } else {
          mode = "r";
        }

        // For write/append modes, ensure the file exists
        if (mode === "w" || mode === "a") {
          if ((oflags & WASI_OFLAGS_DIRECTORY) === 0) {
            try {
              if (
                this.vfs.stat(absPath).type === "dir" &&
                !relativePath.includes("/") &&
                this.currentCwd() !== "/"
              ) {
                const cwdCandidate = joinVfsPath(
                  this.currentCwd(),
                  relativePath,
                );
                if (
                  cwdCandidate !== absPath &&
                  this.pathExists(parentPath(cwdCandidate))
                ) {
                  absPath = cwdCandidate;
                }
              }
            } catch {
              // Missing targets are created below after the final path is chosen.
            }
          }
          try {
            this.vfs.stat(absPath);
          } catch {
            this.vfs.writeFile(
              absPath,
              new Uint8Array(0),
              this.creationMode(0o666),
            );
          }
        }

        if (this.openFdCount() >= this.nofileSoftLimit()) {
          return WASI_EMFILE;
        }
        let fd: number;
        const stdioSlot = this.firstAvailableStdioFd();
        if (this.kernel && this.pid !== undefined) {
          fd = this.kernel.openVfsFile(
            this.pid,
            this.vfs,
            absPath,
            mode,
            stdioSlot ?? undefined,
          );
        } else {
          fd = this.fdTable.open(absPath, mode);
          if (stdioSlot !== null) {
            this.fdTable.renumber(fd, stdioSlot);
            fd = stdioSlot;
          }
        }
        const view = this.getView();
        view.setUint32(fdPtr, fd, true);
        return WASI_ESUCCESS;
      });
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private firstAvailableStdioFd(): number | null {
    for (let fd = 0; fd <= 2; fd++) {
      if (!this.hasOpenFd(fd)) {
        return fd;
      }
    }
    return null;
  }

  private pathFilestatGet(
    dirFd: number,
    flags: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
  ): number {
    this.checkDeadline();
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      // flags bit 0 = SYMLINK_FOLLOW; when not set, use lstat
      const followSymlinks = (flags & 1) !== 0;
      return this.withVfsCredentials(() =>
        this.writeFilestat(bufPtr, absPath, followSymlinks)
      );
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathCreateDirectory(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    this.checkDeadline();
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      if (absPath === "/") return WASI_EEXIST;
      this.withVfsCredentials(() =>
        this.vfs.mkdir(absPath, this.creationMode(0o777))
      );
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private creationMode(baseMode: number): number {
    const mask = this.kernel && this.pid !== undefined
      ? this.kernel.getUmask(this.pid)
      : 0o022;
    return Math.trunc(baseMode) & ~mask & 0o777;
  }

  private withVfsCredentials<T>(fn: () => T): T {
    if (!this.kernel || this.pid === undefined || !this.vfs.withCredential) {
      return fn();
    }
    const credentials = this.kernel.getCredentials(this.pid);
    return this.vfs.withCredential({
      uid: credentials.euid,
      gid: credentials.egid,
    }, fn);
  }

  private openFdCount(): number {
    const fds = new Set<number>();
    for (const fd of this.ioFds.keys()) fds.add(fd);
    for (const fd of this.dirFds.keys()) fds.add(fd);
    for (const fd of this.fdTable.openFds()) fds.add(fd);
    if (this.kernel && this.pid !== undefined) {
      for (const fd of this.kernel.getFdTable(this.pid).keys()) fds.add(fd);
    }
    return fds.size;
  }

  private nofileSoftLimit(): number {
    if (!this.kernel || this.pid === undefined) return Infinity;
    return this.kernel.getResourceLimit(this.pid, 7)?.soft ?? Infinity;
  }

  private pathRemoveDirectory(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      this.withVfsCredentials(() => this.vfs.rmdir(absPath));
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathUnlinkFile(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
  ): number {
    this.checkDeadline();
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      // If unlinking a socket inode, close the AF_UNIX path listener in the
      // registry so that subsequent connect() to this path fails as expected.
      if (this.socketRegistry) {
        try {
          const s = this.vfs.stat(absPath);
          if (s.type === 'socket') {
            this.socketRegistry.closePathListener(absPath);
            this.socketRegistry.removeDgramRoute(absPath);
          }
        } catch {
          // stat failure is fine — unlink will surface the real error below
        }
      }
      this.withVfsCredentials(() => this.vfs.unlink(absPath));
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathRename(
    oldDirFd: number,
    oldPathPtr: number,
    oldPathLen: number,
    newDirFd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number {
    this.checkDeadline();
    try {
      const oldRelative = this.readString(oldPathPtr, oldPathLen);
      const newRelative = this.readString(newPathPtr, newPathLen);
      const oldAbs = this.resolvePath(oldDirFd, oldRelative);
      const newAbs = this.resolvePath(newDirFd, newRelative);
      this.withVfsCredentials(() => this.vfs.rename(oldAbs, newAbs));
      this.kernel?.remapCwdAfterRename(oldAbs, newAbs);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathSymlink(
    oldPathPtr: number,
    oldPathLen: number,
    dirFd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number {
    this.checkDeadline();
    try {
      const target = this.readString(oldPathPtr, oldPathLen);
      const newRelative = this.readString(newPathPtr, newPathLen);
      const newAbs = this.resolvePath(dirFd, newRelative);
      this.withVfsCredentials(() => this.vfs.symlink(target, newAbs));
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private pathReadlink(
    dirFd: number,
    pathPtr: number,
    pathLen: number,
    bufPtr: number,
    bufLen: number,
    bufUsedPtr: number,
  ): number {
    this.checkDeadline();
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      if (absPath === `/proc/${this.pid}`) {
        const encoded = this.encoder.encode(String(this.pid));
        const bytes = this.getBytes();
        const view = this.getView();
        const written = Math.min(encoded.length, bufLen);
        bytes.set(encoded.subarray(0, written), bufPtr);
        view.setUint32(bufUsedPtr, written, true);
        return WASI_ESUCCESS;
      }
      const target = this.vfs.readlink(absPath);
      const encoded = this.encoder.encode(target);
      const bytes = this.getBytes();
      const view = this.getView();
      const written = Math.min(encoded.length, bufLen);
      bytes.set(encoded.subarray(0, written), bufPtr);
      view.setUint32(bufUsedPtr, written, true);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private clockTimeGet(
    _clockId: number,
    _precision: bigint,
    timestampPtr: number,
  ): number {
    this.checkDeadline();
    const view = this.getView();
    // Both realtime and monotonic return nanoseconds since epoch
    const nowMs = Date.now();
    const nowNs = BigInt(nowMs) * BigInt(1_000_000);
    view.setBigUint64(timestampPtr, nowNs, true);
    return WASI_ESUCCESS;
  }

  private randomGet(bufPtr: number, bufLen: number): number {
    this.checkDeadline();
    const bytes = this.getBytes();
    const target = bytes.subarray(bufPtr, bufPtr + bufLen);
    crypto.getRandomValues(target);
    return WASI_ESUCCESS;
  }

  private procExit(code: number): number {
    this.exitCode = code;
    throw new WasiExitError(code);
  }

  private schedYield(): number {
    this.checkDeadline();
    return WASI_ESUCCESS;
  }

  /** fd_pread — positional read without changing fd offset. */
  private fdPread(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    offset: bigint,
    nreadPtr: number,
  ): number {
    const target = this.fdTarget(fd);
    let fdTable = this.fdTable;
    let vfsFd = fd;
    if (target) {
      if (target.type !== "vfs_file") return WASI_EBADF;
      fdTable = target.fdTable;
      vfsFd = target.fd;
    } else if (this.dirFds.has(fd)) {
      return WASI_EBADF;
    }
    const view = this.getView();
    const iovecs = readIovecs(view, iovsPtr, iovsLen);
    let totalRead = 0;
    let pos = Number(offset);
    try {
      for (const iov of iovecs) {
        const buf = new Uint8Array(iov.len);
        const n =
          this.kernel && this.pid !== undefined && target?.type === "vfs_file"
            ? this.kernel.preadVfsFile(this.pid, fd, buf, pos)
            : fdTable.pread(vfsFd, buf, pos);
        if (n > 0) {
          this.getBytes().set(buf.subarray(0, n), iov.buf);
          totalRead += n;
          pos += n;
        }
        if (n < iov.len) break;
      }
    } catch (err) {
      return fdErrorToWasi(err);
    }
    this.getView().setUint32(nreadPtr, totalRead, true);
    return WASI_ESUCCESS;
  }

  /** fd_pwrite — positional write without changing fd offset. */
  private fdPwrite(
    fd: number,
    iovsPtr: number,
    iovsLen: number,
    offset: bigint,
    nwrittenPtr: number,
  ): number {
    const target = this.fdTarget(fd);
    if (this.dirFds.has(fd) || (target && target.type !== "vfs_file")) {
      return WASI_EBADF;
    }
    const view = this.getView();
    const iovecs = readIovecs(view, iovsPtr, iovsLen);
    let totalWritten = 0;
    let pos = Number(offset);
    try {
      for (const iov of iovecs) {
        const data = this.getBytes().slice(iov.buf, iov.buf + iov.len);
        const n =
          this.kernel && this.pid !== undefined && target?.type === "vfs_file"
            ? this.kernel.pwriteVfsFile(this.pid, fd, data, pos)
            : this.fdTable.pwrite(fd, data, pos);
        totalWritten += n;
        pos += n;
      }
    } catch (err) {
      return fdErrorToWasi(err);
    }
    this.getView().setUint32(nwrittenPtr, totalWritten, true);
    return WASI_ESUCCESS;
  }

  /** fd_filestat_set_size — ftruncate. */
  private fdFilestatSetSize(fd: number, size: bigint): number {
    const target = this.fdTarget(fd);
    if (this.dirFds.has(fd) || (target && target.type !== "vfs_file")) {
      return WASI_EBADF;
    }
    try {
      if (
        this.kernel && this.pid !== undefined && target?.type === "vfs_file"
      ) {
        this.kernel.truncateVfsFile(this.pid, fd, Number(size));
      } else {
        this.fdTable.truncate(fd, Number(size));
      }
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private fdFilestatSetTimes(
    fd: number,
    atim: bigint,
    mtim: bigint,
    fstFlags: number,
  ): number {
    this.checkDeadline();
    try {
      if (this.dirFds.has(fd)) return WASI_ESUCCESS;
      const filePath = this.kernel && this.pid !== undefined
        ? this.kernel.vfsFilePath(this.pid, fd) ?? this.fdTable.getPath(fd)
        : this.fdTable.getPath(fd);
      if (filePath === undefined) return WASI_EBADF;
      return this.setVfsTimes(filePath, atim, mtim, fstFlags);
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private pathFilestatSetTimes(
    dirFd: number,
    flags: number,
    pathPtr: number,
    pathLen: number,
    atim: bigint,
    mtim: bigint,
    fstFlags: number,
  ): number {
    this.checkDeadline();
    try {
      const relativePath = this.readString(pathPtr, pathLen);
      const absPath = this.resolvePath(dirFd, relativePath);
      const followSymlinks = (flags & 1) !== 0;
      return this.setVfsTimes(absPath, atim, mtim, fstFlags, followSymlinks);
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private setVfsTimes(
    absPath: string,
    atim: bigint,
    mtim: bigint,
    fstFlags: number,
    followSymlinks = true,
  ): number {
    const invalidAtim = (fstFlags & WASI_FSTFLAGS_ATIM) !== 0 &&
      (fstFlags & WASI_FSTFLAGS_ATIM_NOW) !== 0;
    const invalidMtim = (fstFlags & WASI_FSTFLAGS_MTIM) !== 0 &&
      (fstFlags & WASI_FSTFLAGS_MTIM_NOW) !== 0;
    if (invalidAtim || invalidMtim) return WASI_EINVAL;

    const now = new Date();
    const atime = (fstFlags & WASI_FSTFLAGS_ATIM_NOW) !== 0
      ? now
      : (fstFlags & WASI_FSTFLAGS_ATIM) !== 0
      ? wasiTimestampToDate(atim)
      : undefined;
    const mtime = (fstFlags & WASI_FSTFLAGS_MTIM_NOW) !== 0
      ? now
      : (fstFlags & WASI_FSTFLAGS_MTIM) !== 0
      ? wasiTimestampToDate(mtim)
      : undefined;
    if (!atime && !mtime) {
      this.vfs.stat(absPath);
      return WASI_ESUCCESS;
    }
    if (!this.vfs.setTimes) return WASI_ENOSYS;
    this.withVfsCredentials(() => {
      this.vfs.setTimes!(absPath, atime, mtime, followSymlinks);
    });
    return WASI_ESUCCESS;
  }

  private clockResGet(clockId: number, resPtr: number): number {
    const view = this.getView();
    switch (clockId) {
      case WASI_CLOCK_REALTIME:
      case WASI_CLOCK_MONOTONIC:
        // Date.now() precision is 1ms = 1,000,000 nanoseconds
        view.setBigUint64(resPtr, BigInt(1_000_000), true);
        return WASI_ESUCCESS;
      default:
        return WASI_EINVAL;
    }
  }

  /**
   * path_link — POSIX hard link via VFS.link(). Both paths are resolved
   * against their WASI directory fds; authorization stays in the VFS.
   */
  private pathLink(
    oldDirFd: number,
    _oldFlags: number,
    oldPathPtr: number,
    oldPathLen: number,
    newDirFd: number,
    newPathPtr: number,
    newPathLen: number,
  ): number {
    this.checkDeadline();
    try {
      const oldRelative = this.readString(oldPathPtr, oldPathLen);
      const newRelative = this.readString(newPathPtr, newPathLen);
      const oldAbs = this.resolvePath(oldDirFd, oldRelative);
      const newAbs = this.resolvePath(newDirFd, newRelative);
      if (typeof this.vfs.link !== "function") {
        return WASI_ENOTSUP;
      }
      this.vfs.link(oldAbs, newAbs);
      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  private sockShutdown(fd: number, flags: number): number {
    const WASI_SDFLAGS_RD = 1;
    const WASI_SDFLAGS_WR = 2;
    const validFlags = WASI_SDFLAGS_RD | WASI_SDFLAGS_WR;
    if (flags === 0 || (flags & ~validFlags) !== 0) {
      return WASI_EINVAL;
    }

    const target = this.fdTarget(fd);
    if (!target) return WASI_EBADF;
    if (target.type !== "socket") return WASI_ENOTSOCK;
    if (target.socket === null) return WASI_EBADF;

    if ((flags & WASI_SDFLAGS_RD) !== 0) {
      target.readShutdown = true;
    }
    if ((flags & WASI_SDFLAGS_WR) !== 0) {
      target.writeShutdown = true;
    }
    if ((flags & validFlags) === validFlags) {
      const socket = target.socket;
      target.socket = null;
      target.close(socket);
    }

    return WASI_ESUCCESS;
  }

  renumberFd(fromFd: number, toFd: number): number {
    return this.fdRenumber(fromFd, toFd);
  }

  private fdRenumber(fromFd: number, toFd: number): number {
    if (fromFd === toFd) {
      return this.hasOpenFd(fromFd) ? WASI_ESUCCESS : WASI_EBADF;
    }

    if (this.kernel && this.pid !== undefined) {
      const kernelTarget = this.kernel.getFdTarget(this.pid, fromFd);
      if (kernelTarget) {
        try {
          this.kernel.dup2(this.pid, fromFd, toFd);
          this.kernel.closeFd(this.pid, fromFd);
          const dirPath = this.dirFds.get(fromFd);
          if (dirPath !== undefined) {
            this.dirFds.delete(fromFd);
            this.dirFds.set(toFd, dirPath);
          } else {
            this.dirFds.delete(toFd);
          }
          this.ioFds.delete(fromFd);
          return WASI_ESUCCESS;
        } catch (err) {
          return fdErrorToWasi(err);
        }
      }
    }

    if (this.fdTable.isOpen(fromFd)) {
      try {
        if (
          this.ioFds.has(toFd) &&
          !(this.ioFds.get(toFd)?.type === "vfs_file" &&
            this.fdTable.isOpen(toFd))
        ) {
          if (this.kernel && this.pid !== undefined) {
            this.kernel.closeFd(this.pid, toFd);
          } else this.ioFds.delete(toFd);
        }
        if (this.dirFds.has(toFd)) {
          this.dirFds.delete(toFd);
        }
        if (this.fdTable.isOpen(toFd)) {
          this.fdTable.close(toFd);
        }

        this.fdTable.renumber(fromFd, toFd);

        const fromTarget = this.ioFds.get(fromFd);
        if (
          fromTarget?.type === "vfs_file" && fromTarget.fdTable === this.fdTable
        ) {
          this.ioFds.delete(fromFd);
        }
        if (this.kernel && this.pid !== undefined) {
          this.kernel.setFdTarget(
            this.pid,
            toFd,
            createVfsFileTarget(this.fdTable, toFd),
          );
        }
        return WASI_ESUCCESS;
      } catch (err) {
        return fdErrorToWasi(err);
      }
    }

    const ioTarget = this.ioFds.get(fromFd);
    if (ioTarget) {
      if (this.kernel && this.pid !== undefined) {
        try {
          this.kernel.dup2(this.pid, fromFd, toFd);
          this.kernel.closeFd(this.pid, fromFd);
        } catch {
          // The local ioFds map is authoritative for this WasiHost.
        }
      }
      this.ioFds.delete(fromFd);
      this.ioFds.set(toFd, ioTarget);
      return WASI_ESUCCESS;
    }

    if (this.ioFds.has(toFd)) {
      this.ioFds.delete(toFd);
      if (this.kernel && this.pid !== undefined) {
        this.kernel.closeFd(this.pid, toFd);
      }
    }

    // Handle dirFd sources
    const fromDirPath = this.dirFds.get(fromFd);
    if (fromDirPath !== undefined) {
      if (this.dirFds.has(toFd)) {
        this.dirFds.delete(toFd);
      }
      if (this.fdTable.isOpen(toFd)) {
        try {
          this.fdTable.close(toFd);
        } catch { /* ignore */ }
      }
      this.dirFds.set(toFd, fromDirPath);
      this.dirFds.delete(fromFd);
      return WASI_ESUCCESS;
    }

    // Handle regular fd sources
    if (!this.fdTable.isOpen(fromFd)) {
      return WASI_EBADF;
    }

    try {
      if (this.dirFds.has(toFd)) {
        this.dirFds.delete(toFd);
      }
      this.fdTable.renumber(fromFd, toFd);
      return WASI_ESUCCESS;
    } catch (err) {
      return fdErrorToWasi(err);
    }
  }

  private pollOneoff(
    inPtr: number,
    outPtr: number,
    nsubscriptions: number,
    neventsPtr: number,
  ): number | Promise<number> {
    this.checkDeadline();

    if (nsubscriptions === 0) {
      return WASI_EINVAL;
    }

    const view = this.getView();
    const events: Array<{
      userdata: bigint;
      error: number;
      type: number;
      nbytes: bigint;
      flags: number;
    }> = [];

    let earliestClockDeadlineMs = Infinity;
    let hasClockSub = false;
    const clockSubs: Array<
      { userdata: bigint; deadlineMs: number; base: number }
    > = [];
    const readinessWaits: Array<Promise<void>> = [];

    // Parse all subscriptions (48 bytes each)
    for (let i = 0; i < nsubscriptions; i++) {
      const base = inPtr + i * 48;
      const userdata = view.getBigUint64(base, true);
      const type = view.getUint8(base + 8);

      if (type === WASI_EVENTTYPE_CLOCK) {
        hasClockSub = true;
        const timeout = view.getBigUint64(base + 24, true);
        const flags = view.getUint16(base + 40, true);
        const isAbsolute =
          (flags & WASI_SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME) !== 0;

        let deadlineMs: number;
        if (isAbsolute) {
          deadlineMs = Number(timeout / BigInt(1_000_000));
        } else {
          deadlineMs = Date.now() + Number(timeout / BigInt(1_000_000));
        }

        clockSubs.push({ userdata, deadlineMs, base });
        if (deadlineMs < earliestClockDeadlineMs) {
          earliestClockDeadlineMs = deadlineMs;
        }
      } else if (
        type === WASI_EVENTTYPE_FD_READ || type === WASI_EVENTTYPE_FD_WRITE
      ) {
        const fd = view.getUint32(base + 16, true);
        const target = this.fdTarget(fd);

        let ready = false;
        let hangup = false;
        let nbytes = BigInt(0);

        if (target) {
          if (type === WASI_EVENTTYPE_FD_READ && target.type === "tty_slave") {
            ready = target.state.toSlave.length > 0;
            hangup = target.state.masterClosed;
            nbytes = ready
              ? BigInt(
                target.state.toSlave.reduce((s, c) => s + c.byteLength, 0),
              )
              : BigInt(0);
          } else if (
            type === WASI_EVENTTYPE_FD_READ && target.type === "pipe_read"
          ) {
            ready = target.pipe.hasData;
            hangup = target.pipe.closed;
            if (!ready) readinessWaits.push(target.pipe.waitReadable());
          } else if (
            type === WASI_EVENTTYPE_FD_WRITE && target.type === "pipe_write"
          ) {
            ready = target.pipe.hasCapacity;
            hangup = target.pipe.closed;
          } else if (target.type === "socket") {
            ready = true;
            nbytes = BigInt(1);
          } else if (target.type === "static") {
            ready = true;
            nbytes = BigInt(target.data.byteLength - target.offset);
          } else if (target.type === "null") {
            ready = true;
          } else if (target.type === "buffer") {
            ready = type === WASI_EVENTTYPE_FD_WRITE;
          } else if (target.type === "vfs_file" || target.type === "vfs_dir") {
            ready = true;
          }
        } else if (this.fdTable.isOpen(fd)) {
          ready = true; // VFS-backed fds are always ready
        } else {
          events.push({
            userdata,
            error: WASI_EBADF,
            type,
            nbytes: BigInt(0),
            flags: 0,
          });
          continue;
        }

        if (ready) {
          events.push({
            userdata,
            error: WASI_ESUCCESS,
            type,
            nbytes,
            flags: hangup ? WASI_EVENTRWFLAGS_FD_READWRITE_HANGUP : 0,
          });
        }
      }
    }

    // If any fd events are ready, return immediately
    if (events.length > 0) {
      return this.writePollEvents(outPtr, neventsPtr, events);
    }

    // Wait for earliest clock subscription
    if (hasClockSub) {
      const now = Date.now();

      for (const sub of clockSubs) {
        if (sub.deadlineMs <= now) {
          events.push({
            userdata: sub.userdata,
            error: WASI_ESUCCESS,
            type: WASI_EVENTTYPE_CLOCK,
            nbytes: BigInt(0),
            flags: 0,
          });
        }
      }

      if (events.length > 0) {
        return this.writePollEvents(outPtr, neventsPtr, events);
      }

      // Clamp to sandbox deadline
      const waitMs = Math.max(
        0,
        Math.min(
          earliestClockDeadlineMs - now,
          this.deadlineMs - now,
        ),
      );
      const pollWithPreservedClockDeadlines = () => {
        const patched = clockSubs.map((sub) => {
          const timeoutOffset = sub.base + 24;
          const flagsOffset = sub.base + 40;
          const timeout = view.getBigUint64(timeoutOffset, true);
          const flags = view.getUint16(flagsOffset, true);
          view.setBigUint64(
            timeoutOffset,
            BigInt(Math.max(0, Math.trunc(sub.deadlineMs))) * 1_000_000n,
            true,
          );
          view.setUint16(
            flagsOffset,
            flags | WASI_SUBCLOCKFLAGS_SUBSCRIPTION_CLOCK_ABSTIME,
            true,
          );
          return { timeoutOffset, flagsOffset, timeout, flags };
        });
        try {
          return this.pollOneoff(inPtr, outPtr, nsubscriptions, neventsPtr);
        } finally {
          for (const patch of patched) {
            view.setBigUint64(patch.timeoutOffset, patch.timeout, true);
            view.setUint16(patch.flagsOffset, patch.flags, true);
          }
        }
      };

      return new Promise<number>((resolve, reject) => {
        let done = false;
        const signalWait = this.waitForSignalDelivery();
        const finish = (value: number | Promise<number>) => {
          if (done) return;
          done = true;
          signalWait.cancel();
          Promise.resolve(value).then(resolve, reject);
        };
        const fail = (error: unknown) => {
          if (done) return;
          done = true;
          signalWait.cancel();
          reject(error);
        };
        const timeoutId = setTimeout(() => {
          try {
            this.checkDeadline();
            const afterWait = Date.now();
            for (const sub of clockSubs) {
              if (sub.deadlineMs <= afterWait) {
                events.push({
                  userdata: sub.userdata,
                  error: WASI_ESUCCESS,
                  type: WASI_EVENTTYPE_CLOCK,
                  nbytes: BigInt(0),
                  flags: 0,
                });
              }
            }
            if (events.length === 0) {
              events.push({
                userdata: clockSubs[0].userdata,
                error: WASI_ESUCCESS,
                type: WASI_EVENTTYPE_CLOCK,
                nbytes: BigInt(0),
                flags: 0,
              });
            }
            finish(this.writePollEvents(outPtr, neventsPtr, events));
          } catch (error) {
            fail(error);
          }
        }, waitMs);
        const readiness = readinessWaits.length > 0
          ? Promise.race(readinessWaits)
          : new Promise<void>(() => {});
        Promise.race([readiness, signalWait.promise]).then(() => {
          if (!done) {
            clearTimeout(timeoutId);
            try {
              finish(pollWithPreservedClockDeadlines());
            } catch (error) {
              fail(error);
            }
          }
        }, fail);
      });
    }

    if (readinessWaits.length > 0) {
      return new Promise<number>((resolve, reject) => {
        const signalWait = this.waitForSignalDelivery();
        Promise.race([...readinessWaits, signalWait.promise]).then(() => {
          signalWait.cancel();
          try {
            Promise.resolve(
              this.pollOneoff(inPtr, outPtr, nsubscriptions, neventsPtr),
            ).then(resolve, reject);
          } catch (error) {
            reject(error);
          }
        }, (error) => {
          signalWait.cancel();
          reject(error);
        });
      });
    }

    return WASI_EINVAL;
  }

  /** Write poll events to WASM memory and return ESUCCESS. */
  private writePollEvents(
    outPtr: number,
    neventsPtr: number,
    events: Array<{
      userdata: bigint;
      error: number;
      type: number;
      nbytes: bigint;
      flags: number;
    }>,
  ): number {
    const view = this.getView();
    for (let i = 0; i < events.length; i++) {
      const base = outPtr + i * 32;
      const ev = events[i];
      view.setBigUint64(base, ev.userdata, true);
      view.setUint16(base + 8, ev.error, true);
      view.setUint8(base + 10, ev.type);
      view.setUint8(base + 11, 0);
      view.setUint32(base + 12, 0, true);
      view.setBigUint64(base + 16, ev.nbytes, true);
      view.setUint16(base + 24, ev.flags, true);
      view.setUint16(base + 26, 0, true);
      view.setUint32(base + 28, 0, true);
    }
    view.setUint32(neventsPtr, events.length, true);
    return WASI_ESUCCESS;
  }

  private stub(): number {
    return WASI_ENOSYS;
  }

  /** No-op WASI stub — returns success.  Used for operations that are safe to
   *  skip in a single-threaded sandbox (sync, timestamps, flags, etc.). */
  private fdNoOp(): number {
    return WASI_ESUCCESS;
  }

  // ---- Internal helpers ----

  /** Allocate a pseudo-fd for an opened directory. */
  private allocateDirFd(absPath: string): number {
    const fd = this.nextDirFd();
    this.dirFds.set(fd, absPath);
    if (this.kernel && this.pid !== undefined) {
      this.kernel.setFdTarget(this.pid, fd, createVfsDirTarget(absPath));
    }
    return fd;
  }

  private allocateIoFd(target: FdTarget): number {
    const fd = this.nextDirFd();
    this.ioFds.set(fd, target);
    if (this.kernel && this.pid !== undefined) {
      this.kernel.setFdTarget(this.pid, fd, target);
    }
    return fd;
  }

  /** Track the next available fd for directory pseudo-fds. */
  private _nextDirFdCounter = 100; // Start high to avoid collision with FdTable

  private nextDirFd(): number {
    return this._nextDirFdCounter++;
  }

  private resolveDisplayedProcDirFd(fd: number): number | null {
    if (fd !== 3 || !this.isPreopenFd(3)) return null;
    const procDirFd = Array.from(this.dirFds.keys())
      .filter((candidate) => candidate >= 100)
      .sort((a, b) => a - b)[0];
    return procDirFd ?? null;
  }

  /** Write a WASI filestat structure at bufPtr for the given VFS path. */
  private writeFilestat(
    bufPtr: number,
    absPath: string,
    followSymlinks = true,
  ): number {
    try {
      const stat = followSymlinks
        ? this.vfs.stat(absPath)
        : this.vfs.lstat(absPath);
      const view = this.getView();

      // filestat layout (64 bytes):
      //   u64 dev          (offset 0)
      //   u64 ino          (offset 8)
      //   u8  filetype     (offset 16) + 7 bytes padding
      //   u64 nlink        (offset 24)
      //   u64 size         (offset 32)
      //   u64 atim         (offset 40)
      //   u64 mtim         (offset 48)
      //   u64 ctim         (offset 56)

      const inodePath = followSymlinks
        ? canonicalStatPath(this.vfs, absPath)
        : normalizeVfsPath(absPath);
      view.setBigUint64(bufPtr, yurtStatDevice(stat), true); // dev (Yurt stat metadata side channel)
      view.setBigUint64(bufPtr + 8, stablePathInode(inodePath), true); // ino
      view.setUint8(bufPtr + 16, inodeTypeToWasiFiletype(stat.type)); // filetype
      // padding bytes 17-23
      for (let i = 17; i < 24; i++) {
        view.setUint8(bufPtr + i, 0);
      }
      view.setBigUint64(bufPtr + 24, BigInt(1), true); // nlink
      view.setBigUint64(bufPtr + 32, BigInt(stat.size), true); // size
      view.setBigUint64(
        bufPtr + 40,
        BigInt(stat.atime.getTime()) * BigInt(1_000_000),
        true,
      ); // atim
      view.setBigUint64(
        bufPtr + 48,
        BigInt(stat.mtime.getTime()) * BigInt(1_000_000),
        true,
      ); // mtim
      view.setBigUint64(
        bufPtr + 56,
        BigInt(stat.ctime.getTime()) * BigInt(1_000_000),
        true,
      ); // ctim

      return WASI_ESUCCESS;
    } catch (err) {
      if (err instanceof VfsError) {
        return vfsErrnoToWasi(err.errno);
      }
      return fdErrorToWasi(err);
    }
  }

  /** Write a minimal character device stat (for stdio fds). */
  private writeCharDeviceStat(bufPtr: number): number {
    const view = this.getView();
    // Zero out the entire 64-byte structure
    for (let i = 0; i < 64; i++) {
      view.setUint8(bufPtr + i, 0);
    }
    view.setUint8(bufPtr + 16, WASI_FILETYPE_CHARACTER_DEVICE);
    return WASI_ESUCCESS;
  }
}
