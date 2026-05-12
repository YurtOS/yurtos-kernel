/**
 * Sandboxed-kernel microkernel — portable JS / WebAssembly core.
 *
 * Runs unchanged in every JS engine: Deno, browsers (with JSPI or
 * asyncify when blocking syscalls land), Node, Bun. Browsers and
 * Deno share enough — WebAssembly, fetch, crypto, IndexedDB,
 * WebSocket — that there's no separate `microkernel-browser`. They
 * use *this* package directly.
 *
 * No host-specific APIs (no `Deno.*`, no `fs`, no `Worker`); only
 * `crypto` and `WebAssembly`, which are universal.
 *
 * Loads `yurt-kernel-wasm` (compiled to `wasm32-wasip1`), satisfies
 * the documented `kh_*` import surface, and runs the same kernel.wasm
 * artifact the wasmtime backend uses.
 *
 * Where engines actually differ:
 *   - **Real TCP sockets, real filesystem, real subprocess.** Only
 *     Deno (and Node) have these natively. They live in
 *     `packages/microkernel-deno/` as a thin extension consumed on
 *     top of this core.
 *   - **Service-Worker fetch routing, OPFS, IndexedDB persistence,**
 *     **postMessage to a host page.** Those are browser-page concerns
 *     above the microkernel — they live in the application layer
 *     (e.g. PR15's `sandbox.net` / `ListenerRegistry`), not as a
 *     parallel microkernel package.
 *
 * User-process syscall plumbing lives in two sibling files inside
 * this package:
 *   - `sys_shim.ts` — `sys_*` imports that forward to `kernel_dispatch`.
 *   - `wasi_shim.ts` — preview1 imports that route through `sys_*`.
 *
 * This file is the engine binding plus `kh_*` plus the spawn glue.
 *
 * Async / suspension story (future):
 *   The TS kernel ships `AsyncBridge` at
 *   `packages/kernel/src/async-bridge.ts` with jspi / asyncify /
 *   threads modes. When this microkernel grows blocking syscalls or
 *   a scheduler with multiple concurrent processes, the sys_*
 *   wrappers in `sys_shim.ts` become `bridge.wrapImport(asyncFn)` and
 *   `kernel_dispatch` is wrapped with `bridge.wrapExport(...)`. Every
 *   sys_* call is a suspension point on JS engines — that's the only
 *   way the scheduler can preempt a process.
 *
 * See `docs/superpowers/specs/2026-05-09-sandboxed-kernel-design.md`.
 */

import { buildSysImports } from "./sys_shim.ts";
import { buildWasiShim } from "./wasi_shim.ts";

interface FileSystemWritableFileStream {
  truncate(size: number): Promise<void>;
  write(
    chunk: Uint8Array | { type: "write"; position: number; data: Uint8Array },
  ): Promise<void>;
  close(): Promise<void>;
}

interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(
    options?: { keepExistingData?: boolean },
  ): Promise<FileSystemWritableFileStream>;
}

interface FileSystemDirectoryHandle {
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
  removeEntry(name: string): Promise<void>;
}

interface IDBRequest<T> {
  result: T;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface IDBOpenDBRequest extends IDBRequest<IDBDatabase> {
  onupgradeneeded: (() => void) | null;
}

interface IDBObjectStore {
  get(key: Uint8Array): IDBRequest<Uint8Array | undefined>;
  put(value: Uint8Array, key: Uint8Array): IDBRequest<unknown>;
  delete(key: Uint8Array): IDBRequest<unknown>;
  getAllKeys(): IDBRequest<Uint8Array[]>;
}

interface IDBTransaction {
  objectStore(name: string): IDBObjectStore;
}

interface IDBDatabase {
  objectStoreNames: { contains(name: string): boolean };
  version: number;
  close(): void;
  createObjectStore(name: string): void;
  transaction(name: string, mode: "readonly" | "readwrite"): IDBTransaction;
}

interface IDBFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

// ── Method IDs (must match abi/contract/yurt_abi_methods.toml) ────────────

export const METHOD = {
  KERNEL_ECHO: 1,
  KERNEL_NOW_REALTIME: 2,
  KERNEL_LOG_TEST: 3,
  KERNEL_PROVIDE_STDIN: 4,
  KERNEL_CLOSE_STDIN: 5,
  KERNEL_DRAIN_STDOUT: 6,
  KERNEL_DRAIN_STDERR: 7,
  KERNEL_REGISTER_FILE: 8,
  KERNEL_SET_ARGV: 9,
  KERNEL_INSTALL_TAR_LAYER: 10,
  KERNEL_INSTALL_HOST_FS_MOUNT: 11,
  KERNEL_INSTALL_YURTFS: 12,
  KERNEL_REGISTER_CHILD: 13,
  KERNEL_RECORD_EXIT: 14,
  KERNEL_DRAIN_SPAWN: 15,
  KERNEL_LIST_PROCESSES: 16,
  SYS_GETUID: 0x1_0001,
  SYS_GETEUID: 0x1_0002,
  SYS_GETGID: 0x1_0003,
  SYS_GETEGID: 0x1_0004,
  SYS_GETPID: 0x1_0005,
  SYS_GETPPID: 0x1_0006,
  SYS_UMASK: 0x1_0007,
  SYS_SETRESUID: 0x1_0008,
  SYS_SETRESGID: 0x1_0009,
  SYS_CHDIR: 0x1_000A,
  SYS_GETCWD: 0x1_000B,
  SYS_GETRLIMIT: 0x1_000C,
  SYS_SETRLIMIT: 0x1_000D,
  SYS_CLOSE: 0x1_000E,
  SYS_DUP: 0x1_000F,
  SYS_EXTENSION_INVOKE: 0x1_0010,
  SYS_DUP2: 0x1_0011,
  SYS_PIPE: 0x1_0012,
  SYS_READ: 0x1_0013,
  SYS_WRITE: 0x1_0014,
  SYS_ISATTY: 0x1_0015,
  SYS_CLOCK_GETTIME: 0x1_0016,
  SYS_GETPGID: 0x1_0017,
  SYS_SETPGID: 0x1_0018,
  SYS_GETSID: 0x1_0019,
  SYS_SETSID: 0x1_001A,
  SYS_KILL: 0x1_001B,
  SYS_SIGACTION: 0x1_001C,
  SYS_SCHED_YIELD: 0x1_001D,
  SYS_NANOSLEEP: 0x1_001E,
  SYS_OPEN: 0x1_001F,
  SYS_LSEEK: 0x1_0020,
  SYS_FSTAT: 0x1_0021,
  SYS_CHMOD: 0x1_0022,
  SYS_CHOWN: 0x1_0023,
  SYS_UTIMENS: 0x1_0024,
  SYS_UNLINK: 0x1_0025,
  SYS_STAT: 0x1_0026,
  SYS_SYMLINK: 0x1_0027,
  SYS_READLINK: 0x1_0028,
  SYS_MKDIR: 0x1_0029,
  SYS_RMDIR: 0x1_002A,
  SYS_READDIR: 0x1_002B,
  SYS_WAIT: 0x1_002C,
  SYS_LINK: 0x1_002D,
  SYS_RENAME: 0x1_002E,
  SYS_SPAWN: 0x1_002F,
  SYS_FETCH: 0x1_0030,
  SYS_SOCKET_CONNECT: 0x1_0031,
  SYS_SOCKET_SEND: 0x1_0032,
  SYS_SOCKET_RECV: 0x1_0033,
  SYS_SOCKET_CLOSE: 0x1_0034,
  SYS_IDB_GET: 0x1_0035,
  SYS_IDB_PUT: 0x1_0036,
  SYS_IDB_DELETE: 0x1_0037,
  SYS_IDB_LIST: 0x1_0038,
  SYS_SOCKET_LISTEN: 0x1_0039,
  SYS_SOCKET_ACCEPT: 0x1_003A,
  SYS_SOCKET_ADDR: 0x1_003B,
} as const;

export const KERNEL_PID = 0;

export interface ProcessSnapshot {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  state: "running" | "exited";
  exitStatus: number;
  command: Uint8Array;
  fds: number[];
}

export interface WaitResult {
  pid: number;
  status: number;
}

// ── Embedder-supplied traits ──────────────────────────────────────────────

export interface ExtensionRegistry {
  invoke(request: Uint8Array, responseCap: number): Uint8Array | number;
}

export interface LogSink {
  emit(severity: number, message: string): void;
}

/**
 * Policy decisions returned from {@link PolicyEnforcer} hooks.
 * Synchronous so embedders can plug in any blocking prompt
 * (browser dialog, CLI, "ask the human") behind a single method.
 */
export type PolicyDecision = "allow" | "deny";

/**
 * Embedder-supplied gate that sits at every `kh_*` crossing where
 * kernel.wasm is about to reach the outside world. Mirrors the
 * Rust-side `PolicyEnforcer` trait exactly so the same harness can
 * gate either microkernel backend.
 *
 * Defaults to Allow on every hook so embedders that don't care
 * about policy don't have to implement it. Embedders that do care
 * override the relevant methods.
 *
 * Hooks fire *before* the embedder's I/O code (extension registry,
 * log sink, eventual fs/socket bridges); a Deny short-circuits with
 * `-EACCES`.
 */
export interface PolicyEnforcer {
  /** Gate kh_extension_invoke. Default Allow. */
  mayInvokeExtension?(request: Uint8Array): PolicyDecision;
  /** Gate kh_real_fs_* (not wired yet). */
  mayOpenPath?(path: Uint8Array, write: boolean): PolicyDecision;
  /** Gate kh_socket_connect (not wired yet). */
  mayConnect?(host: string, port: number): PolicyDecision;
  /** Gate kh_socket_listen (not wired yet). */
  mayListen?(port: number): PolicyDecision;
  /** Gate kh_log emissions per message. */
  mayLog?(severity: number, message: string): PolicyDecision;
  /** Gate kh_now_realtime. */
  mayGetRealtime?(): PolicyDecision;
  /** Gate kh_fetch_blocking. `request` is the JSON document. */
  mayFetch?(request: Uint8Array): PolicyDecision;
  /** Gate kh_idb_*. `write` distinguishes mutating ops. */
  mayIdb?(store: Uint8Array, write: boolean): PolicyDecision;
}

/**
 * Pluggable host filesystem. Mirrors the Rust `HostFsImpl` trait
 * — every kh_real_* import goes through this interface when
 * `HostState.hostFs` is set. Browser microkernels back this with
 * OPFS, Deno embedders with Deno.openSync, etc.
 */
export interface HostFsImpl {
  open(path: Uint8Array, flags: number): number;
  read(fd: number, buf: Uint8Array): number;
  write(fd: number, data: Uint8Array): number;
  close(fd: number): number;
  stat(path: Uint8Array): HostFsStat | number; // number = -errno
  unlink(path: Uint8Array): number;
  mkdir(path: Uint8Array, mode: number): number;
  symlink(target: Uint8Array, linkPath: Uint8Array): number;
  rename(oldPath: Uint8Array, newPath: Uint8Array): number;
  /**
   * Optional async variants for hosts where the underlying FS
   * primitive is Promise-shaped (OPFS, S3, Cloudflare R2, etc.).
   * When present AND JSPI is available, the matching kh_real_*
   * import is wrapped with `WebAssembly.Suspending` so userland's
   * sys_open / sys_read / etc. actually suspend until the I/O
   * completes. Without JSPI these are ignored and the sync
   * variants run.
   */
  openAsync?(path: Uint8Array, flags: number): Promise<number>;
  readAsync?(fd: number, buf: Uint8Array): Promise<number>;
  writeAsync?(fd: number, data: Uint8Array): Promise<number>;
  closeAsync?(fd: number): Promise<number>;
  statAsync?(path: Uint8Array): Promise<HostFsStat | number>;
  unlinkAsync?(path: Uint8Array): Promise<number>;
  mkdirAsync?(path: Uint8Array, mode: number): Promise<number>;
  symlinkAsync?(target: Uint8Array, linkPath: Uint8Array): Promise<number>;
  renameAsync?(oldPath: Uint8Array, newPath: Uint8Array): Promise<number>;
}

export interface HostFsStat {
  size: bigint;
  mode: number;
  mtimeNs: bigint;
  isDir: boolean;
  isSymlink: boolean;
}

/**
 * Pluggable durable KV. Mirrors the Rust `KvBackend` trait. Browser
 * microkernels back this with IndexedDB; native deployments with
 * redb / sled / rocksdb / SQLite.
 */
export interface KvBackend {
  get(store: Uint8Array, key: Uint8Array): Uint8Array | number; // number = -errno
  put(store: Uint8Array, key: Uint8Array, value: Uint8Array): number;
  delete(store: Uint8Array, key: Uint8Array): number;
  list(store: Uint8Array, prefix: Uint8Array): Uint8Array[];
  /**
   * Optional async variants. When present AND the host supports
   * JSPI, the matching kh_idb_* import is wrapped with
   * `WebAssembly.Suspending` so userland's syscall actually
   * suspends until the IndexedDB transaction (or other async
   * backing store) resolves. Without JSPI these are ignored and
   * the sync variants run.
   */
  getAsync?(store: Uint8Array, key: Uint8Array): Promise<Uint8Array | number>;
  putAsync?(
    store: Uint8Array,
    key: Uint8Array,
    value: Uint8Array,
  ): Promise<number>;
  deleteAsync?(store: Uint8Array, key: Uint8Array): Promise<number>;
  listAsync?(store: Uint8Array, prefix: Uint8Array): Promise<Uint8Array[]>;
}

/**
 * Pluggable outbound TCP backend. Mirrors the Rust `TcpSocketImpl`
 * trait. Browser microkernels relay through WebSocket / Service
 * Worker; Deno wraps Deno.connect / Deno.listen.
 */
export interface TcpSocketImpl {
  connect(host: string, port: number, flags: number): number;
  send(handle: number, data: Uint8Array): number;
  recv(handle: number, buf: Uint8Array, flags: number): number;
  close(handle: number): number;
  listen(host: string, port: number, backlog: number): number;
  accept(handle: number, flags: number): number;
  localAddr(handle: number): { host: string; port: number } | null;
  /**
   * Optional async variants for hosts where the underlying
   * primitive (Deno.connect, fetch + WebSocket, ...) returns a
   * Promise. When present AND the host supports JSPI, the
   * matching kh_socket_* import is wrapped with
   * `WebAssembly.Suspending` and userland's syscall actually
   * suspends until the I/O completes. Without JSPI these are
   * ignored and the sync variants run.
   */
  connectAsync?(host: string, port: number, flags: number): Promise<number>;
  recvAsync?(handle: number, buf: Uint8Array, flags: number): Promise<number>;
  acceptAsync?(handle: number, flags: number): Promise<number>;
}

export interface HostState {
  nowRealtimeNs: bigint;
  extensions: ExtensionRegistry;
  logSink: LogSink;
  policy: PolicyEnforcer;
  /** When set, every `kh_real_*` import delegates here. */
  hostFs?: HostFsImpl;
  /** When set, every `kh_idb_*` import delegates here. */
  kv?: KvBackend;
  /** When set, every `kh_socket_*` import delegates here. */
  tcp?: TcpSocketImpl;
  /**
   * Async outbound fetch. When set AND the host supports JSPI,
   * `kh_fetch_blocking` is wrapped with `WebAssembly.Suspending`
   * and the user's `sys_fetch` actually awaits the response —
   * the calling wasm suspends at the trampoline boundary. Without
   * JSPI (Safari today, Node/Deno without --jspi), the slot is
   * ignored and `kh_fetch_blocking` returns -ENOSYS.
   *
   * The function takes the JSON request bytes, returns the JSON
   * response bytes (same shape as the existing `host_network_fetch`
   * encoding). Browser microkernels wrap `globalThis.fetch`; Deno
   * embedders wrap `globalThis.fetch` too (it's in the platform).
   */
  fetch?: (request: Uint8Array) => Promise<Uint8Array>;
  /**
   * Bridge that lets kh_* handlers suspend the calling wasm until
   * a JS Promise resolves. Default is `noopAsyncBridge` (every
   * blocking attempt throws "NOT_SUSPENDABLE"); embedders that
   * want real async I/O install one of:
   *
   * - **JSPI** (V8 / SpiderMonkey, Chrome 137+, recent Firefox,
   *   Deno via V8): wrap kh imports with `WebAssembly.Suspending`
   *   and the kernel_dispatch export with `WebAssembly.promising`.
   *   Every syscall becomes async at the JS boundary.
   * - **Asyncify**: kernel.wasm + user wasm built with binaryen
   *   `--asyncify`. Engine-agnostic; works on Safari and old
   *   browsers but adds ~30% binary-size overhead.
   * - **Stack Switching**: when wasmer / Chrome ship the proposal
   *   stably, supersedes both.
   *
   * Async-capable kh_* handlers (kh_fetch_blocking,
   * kh_socket_recv, kh_socket_accept_blocking) check
   * `asyncBridge.capabilities()` and either route through
   * `suspendUntil` or return -ENOSYS when no path is available.
   * See project memory `project_async_bridge` for the matrix.
   */
  asyncBridge?: AsyncBridge;
}

const ENOENT = 2;
const EFAULT = 14;
const EACCES = 13;
const EBADF = 9;
const EEXIST = 17;
const E2BIG = 7;
const EIO = 5;
const ENOSYS = 38;

class EmptyExtensionRegistry implements ExtensionRegistry {
  invoke(): number {
    return -ENOENT;
  }
}

class DiscardLogSink implements LogSink {
  emit(): void {}
}

/**
 * Map-backed [`HostFsImpl`]. Useful for tests and for browser
 * microkernels that haven't wired up OPFS yet.
 */
export class InMemoryHostFs implements HostFsImpl {
  private files = new Map<string, Uint8Array>();
  private dirs = new Set<string>();
  private symlinks = new Map<string, Uint8Array>();
  private fds = new Map<number, { path: string; cursor: number }>();
  private nextFd = 1;

  installFile(path: Uint8Array, content: Uint8Array): void {
    this.files.set(this.bkey(path), content);
  }

  private bkey(b: Uint8Array): string {
    // Use a binary-faithful key; raw byte-string indexing.
    return Array.from(b).map((x) => x.toString(36)).join(",");
  }

  open(path: Uint8Array, flags: number): number {
    const key = this.bkey(path);
    const writable = (flags & 0b001) !== 0;
    const create = (flags & 0b010) !== 0;
    const trunc = (flags & 0b100) !== 0;
    if (!this.files.has(key)) {
      if (!create) return -ENOENT;
      if (!writable) return -EACCES;
      this.files.set(key, new Uint8Array(0));
    } else if (trunc && writable) {
      this.files.set(key, new Uint8Array(0));
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { path: key, cursor: 0 });
    return fd;
  }

  read(fd: number, buf: Uint8Array): number {
    const entry = this.fds.get(fd);
    if (!entry) return -EBADF;
    const content = this.files.get(entry.path);
    if (!content) return -EBADF;
    const start = Math.min(entry.cursor, content.byteLength);
    const n = Math.min(buf.byteLength, content.byteLength - start);
    if (n > 0) buf.set(content.subarray(start, start + n));
    entry.cursor += n;
    return n;
  }

  write(fd: number, data: Uint8Array): number {
    const entry = this.fds.get(fd);
    if (!entry) return -EBADF;
    const content = this.files.get(entry.path);
    if (!content) return -EBADF;
    const start = entry.cursor;
    const end = start + data.byteLength;
    if (end > content.byteLength) {
      const grown = new Uint8Array(end);
      grown.set(content);
      this.files.set(entry.path, grown);
    }
    this.files.get(entry.path)!.set(data, start);
    entry.cursor += data.byteLength;
    return data.byteLength;
  }

  close(fd: number): number {
    this.fds.delete(fd);
    return 0;
  }

  stat(path: Uint8Array): HostFsStat | number {
    const key = this.bkey(path);
    const f = this.files.get(key);
    if (f) {
      return {
        size: BigInt(f.byteLength),
        mode: 0o100_644,
        mtimeNs: 0n,
        isDir: false,
        isSymlink: false,
      };
    }
    if (this.dirs.has(key)) {
      return {
        size: 0n,
        mode: 0o040_755,
        mtimeNs: 0n,
        isDir: true,
        isSymlink: false,
      };
    }
    if (this.symlinks.has(key)) {
      return {
        size: 0n,
        mode: 0o120_777,
        mtimeNs: 0n,
        isDir: false,
        isSymlink: true,
      };
    }
    return -ENOENT;
  }

  unlink(path: Uint8Array): number {
    const key = this.bkey(path);
    if (this.symlinks.delete(key)) return 0;
    if (this.files.delete(key)) return 0;
    return -ENOENT;
  }

  mkdir(path: Uint8Array, _mode: number): number {
    const key = this.bkey(path);
    if (this.dirs.has(key) || this.files.has(key)) return -EEXIST;
    this.dirs.add(key);
    return 0;
  }

  symlink(target: Uint8Array, linkPath: Uint8Array): number {
    const key = this.bkey(linkPath);
    if (
      this.files.has(key) ||
      this.symlinks.has(key) ||
      this.dirs.has(key)
    ) return -EEXIST;
    this.symlinks.set(key, target);
    return 0;
  }

  rename(oldPath: Uint8Array, newPath: Uint8Array): number {
    const ok = this.bkey(oldPath);
    const nk = this.bkey(newPath);
    if (this.files.has(ok)) {
      this.files.set(nk, this.files.get(ok)!);
      this.files.delete(ok);
      return 0;
    }
    if (this.symlinks.has(ok)) {
      this.symlinks.set(nk, this.symlinks.get(ok)!);
      this.symlinks.delete(ok);
      return 0;
    }
    if (this.dirs.has(ok)) {
      this.dirs.delete(ok);
      this.dirs.add(nk);
      return 0;
    }
    return -ENOENT;
  }
}

/** Map-backed [`KvBackend`]. */
export class InMemoryKv implements KvBackend {
  private store = new Map<string, Uint8Array>();
  private composite(s: Uint8Array, k: Uint8Array): string {
    return s.byteLength + ":" + Array.from(s).join(",") + "|" +
      Array.from(k).join(",");
  }
  get(store: Uint8Array, key: Uint8Array): Uint8Array | number {
    const v = this.store.get(this.composite(store, key));
    return v ?? -ENOENT;
  }
  put(store: Uint8Array, key: Uint8Array, value: Uint8Array): number {
    this.store.set(this.composite(store, key), value);
    return 0;
  }
  delete(store: Uint8Array, key: Uint8Array): number {
    this.store.delete(this.composite(store, key));
    return 0;
  }
  list(store: Uint8Array, prefix: Uint8Array): Uint8Array[] {
    const sPart = store.byteLength + ":" + Array.from(store).join(",") + "|";
    const out: Uint8Array[] = [];
    for (const [k] of this.store) {
      if (!k.startsWith(sPart)) continue;
      const keyStr = k.slice(sPart.length);
      const keyBytes = keyStr === ""
        ? new Uint8Array(0)
        : new Uint8Array(keyStr.split(",").map((n) => Number(n)));
      let starts = true;
      for (let i = 0; i < prefix.byteLength; i++) {
        if (keyBytes[i] !== prefix[i]) {
          starts = false;
          break;
        }
      }
      if (starts) out.push(keyBytes);
    }
    return out;
  }
}

/**
 * Capabilities an {@link AsyncBridge} impl exposes. **Two flags are
 * per-host (jspi, threads) and one is per-loaded-wasm (asyncify)**.
 * See project memory `project_async_bridge` for the matrix.
 *
 * - `jspi`: host supports `WebAssembly.Suspending` /
 *   `WebAssembly.promising`. V8 / SpiderMonkey: yes; **Safari
 *   (JavaScriptCore) not yet** — re-check
 *   `webassembly.org/features` before relying on it.
 * - `asyncify`: kernel.wasm + user wasm were built with binaryen
 *   `--asyncify`. Engine-agnostic — works on every wasm engine
 *   because the instrumentation is wasm-level. Universal fallback
 *   when JSPI / stack switching aren't available.
 * - `stackSwitching`: engine supports the WebAssembly Stack
 *   Switching proposal (`cont.new`, `suspend`, `resume`).
 *   First-class wasm suspend/resume — supersedes asyncify and
 *   JSPI. Wasmer ships it; Chrome has experimental support.
 *   When available, prefer over asyncify.
 * - `threads`: host supports wasi-threads / wasm-threads. Widely
 *   supported across modern engines and JS hosts (Safari ≥ 14.1
 *   included).
 */
export interface AsyncCapabilities {
  jspi: boolean;
  asyncify: boolean;
  stackSwitching: boolean;
  threads: boolean;
}

/**
 * Host-supplied bridge to the JS event loop. Lets blocking
 * syscalls — sys_nanosleep, sys_read on an empty pipe, sys_wait
 * once spawn lands — suspend the calling wasm until the host work
 * completes. Capability-dependent: when nothing suspends
 * (Safari without asyncify-built wasm), `suspendUntil` throws
 * `"NOT_SUSPENDABLE"` and callers fall back to non-blocking
 * semantics (EAGAIN / immediate-return).
 *
 * Mirrors the Rust-side `AsyncBridge` trait.
 */
export interface AsyncBridge {
  capabilities(): AsyncCapabilities;
  /**
   * Suspend the calling wasm until `task` resolves; return its
   * payload. Throws `"NOT_SUSPENDABLE"` (literal string) if neither
   * JSPI nor asyncify is available.
   */
  suspendUntil(task: () => Promise<Uint8Array>): Uint8Array;
}

/**
 * Default no-suspension bridge. Used by hosts that have neither
 * JSPI nor asyncify-built wasm. Blocking syscalls fall back to
 * non-blocking semantics through this.
 */
export const noopAsyncBridge: AsyncBridge = {
  capabilities() {
    return {
      jspi: false,
      asyncify: false,
      stackSwitching: false,
      threads: false,
    };
  },
  suspendUntil() {
    throw new Error("NOT_SUSPENDABLE");
  },
};

function decodeProcessList(bytes: Uint8Array): ProcessSnapshot[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 4) throw new Error("short process list");
  const count = view.getUint32(0, true);
  const entries: ProcessSnapshot[] = [];
  let offset = 4;
  for (let i = 0; i < count; i++) {
    if (bytes.byteLength < offset + 25) {
      throw new Error("truncated process list entry");
    }
    const pid = view.getUint32(offset, true);
    offset += 4;
    const ppid = view.getUint32(offset, true);
    offset += 4;
    const pgid = view.getUint32(offset, true);
    offset += 4;
    const sid = view.getUint32(offset, true);
    offset += 4;
    const stateByte = bytes[offset++];
    const exitStatus = view.getInt32(offset, true);
    offset += 4;
    const commandLen = view.getUint32(offset, true);
    offset += 4;
    if (bytes.byteLength < offset + commandLen + 4) {
      throw new Error("truncated process command");
    }
    const command = bytes.subarray(offset, offset + commandLen).slice();
    offset += commandLen;
    const fdCount = view.getUint32(offset, true);
    offset += 4;
    if (bytes.byteLength < offset + fdCount * 4) {
      throw new Error("truncated process fd list");
    }
    const fds: number[] = [];
    for (let j = 0; j < fdCount; j++) {
      fds.push(view.getUint32(offset, true));
      offset += 4;
    }
    entries.push({
      pid,
      ppid,
      pgid,
      sid,
      state: stateByte === 2 ? "exited" : "running",
      exitStatus,
      command,
      fds,
    });
  }
  if (offset !== bytes.byteLength) {
    throw new Error("trailing process list bytes");
  }
  return entries;
}

// Asyncify state value exposed by the binaryen --asyncify pass.
const ASYNCIFY_UNWINDING = 1;

/**
 * Asyncify-instrumented dispatch wrapper. Drives the
 * unwind/rewind dance that lets a wasm module built with
 * `wasm-opt --asyncify` suspend mid-execution on hosts WITHOUT
 * JSPI (Safari's JavaScriptCore today, older browsers, Node
 * builds without --jspi).
 *
 * The asyncify protocol:
 *
 * 1. JS calls `dispatch(...)`. State == NORMAL.
 * 2. wasm calls one of the listed `asyncImports` (e.g.
 *    `kh_fetch_blocking`).
 * 3. The wrapped import schedules the real async work, then
 *    triggers `asyncify_start_unwind(buf)`. The wasm stack
 *    unwinds back to JS; `dispatch` returns. State == UNWINDING.
 * 4. JS awaits the queued Promise.
 * 5. JS calls `asyncify_stop_unwind`, then
 *    `asyncify_start_rewind(buf)`. State == REWINDING.
 * 6. JS calls `dispatch(...)` AGAIN with the same args. Wasm
 *    replays its stack back to where the import suspended.
 * 7. The wrapped import returns the resolved value. wasm calls
 *    `asyncify_stop_rewind`. State == NORMAL. Execution
 *    continues normally; `dispatch` returns the real result.
 *
 * Real (browser-tested) usage requires building kernel.wasm
 * with `wasm-opt --asyncify --pass-arg=asyncify-imports@kh_fetch_blocking,kh_socket_recv,…`.
 * Without that build flag the asyncify_* exports are absent and
 * this path stays dormant.
 */
function maybeWrapWithAsyncify(
  instance: WebAssembly.Instance,
  rawDispatch: (
    methodId: number,
    callerPid: number,
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
  ) => bigint,
  pendingResults: Map<string, unknown>,
): {
  asyncDispatch:
    | ((
      methodId: number,
      callerPid: number,
      inPtr: number,
      inLen: number,
      outPtr: number,
      outCap: number,
    ) => Promise<bigint>)
    | null;
  enabled: boolean;
} {
  const exports = instance.exports as Record<string, unknown>;
  const getState = exports.asyncify_get_state as (() => number) | undefined;
  const startUnwind = exports.asyncify_start_unwind as
    | ((addr: number) => void)
    | undefined;
  const stopUnwind = exports.asyncify_stop_unwind as (() => void) | undefined;
  const startRewind = exports.asyncify_start_rewind as
    | ((addr: number) => void)
    | undefined;
  const stopRewind = exports.asyncify_stop_rewind as (() => void) | undefined;
  if (
    !getState ||
    !startUnwind ||
    !stopUnwind ||
    !startRewind ||
    !stopRewind
  ) {
    return { asyncDispatch: null, enabled: false };
  }
  // Reserve a 4 KiB slot for the asyncify stack-save buffer at
  // a fixed address. The actual buffer comes from kernel.wasm's
  // own scratch — for the dormant path we just remember we'd
  // need one. When the build flag flips, kernel.wasm exports
  // a dedicated `asyncify_buffer_ptr` that returns its address.
  const asyncifyBufferPtr =
    (exports.asyncify_buffer_ptr as (() => number) | undefined)?.() ?? 0;
  const asyncDispatch = async (
    methodId: number,
    callerPid: number,
    inPtr: number,
    inLen: number,
    outPtr: number,
    outCap: number,
  ): Promise<bigint> => {
    let result = rawDispatch(methodId, callerPid, inPtr, inLen, outPtr, outCap);
    while (getState() === ASYNCIFY_UNWINDING) {
      stopUnwind();
      // Take the most-recently-queued pending Promise. The
      // wrapped import populated `pendingResults` with a
      // promise keyed by the import name.
      const promise = pendingResults.get("__pending__") as
        | Promise<unknown>
        | undefined;
      pendingResults.delete("__pending__");
      const resolved = promise ? await promise : undefined;
      pendingResults.set("__resolved__", resolved);
      startRewind(asyncifyBufferPtr);
      result = rawDispatch(methodId, callerPid, inPtr, inLen, outPtr, outCap);
    }
    return result;
  };
  return { asyncDispatch, enabled: true };
}

/**
 * Probe the current host for AsyncBridge capabilities. Returns a
 * fresh capability descriptor; the actual bridge that uses these
 * is plugged in by the embedder. JSPI detection is conservative —
 * presence of the `WebAssembly.Suspending` constructor.
 *
 * Asyncify detection requires inspecting the loaded user wasm
 * (the binaryen pass adds `asyncify_*` exports); detection is
 * deferred to the engine impl that knows which module to inspect.
 */
export function detectAsyncCapabilities(): AsyncCapabilities {
  // deno-lint-ignore no-explicit-any
  const W = (globalThis as any).WebAssembly;
  const hasJspi = typeof W?.Suspending === "function" &&
    typeof W?.promising === "function";
  // Stack Switching detection is similarly conservative — the
  // proposal exposes a `WebAssembly.Suspending` (used by JSPI) plus
  // `WebAssembly.Tag` etc.; for now mark unknown so engines fill
  // in after a feature probe of their choosing.
  return {
    jspi: hasJspi,
    asyncify: false, // engine fills this in after instantiation by checking
    //                  for `asyncify_*` exports in the loaded module
    stackSwitching: false, // engine fills this in via runtime probe
    threads: false, // wasi-threads detection is engine-level
  };
}

/**
 * Default policy: every hook returns "allow". Equivalent to having
 * no policy enforcer at all.
 */
export const allowAllPolicy: PolicyEnforcer = {};

/**
 * Strict policy: every hook returns "deny". Tests and embedders
 * that want zero outside-world access use this.
 */
export const denyAllPolicy: PolicyEnforcer = {
  mayInvokeExtension: () => "deny",
  mayOpenPath: () => "deny",
  mayFetch: () => "deny",
  mayIdb: () => "deny",
  mayConnect: () => "deny",
  mayListen: () => "deny",
  mayLog: () => "deny",
  mayGetRealtime: () => "deny",
};

export function defaultHostState(): HostState {
  return {
    nowRealtimeNs: 0n,
    extensions: new EmptyExtensionRegistry(),
    logSink: new DiscardLogSink(),
    policy: allowAllPolicy,
    asyncBridge: noopAsyncBridge,
  };
}

// ── KernelInstance: loaded kernel.wasm + dispatch handle ──────────────────

/**
 * Public so `sys_shim.ts` and `wasi_shim.ts` can drive `syscall`
 * from inside the user-process linker. Construction is internal.
 */
export class KernelInstance {
  constructor(
    readonly memory: WebAssembly.Memory,
    readonly scratchPtr: number,
    readonly scratchLen: number,
    readonly dispatch: (
      methodId: number,
      callerPid: number,
      inPtr: number,
      inLen: number,
      outPtr: number,
      outCap: number,
    ) => bigint,
    /**
     * Promising-wrapped variant of `dispatch`. Present only when
     * the host supports JSPI and at least one kh_* import is
     * Suspending-wrapped. Returns `Promise<bigint>` instead of
     * `bigint`; routes through the same scratch buffer. Used by
     * `syscallAsync`.
     */
    readonly dispatchAsync:
      | ((
        methodId: number,
        callerPid: number,
        inPtr: number,
        inLen: number,
        outPtr: number,
        outCap: number,
      ) => Promise<bigint>)
      | null = null,
    readonly kernelListProcesses:
      | ((outPtr: number, outCap: number) => bigint)
      | null = null,
    readonly kernelKill:
      | ((pid: number, signal: number) => bigint)
      | null = null,
    readonly kernelWait:
      | ((
        callerPid: number,
        childPid: number,
        flags: number,
        outPtr: number,
        outCap: number,
      ) => bigint)
      | null = null,
    readonly kernelSpawn:
      | ((parentPid: number, argvPtr: number, argvLen: number) => bigint)
      | null = null,
  ) {}

  private stage(
    request: Uint8Array,
    responseCap: number,
  ): { inPtr: number; inLen: number; outPtr: number } {
    if (request.byteLength + responseCap > this.scratchLen) {
      throw new Error(
        `request+response (${
          request.byteLength + responseCap
        } bytes) exceeds scratch capacity (${this.scratchLen})`,
      );
    }
    const inPtr = this.scratchPtr;
    const inLen = request.byteLength;
    const outPtr = this.scratchPtr + inLen;
    if (inLen > 0) {
      new Uint8Array(this.memory.buffer, inPtr, inLen).set(request);
    }
    return { inPtr, inLen, outPtr };
  }

  private collectResponse(outPtr: number, responseCap: number): Uint8Array {
    if (responseCap === 0) return new Uint8Array(0);
    return new Uint8Array(
      new Uint8Array(this.memory.buffer, outPtr, responseCap).slice().buffer,
    );
  }

  syscall(
    methodId: number,
    callerPid: number,
    request: Uint8Array,
    responseCap: number,
  ): { rc: bigint; response: Uint8Array } {
    const { inPtr, inLen, outPtr } = this.stage(request, responseCap);
    const rc = this.dispatch(
      methodId,
      callerPid,
      inPtr,
      inLen,
      outPtr,
      responseCap,
    );
    return { rc, response: this.collectResponse(outPtr, responseCap) };
  }

  /**
   * Async syscall — routes through the promising-wrapped dispatch
   * so kh_* handlers wrapped with `WebAssembly.Suspending` can
   * await JS Promises (real fetch, real socket I/O). Throws if
   * the host has no JSPI support (no `dispatchAsync` slot).
   */
  async syscallAsync(
    methodId: number,
    callerPid: number,
    request: Uint8Array,
    responseCap: number,
  ): Promise<{ rc: bigint; response: Uint8Array }> {
    if (!this.dispatchAsync) {
      throw new Error(
        "syscallAsync called on a kernel without JSPI — install an asyncBridge / fetch impl that requires it, or fall back to syscall()",
      );
    }
    const { inPtr, inLen, outPtr } = this.stage(request, responseCap);
    const rc = await this.dispatchAsync(
      methodId,
      callerPid,
      inPtr,
      inLen,
      outPtr,
      responseCap,
    );
    return { rc, response: this.collectResponse(outPtr, responseCap) };
  }

  listProcessesRaw(): { rc: bigint; response: Uint8Array } {
    if (!this.kernelListProcesses) {
      throw new Error("kernel.wasm missing kernel_list_processes export");
    }
    const outPtr = this.scratchPtr;
    const outCap = this.scratchLen;
    const rc = this.kernelListProcesses(outPtr, outCap);
    return { rc, response: this.collectResponse(outPtr, outCap) };
  }

  killProcess(pid: number, signal: number): bigint {
    if (!this.kernelKill) {
      throw new Error("kernel.wasm missing kernel_kill export");
    }
    return this.kernelKill(pid, signal);
  }

  waitProcess(
    callerPid: number,
    childPid: number,
    flags: number,
  ): { rc: bigint; response: Uint8Array } {
    if (!this.kernelWait) {
      throw new Error("kernel.wasm missing kernel_wait export");
    }
    const outPtr = this.scratchPtr;
    const outCap = 8;
    const rc = this.kernelWait(callerPid, childPid, flags, outPtr, outCap);
    return { rc, response: this.collectResponse(outPtr, outCap) };
  }

  spawnProcess(parentPid: number, argv: Uint8Array): bigint {
    if (!this.kernelSpawn) {
      throw new Error("kernel.wasm missing kernel_spawn export");
    }
    const { inPtr, inLen } = this.stage(argv, 0);
    return this.kernelSpawn(parentPid, inPtr, inLen);
  }
}

// ── User process ──────────────────────────────────────────────────────────

export class UserProcess {
  constructor(
    readonly pid: number,
    private readonly instance: WebAssembly.Instance,
    private readonly memory: WebAssembly.Memory,
    private readonly kernel: KernelInstance,
  ) {}

  callExportI32(name: string): number {
    const f = this.instance.exports[name];
    if (typeof f !== "function") {
      throw new Error(`user-process missing '${name}' export`);
    }
    return (f as () => number)();
  }

  runStart(): void {
    const f = this.instance.exports._start;
    if (typeof f !== "function") {
      throw new Error("user-process missing '_start' (not a WASI command)");
    }
    (f as () => void)();
  }

  readMemory(addr: number, len: number): Uint8Array {
    return new Uint8Array(
      new Uint8Array(this.memory.buffer, addr, len).slice().buffer,
    );
  }

  feedStdin(bytes: Uint8Array): void {
    const req = new Uint8Array(4 + bytes.byteLength);
    new DataView(req.buffer).setUint32(0, this.pid, true);
    req.set(bytes, 4);
    this.kernel.syscall(METHOD.KERNEL_PROVIDE_STDIN, KERNEL_PID, req, 0);
  }

  closeStdin(): void {
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, this.pid, true);
    this.kernel.syscall(METHOD.KERNEL_CLOSE_STDIN, KERNEL_PID, req, 0);
  }

  capturedStdout(): Uint8Array {
    return this.drainStream(METHOD.KERNEL_DRAIN_STDOUT);
  }
  capturedStderr(): Uint8Array {
    return this.drainStream(METHOD.KERNEL_DRAIN_STDERR);
  }

  private drainStream(methodId: number): Uint8Array {
    const out: number[] = [];
    const cap = Math.max(0, this.kernel.scratchLen - 4);
    const req = new Uint8Array(4);
    new DataView(req.buffer).setUint32(0, this.pid, true);
    while (true) {
      const { rc, response } = this.kernel.syscall(
        methodId,
        KERNEL_PID,
        req,
        cap,
      );
      const n = Number(rc);
      if (n <= 0) break;
      for (let i = 0; i < n; i++) out.push(response[i]);
      if (n < cap) break;
    }
    return Uint8Array.from(out);
  }
}

// ── Microkernel ───────────────────────────────────────────────────────────

export class Microkernel {
  private kernel: KernelInstance;
  private hostState: HostState;

  private constructor(kernel: KernelInstance, hostState: HostState) {
    this.kernel = kernel;
    this.hostState = hostState;
  }

  static async load(
    kernelWasmBytes: Uint8Array,
    hostState: HostState = defaultHostState(),
  ): Promise<Microkernel> {
    const memoryRef: { memory?: WebAssembly.Memory } = {};
    const hostBox = { state: hostState };

    const khImports = {
      kh_now_realtime: (outPtr: number): number => {
        // Policy gate fires before any state read.
        if (
          hostBox.state.policy.mayGetRealtime?.() === "deny"
        ) {
          return -EACCES;
        }
        new DataView(memoryRef.memory!.buffer).setBigUint64(
          outPtr,
          hostBox.state.nowRealtimeNs,
          true,
        );
        return 0;
      },
      kh_log: (severity: number, msgPtr: number, msgLen: number): number => {
        const bytes = new Uint8Array(memoryRef.memory!.buffer, msgPtr, msgLen);
        const message = new TextDecoder().decode(bytes);
        // Policy may suppress per message; default Allow.
        if (
          hostBox.state.policy.mayLog?.(severity, message) === "deny"
        ) {
          return 0;
        }
        hostBox.state.logSink.emit(severity, message);
        return 0;
      },
      // Real-disk imports. Phase 5 in microkernel-js: stubs that
      // return -EACCES until the host-fs bridge is wired (Deno
      // can serve these via Deno.openSync; browsers via OPFS).
      // Same shape as the Rust microkernel-wasmtime impl.
      // Pluggable kh_real_*. When HostState.hostFs is set, delegate
      // through the trait-equivalent interface; otherwise -EACCES.
      // Default kept restrictive so embedders that forget to wire
      // hostFs don't accidentally expose host disk access.
      kh_real_open: (
        pathPtr: number,
        pathLen: number,
        flags: number,
        _mode: number,
      ): number => {
        const fs = hostBox.state.hostFs;
        if (!fs) return -EACCES;
        const path = new Uint8Array(memoryRef.memory!.buffer, pathPtr, pathLen)
          .slice();
        return fs.open(path, flags);
      },
      kh_real_read: (fd: number, outPtr: number, len: number): bigint => {
        const fs = hostBox.state.hostFs;
        if (!fs) return BigInt(-EBADF);
        const buf = new Uint8Array(len);
        const n = fs.read(fd, buf);
        if (n > 0) {
          new Uint8Array(memoryRef.memory!.buffer, outPtr, n).set(
            buf.subarray(0, n),
          );
        }
        return BigInt(n);
      },
      kh_real_write: (fd: number, dataPtr: number, dataLen: number): bigint => {
        const fs = hostBox.state.hostFs;
        if (!fs) return BigInt(-EBADF);
        const data = new Uint8Array(memoryRef.memory!.buffer, dataPtr, dataLen)
          .slice();
        return BigInt(fs.write(fd, data));
      },
      kh_real_close: (fd: number): number => {
        const fs = hostBox.state.hostFs;
        if (!fs) return 0;
        return fs.close(fd);
      },
      kh_real_stat: (
        pathPtr: number,
        pathLen: number,
        outPtr: number,
        outCap: number,
      ): bigint => {
        const fs = hostBox.state.hostFs;
        if (!fs) return BigInt(-EACCES);
        if (outCap < 32) return BigInt(-22);
        const path = new Uint8Array(memoryRef.memory!.buffer, pathPtr, pathLen)
          .slice();
        const stat = fs.stat(path);
        if (typeof stat === "number") return BigInt(stat);
        // kh_stat_v1: u16 ver + u16 pad + u32 mode + u64 size + u64 mtime + u8 isDir + u8 isSym + u8[6] reserved.
        const buf = new Uint8Array(32);
        const view = new DataView(buf.buffer);
        view.setUint16(0, 1, true);
        view.setUint32(4, stat.mode >>> 0, true);
        view.setBigUint64(8, stat.size, true);
        view.setBigUint64(16, stat.mtimeNs, true);
        buf[24] = stat.isDir ? 1 : 0;
        buf[25] = stat.isSymlink ? 1 : 0;
        new Uint8Array(memoryRef.memory!.buffer, outPtr, 32).set(buf);
        return BigInt(32);
      },
      kh_real_unlink: (pathPtr: number, pathLen: number): number => {
        const fs = hostBox.state.hostFs;
        if (!fs) return -EACCES;
        const path = new Uint8Array(memoryRef.memory!.buffer, pathPtr, pathLen)
          .slice();
        return fs.unlink(path);
      },
      kh_real_mkdir: (
        pathPtr: number,
        pathLen: number,
        mode: number,
      ): number => {
        const fs = hostBox.state.hostFs;
        if (!fs) return -EACCES;
        const path = new Uint8Array(memoryRef.memory!.buffer, pathPtr, pathLen)
          .slice();
        return fs.mkdir(path, mode);
      },
      kh_real_symlink: (
        targetPtr: number,
        targetLen: number,
        linkPtr: number,
        linkLen: number,
      ): number => {
        const fs = hostBox.state.hostFs;
        if (!fs) return -EACCES;
        const target = new Uint8Array(
          memoryRef.memory!.buffer,
          targetPtr,
          targetLen,
        ).slice();
        const link = new Uint8Array(memoryRef.memory!.buffer, linkPtr, linkLen)
          .slice();
        return fs.symlink(target, link);
      },
      kh_real_rename: (
        oldPtr: number,
        oldLen: number,
        newPtr: number,
        newLen: number,
      ): number => {
        const fs = hostBox.state.hostFs;
        if (!fs) return -EACCES;
        const oldP = new Uint8Array(memoryRef.memory!.buffer, oldPtr, oldLen)
          .slice();
        const newP = new Uint8Array(memoryRef.memory!.buffer, newPtr, newLen)
          .slice();
        return fs.rename(oldP, newP);
      },
      // Outbound HTTP. When the host supports JSPI AND
      // hostState.fetch is set, this slot becomes a Suspending
      // wrapper a few lines below; the placeholder here is
      // installed unconditionally so the Linker has a binding,
      // and the wrap-with-Suspending step below replaces it.
      kh_fetch_blocking: (
        _reqPtr: number,
        _reqLen: number,
        _outPtr: number,
        _outCap: number,
      ): bigint => BigInt(-38), // -ENOSYS
      // Pluggable TCP socket surface. When HostState.tcp is set,
      // delegate; otherwise -EACCES. Browser microkernels install
      // a WebSocket-relay impl; Deno wires Deno.connect/listen.
      kh_socket_connect: (
        addrPtr: number,
        addrLen: number,
        flags: number,
      ): number => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return -EACCES;
        const addr = new TextDecoder().decode(
          new Uint8Array(memoryRef.memory!.buffer, addrPtr, addrLen),
        );
        const colon = addr.lastIndexOf(":");
        if (colon < 0) return -22;
        const host = addr.slice(0, colon);
        const port = parseInt(addr.slice(colon + 1), 10);
        if (!Number.isFinite(port)) return -22;
        if (hostBox.state.policy.mayConnect?.(host, port) === "deny") {
          return -EACCES;
        }
        return tcp.connect(host, port, flags);
      },
      kh_socket_send: (
        handle: number,
        dataPtr: number,
        dataLen: number,
      ): bigint => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return BigInt(-EBADF);
        const data = new Uint8Array(memoryRef.memory!.buffer, dataPtr, dataLen)
          .slice();
        return BigInt(tcp.send(handle, data));
      },
      kh_socket_recv: (
        handle: number,
        outPtr: number,
        len: number,
        flags: number,
      ): bigint => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return BigInt(-EBADF);
        const buf = new Uint8Array(len);
        const n = tcp.recv(handle, buf, flags);
        if (n > 0) {
          new Uint8Array(memoryRef.memory!.buffer, outPtr, n).set(
            buf.subarray(0, n),
          );
        }
        return BigInt(n);
      },
      kh_socket_close: (handle: number): number => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return 0;
        return tcp.close(handle);
      },
      kh_socket_listen_at: (
        addrPtr: number,
        addrLen: number,
        backlog: number,
      ): number => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return -EACCES;
        const addr = new TextDecoder().decode(
          new Uint8Array(memoryRef.memory!.buffer, addrPtr, addrLen),
        );
        const colon = addr.lastIndexOf(":");
        if (colon < 0) return -22;
        const host = addr.slice(0, colon);
        const port = parseInt(addr.slice(colon + 1), 10);
        if (!Number.isFinite(port)) return -22;
        if (hostBox.state.policy.mayListen?.(port) === "deny") return -EACCES;
        return tcp.listen(host, port, backlog);
      },
      kh_socket_accept_blocking: (
        handle: number,
        flags: number,
      ): number => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return -EBADF;
        return tcp.accept(handle, flags);
      },
      kh_socket_local_addr: (
        handle: number,
        outPtr: number,
        outCap: number,
      ): bigint => {
        const tcp = hostBox.state.tcp;
        if (!tcp) return BigInt(-EBADF);
        const addr = tcp.localAddr(handle);
        if (!addr) return BigInt(-EBADF);
        const hostBytes = new TextEncoder().encode(addr.host);
        const need = 2 + hostBytes.byteLength;
        if (need > outCap) return BigInt(-E2BIG);
        const buf = new Uint8Array(need);
        new DataView(buf.buffer).setUint16(0, addr.port, true);
        buf.set(hostBytes, 2);
        new Uint8Array(memoryRef.memory!.buffer, outPtr, need).set(buf);
        return BigInt(need);
      },
      // Durable KV (IndexedDB-shaped). Browser microkernels back
      // this with IndexedDB; Deno with redb-shaped storage; stub
      // returns -EACCES so kernel.wasm callers see the policy
      // shape consistently.
      kh_idb_get: (
        storePtr: number,
        storeLen: number,
        keyPtr: number,
        keyLen: number,
        outPtr: number,
        outCap: number,
      ): bigint => {
        const kv = hostBox.state.kv;
        if (!kv) return BigInt(-EACCES);
        const store = new Uint8Array(
          memoryRef.memory!.buffer,
          storePtr,
          storeLen,
        ).slice();
        const key = new Uint8Array(memoryRef.memory!.buffer, keyPtr, keyLen)
          .slice();
        if (
          hostBox.state.policy.mayIdb?.(store, false) === "deny"
        ) return BigInt(-EACCES);
        const v = kv.get(store, key);
        if (typeof v === "number") return BigInt(v);
        if (v.byteLength > outCap) return BigInt(-E2BIG);
        new Uint8Array(memoryRef.memory!.buffer, outPtr, v.byteLength).set(v);
        return BigInt(v.byteLength);
      },
      kh_idb_put: (
        storePtr: number,
        storeLen: number,
        keyPtr: number,
        keyLen: number,
        valuePtr: number,
        valueLen: number,
      ): number => {
        const kv = hostBox.state.kv;
        if (!kv) return -EACCES;
        const store = new Uint8Array(
          memoryRef.memory!.buffer,
          storePtr,
          storeLen,
        ).slice();
        const key = new Uint8Array(memoryRef.memory!.buffer, keyPtr, keyLen)
          .slice();
        const value = new Uint8Array(
          memoryRef.memory!.buffer,
          valuePtr,
          valueLen,
        ).slice();
        if (hostBox.state.policy.mayIdb?.(store, true) === "deny") {
          return -EACCES;
        }
        return kv.put(store, key, value);
      },
      kh_idb_delete: (
        storePtr: number,
        storeLen: number,
        keyPtr: number,
        keyLen: number,
      ): number => {
        const kv = hostBox.state.kv;
        if (!kv) return -EACCES;
        const store = new Uint8Array(
          memoryRef.memory!.buffer,
          storePtr,
          storeLen,
        ).slice();
        const key = new Uint8Array(memoryRef.memory!.buffer, keyPtr, keyLen)
          .slice();
        if (hostBox.state.policy.mayIdb?.(store, true) === "deny") {
          return -EACCES;
        }
        return kv.delete(store, key);
      },
      kh_idb_list: (
        storePtr: number,
        storeLen: number,
        prefixPtr: number,
        prefixLen: number,
        outPtr: number,
        outCap: number,
      ): bigint => {
        const kv = hostBox.state.kv;
        if (!kv) return BigInt(-EACCES);
        const store = new Uint8Array(
          memoryRef.memory!.buffer,
          storePtr,
          storeLen,
        ).slice();
        const prefix = new Uint8Array(
          memoryRef.memory!.buffer,
          prefixPtr,
          prefixLen,
        ).slice();
        if (hostBox.state.policy.mayIdb?.(store, false) === "deny") {
          return BigInt(-EACCES);
        }
        const keys = kv.list(store, prefix);
        // Pack count + (len, bytes)*.
        let total = 4;
        let count = 0;
        for (const k of keys) {
          const need = 4 + k.byteLength;
          if (total + need > outCap) break;
          total += need;
          count++;
        }
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);
        view.setUint32(0, count >>> 0, true);
        let cur = 4;
        for (let i = 0; i < count; i++) {
          const k = keys[i];
          view.setUint32(cur, k.byteLength >>> 0, true);
          cur += 4;
          buf.set(k, cur);
          cur += k.byteLength;
        }
        new Uint8Array(memoryRef.memory!.buffer, outPtr, total).set(buf);
        return BigInt(total);
      },
      kh_extension_invoke: (
        reqPtr: number,
        reqLen: number,
        outPtr: number,
        outCap: number,
      ): bigint => {
        const request = new Uint8Array(
          new Uint8Array(memoryRef.memory!.buffer, reqPtr, reqLen).slice()
            .buffer,
        );
        // Policy gate at the kh_* boundary — denied calls don't
        // reach the registry.
        if (
          hostBox.state.policy.mayInvokeExtension?.(request) === "deny"
        ) {
          return BigInt(-EACCES);
        }
        const result = hostBox.state.extensions.invoke(request, outCap);
        if (typeof result === "number") return BigInt(result);
        if (result.byteLength > outCap) return BigInt(-EFAULT);
        new Uint8Array(memoryRef.memory!.buffer, outPtr, result.byteLength).set(
          result,
        );
        return BigInt(result.byteLength);
      },
      kh_spawn_process: (
        _moduleIdPtr: number,
        _moduleIdLen: number,
        _argvPtr: number,
        _argvLen: number,
        _envpPtr: number,
        _envpLen: number,
      ): number => -ENOSYS,
      kh_destroy_instance: (_handle: number): number => -ENOSYS,
      kh_process_mem_read: (
        _handle: number,
        _addr: number,
        _dstPtr: number,
        _len: number,
      ): bigint => BigInt(-ENOSYS),
      kh_process_mem_write: (
        _handle: number,
        _addr: number,
        _srcPtr: number,
        _len: number,
      ): bigint => BigInt(-ENOSYS),
      kh_process_resume: (
        _handle: number,
        _result: bigint,
      ): bigint => BigInt(-ENOSYS),
    };

    // std-on-wasi panic-infra stubs for kernel.wasm itself.
    const wasiKernelStubs = {
      environ_get: () => 0,
      environ_sizes_get: (countPtr: number, sizePtr: number) => {
        const view = new DataView(memoryRef.memory!.buffer);
        view.setUint32(countPtr, 0, true);
        view.setUint32(sizePtr, 0, true);
        return 0;
      },
      fd_write: () => 0,
      fd_close: () => 0,
      fd_seek: () => 0,
      fd_fdstat_get: () => 0,
      proc_exit: (code: number): never => {
        throw new Error(`kernel.wasm proc_exit(${code}) — kernel terminated`);
      },
      random_get: (bufPtr: number, bufLen: number) => {
        crypto.getRandomValues(
          new Uint8Array(memoryRef.memory!.buffer, bufPtr, bufLen),
        );
        return 0;
      },
      clock_time_get: (
        _clockId: number,
        _precision: bigint,
        timePtr: number,
      ) => {
        new DataView(memoryRef.memory!.buffer).setBigUint64(
          timePtr,
          BigInt(Date.now()) * 1_000_000n,
          true,
        );
        return 0;
      },
    };

    const module = await WebAssembly.compile(
      kernelWasmBytes as unknown as BufferSource,
    );

    // JSPI integration: when the host supports JSPI AND the
    // embedder supplied an async backend (fetch, etc.), wrap
    // the relevant kh_* imports with WebAssembly.Suspending so
    // they can await Promises inside the wasm call. The
    // matching kernel_dispatch export gets WebAssembly.promising'd
    // so callers see a Promise<i64> at the JS boundary.
    // deno-lint-ignore no-explicit-any
    const W = (globalThis as any).WebAssembly;
    const hasJspi = typeof W?.Suspending === "function" &&
      typeof W?.promising === "function";
    const tcpAsync = hostState.tcp;
    const kvAsync = hostState.kv;
    const fsAsync = hostState.hostFs;
    // When JSPI is available, always emit the promising-wrapped
    // dispatch so callers (Phase 7.2 macro wrappers, embedders
    // mixing sync + async paths) can use syscallAsync uniformly.
    // The Suspending wrappers for the kh_* imports below still
    // only fire when the matching async backend is provided —
    // that's the gating that matters for "will any specific kh
    // call actually suspend."
    const wantsAsync = hasJspi;
    if (wantsAsync && hostState.fetch != null) {
      const fetchImpl = hostState.fetch;
      // The Suspending wrapper takes an async function; the wasm
      // sees a normal sync import that may suspend the calling
      // stack until the promise resolves.
      khImports.kh_fetch_blocking = new W.Suspending(
        async (
          reqPtr: number,
          reqLen: number,
          outPtr: number,
          outCap: number,
        ): Promise<bigint> => {
          const memBuf = () => memoryRef.memory!.buffer;
          const request = new Uint8Array(memBuf(), reqPtr, reqLen).slice();
          if (
            hostBox.state.policy.mayFetch?.(request) === "deny"
          ) return BigInt(-EACCES);
          let response: Uint8Array;
          try {
            response = await fetchImpl(request);
          } catch (_e) {
            return BigInt(-EIO);
          }
          if (response.byteLength > outCap) return BigInt(-E2BIG);
          new Uint8Array(memBuf(), outPtr, response.byteLength).set(
            response,
          );
          return BigInt(response.byteLength);
        },
      );
    }
    if (wantsAsync && tcpAsync?.connectAsync != null) {
      const connectAsync = tcpAsync.connectAsync.bind(tcpAsync);
      khImports.kh_socket_connect = new W.Suspending(
        async (
          addrPtr: number,
          addrLen: number,
          flags: number,
        ): Promise<number> => {
          const addr = new TextDecoder().decode(
            new Uint8Array(memoryRef.memory!.buffer, addrPtr, addrLen),
          );
          const colon = addr.lastIndexOf(":");
          if (colon < 0) return -22;
          const host = addr.slice(0, colon);
          const port = parseInt(addr.slice(colon + 1), 10);
          if (!Number.isFinite(port)) return -22;
          if (
            hostBox.state.policy.mayConnect?.(host, port) === "deny"
          ) return -EACCES;
          return await connectAsync(host, port, flags);
        },
      );
    }
    if (wantsAsync && tcpAsync?.recvAsync != null) {
      const recvAsync = tcpAsync.recvAsync.bind(tcpAsync);
      khImports.kh_socket_recv = new W.Suspending(
        async (
          handle: number,
          outPtr: number,
          len: number,
          flags: number,
        ): Promise<bigint> => {
          const buf = new Uint8Array(len);
          const n = await recvAsync(handle, buf, flags);
          if (n > 0) {
            new Uint8Array(memoryRef.memory!.buffer, outPtr, n).set(
              buf.subarray(0, n),
            );
          }
          return BigInt(n);
        },
      );
    }
    if (wantsAsync && tcpAsync?.acceptAsync != null) {
      const acceptAsync = tcpAsync.acceptAsync.bind(tcpAsync);
      khImports.kh_socket_accept_blocking = new W.Suspending(
        async (handle: number, flags: number): Promise<number> => {
          return await acceptAsync(handle, flags);
        },
      );
    }
    // Async kh_real_* — same Suspending pattern as kh_socket_* /
    // kh_idb_*. OPFS, S3, R2, async-fs embedders plug their
    // *Async impls in here.
    if (wantsAsync && fsAsync?.openAsync != null) {
      const openAsync = fsAsync.openAsync.bind(fsAsync);
      khImports.kh_real_open = new W.Suspending(
        async (
          pathPtr: number,
          pathLen: number,
          flags: number,
          _mode: number,
        ): Promise<number> => {
          const path = new Uint8Array(
            memoryRef.memory!.buffer,
            pathPtr,
            pathLen,
          ).slice();
          return await openAsync(path, flags);
        },
      );
    }
    if (wantsAsync && fsAsync?.readAsync != null) {
      const readAsync = fsAsync.readAsync.bind(fsAsync);
      khImports.kh_real_read = new W.Suspending(
        async (fd: number, outPtr: number, len: number): Promise<bigint> => {
          const buf = new Uint8Array(len);
          const n = await readAsync(fd, buf);
          if (n > 0) {
            new Uint8Array(memoryRef.memory!.buffer, outPtr, n).set(
              buf.subarray(0, n),
            );
          }
          return BigInt(n);
        },
      );
    }
    if (wantsAsync && fsAsync?.writeAsync != null) {
      const writeAsync = fsAsync.writeAsync.bind(fsAsync);
      khImports.kh_real_write = new W.Suspending(
        async (
          fd: number,
          dataPtr: number,
          dataLen: number,
        ): Promise<bigint> => {
          const data = new Uint8Array(
            memoryRef.memory!.buffer,
            dataPtr,
            dataLen,
          ).slice();
          return BigInt(await writeAsync(fd, data));
        },
      );
    }
    if (wantsAsync && fsAsync?.closeAsync != null) {
      const closeAsync = fsAsync.closeAsync.bind(fsAsync);
      khImports.kh_real_close = new W.Suspending(
        async (fd: number): Promise<number> => await closeAsync(fd),
      );
    }
    if (wantsAsync && fsAsync?.statAsync != null) {
      const statAsync = fsAsync.statAsync.bind(fsAsync);
      khImports.kh_real_stat = new W.Suspending(
        async (
          pathPtr: number,
          pathLen: number,
          outPtr: number,
          outCap: number,
        ): Promise<bigint> => {
          if (outCap < 32) return BigInt(-22);
          const path = new Uint8Array(
            memoryRef.memory!.buffer,
            pathPtr,
            pathLen,
          ).slice();
          const stat = await statAsync(path);
          if (typeof stat === "number") return BigInt(stat);
          const buf = new Uint8Array(32);
          const view = new DataView(buf.buffer);
          view.setUint16(0, 1, true);
          view.setUint32(4, stat.mode >>> 0, true);
          view.setBigUint64(8, stat.size, true);
          view.setBigUint64(16, stat.mtimeNs, true);
          buf[24] = stat.isDir ? 1 : 0;
          buf[25] = stat.isSymlink ? 1 : 0;
          new Uint8Array(memoryRef.memory!.buffer, outPtr, 32).set(buf);
          return BigInt(32);
        },
      );
    }
    if (wantsAsync && fsAsync?.unlinkAsync != null) {
      const unlinkAsync = fsAsync.unlinkAsync.bind(fsAsync);
      khImports.kh_real_unlink = new W.Suspending(
        async (pathPtr: number, pathLen: number): Promise<number> => {
          const path = new Uint8Array(
            memoryRef.memory!.buffer,
            pathPtr,
            pathLen,
          ).slice();
          return await unlinkAsync(path);
        },
      );
    }
    if (wantsAsync && fsAsync?.mkdirAsync != null) {
      const mkdirAsync = fsAsync.mkdirAsync.bind(fsAsync);
      khImports.kh_real_mkdir = new W.Suspending(
        async (
          pathPtr: number,
          pathLen: number,
          mode: number,
        ): Promise<number> => {
          const path = new Uint8Array(
            memoryRef.memory!.buffer,
            pathPtr,
            pathLen,
          ).slice();
          return await mkdirAsync(path, mode);
        },
      );
    }
    if (wantsAsync && fsAsync?.symlinkAsync != null) {
      const symlinkAsync = fsAsync.symlinkAsync.bind(fsAsync);
      khImports.kh_real_symlink = new W.Suspending(
        async (
          targetPtr: number,
          targetLen: number,
          linkPtr: number,
          linkLen: number,
        ): Promise<number> => {
          const target = new Uint8Array(
            memoryRef.memory!.buffer,
            targetPtr,
            targetLen,
          ).slice();
          const link = new Uint8Array(
            memoryRef.memory!.buffer,
            linkPtr,
            linkLen,
          ).slice();
          return await symlinkAsync(target, link);
        },
      );
    }
    if (wantsAsync && fsAsync?.renameAsync != null) {
      const renameAsync = fsAsync.renameAsync.bind(fsAsync);
      khImports.kh_real_rename = new W.Suspending(
        async (
          oldPtr: number,
          oldLen: number,
          newPtr: number,
          newLen: number,
        ): Promise<number> => {
          const oldP = new Uint8Array(memoryRef.memory!.buffer, oldPtr, oldLen)
            .slice();
          const newP = new Uint8Array(memoryRef.memory!.buffer, newPtr, newLen)
            .slice();
          return await renameAsync(oldP, newP);
        },
      );
    }
    if (wantsAsync && kvAsync?.getAsync != null) {
      const getAsync = kvAsync.getAsync.bind(kvAsync);
      khImports.kh_idb_get = new W.Suspending(
        async (
          storePtr: number,
          storeLen: number,
          keyPtr: number,
          keyLen: number,
          outPtr: number,
          outCap: number,
        ): Promise<bigint> => {
          const memBuf = () => memoryRef.memory!.buffer;
          const store = new Uint8Array(memBuf(), storePtr, storeLen).slice();
          const key = new Uint8Array(memBuf(), keyPtr, keyLen).slice();
          if (
            hostBox.state.policy.mayIdb?.(store, false) === "deny"
          ) return BigInt(-EACCES);
          const value = await getAsync(store, key);
          if (typeof value === "number") return BigInt(value);
          if (value.byteLength > outCap) return BigInt(-E2BIG);
          new Uint8Array(memBuf(), outPtr, value.byteLength).set(value);
          return BigInt(value.byteLength);
        },
      );
    }
    if (wantsAsync && kvAsync?.putAsync != null) {
      const putAsync = kvAsync.putAsync.bind(kvAsync);
      khImports.kh_idb_put = new W.Suspending(
        async (
          storePtr: number,
          storeLen: number,
          keyPtr: number,
          keyLen: number,
          valuePtr: number,
          valueLen: number,
        ): Promise<number> => {
          const memBuf = () => memoryRef.memory!.buffer;
          const store = new Uint8Array(memBuf(), storePtr, storeLen).slice();
          const key = new Uint8Array(memBuf(), keyPtr, keyLen).slice();
          const value = new Uint8Array(memBuf(), valuePtr, valueLen).slice();
          if (
            hostBox.state.policy.mayIdb?.(store, true) === "deny"
          ) return -EACCES;
          return await putAsync(store, key, value);
        },
      );
    }
    if (wantsAsync && kvAsync?.deleteAsync != null) {
      const deleteAsync = kvAsync.deleteAsync.bind(kvAsync);
      khImports.kh_idb_delete = new W.Suspending(
        async (
          storePtr: number,
          storeLen: number,
          keyPtr: number,
          keyLen: number,
        ): Promise<number> => {
          const memBuf = () => memoryRef.memory!.buffer;
          const store = new Uint8Array(memBuf(), storePtr, storeLen).slice();
          const key = new Uint8Array(memBuf(), keyPtr, keyLen).slice();
          if (
            hostBox.state.policy.mayIdb?.(store, true) === "deny"
          ) return -EACCES;
          return await deleteAsync(store, key);
        },
      );
    }
    if (wantsAsync && kvAsync?.listAsync != null) {
      const listAsync = kvAsync.listAsync.bind(kvAsync);
      khImports.kh_idb_list = new W.Suspending(
        async (
          storePtr: number,
          storeLen: number,
          prefixPtr: number,
          prefixLen: number,
          outPtr: number,
          outCap: number,
        ): Promise<bigint> => {
          const memBuf = () => memoryRef.memory!.buffer;
          const store = new Uint8Array(memBuf(), storePtr, storeLen).slice();
          const prefix = new Uint8Array(memBuf(), prefixPtr, prefixLen).slice();
          if (
            hostBox.state.policy.mayIdb?.(store, false) === "deny"
          ) return BigInt(-EACCES);
          const keys = await listAsync(store, prefix);
          let total = 4;
          let count = 0;
          for (const k of keys) {
            const need = 4 + k.byteLength;
            if (total + need > outCap) break;
            total += need;
            count++;
          }
          const buf = new Uint8Array(total);
          const view = new DataView(buf.buffer);
          view.setUint32(0, count >>> 0, true);
          let cur = 4;
          for (let i = 0; i < count; i++) {
            const k = keys[i];
            view.setUint32(cur, k.byteLength >>> 0, true);
            cur += 4;
            buf.set(k, cur);
            cur += k.byteLength;
          }
          new Uint8Array(memBuf(), outPtr, total).set(buf);
          return BigInt(total);
        },
      );
    }

    const instance = await WebAssembly.instantiate(module, {
      kh: khImports,
      wasi_snapshot_preview1: wasiKernelStubs,
    });
    const memory = instance.exports.memory as WebAssembly.Memory;
    memoryRef.memory = memory;

    const scratchPtr = (instance.exports.kernel_scratch_ptr as () => number)();
    const scratchLen = (instance.exports.kernel_scratch_len as () => number)();
    const dispatch = instance.exports.kernel_dispatch as (
      methodId: number,
      callerPid: number,
      inPtr: number,
      inLen: number,
      outPtr: number,
      outCap: number,
    ) => bigint;
    const kernelListProcesses = instance.exports.kernel_list_processes as
      | ((outPtr: number, outCap: number) => bigint)
      | undefined;
    const kernelKill = instance.exports.kernel_kill as
      | ((pid: number, signal: number) => bigint)
      | undefined;
    const kernelWait = instance.exports.kernel_wait as
      | ((
        callerPid: number,
        childPid: number,
        flags: number,
        outPtr: number,
        outCap: number,
      ) => bigint)
      | undefined;
    const kernelSpawn = instance.exports.kernel_spawn as
      | ((parentPid: number, argvPtr: number, argvLen: number) => bigint)
      | undefined;

    // promising-wrap returns a function that returns Promise<i64>;
    // the underlying call may suspend via any Suspending import.
    let dispatchAsync:
      | ((
        methodId: number,
        callerPid: number,
        inPtr: number,
        inLen: number,
        outPtr: number,
        outCap: number,
      ) => Promise<bigint>)
      | null = null;
    if (wantsAsync) {
      dispatchAsync = W.promising(dispatch) as (
        methodId: number,
        callerPid: number,
        inPtr: number,
        inLen: number,
        outPtr: number,
        outCap: number,
      ) => Promise<bigint>;
    } else {
      // JSPI not available — try asyncify-instrumented dispatch as
      // the universal fallback. Only kicks in when kernel.wasm was
      // built with `wasm-opt --asyncify`; otherwise dormant.
      const pendingResults = new Map<string, unknown>();
      const asyncify = maybeWrapWithAsyncify(
        instance,
        dispatch,
        pendingResults,
      );
      if (asyncify.enabled) {
        dispatchAsync = asyncify.asyncDispatch;
      }
    }

    const kernel = new KernelInstance(
      memory,
      scratchPtr,
      scratchLen,
      dispatch,
      dispatchAsync,
      kernelListProcesses ?? null,
      kernelKill ?? null,
      kernelWait ?? null,
      kernelSpawn ?? null,
    );
    hostBox.state = hostState;
    const mk = new Microkernel(kernel, hostState);
    (mk as unknown as { hostBox: typeof hostBox }).hostBox = hostBox;
    return mk;
  }

  syscall(
    methodId: number,
    request: Uint8Array,
    responseCap: number,
  ): { rc: bigint; response: Uint8Array } {
    return this.kernel.syscall(methodId, KERNEL_PID, request, responseCap);
  }

  /**
   * Async syscall — required for any method whose kh_* handlers
   * may suspend the wasm stack (fetch, blocking sockets, future
   * persistent KV with async backing). Throws if the host
   * doesn't support JSPI.
   */
  syscallAsync(
    methodId: number,
    request: Uint8Array,
    responseCap: number,
  ): Promise<{ rc: bigint; response: Uint8Array }> {
    return this.kernel.syscallAsync(methodId, KERNEL_PID, request, responseCap);
  }

  hostStateMut(): HostState {
    return this.hostState;
  }

  listProcesses(): ProcessSnapshot[] {
    const cap = this.kernel.scratchLen;
    const { rc, response } = this.kernel.listProcessesRaw();
    const n = Number(rc);
    if (n < 0) throw new Error(`kernel_list_processes failed: rc=${rc}`);
    if (n > cap) {
      throw new Error(`kernel_list_processes exceeded scratch capacity: ${n}`);
    }
    return decodeProcessList(response.subarray(0, n));
  }

  waitProcess(callerPid: number, childPid = 0, flags = 0): WaitResult {
    const { rc, response } = this.kernel.waitProcess(
      callerPid,
      childPid,
      flags,
    );
    const n = Number(rc);
    if (n < 0) throw new Error(`kernel_wait failed: rc=${rc}`);
    if (n !== 8) throw new Error(`kernel_wait wrote unexpected size: ${n}`);
    const view = new DataView(response.buffer, response.byteOffset, 8);
    return {
      pid: view.getUint32(0, true),
      status: view.getInt32(4, true),
    };
  }

  killProcess(pid: number, signal: number): number {
    return Number(this.kernel.killProcess(pid, signal));
  }

  /**
   * Install a file blob into kernel.wasm's in-memory ramfs at `path`,
   * replacing any existing content. Phase 2 ramfs is read-only from
   * userland; this is the only way bytes get in today.
   */
  registerRamfsFile(path: Uint8Array, content: Uint8Array): void {
    const req = new Uint8Array(4 + path.byteLength + content.byteLength);
    new DataView(req.buffer).setUint32(0, path.byteLength >>> 0, true);
    req.set(path, 4);
    req.set(content, 4 + path.byteLength);
    const { rc } = this.syscall(METHOD.KERNEL_REGISTER_FILE, req, 0);
    if (Number(rc) !== 0) {
      throw new Error(`kernel_register_file failed: rc=${rc}`);
    }
  }

  spawnUserProcess(userWasmBytes: Uint8Array): UserProcess {
    return this.spawnUserProcessWithArgs(userWasmBytes, []);
  }

  spawnUserProcessWithArgs(
    userWasmBytes: Uint8Array,
    argv: Uint8Array[],
  ): UserProcess {
    const userMemoryRef: { memory?: WebAssembly.Memory } = {};

    // Ask the kernel to allocate the pid and store argv so /proc
    // and process ownership stay inside kernel.wasm.
    let argvSize = 0;
    for (const a of argv) argvSize += 4 + a.byteLength;
    const argvReq = new Uint8Array(argvSize);
    const argvView = new DataView(argvReq.buffer);
    let cursor = 0;
    for (const a of argv) {
      argvView.setUint32(cursor, a.byteLength >>> 0, true);
      cursor += 4;
      argvReq.set(a, cursor);
      cursor += a.byteLength;
    }
    const pid = Number(this.kernel.spawnProcess(KERNEL_PID, argvReq));
    if (pid < 0) throw new Error(`kernel_spawn failed: rc=${pid}`);

    const sysImports = buildSysImports(pid, this.kernel, userMemoryRef);
    // sys_setrlimit takes (i32, i64, i64); BigInt at the wasm boundary
    // doesn't fit the unified signature in sys_shim, so it's wired
    // here directly.
    const sys_setrlimit = (
      resource: number,
      soft: bigint,
      hard: bigint,
    ): number => {
      const req = new Uint8Array(20);
      const v = new DataView(req.buffer);
      v.setUint32(0, resource >>> 0, true);
      v.setBigUint64(4, soft, true);
      v.setBigUint64(12, hard, true);
      return Number(this.kernel.syscall(METHOD.SYS_SETRLIMIT, pid, req, 0).rc);
    };

    const wasiShim = buildWasiShim(pid, this.kernel, argv, userMemoryRef);

    const userModule = new WebAssembly.Module(
      userWasmBytes as unknown as BufferSource,
    );
    const userInstance = new WebAssembly.Instance(userModule, {
      env: { ...sysImports, sys_setrlimit },
      wasi_snapshot_preview1: wasiShim,
    });
    const userMemory = userInstance.exports.memory as
      | WebAssembly.Memory
      | undefined;
    userMemoryRef.memory = userMemory ??
      new WebAssembly.Memory({ initial: 0 });
    return new UserProcess(
      pid,
      userInstance,
      userMemoryRef.memory,
      this.kernel,
    );
  }

  spawnUserProcessWithArgsAndStdin(
    userWasmBytes: Uint8Array,
    argv: Uint8Array[],
    stdin: Uint8Array,
    eof: boolean,
  ): UserProcess {
    const user = this.spawnUserProcessWithArgs(userWasmBytes, argv);
    if (stdin.byteLength > 0) user.feedStdin(stdin);
    if (eof) user.closeStdin();
    return user;
  }
}

/** Encode a string as UTF-8 byte-string for argv. */
export function s(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

// ── Universal browser-friendly impls ──────────────────────────────────
//
// These work in any host that ships the matching standard JS APIs:
// browsers always; Deno where the API exists (fetch + WebSocket).
// Browser-only APIs (IndexedDB, OPFS) feature-detect at construction
// time and throw a clear error in environments where they're absent.

/**
 * Universal `HostState.fetch` impl that wraps `globalThis.fetch`
 * with the JSON request/response encoding `network::fetch` speaks.
 * Works in browsers, Deno, Bun, Node 18+. When installed with
 * JSPI available, kh_fetch_blocking suspends the calling wasm.
 */
export async function globalFetch(
  request: Uint8Array,
): Promise<Uint8Array> {
  const reqStr = new TextDecoder().decode(request);
  let req: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  };
  try {
    req = JSON.parse(reqStr);
  } catch (e) {
    return new TextEncoder().encode(JSON.stringify({
      ok: false,
      status: 0,
      headers: {},
      body: "",
      error: `invalid request JSON: ${e}`,
    }));
  }
  try {
    const resp = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: req.headers,
      body: req.body,
    });
    const headers: Record<string, string> = {};
    for (const [k, v] of resp.headers.entries()) headers[k] = v;
    const bodyBytes = new Uint8Array(await resp.arrayBuffer());
    const body = new TextDecoder("utf-8", { fatal: false }).decode(bodyBytes);
    return new TextEncoder().encode(JSON.stringify({
      ok: resp.ok,
      status: resp.status,
      headers,
      body,
      error: null,
    }));
  } catch (e) {
    return new TextEncoder().encode(JSON.stringify({
      ok: false,
      status: 0,
      headers: {},
      body: "",
      error: `${e}`,
    }));
  }
}

/**
 * `TcpSocketImpl` that uses `WebSocket` as the transport. Suitable
 * for browsers (where raw TCP isn't available) and any host that
 * ships the WebSocket constructor. Connect maps the requested
 * `host:port` to a `ws://host:port/` URL by default; embedders
 * that need a different URL scheme override `urlForAddr`.
 *
 * Outbound only. Inbound (listen / accept) requires a page-side
 * relay callback per the project_listen_port_mapping memory note.
 */
export class WebSocketTcp implements TcpSocketImpl {
  private nextHandle = 1;
  private sockets = new Map<number, WebSocket>();
  // Buffered inbound bytes per handle; recvAsync drains them.
  private inbox = new Map<number, Uint8Array[]>();
  // Pending recv resolvers when inbox is empty and the caller is awaiting.
  private waiters = new Map<number, (n: number) => void>();
  // Tells recv whether the socket is closed (for EOF semantics).
  private closed = new Set<number>();

  constructor(
    /** Override to map `host:port` to a ws:// or wss:// URL. */
    private urlForAddr: (host: string, port: number) => string = (h, p) =>
      `ws://${h}:${p}/`,
  ) {}

  // Sync stubs.
  connect(): number {
    return -38;
  }
  send(): number {
    return -38;
  }
  recv(): number {
    return -38;
  }
  listen(): number {
    return -38;
  }
  accept(): number {
    return -38;
  }
  localAddr(): { host: string; port: number } | null {
    return null;
  }

  close(handle: number): number {
    const ws = this.sockets.get(handle);
    if (ws) {
      try {
        ws.close();
      } catch { /* */ }
      this.sockets.delete(handle);
    }
    this.inbox.delete(handle);
    this.waiters.delete(handle);
    this.closed.add(handle);
    return 0;
  }

  connectAsync(host: string, port: number, _flags: number): Promise<number> {
    return new Promise<number>((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.urlForAddr(host, port));
        ws.binaryType = "arraybuffer";
      } catch (_e) {
        resolve(-(111)); // -ECONNREFUSED
        return;
      }
      const handle = this.nextHandle++;
      ws.onmessage = (ev) => {
        const data = ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new TextEncoder().encode(String(ev.data));
        const queue = this.inbox.get(handle) ?? [];
        queue.push(data);
        this.inbox.set(handle, queue);
        const w = this.waiters.get(handle);
        if (w) {
          this.waiters.delete(handle);
          w(0); // signal; recvAsync drains the queue itself
        }
      };
      ws.onclose = () => {
        this.closed.add(handle);
        const w = this.waiters.get(handle);
        if (w) {
          this.waiters.delete(handle);
          w(0);
        }
      };
      ws.onerror = () => {/* surface via close */};
      ws.onopen = () => {
        this.sockets.set(handle, ws);
        resolve(handle);
      };
    });
  }

  send_internal(handle: number, data: Uint8Array): number {
    const ws = this.sockets.get(handle);
    if (!ws) return -9; // -EBADF
    try {
      ws.send(data);
      return data.byteLength;
    } catch (_e) {
      return -32; // -EPIPE
    }
  }

  // recv blocks (asynchronously) until bytes arrive or peer closes.
  async recvAsync(
    handle: number,
    buf: Uint8Array,
    _flags: number,
  ): Promise<number> {
    const drain = (): number => {
      const queue = this.inbox.get(handle);
      if (!queue || queue.length === 0) return -1;
      const next = queue.shift()!;
      const n = Math.min(next.byteLength, buf.byteLength);
      buf.set(next.subarray(0, n));
      if (next.byteLength > n) {
        // Push back the remainder.
        queue.unshift(next.subarray(n));
      }
      this.inbox.set(handle, queue);
      return n;
    };
    let drained = drain();
    if (drained >= 0) return drained;
    if (this.closed.has(handle) && !this.sockets.has(handle)) return 0; // EOF
    await new Promise<void>((resolve) => {
      this.waiters.set(handle, () => resolve());
    });
    drained = drain();
    if (drained >= 0) return drained;
    return 0; // EOF
  }
}

/**
 * Browser-native [`HostFsImpl`] backed by OPFS (the Origin
 * Private File System, exposed through
 * `navigator.storage.getDirectory()`). Browser-only — throws
 * at construction on hosts without the API (Deno, Node).
 *
 * Containment is automatic: OPFS is rooted at the page's
 * origin storage bucket; there's no concept of `..` escape.
 *
 * Sync HostFsImpl methods stub to -ENOSYS; the actual work
 * lives in the *Async variants and runs through the JSPI
 * Suspending pipeline. Symlinks aren't supported by OPFS —
 * symlinkAsync returns -ENOSYS.
 */
export class OpfsHostFs implements HostFsImpl {
  private rootHandle: Promise<FileSystemDirectoryHandle>;
  private fds = new Map<
    number,
    { fileHandle: FileSystemFileHandle; cursor: number; writable: boolean }
  >();
  private nextFd = 1;

  constructor() {
    // deno-lint-ignore no-explicit-any
    const nav = (globalThis as any).navigator;
    if (!nav?.storage?.getDirectory) {
      throw new Error(
        "OpfsHostFs: navigator.storage.getDirectory() is not available — browser-only impl",
      );
    }
    this.rootHandle = nav.storage.getDirectory();
  }

  // Sync stubs — JSPI takes the *Async path.
  open(): number {
    return -38;
  }
  read(): number {
    return -38;
  }
  write(): number {
    return -38;
  }
  close(): number {
    return 0;
  }
  stat(): HostFsStat | number {
    return -38;
  }
  unlink(): number {
    return -38;
  }
  mkdir(): number {
    return -38;
  }
  symlink(): number {
    return -38;
  }
  rename(): number {
    return -38;
  }

  /**
   * Resolve `path` (kernel-supplied, leading slash optional)
   * to (parent dir handle, leaf name). Walks the directory
   * tree creating intermediate dirs only when `createInter`
   * is set.
   */
  private async resolveParent(
    path: Uint8Array,
    createInter: boolean,
  ): Promise<
    { parent: FileSystemDirectoryHandle; leaf: string } | number
  > {
    const str = new TextDecoder().decode(path);
    const rel = str.startsWith("/") ? str.slice(1) : str;
    if (rel === "") return -22; // -EINVAL on root
    const parts = rel.split("/").filter((p) => p !== "");
    let dir = await this.rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
      try {
        dir = await dir.getDirectoryHandle(parts[i], { create: createInter });
      } catch {
        return -2; // -ENOENT
      }
    }
    return { parent: dir, leaf: parts[parts.length - 1] };
  }

  async openAsync(path: Uint8Array, flags: number): Promise<number> {
    const writable = (flags & 0b001) !== 0;
    const create = (flags & 0b010) !== 0;
    const trunc = (flags & 0b100) !== 0;
    const resolved = await this.resolveParent(path, writable && create);
    if (typeof resolved === "number") return resolved;
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await resolved.parent.getFileHandle(resolved.leaf, {
        create: writable && create,
      });
    } catch {
      return -2; // -ENOENT
    }
    if (trunc && writable) {
      try {
        const w = await fileHandle.createWritable();
        await w.truncate(0);
        await w.close();
      } catch {
        return -5; // -EIO
      }
    }
    const fd = this.nextFd++;
    this.fds.set(fd, { fileHandle, cursor: 0, writable });
    return fd;
  }

  async readAsync(fd: number, buf: Uint8Array): Promise<number> {
    const e = this.fds.get(fd);
    if (!e) return -9; // -EBADF
    let file: File;
    try {
      file = await e.fileHandle.getFile();
    } catch {
      return -5;
    }
    const slice = file.slice(e.cursor, e.cursor + buf.byteLength);
    const bytes = new Uint8Array(await slice.arrayBuffer());
    buf.set(bytes);
    e.cursor += bytes.byteLength;
    return bytes.byteLength;
  }

  async writeAsync(fd: number, data: Uint8Array): Promise<number> {
    const e = this.fds.get(fd);
    if (!e) return -9;
    if (!e.writable) return -9;
    try {
      const w = await e.fileHandle.createWritable({ keepExistingData: true });
      await w.write({ type: "write", position: e.cursor, data });
      await w.close();
      e.cursor += data.byteLength;
      return data.byteLength;
    } catch {
      return -5;
    }
  }

  closeAsync(fd: number): Promise<number> {
    this.fds.delete(fd);
    return Promise.resolve(0);
  }

  async statAsync(path: Uint8Array): Promise<HostFsStat | number> {
    const resolved = await this.resolveParent(path, false);
    if (typeof resolved === "number") return resolved;
    // Try as a file first; fall back to directory.
    try {
      const handle = await resolved.parent.getFileHandle(resolved.leaf);
      const file = await handle.getFile();
      return {
        size: BigInt(file.size),
        mode: 0o100_644,
        mtimeNs: BigInt(file.lastModified) * 1_000_000n,
        isDir: false,
        isSymlink: false,
      };
    } catch {
      try {
        await resolved.parent.getDirectoryHandle(resolved.leaf);
        return {
          size: 0n,
          mode: 0o040_755,
          mtimeNs: 0n,
          isDir: true,
          isSymlink: false,
        };
      } catch {
        return -2;
      }
    }
  }

  async unlinkAsync(path: Uint8Array): Promise<number> {
    const resolved = await this.resolveParent(path, false);
    if (typeof resolved === "number") return resolved;
    try {
      await resolved.parent.removeEntry(resolved.leaf);
      return 0;
    } catch {
      return -2;
    }
  }

  async mkdirAsync(path: Uint8Array, _mode: number): Promise<number> {
    const resolved = await this.resolveParent(path, true);
    if (typeof resolved === "number") return resolved;
    // Detect already-exists by getting it without create first.
    try {
      await resolved.parent.getDirectoryHandle(resolved.leaf);
      return -17; // -EEXIST
    } catch { /* didn't exist — proceed */ }
    try {
      await resolved.parent.getDirectoryHandle(resolved.leaf, { create: true });
      return 0;
    } catch {
      return -5;
    }
  }

  symlinkAsync(
    _target: Uint8Array,
    _linkPath: Uint8Array,
  ): Promise<number> {
    return Promise.resolve(-38); // OPFS doesn't support symlinks
  }

  async renameAsync(oldPath: Uint8Array, newPath: Uint8Array): Promise<number> {
    // Fallback: copy + delete. The newer FileSystemFileHandle.move
    // API isn't universally available, so this works everywhere
    // OPFS does. Loses inode identity (POSIX rename callers
    // don't observe inode numbers).
    const oldR = await this.resolveParent(oldPath, false);
    if (typeof oldR === "number") return oldR;
    const newR = await this.resolveParent(newPath, true);
    if (typeof newR === "number") return newR;
    try {
      const src = await oldR.parent.getFileHandle(oldR.leaf);
      const file = await src.getFile();
      const data = new Uint8Array(await file.arrayBuffer());
      const dst = await newR.parent.getFileHandle(newR.leaf, { create: true });
      const w = await dst.createWritable();
      await w.write(data);
      await w.close();
      await oldR.parent.removeEntry(oldR.leaf);
      return 0;
    } catch {
      return -5;
    }
  }
}

/**
 * `KvBackend` that proxies to browser-native `globalThis.indexedDB`.
 * Browser-only — throws at construction in Deno (no `indexedDB`)
 * and other hosts that don't ship the API. Storage layout: one
 * IDB *database* per `IndexedDbKv` instance; one IDB *object store*
 * per `store` argument; entries are `(key bytes -> value bytes)`.
 *
 * All ops are async (matches IndexedDB). Without JSPI the matching
 * kh_idb_* imports stay -EACCES — same constraint as kh_fetch_blocking.
 */
export class IndexedDbKv implements KvBackend {
  private db: IDBDatabase | null = null;
  private opening: Promise<IDBDatabase>;
  private knownStores = new Set<string>();

  constructor(private dbName: string = "yurt-kv") {
    // deno-lint-ignore no-explicit-any
    const idb = (globalThis as any).indexedDB as IDBFactory | undefined;
    if (!idb) {
      throw new Error(
        "IndexedDbKv: globalThis.indexedDB is not available — use this impl from browser code only",
      );
    }
    this.opening = new Promise((resolve, reject) => {
      const req = idb.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        // Stores added lazily via ensureStore; nothing to do here.
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.opening.then((db) => {
      this.db = db;
    });
  }

  private storeName(s: Uint8Array): string {
    return new TextDecoder().decode(s) || "_default";
  }

  private async ensureStore(name: string): Promise<IDBDatabase> {
    const db = this.db ?? (await this.opening);
    if (db.objectStoreNames.contains(name)) {
      this.knownStores.add(name);
      return db;
    }
    if (this.knownStores.has(name)) return db;
    // Trigger an upgrade to add the new store.
    db.close();
    this.db = null;
    // deno-lint-ignore no-explicit-any
    const idb = (globalThis as any).indexedDB as IDBFactory;
    const newDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = idb.open(this.dbName, db.version + 1);
      req.onupgradeneeded = () => {
        const upgraded = req.result;
        if (!upgraded.objectStoreNames.contains(name)) {
          upgraded.createObjectStore(name);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    this.knownStores.add(name);
    this.db = newDb;
    this.opening = Promise.resolve(newDb);
    return newDb;
  }

  // Sync stubs.
  get(): Uint8Array | number {
    return -38;
  }
  put(): number {
    return -38;
  }
  delete(): number {
    return -38;
  }
  list(): Uint8Array[] {
    return [];
  }

  async getAsync(
    store: Uint8Array,
    key: Uint8Array,
  ): Promise<Uint8Array | number> {
    const name = this.storeName(store);
    const db = await this.ensureStore(name);
    return await new Promise((resolve) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).get(key);
      req.onsuccess = () => {
        const v = req.result as Uint8Array | undefined;
        resolve(v ?? -2); // -ENOENT
      };
      req.onerror = () => resolve(-5); // -EIO
    });
  }

  async putAsync(
    store: Uint8Array,
    key: Uint8Array,
    value: Uint8Array,
  ): Promise<number> {
    const name = this.storeName(store);
    const db = await this.ensureStore(name);
    return await new Promise((resolve) => {
      const tx = db.transaction(name, "readwrite");
      const req = tx.objectStore(name).put(value, key);
      req.onsuccess = () => resolve(0);
      req.onerror = () => resolve(-5);
    });
  }

  async deleteAsync(store: Uint8Array, key: Uint8Array): Promise<number> {
    const name = this.storeName(store);
    const db = await this.ensureStore(name);
    return await new Promise((resolve) => {
      const tx = db.transaction(name, "readwrite");
      const req = tx.objectStore(name).delete(key);
      req.onsuccess = () => resolve(0);
      req.onerror = () => resolve(-5);
    });
  }

  async listAsync(
    store: Uint8Array,
    prefix: Uint8Array,
  ): Promise<Uint8Array[]> {
    const name = this.storeName(store);
    const db = await this.ensureStore(name);
    return await new Promise((resolve) => {
      const tx = db.transaction(name, "readonly");
      const req = tx.objectStore(name).getAllKeys();
      req.onsuccess = () => {
        const keys = (req.result as Uint8Array[]).filter((k) => {
          if (k.byteLength < prefix.byteLength) return false;
          for (let i = 0; i < prefix.byteLength; i++) {
            if (k[i] !== prefix[i]) return false;
          }
          return true;
        });
        resolve(keys);
      };
      req.onerror = () => resolve([]);
    });
  }
}
