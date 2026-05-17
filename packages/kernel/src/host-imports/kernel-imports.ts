/**
 * Unified host import implementations for the `yurt` WASM namespace.
 *
 * createKernelImports() returns a record of functions that form the `yurt`
 * import namespace consumed by ANY WASM process (shell, python, tool binaries).
 *
 * Syscalls provided:
 *   Process management (new):
 *   - host_pipe: create a pipe, returns read_fd and write_fd
 *   - host_spawn: spawn a child WASM process
 *   - host_wait: wait for a child process to exit (async, requires JSPI)
 *   - host_close_fd: close a file descriptor
 *
 *   Network / extensions:
 *   - host_network_fetch: HTTP fetch via NetworkBridge (async/JSPI)
 *   - host_extension_invoke: call a host extension (Python only; shell uses host_spawn)
 */

import type {
  FetchRedirectMode,
  NetworkBridgeLike,
} from "../network/bridge.js";
import type {
  SocketBackend,
  SocketListenPolicy,
  SocketPortMapping,
} from "../network/socket-backend.js";
import {
  acceptSocketAsync,
  createLoopbackSocketBackend,
  createNetworkBridgeSocketBackend,
  recvSocketAsync,
} from "../network/socket-backend.js";
import {
  HandleTable as DynlinkHandleTable,
  loadSideModule,
  lookupSymbol,
  mainAccessFromInstance,
} from "../process/dynlink.js";
import type { ExtensionRegistry } from "../extension/registry.js";
import type {
  ProcessCredentials,
  ProcessKernel,
  SpawnRequest,
} from "../process/kernel.js";
import { FdDupMinError, POSIX_EINVAL } from "../process/kernel.js";
import {
  normalizeNice,
  normalizeSchedulerPolicy,
  normalizeSchedulerPriority,
  type RuntimeEngineBackend,
  unsupportedRuntimeEngineBackend,
} from "../engine/backend.js";
import type { ProcessManager } from "../process/manager.js";
import { WasiExitError, type WasiHost } from "../wasi/wasi-host.js";
import type { ThreadsBackend } from "../process/threads/backend.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import type { FdTarget } from "../wasi/fd-target.js";
import { createStaticTarget } from "../wasi/fd-target.js";
import { WASI_FDFLAGS_NONBLOCK } from "../wasi/types.ts";
import {
  decodeSockaddrIn,
  readBytes,
  readRecordHeader,
  readSpan,
  readString,
  writeBytes,
  writeString,
} from "./common.js";
import { resolveHostname } from "../platform/dns.js";

export interface KernelImportsOptions {
  memory: WebAssembly.Memory;

  /** PID of the calling process (used for fd table lookups). */
  callerPid?: number;
  /** Effective uid/gid of the calling guest process. Defaults to the sandbox user. */
  callerUid?: number;
  callerGid?: number;

  /** Process kernel for pipe/spawn/waitpid/close_fd. Optional until Task 8. */
  kernel?: ProcessKernel;

  /** VFS backing this process. Used by generic file metadata imports. */
  vfs?: VfsLike;

  /** Network bridge for synchronous HTTP fetch from WASM. */
  networkBridge?: NetworkBridgeLike;

  /** Backend for fd-based POSIX socket imports. Defaults to a NetworkBridge adapter. */
  socketBackend?: SocketBackend;

  /** Fake sandbox-local IPv4 address reported by getsockname()/socket_addr(). */
  socketLocalHost?: string;

  /** Prepared policy surface for future bind/listen/accept support. */
  serverSockets?: SocketListenPolicy;

  /**
   * Extension registry for host_extension_invoke (used by Python WASM).
   * The shell no longer calls host_extension_invoke — it routes everything
   * through host_spawn, and the ProcessManager dispatches to host commands.
   */
  extensionRegistry?: ExtensionRegistry;

  /**
   * Legacy extension handler (used by Worker proxy).
   * If both extensionRegistry and extensionHandler are provided,
   * extensionRegistry takes precedence.
   */
  extensionHandler?: (
    cmd: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;

  /** Called by host_spawn to actually create and start a WASM process.
   *  `parentPid` is the PID of the in-sandbox process making the spawn
   *  call — set on the child as ppid so getppid() inside the child
   *  resolves to its real spawning parent. */
  spawnProcess?: (
    req: SpawnRequest,
    fdTable: Map<number, FdTarget>,
    parentPid: number,
  ) => number;

  /** Active WASI host for guest-side fd operations such as dup2 on stdio. */
  wasiHost?: WasiHost;

  /** Backend for guest pthread/std::thread host imports. */
  threadsBackend?: ThreadsBackend;

  /** Engine-specific runtime capabilities selected once when the sandbox starts. */
  runtimeBackend?: RuntimeEngineBackend;

  /** Process manager for tool registry (host_has_tool, host_register_tool). */
  mgr?: ProcessManager;

  /**
   * Lazy accessor for the main module's instance. Used by the Phase 1
   * shared-library loader to call `__alloc`, grow the
   * `__indirect_function_table`, and reuse `memory` when instantiating
   * a side module. The accessor is invoked AFTER the main module
   * finishes instantiating (which is necessarily after
   * `createKernelImports` has returned), so callers wire it via a
   * captured ref-cell or proxy. Returns `null` if dlopen is invoked
   * before the main module is ready (the loader treats that as an
   * error). See packages/kernel/src/process/dynlink.ts.
   */
  mainInstance?: () => WebAssembly.Instance | null;

  /**
   * The `WebAssembly.Memory` instance the main module imports from
   * `env.memory`, or `null` when the main module exports its own
   * memory. Threaded modules (target=wasm32-wasip1-threads with
   * `-Wl,--import-memory --shared-memory`) import a SAB-backed
   * memory and don't export `memory` — the Phase 1 dlopen loader
   * needs this reference to satisfy side modules' `env.memory`
   * imports, since `mainInstance.exports.memory` is undefined.
   * Defaults to `null` for backwards-compatibility with non-threaded
   * callers.
   */
  mainImportedMemory?: WebAssembly.Memory | null;
}

const ERR_NOT_FOUND = -1;
const ERR_PERMISSION = -2;
const ERR_IO = -3;
const ERR_NOT_DIR = -4;
const ERR_UNSUPPORTED = -38;
const ERR_INVALID = -22;
const ERR_INTERRUPTED = -27;
const ERR_PRIORITY_NOT_FOUND = -1001;
const ERR_AGAIN = -11;
const ERR_CHILD = -10;
const ERR_BADF = -9;
const ERR_OP_NOT_SUPPORTED = -95;
const ERR_CONN_REFUSED = -111;
const ROOT_UID = 0;
const USER_UID = 1000;
const USER_GID = 1000;
const PRIO_PROCESS = 0;
const YURT_WAIT_NOHANG = 1;
export const POLLIN = 0x0001;
export const POLLOUT = 0x0002;
export const POLLERR = 0x0008;
export const POLLHUP = 0x0010;
export const POLLNVAL = 0x0020;
export const POLLFD_SIZE = 8;

export { netLog } from "./net-debug.ts";
import { netLog } from "./net-debug.ts";

function writeI32(
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number,
  value: number,
): number {
  const required = 4;
  if (cap < required) return required;
  const end = ptr + required;
  if (ptr < 0 || end > memory.buffer.byteLength) return ERR_IO;
  new DataView(memory.buffer).setInt32(ptr, value, true);
  return required;
}

function writePipeResult(
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number,
  readFd: number,
  writeFd: number,
): number {
  const required = 8;
  if (cap < required) return required;
  const end = ptr + required;
  if (ptr < 0 || end > memory.buffer.byteLength) return ERR_IO;
  const view = new DataView(memory.buffer);
  view.setInt32(ptr, readFd, true);
  view.setInt32(ptr + 4, writeFd, true);
  return required;
}

function writeWaitResult(
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number,
  pid: number,
  exitCode: number,
  signal = 0,
  flags = 0,
): number {
  const required = 16;
  if (cap < required) return required;
  const end = ptr + required;
  if (ptr < 0 || end > memory.buffer.byteLength) return ERR_IO;
  const view = new DataView(memory.buffer);
  view.setInt32(ptr, pid, true);
  view.setInt32(ptr + 4, exitCode, true);
  view.setInt32(ptr + 8, signal, true);
  view.setInt32(ptr + 12, flags, true);
  return required;
}

function writeSpawnResult(
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number,
  pid: number,
): number {
  return writeI32(memory, ptr, cap, pid);
}

const NATIVE_RECORD_VERSION_1 = 1;
const STAT_RECORD_SIZE = 32;
const FILE_TYPE_FILE = 1;
const FILE_TYPE_DIR = 2;
const FILE_TYPE_SYMLINK = 4;
const SPAWN_REQUEST_V1_SIZE = 88;
const SPAN_SIZE = 8;
const ENV_PAIR_SIZE = 16;
const FD_MAP_PAIR_SIZE = 8;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function writeStatRecord(
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number,
  stat: { type: string; permissions: number; size: number; mtime?: Date },
): number {
  if (cap < STAT_RECORD_SIZE) return STAT_RECORD_SIZE;
  const end = ptr + STAT_RECORD_SIZE;
  if (ptr < 0 || end > memory.buffer.byteLength) return ERR_IO;
  const view = new DataView(memory.buffer);
  let typeBits = 0;
  if (stat.type === "file") typeBits |= FILE_TYPE_FILE;
  if (stat.type === "dir") typeBits |= FILE_TYPE_DIR;
  if (stat.type === "symlink") typeBits |= FILE_TYPE_SYMLINK;
  view.setUint32(ptr, STAT_RECORD_SIZE, true);
  view.setUint16(ptr + 4, NATIVE_RECORD_VERSION_1, true);
  view.setUint16(ptr + 6, 0, true);
  view.setUint32(ptr + 8, typeBits, true);
  view.setUint32(ptr + 12, stat.permissions >>> 0, true);
  view.setBigUint64(ptr + 16, BigInt(stat.size), true);
  view.setBigUint64(ptr + 24, BigInt(stat.mtime?.getTime() ?? 0), true);
  return STAT_RECORD_SIZE;
}

function writeStringListRecord(
  memory: WebAssembly.Memory,
  ptr: number,
  cap: number,
  values: string[],
): number {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const headerSize = 24;
  const entriesOffset = headerSize;
  const stringsOffset = entriesOffset + encoded.length * SPAN_SIZE;
  const stringsLength = encoded.reduce(
    (sum, bytes) => sum + bytes.byteLength,
    0,
  );
  const required = stringsOffset + stringsLength;
  if (cap < required) return required;
  const end = ptr + required;
  if (ptr < 0 || end > memory.buffer.byteLength) return ERR_IO;
  const out = new Uint8Array(memory.buffer, ptr, required);
  const view = new DataView(memory.buffer, ptr, required);
  out.fill(0);
  view.setUint32(0, required, true);
  view.setUint16(4, NATIVE_RECORD_VERSION_1, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, encoded.length, true);
  view.setUint32(12, entriesOffset, true);
  view.setUint32(16, stringsOffset, true);
  view.setUint32(20, stringsLength, true);
  let cursor = 0;
  for (let i = 0; i < encoded.length; i++) {
    const entry = entriesOffset + i * SPAN_SIZE;
    const bytes = encoded[i];
    view.setUint32(entry, cursor, true);
    view.setUint32(entry + 4, bytes.byteLength, true);
    out.set(bytes, stringsOffset + cursor);
    cursor += bytes.byteLength;
  }
  return required;
}

function decodeNativeSpawnRequest(bytes: Uint8Array): SpawnRequest | null {
  if (bytes.byteLength < SPAWN_REQUEST_V1_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const logicalSize = view.getUint32(0, true);
  const version = view.getUint16(4, true);
  if (
    version !== NATIVE_RECORD_VERSION_1 ||
    logicalSize < SPAWN_REQUEST_V1_SIZE
  ) return null;
  if (logicalSize > bytes.byteLength) {
    throw new Error("native spawn request exceeds buffer");
  }

  const readU32 = (off: number) => {
    if (off < 0 || off + 4 > logicalSize) {
      throw new Error("native spawn scalar out of bounds");
    }
    return view.getUint32(off, true);
  };
  const readI32 = (off: number) => {
    if (off < 0 || off + 4 > logicalSize) {
      throw new Error("native spawn scalar out of bounds");
    }
    return view.getInt32(off, true);
  };
  const readSpan = (off: number): string | undefined => {
    const spanOff = readU32(off);
    const len = readU32(off + 4);
    if (spanOff === 0 && len === 0) return undefined;
    if (spanOff % 4 !== 0) throw new Error("native spawn unaligned span");
    if (spanOff + len > logicalSize) {
      throw new Error("native spawn span out of bounds");
    }
    return fatalUtf8Decoder.decode(bytes.subarray(spanOff, spanOff + len));
  };
  const readRequiredSpan = (off: number): string => {
    const value = readSpan(off);
    if (value === undefined) {
      throw new Error("native spawn missing required string");
    }
    return value;
  };
  const readStringVec = (vecOff: number, count: number): string[] => {
    if (count === 0) return [];
    if (
      vecOff === 0 || vecOff % 4 !== 0 ||
      vecOff + count * SPAN_SIZE > logicalSize
    ) {
      throw new Error("native spawn string vec out of bounds");
    }
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      out.push(readRequiredSpan(vecOff + i * SPAN_SIZE));
    }
    return out;
  };
  const readEnvVec = (vecOff: number, count: number): [string, string][] => {
    if (count === 0) return [];
    if (
      vecOff === 0 || vecOff % 4 !== 0 ||
      vecOff + count * ENV_PAIR_SIZE > logicalSize
    ) {
      throw new Error("native spawn env vec out of bounds");
    }
    const out: [string, string][] = [];
    for (let i = 0; i < count; i++) {
      const off = vecOff + i * ENV_PAIR_SIZE;
      out.push([readRequiredSpan(off), readRequiredSpan(off + SPAN_SIZE)]);
    }
    return out;
  };
  const readI32Vec = (vecOff: number, count: number): number[] => {
    if (count === 0) return [];
    if (vecOff === 0 || vecOff % 4 !== 0 || vecOff + count * 4 > logicalSize) {
      throw new Error("native spawn i32 vec out of bounds");
    }
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(readI32(vecOff + i * 4));
    return out;
  };
  const readFdMap = (vecOff: number, count: number): [number, number][] => {
    if (count === 0) return [];
    if (
      vecOff === 0 || vecOff % 4 !== 0 ||
      vecOff + count * FD_MAP_PAIR_SIZE > logicalSize
    ) {
      throw new Error("native spawn fd map out of bounds");
    }
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) {
      const off = vecOff + i * FD_MAP_PAIR_SIZE;
      out.push([readI32(off), readI32(off + 4)]);
    }
    return out;
  };
  const argv0 = readSpan(16);
  const cwd = readSpan(40);
  const stdinData = readSpan(68);
  const fdMap = readFdMap(readU32(80), readU32(84));
  return {
    prog: readRequiredSpan(8),
    ...(argv0 === undefined ? {} : { argv0 }),
    args: readStringVec(readU32(24), readU32(28)),
    env: readEnvVec(readU32(32), readU32(36)),
    cwd: cwd ?? "",
    stdin_fd: readI32(48),
    stdout_fd: readI32(52),
    stderr_fd: readI32(56),
    pass_fds: readI32Vec(readU32(60), readU32(64)),
    fd_map: fdMap,
    ...(stdinData === undefined ? {} : { stdin_data: stdinData }),
    nice: readI32(76),
  };
}

function yieldToScheduler(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Allocate a connected AF_UNIX socket pair (stream or dgram) and
 * register both sides as kernel fds for the caller process. Shared
 * between `host_socket_socketpair` on main and the worker-host
 * dispatcher's `socketPair` body, so pthread workers reach the same
 * kernel state through the proxy.
 */
export function allocUnixSocketPair(
  kernel: ProcessKernel,
  socketBackend: SocketBackend,
  callerPid: number,
  sockType: number,
): { fdA: number; fdB: number } | null {
  try {
    const registry = socketBackend.registry;
    if (!registry) return null;
    const pairCreds = kernel.getCredentials(callerPid);
    const SOCK_DGRAM = 5; // wasi-sdk-30 value passed by C via base_type
    if (sockType === SOCK_DGRAM) {
      const { a, b } = registry.openDgramPair();
      const makeDgramTarget = (rawHandle: number): FdTarget => ({
        type: "socket",
        socket: -rawHandle,
        family: "AF_UNIX",
        isDgram: true,
        refs: 1,
        peerPid: callerPid,
        peerUid: pairCreds.euid,
        peerGid: pairCreds.egid,
        send: socketBackend.send.bind(socketBackend),
        recv: socketBackend.recv.bind(socketBackend),
        recvAsync: (socket, maxBytes) =>
          recvSocketAsync(socketBackend, socket, maxBytes),
        setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
        close: (_socket) => {
          registry.closeDgramSocket(rawHandle);
        },
      });
      const fdA = kernel.allocFd(callerPid, makeDgramTarget(a));
      const fdB = kernel.allocFd(callerPid, makeDgramTarget(b));
      return { fdA, fdB };
    }
    const { a, b } = registry.openUnixPair();
    const makeTarget = (rawHandle: number): FdTarget => ({
      type: "socket",
      socket: -rawHandle,
      family: "AF_UNIX",
      refs: 1,
      peerPid: callerPid,
      peerUid: pairCreds.euid,
      peerGid: pairCreds.egid,
      send: socketBackend.send.bind(socketBackend),
      recv: socketBackend.recv.bind(socketBackend),
      recvAsync: (socket, maxBytes) =>
        recvSocketAsync(socketBackend, socket, maxBytes),
      setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
      close: (socket) => {
        socketBackend.close(socket);
      },
    });
    const fdA = kernel.allocFd(callerPid, makeTarget(a));
    const fdB = kernel.allocFd(callerPid, makeTarget(b));
    return { fdA, fdB };
  } catch {
    return null;
  }
}

/**
 * Allocate a fresh AF_INET stream socket fd with the same backend-
 * wired closures `host_socket_open` installs on the main thread.
 * Shared between the wasm import and the worker-host dispatcher so
 * pthread Workers (e.g. ipykernel's Heartbeat thread, libzmq's I/O
 * reactor) can `socket()` + `bind()` + `accept()` against the same
 * loopback registry main uses.
 */
export function allocInetStreamSocket(
  kernel: ProcessKernel,
  socketBackend: SocketBackend | null,
  callerPid: number,
  nonblocking = false,
): number {
  return kernel.allocFd(callerPid, {
    type: "socket",
    socket: null,
    refs: 1,
    fdFlags: nonblocking ? WASI_FDFLAGS_NONBLOCK : 0,
    send: (socket, data) =>
      socketBackend?.send(socket, data) ??
        { ok: false, error: "networking not configured" },
    recv: (socket, maxBytes, recvOpts) =>
      socketBackend?.recv(socket, maxBytes, recvOpts) ??
        { ok: false, error: "networking not configured" },
    recvAsync: (socket, maxBytes) =>
      socketBackend
        ? recvSocketAsync(socketBackend, socket, maxBytes)
        : Promise.resolve({
          ok: false,
          error: "networking not configured",
        }),
    setNoDelay: (socket, enabled) =>
      socketBackend?.setNoDelay?.(socket, enabled) ??
        { ok: false, error: "TCP_NODELAY not supported by socket backend" },
    close: (socket) => {
      socketBackend?.close(socket);
    },
  });
}

/**
 * Nonblocking AF_UNIX recv for pthread workers. Mirrors the
 * sync-friendly fast-path of `host_socket_recv_unix`: probes the
 * registry without awaiting and returns {-3} for wrong family,
 * {-2} for EAGAIN, {-1} for hard errors, or {bytes-read, bytes}.
 * The pthread side decides whether to retry on -2.
 */
export function recvUnixSocketNonblocking(
  kernel: ProcessKernel,
  socketBackend: SocketBackend,
  callerPid: number,
  sockfd: number,
  bufCap: number,
  peek: boolean,
): { result: number; bytes?: Uint8Array } {
  const target = kernel.getFdTarget(callerPid, sockfd);
  if (!target || target.type !== "socket") return { result: -3 };
  if (target.family !== "AF_UNIX") return { result: -3 };
  const registry = socketBackend.registry;
  if (!registry) return { result: -1 };

  if (target.isDgram) {
    if (target.socket == null) return { result: -1 };
    const rawHandle = -(target.socket as number);
    const r = registry.recvDgram(rawHandle, bufCap, true);
    if (!r.ok) return { result: -2 };
    const b = (r as { ok: true; bytes: Uint8Array }).bytes;
    const n = Math.min(b.length, bufCap);
    return { result: n, bytes: b.subarray(0, n) };
  }

  const socket = target.socket as number | null;
  if (socket === null || socket >= 0) return { result: -1 };
  const regHandle = -socket;

  if (target.peekBuffer && target.peekBuffer.byteLength > 0) {
    const chunk = target.peekBuffer.slice(0, bufCap);
    if (!peek) target.peekBuffer = target.peekBuffer.slice(chunk.byteLength);
    return { result: chunk.byteLength, bytes: chunk };
  }

  const probe = registry.recv(regHandle, bufCap, { nonblocking: true });
  if (!probe.ok) return { result: probe.error === "EAGAIN" ? -2 : -1 };
  if (peek) target.peekBuffer = probe.bytes;
  return { result: probe.bytes.byteLength, bytes: probe.bytes };
}

/**
 * AF_UNIX send for pthread workers. Mirrors the synchronous fast-path of
 * `host_socket_send_unix` so the worker-host dispatcher can satisfy
 * libzmq signaler writes without crossing back to main's async surface.
 */
export function sendUnixSocket(
  kernel: ProcessKernel,
  socketBackend: SocketBackend,
  callerPid: number,
  sockfd: number,
  data: Uint8Array,
): number {
  const target = kernel.getFdTarget(callerPid, sockfd);
  if (!target || target.type !== "socket") return -2;
  if (target.family !== "AF_UNIX") return -2;
  const socket = target.socket as number | null;
  if (socket === null || socket >= 0) return -1;
  const registry = socketBackend.registry;
  if (!registry) return -1;
  if (target.isDgram) {
    const result = registry.sendDgramToPeer(-socket, new Uint8Array(data));
    if (!result.ok) return -1;
    return result.bytesSent;
  }
  const result = registry.send(-socket, new Uint8Array(data));
  if (!result.ok) return -1;
  return result.bytesSent;
}

export function pollReventsForTarget(target: FdTarget, events: number): number {
  let revents = 0;
  const wantsRead = (events & POLLIN) !== 0;
  const wantsWrite = (events & POLLOUT) !== 0;

  switch (target.type) {
    case "pipe_read":
      if (wantsRead && target.pipe.hasBufferedData) revents |= POLLIN;
      if (target.pipe.writeClosed && !target.pipe.hasBufferedData) {
        revents |= POLLHUP;
      }
      break;
    case "pipe_write":
      if (target.pipe.closed) revents |= POLLERR;
      else if (wantsWrite && target.pipe.hasCapacity) revents |= POLLOUT;
      break;
    case "tty_slave":
      if (wantsRead && target.state.toSlave.length > 0) revents |= POLLIN;
      if (target.state.masterClosed) revents |= POLLHUP;
      if (wantsWrite) revents |= POLLOUT;
      break;
    case "tty_master":
      if (wantsRead && target.state.toMaster.length > 0) revents |= POLLIN;
      if (wantsWrite && !target.state.masterClosed) revents |= POLLOUT;
      if (target.state.masterClosed) revents |= POLLHUP;
      break;
    case "buffer":
      // Buffer targets are write-only stdout/stderr captures.
      if (wantsWrite) revents |= POLLOUT;
      break;
    case "static":
      if (wantsRead) revents |= POLLIN;
      break;
    case "socket":
      if (wantsRead) {
        if ((target.peekBuffer?.byteLength ?? 0) > 0 || target.readShutdown) {
          revents |= POLLIN;
        } else if (target.socket !== null) {
          // Socket readiness is probed by a nonblocking recv; any byte read
          // here is cached so the following guest recv observes it.
          // After the bridge async-fication, recv returns Awaitable: for
          // the loopback fast-path it's still sync, for the bridge it's
          // a Promise. poll() is a sync helper, so if we get a Promise
          // we conservatively treat the fd as not-ready-yet; the next
          // poll cycle will retry.
          const probeAwaitable = target.recv(target.socket, 1, {
            nonblocking: true,
          });
          if (
            typeof (probeAwaitable as Promise<unknown>).then !== "function"
          ) {
            const probe = probeAwaitable as
              & { ok: boolean }
              & Record<
                string,
                unknown
              >;
            if (probe.ok) {
              const data = (probe.data as Uint8Array | undefined) ??
                new Uint8Array(0);
              if (data.byteLength > 0) target.peekBuffer = data;
              else target.readShutdown = true;
              revents |= POLLIN;
            } else if (probe.error !== "EAGAIN") {
              revents |= POLLERR;
            }
          }
        }
      }
      if (wantsWrite && target.socket !== null && !target.writeShutdown) {
        revents |= POLLOUT;
      }
      break;
    case "null":
    case "vfs_file":
    case "vfs_dir":
      if (wantsRead) revents |= POLLIN;
      if (wantsWrite) revents |= POLLOUT;
      break;
  }

  return revents;
}

function globToRegExp(pattern: string): RegExp {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
        if (pattern[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "[") {
      let j = i + 1;
      if (j < pattern.length && (pattern[j] === "!" || pattern[j] === "^")) j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) {
        re += "\\[";
        i++;
      } else {
        let cls = pattern.slice(i + 1, j);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        re += "[" + cls + "]";
        i = j + 1;
      }
    } else if (".+^${}()|\\".includes(ch)) {
      re += "\\" + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp("^" + re + "$");
}

function globBaseDir(pattern: string): string {
  const parts = pattern.split("/");
  const base: string[] = [];
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break;
    base.push(part);
  }
  const dir = base.join("/");
  if (dir === "") return pattern.startsWith("/") ? "/" : ".";
  return dir;
}

function walkVfs(vfs: VfsLike, dir: string): string[] {
  const results: string[] = [];
  let entries: ReturnType<VfsLike["readdir"]>;
  try {
    entries = vfs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = dir === "/" ? "/" + entry.name : dir + "/" + entry.name;
    results.push(fullPath);
    if (entry.type === "dir") {
      results.push(...walkVfs(vfs, fullPath));
    }
  }
  return results;
}

function globMatch(vfs: VfsLike, pattern: string): string[] {
  const absPattern = pattern.startsWith("/") ? pattern : "/" + pattern;
  const baseDir = globBaseDir(absPattern);
  const regex = globToRegExp(absPattern);
  const allPaths = walkVfs(vfs, baseDir);
  const matches = allPaths.filter((p) => regex.test(p));
  matches.sort();
  return matches;
}

async function walkVfsAsync(vfs: AsyncHostVfs, dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: ReturnType<VfsLike["readdir"]>;
  try {
    entries = vfs.readdirAsync ? await vfs.readdirAsync(dir) : vfs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = dir === "/" ? "/" + entry.name : dir + "/" + entry.name;
    results.push(fullPath);
    if (entry.type === "dir") {
      results.push(...await walkVfsAsync(vfs, fullPath));
    }
  }
  return results;
}

async function globMatchAsync(
  vfs: AsyncHostVfs,
  pattern: string,
): Promise<string[]> {
  const absPattern = pattern.startsWith("/") ? pattern : "/" + pattern;
  const baseDir = globBaseDir(absPattern);
  const regex = globToRegExp(absPattern);
  const allPaths = await walkVfsAsync(vfs, baseDir);
  const matches = allPaths.filter((p) => regex.test(p));
  matches.sort();
  return matches;
}

function normalizeImportPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

function resolveCwdPath(cwd: string, path: string): string {
  if (path.startsWith("/")) return normalizeImportPath(path);
  if (path === "" || path === ".") return normalizeImportPath(cwd);
  return normalizeImportPath(cwd === "/" ? `/${path}` : `${cwd}/${path}`);
}

function resolveLogicalCwdPath(cwd: string, path: string): string {
  if (path.startsWith("/")) {
    const physicalCwd = normalizeImportPath(cwd);
    const physicalPath = normalizeImportPath(path);
    if (cwd !== physicalCwd) {
      if (physicalPath === physicalCwd) return cwd;
      const prefix = physicalCwd === "/" ? "/" : `${physicalCwd}/`;
      if (physicalPath.startsWith(prefix)) {
        const suffix = physicalPath.slice(prefix.length);
        return cwd === "/" ? `/${suffix}` : `${cwd}/${suffix}`;
      }
    }
  }
  const raw = path.startsWith("/")
    ? path
    : cwd === "/"
    ? `/${path}`
    : `${cwd}/${path}`;
  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

function dirnameOfPath(path: string): string {
  const normalized = normalizeImportPath(path);
  if (normalized === "/") return "/";
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}

function splitResolutionPath(path: string): string[] {
  if (!path.startsWith("/")) {
    throw new Error(`ENOENT: not an absolute path: ${path}`);
  }
  return path.split("/").filter((part) => part !== "" && part !== ".");
}

type AsyncHostVfs = VfsLike & {
  isAsyncVfs?: boolean;
  readFileAsync?: (path: string) => Promise<Uint8Array>;
  writeFileAsync?: (
    path: string,
    data: Uint8Array,
    mode?: number,
  ) => Promise<void>;
  statAsync?: (path: string) => Promise<ReturnType<VfsLike["stat"]>>;
  lstatAsync?: (path: string) => Promise<ReturnType<VfsLike["lstat"]>>;
  readdirAsync?: (path: string) => Promise<ReturnType<VfsLike["readdir"]>>;
  mkdirAsync?: (path: string, mode?: number) => Promise<void>;
  unlinkAsync?: (path: string) => Promise<void>;
  rmdirAsync?: (path: string) => Promise<void>;
  renameAsync?: (oldPath: string, newPath: string) => Promise<void>;
  symlinkAsync?: (target: string, path: string) => Promise<void>;
  readlinkAsync?: (path: string) => Promise<string>;
  chmodAsync?: (path: string, mode: number) => Promise<void>;
  chownAsync?: (
    path: string,
    uid: number,
    gid: number,
    followSymlinks?: boolean,
  ) => Promise<void>;
};

function asyncHostVfs(vfs: VfsLike | undefined): AsyncHostVfs | null {
  const candidate = vfs as AsyncHostVfs | undefined;
  return candidate?.isAsyncVfs ? candidate : null;
}

function resolveRealpath(vfs: VfsLike, cwd: string, rawPath: string): string {
  if (rawPath === "") throw new Error("ENOENT: empty path");
  const startPath = rawPath.startsWith("/")
    ? rawPath
    : cwd === "/"
    ? `/${rawPath}`
    : `${cwd}/${rawPath}`;
  let queue = splitResolutionPath(startPath);
  const resolved: string[] = [];
  let symlinkDepth = 0;

  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }

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
      : `${dirnameOfPath(candidate)}/${target}`;
    queue = [...splitResolutionPath(targetPath), ...queue];
    resolved.length = 0;
  }

  const real = "/" + resolved.join("/");
  vfs.stat(real);
  return real === "" ? "/" : real;
}

async function resolveRealpathAsync(
  vfs: AsyncHostVfs,
  cwd: string,
  rawPath: string,
): Promise<string> {
  if (rawPath === "") throw new Error("ENOENT: empty path");
  const startPath = rawPath.startsWith("/")
    ? rawPath
    : cwd === "/"
    ? `/${rawPath}`
    : `${cwd}/${rawPath}`;
  let queue = splitResolutionPath(startPath);
  const resolved: string[] = [];
  let symlinkDepth = 0;

  while (queue.length > 0) {
    const part = queue.shift()!;
    if (part === "" || part === ".") continue;
    if (part === "..") {
      resolved.pop();
      continue;
    }

    const candidate = "/" + [...resolved, part].join("/");
    const stat = vfs.lstatAsync
      ? await vfs.lstatAsync(candidate)
      : vfs.lstat(candidate);
    if (stat.type !== "symlink") {
      resolved.push(part);
      continue;
    }
    if (++symlinkDepth > 40) throw new Error("ELOOP: too many symlink levels");

    const target = vfs.readlinkAsync
      ? await vfs.readlinkAsync(candidate)
      : vfs.readlink(candidate);
    const targetPath = target.startsWith("/")
      ? target
      : `${dirnameOfPath(candidate)}/${target}`;
    queue = [...splitResolutionPath(targetPath), ...queue];
    resolved.length = 0;
  }

  const real = "/" + resolved.join("/");
  if (vfs.statAsync) await vfs.statAsync(real);
  else vfs.stat(real);
  return real === "" ? "/" : real;
}

export function createKernelImports(
  opts: KernelImportsOptions,
): Record<string, WebAssembly.ImportValue> {
  const { memory } = opts;
  const callerPid = opts.callerPid ?? 0;
  const fallbackUid = opts.callerUid ?? USER_UID;
  const fallbackGid = opts.callerGid ?? USER_GID;
  const runtimeBackend = opts.runtimeBackend ?? unsupportedRuntimeEngineBackend;
  const schedulerBackend = runtimeBackend.scheduler;
  let fallbackUmask = 0o022;
  // Sandbox.create owns the socket-backend decision so all processes share
  // the same ListenerRegistry. Fall back to constructing one here only when
  // no Sandbox is in the loop (standalone createKernelImports callers, like
  // a few unit tests) — those callers also won't share state across imports
  // by construction.
  const bridgeSocketBackend = opts.networkBridge
    ? createNetworkBridgeSocketBackend(opts.networkBridge)
    : undefined;
  const socketBackend = opts.socketBackend ??
    (opts.serverSockets?.allowLoopback === true
      ? createLoopbackSocketBackend(bridgeSocketBackend)
      : bridgeSocketBackend);
  const socketLocalHost = opts.socketLocalHost ?? "10.0.2.15";
  const socketLocalPortForFd = (fd: number) =>
    49152 + (Math.max(0, fd - 3) % 16384);

  function getCallerCredentials(): ProcessCredentials {
    return opts.kernel?.getCredentials(callerPid) ?? {
      uid: fallbackUid,
      gid: fallbackGid,
      euid: fallbackUid,
      egid: fallbackGid,
      suid: fallbackUid,
      sgid: fallbackGid,
    };
  }

  function withVfsCallerCredentials<T>(fn: () => T): T {
    const credentials = getCallerCredentials();
    const vfsWithCredential = opts.vfs as
      | (VfsLike & {
        withCredential?: <U>(
          credential: { uid: number; gid: number },
          inner: () => U,
        ) => U;
      })
      | undefined;
    return vfsWithCredential?.withCredential
      ? vfsWithCredential.withCredential({
        uid: credentials.euid,
        gid: credentials.egid,
      }, fn)
      : fn();
  }

  async function getCallerPhysicalCwdAsync(vfs: AsyncHostVfs): Promise<string> {
    const cwd = getCallerCwd();
    try {
      return await withVfsCallerCredentials(() =>
        resolveRealpathAsync(vfs, cwd, ".")
      );
    } catch {
      return normalizeImportPath(cwd);
    }
  }

  function authorizeChown(
    path: string,
    uid: number,
    gid: number,
    followSymlinks = true,
  ): number {
    const credentials = getCallerCredentials();
    if (credentials.euid === ROOT_UID) return 0;
    if (gid !== -1 && gid !== credentials.egid) return ERR_PERMISSION;
    if (uid === -1) return 0;
    try {
      const stat = followSymlinks
        ? opts.vfs!.stat(path)
        : opts.vfs!.lstat(path);
      return stat.uid === credentials.euid && uid === stat.uid
        ? 0
        : ERR_PERMISSION;
    } catch {
      return ERR_PERMISSION;
    }
  }

  async function authorizeChownAsync(
    vfs: AsyncHostVfs,
    path: string,
    uid: number,
    gid: number,
    followSymlinks = true,
  ): Promise<number> {
    const credentials = getCallerCredentials();
    if (credentials.euid === ROOT_UID) return 0;
    if (gid !== -1 && gid !== credentials.egid) return ERR_PERMISSION;
    if (uid === -1) return 0;
    try {
      const stat = followSymlinks
        ? vfs.statAsync ? await vfs.statAsync(path) : vfs.stat(path)
        : vfs.lstatAsync
        ? await vfs.lstatAsync(path)
        : vfs.lstat(path);
      return stat.uid === credentials.euid && uid === stat.uid
        ? 0
        : ERR_PERMISSION;
    } catch {
      return ERR_PERMISSION;
    }
  }

  function writeCStringResult(
    value: string,
    outPtr: number,
    outCap: number,
  ): number {
    const bytes = new TextEncoder().encode(value);
    const required = bytes.byteLength + 1;
    if (outCap < required) return required;
    new Uint8Array(memory.buffer, outPtr, bytes.byteLength).set(bytes);
    new Uint8Array(memory.buffer)[outPtr + bytes.byteLength] = 0;
    return required;
  }

  function limitToBigUint64(limit: number): bigint {
    if (!Number.isFinite(limit)) return 0xffff_ffff_ffff_ffffn;
    return BigInt(Math.max(0, Math.trunc(limit)));
  }

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
          // Fire-and-forget: bridge-backed closes are async but
          // closeFdTarget is sync. The bridge worker tears down its
          // side independently; we only care that the kernel-side fd
          // table is reaped here.
          void target.closeListener(target.listener);
          target.listener = null;
        }
        if (target.socket !== null) {
          void target.close(target.socket);
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
    if (target.type === "vfs_file") target.fdTable.retain(target.fd);
    if (target.type === "vfs_file") target.refs++;
    if (target.type === "socket") target.refs++;
  }

  function isActivePreopenFd(fd: number): boolean {
    if (!opts.wasiHost?.isPreopenFd(fd)) return false;
    if (!opts.kernel) return true;
    const target = opts.kernel.getFdTarget(callerPid, fd);
    return !target || target.type === "vfs_dir";
  }

  const syntheticDns = new Map<string, string>();

  function syntheticAddressForHost(hostname: string): string {
    const existing = syntheticDns.get(hostname);
    if (existing) return existing;
    let hash = 0;
    for (let i = 0; i < hostname.length; i++) {
      hash = (hash * 33 + hostname.charCodeAt(i)) >>> 0;
    }
    const addr = `10.0.2.${2 + (hash % 253)}`;
    syntheticDns.set(hostname, addr);
    return addr;
  }

  function normalizeIpv4(host: string): string {
    if (host === "localhost") return "127.0.0.1";
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
    return syntheticAddressForHost(host);
  }

  function ipv4ToBytes(host: string): [number, number, number, number] {
    const normalized = normalizeIpv4(host);
    const parts = normalized.split(".").map((part) => Number(part));
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return [0, 0, 0, 0];
    }
    return parts as [number, number, number, number];
  }

  function writeSocketAddrResult(
    ptr: number,
    cap: number,
    host: string,
    port: number,
  ): number {
    const size = 8;
    if (cap < size) return size;
    const bytes = new Uint8Array(memory.buffer, ptr, size);
    const hostBytes = ipv4ToBytes(host);
    bytes.set(hostBytes, 0);
    const view = new DataView(memory.buffer, ptr, size);
    view.setUint16(4, port & 0xffff, false);
    view.setUint16(6, 0, true);
    return size;
  }

  function writeSocketAcceptResult(
    ptr: number,
    cap: number,
    accepted: {
      fd: number;
      peerHost: string;
      peerPort: number;
      localHost: string;
      localPort: number;
    },
  ): number {
    const size = 16;
    if (cap < size) return size;
    const bytes = new Uint8Array(memory.buffer, ptr, size);
    const view = new DataView(memory.buffer, ptr, size);
    view.setInt32(0, accepted.fd, true);
    bytes.set(ipv4ToBytes(accepted.peerHost), 4);
    view.setUint16(8, accepted.peerPort & 0xffff, false);
    view.setUint16(10, accepted.localPort & 0xffff, false);
    bytes.set(ipv4ToBytes(accepted.localHost), 12);
    return size;
  }

  function setFallbackUid(ruid: number, euid: number, suid: number): number {
    const current = new Set([fallbackUid]);
    for (const value of [ruid, euid, suid]) {
      if (value !== -1 && !current.has(value)) return ERR_PERMISSION;
    }
    return 0;
  }

  function setFallbackGid(rgid: number, egid: number, sgid: number): number {
    const current = new Set([fallbackGid]);
    for (const value of [rgid, egid, sgid]) {
      if (value !== -1 && !current.has(value)) return ERR_PERMISSION;
    }
    return 0;
  }

  function getCallerCwd(): string {
    return opts.kernel?.getCwd(callerPid) ?? opts.wasiHost?.getCwd() ?? "/";
  }

  function getCallerPhysicalCwd(): string {
    const cwd = getCallerCwd();
    if (!opts.vfs) return normalizeImportPath(cwd);
    try {
      return withVfsCallerCredentials(() =>
        resolveRealpath(opts.vfs!, cwd, ".")
      );
    } catch {
      return normalizeImportPath(cwd);
    }
  }

  function setCallerCwd(cwd: string): void {
    opts.kernel?.setCwd(callerPid, cwd);
    opts.wasiHost?.setCwd(cwd);
  }

  function priorityTargetPid(which: number, who: number): number {
    if (which !== PRIO_PROCESS) return ERR_INVALID;
    if (who === 0) return callerPid;
    if (!opts.kernel?.hasProcess(who)) return ERR_NOT_FOUND;
    return who;
  }

  function authorizeSetPriority(targetPid: number, nice: number): number {
    const caller = getCallerCredentials();
    const currentNice = opts.kernel?.getPriority(targetPid) ?? 0;
    if (targetPid !== callerPid && caller.euid !== ROOT_UID) {
      const target = opts.kernel?.getCredentials(targetPid);
      if (!target || target.uid !== caller.euid) return ERR_PERMISSION;
    }
    if (nice < currentNice && caller.euid !== ROOT_UID) return ERR_PERMISSION;
    return 0;
  }

  function schedulerTargetPid(pidRaw: number): number {
    const targetPid = Math.trunc(pidRaw) === 0 ? callerPid : Math.trunc(pidRaw);
    if (targetPid < 0) return ERR_INVALID;
    if (opts.kernel && !opts.kernel.hasProcess(targetPid)) return ERR_NOT_FOUND;
    if (!opts.kernel && targetPid !== callerPid) return ERR_NOT_FOUND;
    return targetPid;
  }

  function setSchedulerForTarget(
    targetPid: number,
    policyRaw: number,
    priorityRaw: number,
  ): number {
    const policy = normalizeSchedulerPolicy(policyRaw);
    const priority = normalizeSchedulerPriority(policy, priorityRaw);
    if (policy < 0 || priority < 0) return ERR_INVALID;

    const current = opts.kernel?.getScheduler(targetPid) ??
      { policy: 0, priority: 0 };
    const noOp = current.policy === policy && current.priority === priority;
    if (!noOp) {
      const caller = getCallerCredentials();
      if (targetPid !== callerPid && caller.euid !== ROOT_UID) {
        return ERR_PERMISSION;
      }
      if (
        (policy === 1 || policy === 2 || current.policy === 1 ||
          current.policy === 2) && caller.euid !== ROOT_UID
      ) {
        return ERR_PERMISSION;
      }
      if (!schedulerBackend?.setScheduler) return ERR_UNSUPPORTED;
      const result = schedulerBackend.setScheduler({
        callerPid,
        targetPid,
        policy,
        priority,
      });
      if (!result.ok) {
        if (result.error === "unsupported") return ERR_UNSUPPORTED;
        if (result.error === "permission") return ERR_PERMISSION;
        if (result.error === "invalid") return ERR_INVALID;
        if (result.error === "not_found") return ERR_NOT_FOUND;
        return ERR_IO;
      }
    }

    opts.kernel?.setScheduler(targetPid, policy, priority);
    return 0;
  }

  function validateSingleCpuAffinity(
    maskPtr: number,
    cpusetsizeRaw: number,
  ): number {
    const cpusetsize = Math.trunc(cpusetsizeRaw);
    if (cpusetsize < 4) return ERR_INVALID;
    const bytes = new Uint8Array(memory.buffer, maskPtr, cpusetsize);
    if (bytes[0] !== 1) return ERR_INVALID;
    for (let i = 1; i < cpusetsize; i++) {
      if (bytes[i] !== 0) return ERR_INVALID;
    }
    return 0;
  }

  function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    const out = new Uint8Array(left.byteLength + right.byteLength);
    out.set(left, 0);
    out.set(right, left.byteLength);
    return out;
  }

  function authorizeListen(
    policy: SocketListenPolicy | undefined,
    host: "127.0.0.1" | "localhost" | "0.0.0.0",
    port: number,
    backlog: number,
  ): { ok: true; mapping?: SocketPortMapping } | { ok: false; error: string } {
    if (!policy) {
      return {
        ok: false,
        error: `listen on ${host}:${port} is not allowed by sandbox policy`,
      };
    }
    if (host === "127.0.0.1" || host === "localhost") {
      if (policy.allowLoopback === true) return { ok: true };
      return {
        ok: false,
        error: `listen on ${host}:${port} is not allowed by sandbox policy`,
      };
    }
    const mapping = policy.portMappings?.find((m) =>
      m.sandboxHost === "0.0.0.0" && m.sandboxPort === port
    );
    if (!mapping) {
      return {
        ok: false,
        error: `listen on 0.0.0.0:${port} requires an explicit port mapping`,
      };
    }
    const allowed = policy.onListen?.({ host, port, backlog, mapping });
    if (allowed === false) {
      return {
        ok: false,
        error: `listen on 0.0.0.0:${port} was denied by sandbox policy`,
      };
    }
    if (allowed && typeof (allowed as Promise<boolean>).then === "function") {
      return {
        ok: false,
        error:
          "async listen authorization is not supported by synchronous socket imports",
      };
    }
    return { ok: true, mapping };
  }

  function authorizeUnixListen(
    policy: SocketListenPolicy | undefined,
    path: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!policy?.allowUnixDomain) {
      return {
        ok: false,
        error: `AF_UNIX listen on ${path} is not allowed by sandbox policy`,
      };
    }
    const allowlist = policy.unixPathAllowlist;
    if (allowlist && allowlist.length > 0) {
      const allowed = allowlist.some((re) => re.test(path));
      if (!allowed) {
        return {
          ok: false,
          error: `AF_UNIX path ${path} is not in the sandbox allowlist`,
        };
      }
    }
    return { ok: true };
  }

  function authorizeUnixAbstract(
    policy: SocketListenPolicy | undefined,
    name: string,
  ): { ok: true } | { ok: false; error: string } {
    if (!policy?.allowUnixDomain) {
      return {
        ok: false,
        error:
          `AF_UNIX abstract listen on @${name} is not allowed by sandbox policy`,
      };
    }
    const allowlist = policy.unixAbstractAllowlist;
    if (allowlist && allowlist.length > 0) {
      const allowed = allowlist.some((re) => re.test(name));
      if (!allowed) {
        return {
          ok: false,
          error:
            `AF_UNIX abstract name @${name} is not in the sandbox allowlist`,
        };
      }
    }
    return { ok: true };
  }

  // ── Phase 1 dlopen state (per-sandbox) ──
  // Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
  // The handle table owns loaded side-module instances; lastDlError
  // is drained by yurt_dlerror per POSIX dlerror semantics. The string
  // helpers reused here (readString) are imported from common.ts.
  const dlHandleTable = new DynlinkHandleTable();
  let lastDlError = "";

  // The yurt-namespace imports are forwarded to side modules so they
  // can call the same host imports the main module uses. The closure
  // below captures the `imports` record after it is fully built —
  // dlopen runs from inside a host import call, so by then the record
  // exists and is populated.
  function getYurtImportSnapshot(): WebAssembly.ModuleImports {
    return imports as WebAssembly.ModuleImports;
  }

  function makeDlVfsLookup(vfs: VfsLike) {
    return {
      readFile(
        path: string,
      ): { bytes: Uint8Array; canonicalPath: string } | undefined {
        try {
          const bytes = vfs.readFile(path);
          // Phase 1 base: canonical path is the requested absolute
          // path. Symlink resolution / realpath promotion is a
          // follow-on; the dlopen-canary uses absolute paths so the
          // canary case set is fully covered without it.
          return { bytes, canonicalPath: path };
        } catch {
          return undefined;
        }
      },
    };
  }

  const imports: Record<string, WebAssembly.ImportValue> = {
    // ── Process management (new) ──

    // host_pipe(out_ptr, out_cap) -> i32
    // Creates a pipe and writes yurt_pipe_result_v1 to the output buffer.
    host_pipe(outPtr: number, outCap: number): number {
      if (!opts.kernel) {
        return ERR_IO;
      }
      const { readFd, writeFd } = opts.kernel.createPipe(callerPid);
      if (opts.wasiHost) {
        const ioFds = opts.wasiHost.getIoFds();
        const readTarget = opts.kernel.getFdTarget(callerPid, readFd);
        const writeTarget = opts.kernel.getFdTarget(callerPid, writeFd);
        if (readTarget) ioFds.set(readFd, readTarget);
        if (writeTarget) ioFds.set(writeFd, writeTarget);
      }
      return writePipeResult(memory, outPtr, outCap, readFd, writeFd);
    },

    // host_poll(fds_ptr, nfds, timeout_ms) -> i32 | Promise<i32>
    // Updates pollfd.revents in-place and returns the number of ready fds.
    host_poll(
      fdsPtr: number,
      nfds: number,
      timeoutMs: number,
    ): number | Promise<number> {
      if (!opts.kernel) return ERR_IO;
      if (nfds < 0 || !Number.isInteger(nfds)) return ERR_INVALID;

      const evaluate = (): number => {
        const end = fdsPtr + nfds * POLLFD_SIZE;
        if (fdsPtr < 0 || end > memory.buffer.byteLength) return ERR_IO;
        const view = new DataView(memory.buffer);
        let ready = 0;
        for (let i = 0; i < nfds; i++) {
          const base = fdsPtr + i * POLLFD_SIZE;
          const fd = view.getInt32(base, true);
          const events = view.getInt16(base + 4, true);
          let revents = 0;
          if (fd >= 0) {
            const target = opts.kernel!.getFdTarget(callerPid, fd);
            revents = target ? pollReventsForTarget(target, events) : POLLNVAL;
          }
          view.setInt16(base + 6, revents, true);
          if (revents !== 0) ready++;
        }
        return ready;
      };

      const waitForSocketReadiness = (
        target: FdTarget & { type: "socket" },
      ): Promise<void> => {
        if (target.socket === null) return Promise.resolve();
        return target.recvAsync(target.socket, 1).then((result) => {
          if (!result.ok) return;
          const data = result.data ?? new Uint8Array(0);
          if (data.byteLength > 0) {
            target.peekBuffer = target.peekBuffer
              ? concatBytes(target.peekBuffer, data)
              : data;
          } else {
            target.readShutdown = true;
          }
        });
      };

      const collectReadinessWaits = (): Array<Promise<void>> | null => {
        const end = fdsPtr + nfds * POLLFD_SIZE;
        if (fdsPtr < 0 || end > memory.buffer.byteLength) return null;
        const view = new DataView(memory.buffer);
        const waits: Array<Promise<void>> = [];
        for (let i = 0; i < nfds; i++) {
          const base = fdsPtr + i * POLLFD_SIZE;
          const fd = view.getInt32(base, true);
          if (fd < 0) continue;
          const target = opts.kernel!.getFdTarget(callerPid, fd);
          if (!target) continue;
          const events = view.getInt16(base + 4, true);
          const wantsRead = (events & POLLIN) !== 0;
          const wantsWrite = (events & POLLOUT) !== 0;

          if (
            target.type === "pipe_read" && wantsRead &&
            !target.pipe.hasData
          ) {
            waits.push(target.pipe.waitReadable());
          } else if (
            target.type === "pipe_write" && wantsWrite &&
            !target.pipe.closed && !target.pipe.hasCapacity
          ) {
            waits.push(target.pipe.waitWritable());
          } else if (
            target.type === "tty_slave" && wantsRead &&
            target.state.toSlave.length === 0 && !target.state.masterClosed
          ) {
            waits.push(
              new Promise<void>((resolve) => {
                target.state.toSlaveWaiters.push(resolve);
              }),
            );
          } else if (
            target.type === "tty_master" && wantsRead &&
            target.state.toMaster.length === 0 && !target.state.masterClosed
          ) {
            waits.push(
              new Promise<void>((resolve) => {
                target.state.toMasterWaiters.push(resolve);
              }),
            );
          } else if (
            target.type === "socket" && wantsRead &&
            target.socket !== null &&
            (target.peekBuffer?.byteLength ?? 0) === 0 &&
            !target.readShutdown
          ) {
            waits.push(waitForSocketReadiness(target));
          }
        }
        return waits;
      };

      const immediate = evaluate();
      if (immediate !== 0 || timeoutMs === 0) return immediate;

      const tid = opts.threadsBackend?.self() ?? 0;
      if (
        tid !== 0 && timeoutMs < 0 && opts.threadsBackend?.isDetached?.(tid)
      ) {
        if (opts.threadsBackend.detachedThreadsCancelled?.()) {
          opts.threadsBackend.exit(0);
        }
        return opts.threadsBackend.parkDetachedThread?.() ??
          new Promise<number>(() => {});
      }

      const readinessWaits = collectReadinessWaits();
      if (readinessWaits === null) return ERR_IO;

      return new Promise<number>((resolve, reject) => {
        const started = Date.now();
        let done = false;
        let interval: number | undefined;
        let timeout: number | undefined;
        let cancellationInterval: number | undefined;

        const cleanup = () => {
          if (interval !== undefined) clearInterval(interval);
          if (timeout !== undefined) clearTimeout(timeout);
          if (cancellationInterval !== undefined) {
            clearInterval(cancellationInterval);
          }
        };
        const finish = (value: number) => {
          if (done) return;
          done = true;
          cleanup();
          resolve(value);
        };
        const fail = (err: unknown) => {
          if (done) return;
          done = true;
          cleanup();
          reject(err);
        };
        const checkDetachedCancellation = (): boolean => {
          if (
            tid !== 0 && opts.threadsBackend?.isDetached?.(tid) &&
            opts.threadsBackend.detachedThreadsCancelled?.()
          ) {
            try {
              opts.threadsBackend.exit(0);
            } catch (err) {
              fail(err);
            }
            return true;
          }
          return false;
        };
        const startLegacyTimerPoll = () => {
          interval = setInterval(() => {
            if (checkDetachedCancellation()) return;
            const ready = evaluate();
            const expired = timeoutMs >= 0 &&
              Date.now() - started >= timeoutMs;
            if (ready !== 0 || expired) {
              finish(ready > 0 ? ready : 0);
            }
          }, 10);
        };

        if (readinessWaits.length > 0) {
          if (timeoutMs >= 0) {
            timeout = setTimeout(() => {
              if (checkDetachedCancellation()) return;
              const ready = evaluate();
              finish(ready > 0 ? ready : 0);
            }, timeoutMs);
          }
          if (tid !== 0 && opts.threadsBackend?.isDetached?.(tid)) {
            cancellationInterval = setInterval(() => {
              checkDetachedCancellation();
            }, 10);
          }
          const armReadinessWait = (waits: Array<Promise<void>>) => {
            Promise.race(waits).then(() => {
              if (done) return;
              if (checkDetachedCancellation()) return;
              const ready = evaluate();
              if (ready !== 0) {
                finish(ready);
                return;
              }
              const nextWaits = collectReadinessWaits();
              if (nextWaits === null) {
                finish(ERR_IO);
              } else if (nextWaits.length > 0) {
                armReadinessWait(nextWaits);
              } else {
                startLegacyTimerPoll();
              }
            }, fail);
          };
          armReadinessWait(readinessWaits);
          return;
        }

        // Targets without host-side readiness notification still use the
        // legacy cooperative timer path.
        startLegacyTimerPoll();
      });
    },

    // host_spawn(req_ptr, req_len, out_ptr?, out_cap?) -> i32
    // Native-only: the request bytes must decode as a yurt_spawn_request_v1
    // record. The 4-argument form writes yurt_spawn_result_v1; the 2-argument
    // form (host_spawn_async) returns the pid directly. No text serialization
    // fallback — a decode failure is a hard error.
    host_spawn(
      reqPtr: number,
      reqLen: number,
      outPtr?: number,
      outCap?: number,
    ): number {
      const spawnFromRequest = (req: SpawnRequest): number => {
        const requestedNice = normalizeNice(req.nice ?? 0);
        if (requestedNice > 0 && !schedulerBackend) return ERR_UNSUPPORTED;
        if (req.nice !== undefined) req.nice = requestedNice;
        if (opts.spawnProcess && opts.kernel) {
          if (!opts.kernel.canReserveProcessSlot()) return -1;
          const fdTable = opts.kernel.buildFdTableForSpawn(callerPid, req);
          let previousStdin: FdTarget | undefined;
          if (req.stdin_data) {
            previousStdin = fdTable.get(0);
            fdTable.set(
              0,
              createStaticTarget(new TextEncoder().encode(req.stdin_data)),
            );
          }
          try {
            const childPid = opts.spawnProcess(req, fdTable, callerPid);
            if (previousStdin) {
              opts.kernel.releaseFdTable(new Map([[0, previousStdin]]));
            }
            return childPid;
          } catch (e) {
            opts.kernel.releaseFdTable(fdTable);
            if (previousStdin) {
              opts.kernel.releaseFdTable(new Map([[0, previousStdin]]));
            }
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            if (
              msg.includes("ENOENT") ||
              msg.includes("no such file or directory")
            ) return ERR_NOT_FOUND;
            if (msg.includes("ENOTDIR") || msg.includes("not a directory")) {
              return ERR_NOT_DIR;
            }
            return -1;
          }
        }
        return -1;
      };

      const reqBytes = readBytes(memory, reqPtr, reqLen);
      let req: SpawnRequest;
      try {
        const decoded = decodeNativeSpawnRequest(reqBytes);
        if (!decoded) return ERR_INVALID;
        req = decoded;
      } catch {
        return ERR_INVALID;
      }
      const pid = spawnFromRequest(req);
      if (typeof outPtr === "number" && typeof outCap === "number") {
        return pid < 0 ? pid : writeSpawnResult(memory, outPtr, outCap, pid);
      }
      return pid;
    },

    // host_getpid() -> i32
    // Returns the pid of the calling process within the yurt kernel.
    host_getpid(): number {
      return opts.kernel?.getVisiblePid(callerPid) ?? callerPid;
    },

    // host_getppid() -> i32
    // Returns the parent pid of the calling process, or 0 if no
    // in-sandbox parent (the topmost process — typically the shell —
    // sees getppid() == 0, mirroring Linux init).
    host_getppid(): number {
      return opts.kernel ? opts.kernel.getVisiblePpid(callerPid) : 0;
    },

    // host_mark_exec_child(child_pid) -> i32
    // Marks a freshly spawned child as the process image that replaces this
    // caller for exec(3) emulation. The kernel verifies parentage before
    // exposing the caller's PID through the replacement image.
    host_mark_exec_child(childPid: number): number {
      if (!opts.kernel) return -1;
      return opts.kernel.markExecReplacement(callerPid, childPid) ? 0 : -1;
    },

    host_getuid(): number {
      return getCallerCredentials().uid;
    },

    host_geteuid(): number {
      return getCallerCredentials().euid;
    },

    host_getgid(): number {
      return getCallerCredentials().gid;
    },

    host_getegid(): number {
      return getCallerCredentials().egid;
    },

    host_setresuid(ruid: number, euid: number, suid: number): number {
      if (!opts.kernel) return setFallbackUid(ruid, euid, suid);
      return opts.kernel.setresuid(callerPid, ruid, euid, suid)
        ? 0
        : ERR_PERMISSION;
    },

    host_setresgid(rgid: number, egid: number, sgid: number): number {
      if (!opts.kernel) return setFallbackGid(rgid, egid, sgid);
      return opts.kernel.setresgid(callerPid, rgid, egid, sgid)
        ? 0
        : ERR_PERMISSION;
    },

    host_umask(mask: number): number {
      if (opts.kernel) return opts.kernel.setUmask(callerPid, mask);
      const prev = fallbackUmask;
      fallbackUmask = Math.trunc(mask) & 0o777;
      return prev;
    },

    host_getpriority(which: number, who: number): number {
      const targetPid = priorityTargetPid(which, who);
      if (targetPid === ERR_NOT_FOUND) return ERR_PRIORITY_NOT_FOUND;
      if (targetPid < 0) return targetPid;
      return opts.kernel?.getPriority(targetPid) ?? 0;
    },

    host_setpriority(which: number, who: number, niceRaw: number): number {
      const targetPid = priorityTargetPid(which, who);
      if (targetPid < 0) return targetPid;
      const nice = normalizeNice(niceRaw);
      const auth = authorizeSetPriority(targetPid, nice);
      if (auth !== 0) return auth;
      if (!schedulerBackend) {
        return nice === (opts.kernel?.getPriority(targetPid) ?? 0)
          ? 0
          : ERR_UNSUPPORTED;
      }
      const result = schedulerBackend.setPriority({
        callerPid,
        targetPid,
        nice,
      });
      if (result.ok) {
        opts.kernel?.setPriority(targetPid, nice);
        return 0;
      }
      if (result.error === "unsupported") return ERR_UNSUPPORTED;
      if (result.error === "permission") return ERR_PERMISSION;
      if (result.error === "invalid") return ERR_INVALID;
      if (result.error === "not_found") return ERR_NOT_FOUND;
      return ERR_IO;
    },

    host_sched_getscheduler(pidRaw: number): number {
      const targetPid = schedulerTargetPid(pidRaw);
      if (targetPid < 0) return targetPid;
      return opts.kernel?.getScheduler(targetPid).policy ?? 0;
    },

    host_sched_getparam(pidRaw: number): number {
      const targetPid = schedulerTargetPid(pidRaw);
      if (targetPid < 0) return targetPid;
      return opts.kernel?.getScheduler(targetPid).priority ?? 0;
    },

    host_sched_setscheduler(
      pidRaw: number,
      policyRaw: number,
      priorityRaw: number,
    ): number {
      const targetPid = schedulerTargetPid(pidRaw);
      if (targetPid < 0) return targetPid;
      return setSchedulerForTarget(targetPid, policyRaw, priorityRaw);
    },

    host_sched_setparam(pidRaw: number, priorityRaw: number): number {
      const targetPid = schedulerTargetPid(pidRaw);
      if (targetPid < 0) return targetPid;
      const current = opts.kernel?.getScheduler(targetPid) ??
        { policy: 0, priority: 0 };
      return setSchedulerForTarget(targetPid, current.policy, priorityRaw);
    },

    host_sched_getaffinity(
      pidRaw: number,
      maskPtr: number,
      cpusetsizeRaw: number,
    ): number {
      const targetPid = schedulerTargetPid(pidRaw);
      if (targetPid < 0) return targetPid;
      const cpusetsize = Math.trunc(cpusetsizeRaw);
      if (cpusetsize < 4) return ERR_INVALID;
      const bytes = new Uint8Array(memory.buffer, maskPtr, cpusetsize);
      bytes.fill(0);
      bytes[0] = 1;
      return 0;
    },

    host_sched_setaffinity(
      pidRaw: number,
      maskPtr: number,
      cpusetsizeRaw: number,
    ): number {
      const targetPid = schedulerTargetPid(pidRaw);
      if (targetPid < 0) return targetPid;
      return validateSingleCpuAffinity(maskPtr, cpusetsizeRaw);
    },

    host_getrlimit(resourceRaw: number, outPtr: number): number {
      const limit =
        opts.kernel?.getResourceLimit(callerPid, Math.trunc(resourceRaw)) ??
          defaultImportResourceLimit(Math.trunc(resourceRaw));
      if (!limit) return ERR_INVALID;
      const view = new DataView(memory.buffer);
      view.setBigUint64(outPtr, limitToBigUint64(limit.soft), true);
      view.setBigUint64(outPtr + 8, limitToBigUint64(limit.hard), true);
      return 0;
    },

    host_setrlimit(
      resourceRaw: number,
      softRaw: number | bigint,
      hardRaw: number | bigint,
    ): number {
      const resource = Math.trunc(resourceRaw);
      if (!opts.kernel) {
        return defaultImportResourceLimit(resource) ? 0 : ERR_INVALID;
      }
      const result = opts.kernel.setResourceLimit(
        callerPid,
        resource,
        softRaw,
        hardRaw,
      );
      if (result === "ok") return 0;
      if (result === "permission") return ERR_PERMISSION;
      return ERR_INVALID;
    },

    host_getcwd(outPtr: number, outCap: number): number | Promise<number> {
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          const cwd = await getCallerPhysicalCwdAsync(asyncVfs);
          return writeCStringResult(cwd, outPtr, outCap);
        })();
      }
      const cwd = getCallerPhysicalCwd();
      return writeCStringResult(cwd, outPtr, outCap);
    },

    host_realpath(
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const real = await withVfsCallerCredentials(() =>
              resolveRealpathAsync(asyncVfs, getCallerCwd(), rawPath)
            );
            return writeCStringResult(real, outPtr, outCap);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (msg.includes("ENOENT") || msg.includes("no such file")) {
              return ERR_NOT_FOUND;
            }
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            if (msg.includes("ENOTDIR") || msg.includes("not a directory")) {
              return ERR_NOT_DIR;
            }
            if (msg.includes("ELOOP")) return ERR_INVALID;
            return ERR_IO;
          }
        })();
      }
      try {
        const real = withVfsCallerCredentials(() =>
          resolveRealpath(opts.vfs!, getCallerCwd(), rawPath)
        );
        return writeCStringResult(real, outPtr, outCap);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          return ERR_NOT_FOUND;
        }
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          return ERR_PERMISSION;
        }
        if (msg.includes("ENOTDIR") || msg.includes("not a directory")) {
          return ERR_NOT_DIR;
        }
        if (msg.includes("ELOOP")) return ERR_INVALID;
        return ERR_IO;
      }
    },

    host_chdir(pathPtr: number, pathLen: number): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const path = resolveCwdPath(getCallerCwd(), rawPath);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const stat = asyncVfs.statAsync
              ? await asyncVfs.statAsync(path)
              : asyncVfs.stat(path);
            if (stat.type !== "dir") return ERR_NOT_DIR;
            setCallerCwd(resolveLogicalCwdPath(getCallerCwd(), rawPath));
            return 0;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (msg.includes("ENOENT") || msg.includes("no such file")) {
              return ERR_NOT_FOUND;
            }
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            return ERR_IO;
          }
        })();
      }
      try {
        const stat = opts.vfs.stat(path);
        if (stat.type !== "dir") return ERR_NOT_DIR;
        setCallerCwd(resolveLogicalCwdPath(getCallerCwd(), rawPath));
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          return ERR_NOT_FOUND;
        }
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          return ERR_PERMISSION;
        }
        return ERR_IO;
      }
    },

    host_fchdir(fd: number): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      let path = opts.wasiHost?.getDirectoryFdPath(fd) ?? null;
      if (path === null && opts.kernel) {
        const target = opts.kernel.getFdTarget(callerPid, fd);
        if (target?.type === "vfs_dir") {
          path = target.path;
        } else if (target?.type === "vfs_file") {
          path = target.fdTable.getPath(target.fd) ?? null;
        }
      }
      if (path === null) return ERR_NOT_FOUND;
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const stat = asyncVfs.statAsync
              ? await asyncVfs.statAsync(path!)
              : asyncVfs.stat(path!);
            if (stat.type !== "dir") return ERR_NOT_DIR;
            setCallerCwd(path!);
            return 0;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (msg.includes("ENOENT") || msg.includes("no such file")) {
              return ERR_NOT_FOUND;
            }
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            return ERR_IO;
          }
        })();
      }
      try {
        const stat = opts.vfs.stat(path);
        if (stat.type !== "dir") return ERR_NOT_DIR;
        setCallerCwd(path);
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          return ERR_NOT_FOUND;
        }
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          return ERR_PERMISSION;
        }
        return ERR_IO;
      }
    },

    // host_kill(pid, sig) -> i32
    // Best-effort signal delivery: cancels the target's WASI host so it
    // exits with WasiExitError(124).  This is enough for `kill -TERM` /
    // `kill -9` style termination from one in-sandbox process to another.
    // Returns 0 on success, -1 with errno=ESRCH (3) if no such process,
    // mirroring kill(2).
    host_kill(pid: number, sig: number): number {
      opts.wasiHost?.drainPendingSignals();
      if (!opts.kernel) return -1;
      const exists = opts.kernel
        .listProcesses()
        .some((p) => p.pid === pid && p.state !== "exited");
      if (!exists) return -1;
      // sig 0 is the existence probe — POSIX requires no signal sent.
      if (sig === 0) return 0;
      if (!opts.kernel.killProcess(pid, sig)) return -1;
      if (pid === callerPid || pid === opts.kernel.getVisiblePid(callerPid)) {
        opts.wasiHost?.drainPendingSignals();
      }
      return 0;
    },

    // host_getpgid(pid) -> i32
    // Returns the process group id for pid (0 = self). Returns -1 if not found.
    host_getpgid(pid: number): number {
      if (!opts.kernel) return -1;
      return opts.kernel.getpgid(pid === 0 ? callerPid : pid);
    },

    // host_setpgid(pid, pgid) -> i32
    // Sets the process group id.  pid=0 means self, pgid=0 means use pid.
    // Returns 0 on success, -1 on failure.
    host_setpgid(pid: number, pgid: number): number {
      if (!opts.kernel) return -1;
      const targetPid = pid === 0 ? callerPid : pid;
      const targetPgid = pgid === 0 ? targetPid : pgid;
      return opts.kernel.setpgid(targetPid, targetPgid);
    },

    // host_getsid(pid) -> i32
    // Returns the session id for pid (0 = self). Returns -1 if not found.
    host_getsid(pid: number): number {
      if (!opts.kernel) return -1;
      return opts.kernel.getsid(pid === 0 ? callerPid : pid);
    },

    // host_setsid() -> i32
    // Creates a new session for the calling process.
    // Returns the new session id (= callerPid), or -1 on failure.
    host_setsid(): number {
      if (!opts.kernel) return -1;
      return opts.kernel.setsid(callerPid);
    },

    // host_killpg(pgid, sig) -> i32
    // Sends sig to all processes in process group pgid.
    // Returns 0 if at least one process was signalled, -1 if none found.
    host_killpg(pgid: number, sig: number): number {
      opts.wasiHost?.drainPendingSignals();
      if (!opts.kernel) return -1;
      if (sig === 0) {
        return opts.kernel
            .listProcesses()
            .some((p) => p.pgid === pgid && p.state !== "exited")
          ? 0
          : -1;
      }
      return opts.kernel.killpg(pgid, sig) > 0 ? 0 : -1;
    },

    // host_isatty(fd) -> i32
    // Returns 0 if fd refers to a TTY (tty_slave or tty_master), -1 (ENOTTY) otherwise.
    host_isatty(fd: number): number {
      const ioTarget = opts.wasiHost?.getIoFds().get(fd);
      if (ioTarget?.type === "tty_slave" || ioTarget?.type === "tty_master") {
        return 0;
      }
      const kernelTarget = opts.kernel?.getFdTarget(callerPid, fd);
      if (
        kernelTarget?.type === "tty_slave" ||
        kernelTarget?.type === "tty_master"
      ) return 0;
      return -1;
    },

    // host_tcgetpgrp(fd) -> i32
    // Returns the foreground process group of the terminal on fd, or -1.
    host_tcgetpgrp(fd: number): number {
      const target = opts.wasiHost?.getIoFds().get(fd) ??
        opts.kernel?.getFdTarget(callerPid, fd);
      if (target?.type === "tty_slave" || target?.type === "tty_master") {
        return target.state.fgPgid;
      }
      return -1;
    },

    // host_tcsetpgrp(fd, pgid) -> i32
    // Sets the foreground process group of the terminal on fd.
    // Returns 0 on success, -1 if fd is not a terminal.
    host_tcsetpgrp(fd: number, pgid: number): number {
      if (!opts.kernel) return -1;
      const target = opts.wasiHost?.getIoFds().get(fd) ??
        opts.kernel?.getFdTarget(callerPid, fd);
      if (target?.type === "tty_slave" || target?.type === "tty_master") {
        return opts.kernel.tcsetpgrp(target.ttyId, pgid, callerPid) ? 0 : -1;
      }
      return -1;
    },

    // host_tiocsctty(fd) -> i32
    // Register fd as the calling process's controlling terminal (TIOCSCTTY).
    // Returns 0 on success, -1 if fd is not a TTY.
    host_tiocsctty(fd: number): number {
      if (!opts.kernel) return -1;
      const target = opts.wasiHost?.getIoFds().get(fd) ??
        opts.kernel.getFdTarget(callerPid, fd);
      if (
        !target || (target.type !== "tty_slave" && target.type !== "tty_master")
      ) return -1;
      return opts.kernel.setControllingTty(callerPid, target.ttyId);
    },

    // host_tcgetattr(fd, out_ptr, out_cap) -> i32
    // Writes a minimal sane termios struct to the output buffer.
    // Returns bytes written, or -1 if fd is not a terminal.
    host_tcgetattr(fd: number, outPtr: number, outCap: number): number {
      const target = opts.wasiHost?.getIoFds().get(fd) ??
        opts.kernel?.getFdTarget(callerPid, fd);
      if (
        !target || (target.type !== "tty_slave" && target.type !== "tty_master")
      ) return -1;
      // musl wasm32 termios layout (60 bytes):
      //   [0]  c_iflag (4) — ICRNL|IXON
      //   [4]  c_oflag (4) — OPOST|ONLCR
      //   [8]  c_cflag (4) — CS8|CREAD|CLOCAL|B38400
      //   [12] c_lflag (4) — ISIG|ICANON|ECHO|ECHOE|ECHOK|IEXTEN
      //   [16] c_line  (1)
      //   [17] c_cc[19]    — VINTR=3, VQUIT=28, VERASE=127, VKILL=21, VEOF=4, VMIN=1, VSUSP=26
      //   [40] c_ispeed (4), [44] c_ospeed (4)
      const buf = new Uint8Array(60);
      const view = new DataView(buf.buffer);
      view.setUint32(0, 0x0600, true); // c_iflag: ICRNL(0x400)|IXON(0x200)
      view.setUint32(4, 0x0005, true); // c_oflag: OPOST(0x01)|ONLCR(0x04)
      view.setUint32(8, 0x08BF, true); // c_cflag: CS8|CREAD|CLOCAL|B38400
      view.setUint32(12, 0x8A3B, true); // c_lflag: ISIG|ICANON|ECHO|ECHOE|ECHOK|IEXTEN
      buf[17] = 3;
      buf[18] = 28;
      buf[19] = 127;
      buf[20] = 21; // VINTR VQUIT VERASE VKILL
      buf[21] = 4;
      buf[22] = 0;
      buf[23] = 1; // VEOF VTIME VMIN
      buf[25] = 17;
      buf[26] = 19;
      buf[27] = 26; // VSTART VSTOP VSUSP
      view.setUint32(40, 15, true);
      view.setUint32(44, 15, true); // B38400
      return writeBytes(memory, outPtr, outCap, buf);
    },

    // host_tcsetattr(fd, actions, termios_ptr) -> i32
    // Accepts terminal attribute changes silently (we don't implement a line discipline).
    // Returns 0 on success, -1 if fd is not a terminal.
    host_tcsetattr(fd: number, _actions: number, _termiosPtr: number): number {
      const target = opts.wasiHost?.getIoFds().get(fd) ??
        opts.kernel?.getFdTarget(callerPid, fd);
      if (
        !target || (target.type !== "tty_slave" && target.type !== "tty_master")
      ) return -1;
      return 0;
    },

    // host_winsize(fd, out_ptr, out_cap) -> i32
    // Writes a struct winsize { rows, cols, xpixel, ypixel } to the output buffer.
    // Returns bytes written, or -1 if fd is not a terminal.
    host_winsize(fd: number, outPtr: number, outCap: number): number {
      const target = opts.wasiHost?.getIoFds().get(fd) ??
        opts.kernel?.getFdTarget(callerPid, fd);
      if (
        !target || (target.type !== "tty_slave" && target.type !== "tty_master")
      ) return -1;
      const buf = new Uint8Array(8);
      const view = new DataView(buf.buffer);
      view.setUint16(0, target.state.rows, true);
      view.setUint16(2, target.state.cols, true);
      return writeBytes(memory, outPtr, outCap, buf);
    },

    // host_wait(pid, flags, out_ptr, out_cap) -> i32
    // Async — must be wrapped with WebAssembly.Suspending for JSPI.
    // Waits for a child process to exit and writes yurt_wait_result_v1.
    host_wait(
      pid: number,
      flags: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.kernel) return ERR_CHILD;
      const kernel = opts.kernel;
      opts.wasiHost?.drainPendingSignals();
      const nohang = (flags & YURT_WAIT_NOHANG) !== 0;

      if (nohang) {
        if (pid <= 0) {
          const result = kernel.waitAnyChildStatusNohang(callerPid);
          if (result.state === "running") return ERR_AGAIN;
          if (result.state === "none") return ERR_CHILD;
          return writeWaitResult(
            memory,
            outPtr,
            outCap,
            result.pid,
            result.exitCode,
            result.signal,
          );
        }
        const result = kernel.waitpidStatusNohang(pid, callerPid);
        if (result.state !== "exited") {
          return result.code === -1 ? ERR_AGAIN : ERR_CHILD;
        }
        return writeWaitResult(
          memory,
          outPtr,
          outCap,
          pid,
          result.exitCode,
          result.signal,
        );
      }

      return (async () => {
        await yieldToScheduler();
        opts.wasiHost?.drainPendingSignals();
        const signalWait = opts.wasiHost?.waitForSignalDelivery();
        const interrupt = signalWait?.promise ?? new Promise<void>(() => {});
        if (pid <= 0) {
          const waited = await kernel.waitAnyChildStatusInterruptible(
            callerPid,
            interrupt,
          );
          signalWait?.cancel();
          if (waited.interrupted) {
            opts.wasiHost?.drainPendingSignals();
            const result = kernel.waitAnyChildStatusNohang(callerPid);
            if (result.state === "exited") {
              return writeWaitResult(
                memory,
                outPtr,
                outCap,
                result.pid,
                result.exitCode,
                result.signal,
              );
            }
            return ERR_INTERRUPTED;
          }
          const result = waited.result;
          if (!result) return ERR_CHILD;
          return writeWaitResult(
            memory,
            outPtr,
            outCap,
            result.pid,
            result.exitCode,
            result.signal,
          );
        }
        const waited = await kernel.waitpidStatusInterruptible(
          pid,
          callerPid,
          interrupt,
        );
        signalWait?.cancel();
        if (waited.interrupted) {
          opts.wasiHost?.drainPendingSignals();
          const result = kernel.waitpidStatusNohang(pid, callerPid);
          if (result.state === "exited") {
            return writeWaitResult(
              memory,
              outPtr,
              outCap,
              pid,
              result.exitCode,
              result.signal,
            );
          }
          return ERR_INTERRUPTED;
        }
        if (waited.exitCode < 0) return ERR_CHILD;
        return writeWaitResult(
          memory,
          outPtr,
          outCap,
          pid,
          waited.exitCode,
          waited.signal,
        );
      })();
    },

    // host_close_fd(fd) -> i32
    // Closes a file descriptor in the caller's fd table.
    host_close_fd(fd: number): number {
      if (!opts.kernel) return -1;
      opts.kernel.closeFd(callerPid, fd);
      opts.wasiHost?.getIoFds().delete(fd);
      return 0;
    },

    // host_file_lock(fd, operation) -> i32
    // flock(2)-style advisory locking for VFS file descriptors.
    host_file_lock(fd: number, operation: number): number {
      if (!opts.kernel) return -38; // ENOSYS
      const LOCK_SH = 1;
      const LOCK_EX = 2;
      const LOCK_UN = 8;
      if ((operation & LOCK_UN) !== 0) {
        const errno = opts.kernel.unlockFile(callerPid, fd);
        return errno === 0 ? 0 : -errno;
      }
      const exclusive = (operation & LOCK_EX) !== 0;
      if (!exclusive && (operation & LOCK_SH) === 0) return -22; // EINVAL
      const errno = opts.kernel.lockFile(callerPid, fd, exclusive);
      return errno === 0 ? 0 : -errno;
    },

    // host_read_fd(fd, out_ptr, out_cap) -> i32
    // Reads all available data from a pipe fd and writes it to the output buffer.
    host_read_fd(fd: number, outPtr: number, outCap: number): number {
      if (!opts.kernel) return -38;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (target?.type === "pipe_read") {
        const data = target.pipe.drainSync();
        if (data.byteLength > outCap) return data.byteLength;
        new Uint8Array(memory.buffer, outPtr, outCap).set(data);
        return data.byteLength;
      } else if (target?.type === "static") {
        const data = target.data.subarray(target.offset);
        if (data.byteLength > outCap) return data.byteLength;
        new Uint8Array(memory.buffer, outPtr, outCap).set(data);
        target.offset = target.data.byteLength;
        return data.byteLength;
      } else if (target?.type === "null") {
        return 0;
      } else {
        return -9;
      }
    },

    // host_write_fd(fd, data_ptr, data_len) -> i32
    // Writes data to a pipe fd. Returns bytes written, or negative error code.
    host_write_fd(fd: number, dataPtr: number, dataLen: number): number {
      if (!opts.kernel) return -1;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== "pipe_write") {
        return -1;
      }
      const data = new Uint8Array(memory.buffer, dataPtr, dataLen);
      target.pipe.write(new Uint8Array(data)); // copy since wasm memory may shift
      return dataLen;
    },

    // host_dup(fd, out_ptr, out_cap) -> i32
    // Duplicates a file descriptor and writes the new fd as int32_t.
    host_dup(fd: number, outPtr: number, outCap: number): number {
      if (!opts.kernel) return ERR_IO;
      if (isActivePreopenFd(fd)) return -9;
      try {
        const newFd = opts.kernel.dup(callerPid, fd);
        return writeI32(memory, outPtr, outCap, newFd);
      } catch {
        return -9;
      }
    },

    // host_dup_min(src_fd, min_fd) -> i32
    // POSIX F_DUPFD/F_DUPFD_CLOEXEC: duplicate into the lowest free fd >= min_fd.
    host_dup_min(srcFd: number, minFd: number): number {
      if (isActivePreopenFd(srcFd)) return -1;
      if (minFd < 0) return -POSIX_EINVAL;
      try {
        const kernelTarget = opts.kernel?.getFdTarget(callerPid, srcFd);
        if (opts.kernel && kernelTarget) {
          const newFd = opts.kernel.dupMin(callerPid, srcFd, minFd);
          return newFd;
        }
        const newFd = opts.wasiHost?.duplicateFdMin(srcFd, minFd, false);
        return newFd ?? -1;
      } catch (err) {
        if (err instanceof FdDupMinError) return -err.errno;
        return -1;
      }
    },

    // host_dup2(src_fd, dst_fd) -> i32
    // Makes dst_fd point to the same target as src_fd.
    host_dup2(srcFd: number, dstFd: number): number {
      try {
        if (isActivePreopenFd(srcFd)) return -1;
        if (opts.kernel?.getFdTarget(callerPid, srcFd)) {
          opts.kernel.dup2(callerPid, srcFd, dstFd);
          return 0;
        }
        if (opts.wasiHost) {
          const ioFds = opts.wasiHost.getIoFds();
          const existingKernelTarget =
            opts.kernel?.getFdTarget(callerPid, dstFd) ?? null;
          const mirrored = opts.wasiHost.duplicateFdTo(srcFd, dstFd, false);
          if (mirrored) {
            if (existingKernelTarget && existingKernelTarget !== mirrored) {
              closeFdTarget(existingKernelTarget);
            }
            if (opts.kernel) {
              opts.kernel.setFdTarget(callerPid, dstFd, mirrored);
            }
            return 0;
          }
          const target = ioFds.get(srcFd);
          if (target) {
            if (srcFd === dstFd) return 0;
            const existing = ioFds.get(dstFd);
            if (existing) closeFdTarget(existing);
            if (target.type === "vfs_file") {
              target.fdTable.dupToShared(target.fd, dstFd);
              target.refs++;
              ioFds.set(dstFd, { ...target, fd: dstFd, refs: 1 });
            } else {
              retainFdTarget(target);
              ioFds.set(dstFd, target);
            }
          } else return -1;
        }
        return 0;
      } catch {
        return -1;
      }
    },

    // host_set_fd_descriptor_flags(fd, flags) -> i32
    // Stores POSIX descriptor flags such as FD_CLOEXEC in the kernel fd table.
    host_set_fd_descriptor_flags(fd: number, flags: number): number {
      if (!opts.kernel) return -1;
      if (!opts.kernel.getFdTarget(callerPid, fd)) return -1;
      opts.kernel.setFdDescriptorFlags(callerPid, fd, flags);
      return 0;
    },

    // host_setjmp(env_ptr) -> i32
    // POSIX setjmp via Asyncify.  Phase 1 (this commit): a stub that
    // returns 0 on every call — sufficient for any guest binary that
    // links setjmp's prototype but never actually invokes it (most
    // applets), and for callers that ignore setjmp's return value.
    // Phase 2 will drive the Asyncify state machine to capture the
    // current save-state into env and return the matching longjmp val
    // on rewind.  Keeping a stub here unblocks the build so toolchain
    // changes (--asyncify pass, dropped -wasm-enable-sjlj) ship
    // alongside the host-side stub; the full impl is contained.
    host_setjmp(envPtr: number): number {
      void envPtr;
      return 0;
    },

    // host_longjmp(env_ptr, val) -> void
    // Phase 1 stub: a longjmp call without a matching setjmp save is
    // undefined behavior in POSIX — we surface it as a guest abort
    // (WasiExit 134, the SIGABRT exit code) rather than silently
    // returning, so a misuse during the stub period is loud rather
    // than a mysterious continuation.  Phase 2 replaces this with the
    // real Asyncify-driven unwind+rewind back to the matching
    // host_setjmp call site.
    host_longjmp(envPtr: number, val: number): void {
      void envPtr;
      void val;
      if (opts.wasiHost) opts.wasiHost.cancelExecution();
      throw new Error(
        "longjmp without matching setjmp (Asyncify-based sjlj is Phase 2)",
      );
    },

    // host_fork() -> i32
    // The process loader replaces this with the Asyncify continuation
    // implementation for binaries linked with YURT_CC_USE_CONTINUATION=1.
    // Generic import creation cannot split a wasm continuation, so it
    // reports ENOSYS instead of pretending fork succeeded.
    host_fork(): number {
      return -38;
    },

    // host_yield() -> void
    // Async — yields to the JS event loop, allowing timers and other WASM stacks to run.
    // This is the cooperative scheduling primitive: sleep(0).
    async host_yield(): Promise<void> {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      opts.wasiHost?.drainPendingSignals();
    },

    // host_list_processes(out_ptr, out_cap) -> i32
    // Returns a native yurt_process_list_response_v1 record.
    host_list_processes(outPtr: number, outCap: number): number {
      const encoder = new TextEncoder();
      const procs = opts.kernel?.listProcesses() ?? [];
      const headerSize = 16;
      const entrySize = 20;
      const entriesOffset = headerSize;
      const stringsOffset = entriesOffset + procs.length * entrySize;
      const commandBytes = procs.map((proc) => encoder.encode(proc.command));
      const size = stringsOffset +
        commandBytes.reduce((sum, bytes) => sum + bytes.byteLength, 0);
      if (outCap < size) return size;

      const out = new Uint8Array(memory.buffer, outPtr, size);
      const view = new DataView(memory.buffer, outPtr, size);
      out.fill(0);
      view.setUint32(0, size, true);
      view.setUint16(4, 1, true);
      view.setUint16(6, 0, true);
      view.setUint32(8, entriesOffset, true);
      view.setUint32(12, procs.length, true);

      let cursor = stringsOffset;
      for (let i = 0; i < procs.length; i++) {
        const proc = procs[i];
        const bytes = commandBytes[i];
        const entryOffset = entriesOffset + i * entrySize;
        view.setInt32(entryOffset, proc.pid, true);
        view.setInt32(entryOffset + 4, proc.ppid, true);
        view.setUint32(entryOffset + 8, proc.state === "running" ? 1 : 2, true);
        view.setUint32(entryOffset + 12, cursor, true);
        view.setUint32(entryOffset + 16, bytes.byteLength, true);
        out.set(bytes, cursor);
        cursor += bytes.byteLength;
      }
      return size;
    },

    // ── Network ──

    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    // HTTP fetch via native yurt_fetch_request_v1/yurt_fetch_response_v1 records.
    // Async (JSPI) to support both SAB-based bridges (Node/Deno) and direct
    // fetch() in the browser.
    async host_network_fetch(
      reqPtr: number,
      reqLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> {
      const readFetchString = (
        base: number,
        size: number,
        off: number,
        len: number,
      ): string | null => {
        const bytes = readSpan(memory, base, size, off, len);
        return bytes === null ? null : new TextDecoder().decode(bytes);
      };
      const readHeaderPairs = (
        base: number,
        size: number,
        off: number,
        count: number,
      ): Record<string, string> | null => {
        const pairBytes = readSpan(memory, base, size, off, count * 16);
        if (pairBytes === null) return null;
        const view = new DataView(pairBytes.buffer, pairBytes.byteOffset);
        const headers: Record<string, string> = {};
        for (let i = 0; i < count; i++) {
          const at = i * 16;
          const key = readFetchString(
            base,
            size,
            view.getUint32(at, true),
            view.getUint32(at + 4, true),
          );
          const value = readFetchString(
            base,
            size,
            view.getUint32(at + 8, true),
            view.getUint32(at + 12, true),
          );
          if (key === null || value === null) return null;
          headers[key] = value;
        }
        return headers;
      };
      const writeFetchResponse = (
        status: number,
        headers: Record<string, string>,
        body: Uint8Array,
        error: string | null,
      ): number => {
        const encoder = new TextEncoder();
        const entries = Object.entries(headers);
        const headerSize = 36;
        const pairSize = 16;
        const pairsOffset = headerSize;
        let cursor = pairsOffset + entries.length * pairSize;
        const strings: Uint8Array[] = [];
        const pairs: Array<[number, number, number, number]> = [];
        for (const [key, value] of entries) {
          const keyBytes = encoder.encode(key);
          const valueBytes = encoder.encode(value);
          const keyOffset = cursor;
          cursor += keyBytes.byteLength;
          const valueOffset = cursor;
          cursor += valueBytes.byteLength;
          strings.push(keyBytes, valueBytes);
          pairs.push([
            keyOffset,
            keyBytes.byteLength,
            valueOffset,
            valueBytes.byteLength,
          ]);
        }
        const bodyOffset = cursor;
        cursor += body.byteLength;
        const errorBytes = error ? encoder.encode(error) : new Uint8Array();
        const errorOffset = cursor;
        cursor += errorBytes.byteLength;
        const size = cursor;
        if (outCap < size) return size;

        const out = new Uint8Array(memory.buffer, outPtr, size);
        out.fill(0);
        const view = new DataView(memory.buffer, outPtr, size);
        view.setUint32(0, size, true);
        view.setUint16(4, 1, true);
        view.setUint16(6, 0, true);
        view.setUint32(8, status >>> 0, true);
        view.setUint32(12, pairsOffset, true);
        view.setUint32(16, entries.length, true);
        view.setUint32(20, bodyOffset, true);
        view.setUint32(24, body.byteLength, true);
        view.setUint32(28, errorOffset, true);
        view.setUint32(32, errorBytes.byteLength, true);
        for (let i = 0; i < pairs.length; i++) {
          const at = pairsOffset + i * pairSize;
          const [keyOffset, keyLength, valueOffset, valueLength] = pairs[i];
          view.setUint32(at, keyOffset, true);
          view.setUint32(at + 4, keyLength, true);
          view.setUint32(at + 8, valueOffset, true);
          view.setUint32(at + 12, valueLength, true);
        }
        cursor = pairsOffset + entries.length * pairSize;
        for (const bytes of strings) {
          out.set(bytes, cursor);
          cursor += bytes.byteLength;
        }
        out.set(body, bodyOffset);
        out.set(errorBytes, errorOffset);
        return size;
      };

      const fetchError = (error: string) =>
        writeFetchResponse(0, {}, new Uint8Array(), error);

      if (!opts.networkBridge) {
        return fetchError("networking not configured");
      }

      try {
        const header = readRecordHeader(memory, reqPtr, reqLen);
        if (!header || header.version !== 1 || header.size < 44) {
          return fetchError("invalid fetch request record");
        }
        const view = new DataView(memory.buffer, reqPtr, header.size);
        const url = readFetchString(
          reqPtr,
          header.size,
          view.getUint32(8, true),
          view.getUint32(12, true),
        );
        const method = readFetchString(
          reqPtr,
          header.size,
          view.getUint32(16, true),
          view.getUint32(20, true),
        ) ?? "GET";
        const headers = readHeaderPairs(
          reqPtr,
          header.size,
          view.getUint32(24, true),
          view.getUint32(28, true),
        );
        const bodyBytes = readSpan(
          memory,
          reqPtr,
          header.size,
          view.getUint32(32, true),
          view.getUint32(36, true),
        );
        if (url === null || headers === null || bodyBytes === null) {
          return fetchError("invalid fetch request spans");
        }
        const redirect: FetchRedirectMode = view.getUint32(40, true) === 1
          ? "manual"
          : "follow";
        const body = bodyBytes.byteLength > 0
          ? new Uint8Array(bodyBytes)
          : null;

        // Both fetchAsync (browser) and fetchSync (node bridge) return
        // Promises — the latter's name is legacy from when the bridge
        // blocked on Atomics.wait.
        const result = opts.networkBridge.fetchAsync
          ? await opts.networkBridge.fetchAsync(
            url,
            method,
            headers,
            body,
            redirect,
          )
          : await opts.networkBridge.fetchSync(
            url,
            method,
            headers,
            body,
            redirect,
          );
        const responseBody = result.body_base64
          ? base64ToBytes(result.body_base64)
          : new TextEncoder().encode(result.body);
        return writeFetchResponse(
          result.status,
          result.headers,
          responseBody,
          result.error ?? null,
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return fetchError(msg);
      }
    },

    // ── DNS ──

    // host_dns_resolve(host_ptr, host_len, out_ptr, out_cap) -> i32
    // Resolves a hostname to a native yurt_dns_addr_result_v1 record.
    // Returns bytes written into out_ptr, or -1 if the name cannot be resolved.
    // Async (JSPI): used by yurt_netdb_addr_for_host in the guest.
    async host_dns_resolve(
      hostPtr: number,
      hostLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> {
      const writeDnsAddrResult = (addr: string): number => {
        const size = 8;
        if (outCap < size) return size;
        const bytes = new Uint8Array(memory.buffer, outPtr, size);
        const view = new DataView(memory.buffer, outPtr, size);
        view.setUint32(0, 2, true);
        bytes.set(ipv4ToBytes(addr), 4);
        return size;
      };
      const hostname = readString(memory, hostPtr, hostLen);
      if (!hostname) return -1;
      // Loopback — always resolved locally regardless of platform.
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        return writeDnsAddrResult("127.0.0.1");
      }
      // Sandbox's own address — matches the configured local IP without a syscall.
      if (hostname === socketLocalHost) {
        return writeDnsAddrResult(socketLocalHost);
      }
      const addr = await resolveHostname(hostname);
      if (!addr && socketBackend) {
        return writeDnsAddrResult(syntheticAddressForHost(hostname));
      }
      if (!addr) return -1;
      return writeDnsAddrResult(addr);
    },

    // host_get_local_addr(out_ptr, out_cap) -> i32
    // Writes the kernel-configured sandbox local IPv4 address to out_ptr.
    host_get_local_addr(outPtr: number, outCap: number): number {
      return writeBytes(
        memory,
        outPtr,
        outCap,
        new TextEncoder().encode(socketLocalHost),
      );
    },

    // ── Sockets (full mode only) ──

    // host_socket_open(domain, type, protocol) -> fd
    // Allocates a kernel-owned socket fd. connect() fills in the backend handle later.
    // For AF_UNIX SOCK_DGRAM, allocates a dgram socket in the registry.
    host_socket_open(
      domain: number,
      type: number,
      _protocol: number,
    ): number {
      if (!opts.kernel) return -1;
      // wasi-sdk-30 defines AF_UNIX=3, SOCK_DGRAM=5. C passes these values
      // directly (sys/socket.h #include_next runs before our #ifndef overrides).
      const AF_UNIX = 3;
      const SOCK_DGRAM = 5;
      const SOCK_CLOEXEC = 0x2000;
      const SOCK_NONBLOCK = 0x4000;
      const baseType = type & ~SOCK_CLOEXEC & ~SOCK_NONBLOCK;
      // AF_UNIX SOCK_DGRAM: allocate a registry dgram socket
      if (domain === AF_UNIX && baseType === SOCK_DGRAM) {
        const registry = socketBackend?.registry;
        if (!registry) return -1;
        const rawHandle = registry.openDgramSocket();
        return opts.kernel.allocFd(callerPid, {
          type: "socket",
          socket: -rawHandle, // negate for loopback convention
          family: "AF_UNIX",
          isDgram: true,
          fdFlags: (type & SOCK_NONBLOCK) !== 0 ? WASI_FDFLAGS_NONBLOCK : 0,
          refs: 1,
          send: (socket, data) =>
            socketBackend?.send(socket, data) ??
              { ok: false, error: "networking not configured" },
          recv: (socket, maxBytes, recvOpts) =>
            socketBackend?.recv(socket, maxBytes, recvOpts) ??
              { ok: false, error: "networking not configured" },
          recvAsync: (socket, maxBytes) =>
            socketBackend
              ? recvSocketAsync(socketBackend, socket, maxBytes)
              : Promise.resolve({
                ok: false,
                error: "networking not configured",
              }),
          setNoDelay: (socket, enabled) =>
            socketBackend?.setNoDelay?.(socket, enabled) ??
              {
                ok: false,
                error: "TCP_NODELAY not supported by socket backend",
              },
          close: (_socket) => {
            registry.closeDgramSocket(rawHandle);
          },
        });
      }
      return allocInetStreamSocket(
        opts.kernel,
        socketBackend ?? null,
        callerPid,
        (type & SOCK_NONBLOCK) !== 0,
      );
    },

    // host_socket_connect(fd, sockaddr_ptr, sockaddr_len, flags) -> i32
    // Opens a TCP or TLS socket to the given AF_INET sockaddr. Returns sync
    // (number) when the backend resolves synchronously (loopback) and a
    // Promise<number> when it doesn't (network bridge). JSPI/Asyncify
    // handles the suspension on the Promise path.
    host_socket_connect(
      fd: number,
      addrPtr: number,
      addrLen: number,
      flags: number,
    ): number | Promise<number> {
      if (!socketBackend) {
        netLog("connect", { fd, result: "ECONNREFUSED", reason: "no backend" });
        return ERR_CONN_REFUSED;
      }
      const addr = decodeSockaddrIn(memory, addrPtr, addrLen);
      if (!addr) {
        netLog("connect", { fd, result: "EINVAL" });
        return ERR_INVALID;
      }
      const { host, port } = addr;
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") {
        netLog("connect", { fd, host, port, result: "EBADF" });
        return ERR_BADF;
      }
      netLog("connect", {
        fd,
        host,
        port,
        tls: (flags & 1) !== 0,
      });
      const applyConnect = (
        result: Awaited<ReturnType<typeof socketBackend.connect>>,
      ): number | Promise<number> => {
        if (!result.ok) {
          netLog("connect", {
            fd,
            host,
            port,
            result: "ECONNREFUSED",
            reason: result.error,
          });
          return ERR_CONN_REFUSED;
        }
        const finalise = (): number => {
          target.socket = result.socket;
          target.peerHost = result.peerHost ?? host;
          target.peerPort = result.peerPort ?? port;
          target.localHost = result.localHost ?? socketLocalHost;
          target.localPort = result.localPort ?? socketLocalPortForFd(fd);
          return 0;
        };
        if (target.noDelay) {
          const optR = target.setNoDelay?.(result.socket, true) ??
            { ok: false as const, error: "TCP_NODELAY not supported" };
          if (typeof (optR as Promise<unknown>).then === "function") {
            return (optR as Promise<{ ok: boolean }>).then((opt) =>
              opt.ok ? finalise() : ERR_OP_NOT_SUPPORTED
            );
          }
          return (optR as { ok: boolean }).ok
            ? finalise()
            : ERR_OP_NOT_SUPPORTED;
        }
        return finalise();
      };
      const connectResult = socketBackend.connect({
        host,
        port,
        tls: (flags & 1) !== 0,
      });
      if (typeof (connectResult as Promise<unknown>).then === "function") {
        return (connectResult as Promise<
          Awaited<ReturnType<typeof socketBackend.connect>>
        >).then(applyConnect);
      }
      return applyConnect(
        connectResult as Awaited<ReturnType<typeof socketBackend.connect>>,
      );
    },

    // host_socket_bind(fd, sockaddr_ptr, sockaddr_len) -> i32
    // Records the sandbox-visible local address requested for a socket fd.
    // AF_UNIX uses host_socket_bind_unix; AF_INET uses sockaddr_in bytes.
    host_socket_bind(
      fd: number,
      addrPtr: number,
      addrLen: number,
    ): number {
      const addr = decodeSockaddrIn(memory, addrPtr, addrLen);
      if (!addr) {
        netLog("bind", { fd, result: "EINVAL" });
        return ERR_INVALID;
      }
      const { host, port } = addr;
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") {
        netLog("bind", { fd, host, port, result: "EBADF" });
        return ERR_BADF;
      }
      if (
        host !== "127.0.0.1" && host !== "localhost" && host !== "0.0.0.0"
      ) {
        netLog("bind", { fd, host, port, result: "EAFNOSUPPORT" });
        return ERR_OP_NOT_SUPPORTED;
      }
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        netLog("bind", { fd, host, port, result: "EINVAL" });
        return ERR_INVALID;
      }
      target.boundHost = host;
      target.boundPort = port;
      target.localHost = host === "0.0.0.0" ? socketLocalHost : host;
      target.localPort = port;
      netLog("bind", { fd, host, port, result: "ok" });
      return 0;
    },

    // host_socket_bind_unix(sockfd, path_ptr, path_len, is_abstract) -> 0 | -1
    // Binds an AF_UNIX socket. is_abstract=1 for abstract namespace.
    host_socket_bind_unix(
      sockfd: number,
      pathPtr: number,
      pathLen: number,
      isAbstract: number,
    ): number {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -1;
      const name = new TextDecoder().decode(
        new Uint8Array(memory.buffer, pathPtr, pathLen),
      );
      target.family = "AF_UNIX";
      if (isAbstract) {
        const abstractAuth = authorizeUnixAbstract(opts.serverSockets, name);
        if (!abstractAuth.ok) return -1;
        target.boundPath = `\0${name}`;
        // Abstract DGRAM sockets also register in the dgram route table
        if (target.isDgram) {
          const registry = socketBackend?.registry;
          if (!registry) return -1;
          try {
            registry.bindDgramToPath(-(target.socket as number), `\0${name}`);
          } catch {
            return -1;
          }
        }
        return 0;
      }
      // Enforce path allowlist at bind time (same policy as listen).
      const bindAuth = authorizeUnixListen(opts.serverSockets, name);
      if (!bindAuth.ok) return -1;
      target.boundPath = name;
      // Create the VFS socket inode first to detect conflicts (EEXIST) atomically.
      try {
        opts.vfs?.createSocket?.(name);
      } catch {
        return -1;
      }
      if (target.isDgram) {
        const registry = socketBackend?.registry;
        if (!registry) return -1;
        try {
          registry.bindDgramToPath(-(target.socket as number), name);
        } catch {
          // Roll back the VFS inode we just created.
          try {
            opts.vfs?.unlink(name);
          } catch { /* best-effort */ }
          return -1;
        }
      }
      return 0;
    },

    // host_socket_connect_unix(sockfd, path_ptr, path_len, is_abstract) -> 0 | -1
    // Connects an AF_UNIX socket. is_abstract=1 for abstract namespace.
    host_socket_connect_unix(
      sockfd: number,
      pathPtr: number,
      pathLen: number,
      isAbstract: number,
    ): number {
      const registry = socketBackend?.registry;
      if (!registry) return -1;
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -1;
      const name = new TextDecoder().decode(
        new Uint8Array(memory.buffer, pathPtr, pathLen),
      );
      let result: { ok: boolean; socket?: number; error?: string };
      const connCreds = opts.kernel?.getCredentials(callerPid ?? 0);
      if (isAbstract) {
        result = registry.connectToAbstract(name);
        if (!result.ok) return -1;
        target.socket = -(result.socket as number);
        target.family = "AF_UNIX";
        target.peerPath = `\0${name}`;
        target.peerPid = callerPid ?? 0;
        target.peerUid = connCreds?.euid ?? 0;
        target.peerGid = connCreds?.egid ?? 0;
        return 0;
      }
      result = registry.connectToPath(
        name,
        callerPid,
        connCreds?.euid,
        connCreds?.egid,
      );
      if (!result.ok) return -1;
      target.socket = -(result.socket as number);
      target.family = "AF_UNIX";
      target.peerPath = name;
      target.peerPid = callerPid ?? 0;
      target.peerUid = connCreds?.euid ?? 0;
      target.peerGid = connCreds?.egid ?? 0;
      return 0;
    },

    // host_socket_sendto_unix(sockfd, buf_ptr, buf_len, path_ptr, path_len, is_abstract) -> bytes | -1
    // Sends a SOCK_DGRAM to a bound path. is_abstract=1 for abstract namespace.
    host_socket_sendto_unix(
      sockfd: number,
      bufPtr: number,
      bufLen: number,
      pathPtr: number,
      pathLen: number,
      isAbstract: number,
    ): number {
      const registry = socketBackend?.registry;
      if (!registry) return -1;
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket" || !target.isDgram) return -1;
      const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
      const toPath = new TextDecoder().decode(
        new Uint8Array(memory.buffer, pathPtr, pathLen),
      );
      if (isAbstract) return -1; // abstract dgram sendto not yet supported
      const result = registry.sendDgramToPath(
        toPath,
        bytes,
        target.boundPath ?? undefined,
      );
      return result.ok ? bufLen : -1;
    },

    // host_socket_recvfrom_unix(sockfd, buf_ptr, buf_cap, from_path_ptr, from_path_cap,
    //   from_path_len_ptr, from_is_abstract_ptr) -> bytes | -1 | -2
    // Async dgram recv. Returns byte count, -1 on error, -2 for EAGAIN (no data yet).
    async host_socket_recvfrom_unix(
      sockfd: number,
      bufPtr: number,
      bufCap: number,
      fromPathPtr: number,
      fromPathCap: number,
      fromPathLenPtr: number,
      fromIsAbstractPtr: number,
    ): Promise<number> {
      const registry = socketBackend?.registry;
      if (!registry) return -1;
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket" || !target.isDgram) return -1;
      if (target.socket == null) return -1;
      const rawHandle = -(target.socket as number);
      const nonblocking = ((target.fdFlags ?? 0) & WASI_FDFLAGS_NONBLOCK) !== 0;
      const result = nonblocking
        ? registry.recvDgram(rawHandle, bufCap, true)
        : await registry.recvDgramAsync(rawHandle, bufCap);
      if (!result.ok) return -2;
      const bytes = (result as { ok: true; bytes: Uint8Array }).bytes;
      const recvLen = Math.min(bytes.length, bufCap);
      new Uint8Array(memory.buffer, bufPtr, recvLen).set(
        bytes.subarray(0, recvLen),
      );
      if (result.fromPath || result.fromAbstract) {
        const senderName = result.fromAbstract ?? result.fromPath ?? "";
        const isAbs = result.fromAbstract != null ? 1 : 0;
        const pathBytes = new TextEncoder().encode(senderName);
        const writeLen = Math.min(pathBytes.length, fromPathCap);
        if (fromPathPtr && fromPathCap > 0) {
          new Uint8Array(memory.buffer, fromPathPtr, writeLen).set(
            pathBytes.subarray(0, writeLen),
          );
        }
        new Int32Array(memory.buffer, fromPathLenPtr, 1)[0] = writeLen;
        new Int32Array(memory.buffer, fromIsAbstractPtr, 1)[0] = isAbs;
      } else {
        new Int32Array(memory.buffer, fromPathLenPtr, 1)[0] = 0;
        new Int32Array(memory.buffer, fromIsAbstractPtr, 1)[0] = 0;
      }
      return recvLen;
    },

    // host_socket_addr_unix(sockfd, is_peer, path_ptr, path_cap, is_abstract_ptr)
    //   -> path_len | -1 (not AF_UNIX) | -2 (ENOTCONN)
    // Writes path bytes (no leading NUL for abstract) to path_ptr; sets *is_abstract_ptr.
    host_socket_addr_unix(
      sockfd: number,
      isPeer: number,
      pathPtr: number,
      pathCap: number,
      isAbstractPtr: number,
    ): number {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -1;
      if (target.family !== "AF_UNIX") return -1;
      const rawPath = isPeer ? target.peerPath : target.boundPath;
      if (rawPath == null) return isPeer ? -2 : 0;
      let path: string;
      let isAbstract: number;
      if (rawPath.startsWith("\0")) {
        path = rawPath.slice(1);
        isAbstract = 1;
      } else {
        path = rawPath;
        isAbstract = 0;
      }
      const pathBytes = new TextEncoder().encode(path);
      const writeLen = Math.min(pathBytes.length, pathCap);
      if (pathPtr && pathCap > 0) {
        new Uint8Array(memory.buffer, pathPtr, writeLen).set(
          pathBytes.subarray(0, writeLen),
        );
      }
      if (isAbstractPtr) {
        new Int32Array(memory.buffer, isAbstractPtr, 1)[0] = isAbstract;
      }
      return writeLen;
    },

    // host_socket_peercred(sockfd, pid_ptr, uid_ptr, gid_ptr) -> 0 | -1
    host_socket_peercred(
      sockfd: number,
      pidPtr: number,
      uidPtr: number,
      gidPtr: number,
    ): number {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -1;
      new Int32Array(memory.buffer, pidPtr, 1)[0] = target.peerPid ?? 0;
      new Int32Array(memory.buffer, uidPtr, 1)[0] = target.peerUid ?? 0;
      new Int32Array(memory.buffer, gidPtr, 1)[0] = target.peerGid ?? 0;
      return 0;
    },

    // host_socket_is_dgram(sockfd) -> 1 (SOCK_DGRAM) | 0 (SOCK_STREAM) | -1 (not a socket)
    host_socket_is_dgram(sockfd: number): number {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -1;
      return target.isDgram ? 1 : 0;
    },

    // host_socket_listen_unix(sockfd, backlog) -> 0 | -1 | -2
    // listen() for AF_UNIX sockets (pathname and abstract).
    // Returns 0 on success, -1 on error, -2 if sockfd is not AF_UNIX.
    host_socket_listen_unix(sockfd: number, backlog: number): number {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -2;
      if (target.family !== "AF_UNIX" && typeof target.boundPath !== "string") {
        return -2;
      }
      const registry = socketBackend?.registry;
      if (!registry) return -1;
      const path = target.boundPath!;
      const cap = backlog > 0 ? backlog : 128;
      try {
        if (path.startsWith("\0")) {
          const abstractName = path.slice(1);
          const auth = authorizeUnixAbstract(opts.serverSockets, abstractName);
          if (!auth.ok) return -1;
          const rawHandle = registry.listenOnAbstract(abstractName, cap);
          target.listener = -rawHandle;
          target.closeListener = () => {
            registry.closeAbstractListener(abstractName);
          };
        } else {
          const auth = authorizeUnixListen(opts.serverSockets, path);
          if (!auth.ok) return -1;
          const rawHandle = registry.listenOnPath(path, cap);
          target.listener = -rawHandle;
          const boundPath = path;
          target.closeListener = () => {
            registry.closePathListener(boundPath);
          };
        }
        return 0;
      } catch {
        return -1;
      }
    },

    // host_socket_accept_unix(sockfd) -> new_fd | -1 | -2
    // accept() for AF_UNIX sockets. Async (JSPI/Asyncify).
    // Returns the new accepted fd on success, -1 on error, -2 if sockfd is not AF_UNIX.
    async host_socket_accept_unix(sockfd: number): Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (
        !target || target.type !== "socket" ||
        target.family !== "AF_UNIX" || target.listener == null
      ) return -2;
      if (!opts.kernel || !socketBackend?.registry) return -1;
      const rawHandle = -(target.listener);
      const accepted = await socketBackend.registry.acceptUnix(rawHandle);
      return opts.kernel.allocFd(callerPid, {
        type: "socket",
        socket: -(accepted.socket),
        family: "AF_UNIX",
        boundPath: accepted.localPath,
        peerPath: accepted.peerPath,
        refs: 1,
        peerPid: accepted.peerPid ?? 0,
        peerUid: accepted.peerUid ?? 0,
        peerGid: accepted.peerGid ?? 0,
        send: socketBackend.send.bind(socketBackend),
        recv: socketBackend.recv.bind(socketBackend),
        recvAsync: (socket, maxBytes) =>
          recvSocketAsync(socketBackend, socket, maxBytes),
        setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
        close: (socket) => {
          socketBackend.close(socket);
        },
      });
    },

    // host_socket_send_unix(sockfd, buf_ptr, buf_len) -> bytes | -1 | -2
    // send() for AF_UNIX sockets, passing raw bytes without base64. Synchronous.
    // Returns byte count on success, -1 on error, -2 if sockfd is not AF_UNIX.
    host_socket_send_unix(
      sockfd: number,
      bufPtr: number,
      bufLen: number,
    ): number {
      if (!opts.kernel || !socketBackend) return -1;
      const bytes = new Uint8Array(memory.buffer, bufPtr, bufLen);
      return sendUnixSocket(
        opts.kernel,
        socketBackend,
        callerPid,
        sockfd,
        bytes,
      );
    },

    // host_socket_recv_unix(sockfd, buf_ptr, buf_cap, peek) -> bytes | -1 | -2 | -3
    // recv() for AF_UNIX STREAM sockets, writing raw bytes without base64. Async.
    // Returns byte count on success, -1 on error, -2 for EAGAIN, -3 if not AF_UNIX STREAM.
    async host_socket_recv_unix(
      sockfd: number,
      bufPtr: number,
      bufCap: number,
      peek: number,
    ): Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, sockfd);
      if (!target || target.type !== "socket") return -3;
      if (target.family !== "AF_UNIX") return -3;
      // DGRAM sockets: use recvDgram / recvDgramAsync (ignores fromPath for plain recv)
      if (target.isDgram) {
        if (target.socket == null) return -1;
        const rawHandle = -(target.socket as number);
        const registry = socketBackend?.registry;
        if (!registry) return -1;
        const nonblockingDgram =
          ((target.fdFlags ?? 0) & WASI_FDFLAGS_NONBLOCK) !== 0;
        const dgramResult = nonblockingDgram
          ? registry.recvDgram(rawHandle, bufCap, true)
          : await registry.recvDgramAsync(rawHandle, bufCap);
        if (!dgramResult.ok) return -2;
        const dgramBytes =
          (dgramResult as { ok: true; bytes: Uint8Array }).bytes;
        const n = Math.min(dgramBytes.length, bufCap);
        new Uint8Array(memory.buffer, bufPtr, n).set(dgramBytes.subarray(0, n));
        return n;
      }
      const socket = target.socket as number | null;
      if (socket === null || socket >= 0) return -1;
      const registry = socketBackend?.registry;
      if (!registry) return -1;
      const regHandle = -socket;
      const isPeek = peek !== 0;
      const nonblocking = ((target.fdFlags ?? 0) & WASI_FDFLAGS_NONBLOCK) !== 0;

      function writeResult(bytes: Uint8Array): number {
        const n = Math.min(bytes.byteLength, bufCap);
        new Uint8Array(memory.buffer, bufPtr, n).set(bytes.subarray(0, n));
        return n;
      }

      // Drain peekBuffer first (populated by a previous MSG_PEEK call).
      if (target.peekBuffer && target.peekBuffer.byteLength > 0) {
        const chunk = target.peekBuffer.slice(0, bufCap);
        if (!isPeek) {
          target.peekBuffer = target.peekBuffer.slice(chunk.byteLength);
        }
        return writeResult(chunk);
      }

      if (isPeek) {
        // Nonblocking probe: stash result in peekBuffer for the next real recv.
        const probe = registry.recv(regHandle, bufCap, { nonblocking: true });
        if (!probe.ok) return -2;
        target.peekBuffer = probe.bytes;
        return writeResult(probe.bytes);
      }

      if (nonblocking) {
        const probe = registry.recv(regHandle, bufCap, { nonblocking: true });
        if (!probe.ok) return probe.error === "EAGAIN" ? -2 : -1;
        return writeResult(probe.bytes);
      }

      const result = await registry.recvAsync(regHandle, bufCap);
      if (!result.ok) return -1;
      return writeResult(result.bytes);
    },

    // host_socket_listen(fd, backlog) -> i32
    // Creates a backend listener for a socket fd after sandbox policy
    // authorizes it. Returns sync for loopback, a Promise for the
    // network bridge backend — JSPI/Asyncify handles either shape.
    host_socket_listen(
      fd: number,
      backlogArg: number,
    ): number | Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") {
        netLog("listen", { fd, result: "EBADF" });
        return -9;
      }
      const host = target.boundHost ?? "127.0.0.1";
      const port = target.boundPort ?? 0;
      const backlog = backlogArg > 0 ? backlogArg : 128;
      const auth = authorizeListen(opts.serverSockets, host, port, backlog);
      if (!auth.ok) {
        netLog("listen", {
          fd,
          host,
          port,
          backlog,
          result: "EACCES",
          reason: "authorizeListen denied",
        });
        return -13;
      }
      if (!socketBackend?.listen) {
        netLog("listen", {
          fd,
          host,
          port,
          backlog,
          result: "ENOTSUP",
          reason: "socketBackend.listen is undefined",
        });
        return -95;
      }
      netLog("listen", {
        fd,
        host,
        port,
        backlog,
        backend: socketBackend.constructor?.name ?? "(unknown)",
      });
      const apply = (
        result: Awaited<ReturnType<NonNullable<typeof socketBackend.listen>>>,
      ): number => {
        if (!result.ok) {
          netLog("listen", {
            fd,
            host,
            port,
            result: "EIO",
            reason: result.error ?? "backend listen rejected",
          });
          return -5;
        }
        target.listener = result.listener;
        target.boundHost = host;
        target.boundPort = port;
        target.localHost = result.host;
        target.localPort = result.port;
        target.closeListener = (listener) => {
          // Fire-and-forget: closeListener's host-side return is void;
          // bridge close runs async in the bridge worker regardless.
          void socketBackend.closeListener?.(listener);
        };
        netLog("listen", {
          fd,
          host,
          port,
          result: "ok",
          assignedHost: result.host,
          assignedPort: result.port,
        });
        return 0;
      };
      const listenResult = socketBackend.listen({
        host,
        port,
        backlog,
        mapping: auth.mapping,
      });
      if (typeof (listenResult as Promise<unknown>).then === "function") {
        return (listenResult as Promise<
          Awaited<ReturnType<NonNullable<typeof socketBackend.listen>>>
        >).then(apply);
      }
      return apply(
        listenResult as Awaited<
          ReturnType<NonNullable<typeof socketBackend.listen>>
        >,
      );
    },

    // host_socket_accept(fd, out_ptr, out_cap) -> i32
    // Polls one accepted connection from a listening socket fd.
    async host_socket_accept(
      fd: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket" || target.listener == null) {
        netLog("accept", { fd, result: "EBADF" });
        return -9;
      }
      if (!socketBackend?.accept) {
        netLog("accept", { fd, result: "ENOTSUP" });
        return -95;
      }
      const accepted = await acceptSocketAsync(socketBackend, target.listener);
      if (!accepted.ok) {
        netLog("accept", {
          fd,
          result: accepted.error === "EAGAIN" ? "EAGAIN" : "EIO",
          reason: accepted.error,
        });
        return accepted.error === "EAGAIN" ? -11 : -5;
      }
      netLog("accept", {
        fd,
        peerHost: accepted.peerHost,
        peerPort: accepted.peerPort,
        result: "ok",
      });
      if (!opts.kernel) return -5;
      const acceptedFd = opts.kernel.allocFd(callerPid, {
        type: "socket",
        socket: accepted.socket,
        refs: 1,
        peerHost: accepted.peerHost,
        peerPort: accepted.peerPort,
        localHost: accepted.localHost,
        localPort: accepted.localPort,
        send: socketBackend.send.bind(socketBackend),
        recv: socketBackend.recv.bind(socketBackend),
        recvAsync: (socket, maxBytes) =>
          recvSocketAsync(socketBackend, socket, maxBytes),
        setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
        close: (socket) => {
          socketBackend.close(socket);
        },
      });
      return writeSocketAcceptResult(outPtr, outCap, {
        fd: acceptedFd,
        peerHost: accepted.peerHost,
        peerPort: accepted.peerPort,
        localHost: accepted.localHost,
        localPort: accepted.localPort,
      });
    },

    // host_socket_addr(fd, which, out_ptr, out_cap) -> i32
    // Reports sandbox-visible socket address metadata.
    host_socket_addr(
      fd: number,
      which: number,
      outPtr: number,
      outCap: number,
    ): number {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") return -9;
      if (
        target.socket === null && target.listener == null &&
        target.boundPort === undefined
      ) {
        return -107;
      }
      const local = which === 0;
      if (!local && target.socket === null) return -107;
      return writeSocketAddrResult(
        outPtr,
        outCap,
        local
          ? (target.localHost ?? socketLocalHost)
          : (target.peerHost ?? "0.0.0.0"),
        local
          ? (target.localPort ?? socketLocalPortForFd(fd))
          : (target.peerPort ?? 0),
      );
    },

    // host_socket_send(fd, data_ptr, data_len, flags) -> i32
    // Sends raw bytes from WASM linear memory on an open socket.
    // Returns sync for loopback backends, a Promise for the network
    // bridge — JSPI/Asyncify handles the suspension either way.
    host_socket_send(
      fd: number,
      dataPtr: number,
      dataLen: number,
      _flags: number,
    ): number | Promise<number> {
      if (!socketBackend) {
        netLog("send", { fd, result: "EIO", reason: "no backend" });
        return ERR_IO;
      }
      if (dataLen < 0 || dataPtr < 0) return ERR_INVALID;
      const end = dataPtr + dataLen;
      if (end > memory.buffer.byteLength) return ERR_IO;
      try {
        const target = opts.kernel?.getFdTarget(callerPid, fd);
        if (!target || target.type !== "socket" || target.socket === null) {
          netLog("send", { fd, result: "EBADF" });
          return ERR_NOT_FOUND;
        }
        const data = readBytes(memory, dataPtr, dataLen);
        if (target.isDgram) {
          const registry = socketBackend.registry;
          if (!registry) return ERR_IO;
          const rawHandle = -(target.socket as number);
          const result = registry.sendDgramToPeer(rawHandle, data);
          if (!result.ok) netLog("send", { fd, len: dataLen, result: "EIO" });
          return result.ok ? result.bytesSent : ERR_IO;
        }
        const interpret = (
          r: Awaited<ReturnType<typeof socketBackend.send>>,
        ): number => {
          if (!r.ok) {
            netLog("send", { fd, len: dataLen, result: "EIO" });
            return ERR_IO;
          }
          return typeof r.bytes_sent === "number" ? r.bytes_sent : ERR_IO;
        };
        const sendResult = socketBackend.send(target.socket, data);
        if (typeof (sendResult as Promise<unknown>).then === "function") {
          return (sendResult as Promise<
            Awaited<ReturnType<typeof socketBackend.send>>
          >).then(interpret);
        }
        return interpret(
          sendResult as Awaited<ReturnType<typeof socketBackend.send>>,
        );
      } catch {
        return ERR_IO;
      }
    },

    // host_socket_recv(fd, out_ptr, out_cap, flags) -> i32
    // Receives raw bytes into WASM linear memory. Returns sync for
    // peek-with-buffer and the loopback fast-path; returns a Promise
    // when the backend (network bridge) is async, when target.recvAsync
    // is needed for blocking semantics, or when a nonblocking probe
    // routes through the bridge — JSPI/Asyncify handles the suspension.
    host_socket_recv(
      fd: number,
      outPtr: number,
      outCap: number,
      flags: number,
    ): number | Promise<number> {
      if (!socketBackend) {
        netLog("recv", { fd, result: "EIO", reason: "no backend" });
        return ERR_IO;
      }
      if (outCap < 0 || outPtr < 0) return ERR_INVALID;
      const end = outPtr + outCap;
      if (end > memory.buffer.byteLength) return ERR_IO;
      const MSG_PEEK = 0x02;
      if (flags !== 0 && flags !== MSG_PEEK) {
        netLog("recv", { fd, flags, result: "ENOTSUP" });
        return ERR_UNSUPPORTED;
      }
      try {
        const target = opts.kernel?.getFdTarget(callerPid, fd);
        if (!target || target.type !== "socket" || target.socket === null) {
          netLog("recv", { fd, result: "EBADF" });
          return ERR_NOT_FOUND;
        }
        const maxBytes = outCap;
        const peek = flags === MSG_PEEK;
        if (target.isDgram) {
          const registry = socketBackend.registry;
          if (!registry) return ERR_IO;
          const rawHandle = -(target.socket as number);
          const result = registry.recvDgram(rawHandle, maxBytes, true);
          if (!result.ok) return ERR_AGAIN;
          return writeBytes(memory, outPtr, maxBytes, result.bytes);
        }
        const nonblocking =
          ((target.fdFlags ?? 0) & WASI_FDFLAGS_NONBLOCK) !== 0;
        const writeSocketBytes = (data: Uint8Array): number => {
          const chunk = data.slice(0, maxBytes);
          return writeBytes(memory, outPtr, maxBytes, chunk);
        };
        if (target.peekBuffer && target.peekBuffer.byteLength > 0) {
          const chunk = target.peekBuffer.slice(0, maxBytes);
          if (!peek) {
            target.peekBuffer = target.peekBuffer.slice(chunk.byteLength);
          }
          return writeSocketBytes(chunk);
        }
        if (target.readShutdown) {
          return writeSocketBytes(new Uint8Array(0));
        }
        // peekBuffer is empty.
        if (peek) {
          // Peek probes the backend without suspending and stashes any data
          // into peekBuffer for the following non-peek recv.
          const probe = socketBackend.recv(target.socket, maxBytes, {
            nonblocking: true,
          });
          const finishPeek = (
            r: Awaited<typeof probe>,
          ): number => {
            if (r.ok) {
              const data = r.data ?? new Uint8Array(0);
              target.peekBuffer = target.peekBuffer
                ? concatBytes(target.peekBuffer, data)
                : data;
              return writeSocketBytes(data);
            }
            return r.error === "EAGAIN" ? ERR_AGAIN : ERR_IO;
          };
          if (typeof (probe as Promise<unknown>).then === "function") {
            return (probe as Promise<Awaited<typeof probe>>).then(finishPeek);
          }
          return finishPeek(probe as Awaited<typeof probe>);
        }
        if (nonblocking) {
          // Poll the backend with the nonblocking flag.
          const probe = socketBackend.recv(target.socket, maxBytes, {
            nonblocking: true,
          });
          const finishProbe = (r: Awaited<typeof probe>): number => {
            if (!r.ok) return r.error === "EAGAIN" ? ERR_AGAIN : ERR_IO;
            return writeSocketBytes(r.data ?? new Uint8Array(0));
          };
          if (typeof (probe as Promise<unknown>).then === "function") {
            return (probe as Promise<Awaited<typeof probe>>).then(finishProbe);
          }
          return finishProbe(probe as Awaited<typeof probe>);
        }
        return target.recvAsync(target.socket, maxBytes).then((result) => {
          if (!result.ok) return result.error === "EAGAIN" ? ERR_AGAIN : ERR_IO;
          return writeSocketBytes(result.data ?? new Uint8Array(0));
        });
      } catch {
        return ERR_IO;
      }
    },

    // host_socket_sendmsg(sockfd, data_ptr, data_len, fds_ptr, fds_count) -> bytes | -1
    // SCM_RIGHTS: send bytes + ancillary fd handles.
    // Reads data_len bytes from data_ptr; reads fds_count i32 fd numbers from
    // fds_ptr (fds_ptr == 0 means no ancillary fds).
    host_socket_sendmsg(
      sockfd: number,
      dataPtr: number,
      dataLen: number,
      fdsPtr: number,
      fdsCount: number,
    ): number {
      try {
        if (!opts.kernel) return -1;
        const target = opts.kernel.getFdTarget(callerPid, sockfd);
        if (!target || target.type !== "socket" || target.socket === null) {
          return -1;
        }
        const registry = socketBackend?.registry;
        if (!registry) return -1;
        const bytes = new Uint8Array(memory.buffer, dataPtr, dataLen).slice();
        let ancFds: number[] | undefined;
        if (fdsPtr !== 0 && fdsCount > 0) {
          const view = new DataView(memory.buffer);
          // Dup each ancillary fd so it survives the sender closing the original.
          ancFds = Array.from(
            { length: fdsCount },
            (_, i) =>
              opts.kernel!.dup(callerPid, view.getInt32(fdsPtr + i * 4, true)),
          );
        }
        const rawHandle = -(target.socket);
        const result = registry.sendWithAnc(
          rawHandle,
          bytes,
          ancFds,
          callerPid,
        );
        return result.ok ? result.bytesSent : -1;
      } catch {
        return -1;
      }
    },

    // host_socket_recvmsg(sockfd, buf_ptr, buf_cap, fds_ptr, fds_cap, n_fds_ptr)
    //   -> bytes | -1 (EIO) | -2 (EAGAIN)
    // Writes received bytes to buf_ptr; writes received fd numbers as i32 LE
    // starting at fds_ptr; writes the fd count as i32 LE at n_fds_ptr.
    // fds_ptr == 0 means the caller has no ancillary buffer. Async (JSPI).
    async host_socket_recvmsg(
      sockfd: number,
      bufPtr: number,
      bufCap: number,
      fdsPtr: number,
      fdsCap: number,
      nFdsPtr: number,
    ): Promise<number> {
      try {
        if (!opts.kernel) return -1;
        const target = opts.kernel.getFdTarget(callerPid, sockfd);
        if (!target || target.type !== "socket" || target.socket === null) {
          return -1;
        }
        const registry = socketBackend?.registry;
        if (!registry) return -1;
        const rawHandle = -(target.socket);
        // Peek anc before suspend (recvAsync shifts rx+rxAnc together, so
        // the peek must precede the await for the queued-message case).
        const ancBefore = registry.peekAnc(rawHandle);
        const result = await registry.recvAsync(rawHandle, bufCap);
        if (!result.ok) return result.error === "EAGAIN" ? -2 : -1;
        const bytes = result.bytes;
        const n = Math.min(bytes.length, bufCap);
        new Uint8Array(memory.buffer, bufPtr, n).set(bytes.subarray(0, n));
        // SCM_RIGHTS: get anc from queued path or fast-path waiter.
        const anc = ancBefore ?? registry.popWaiterAnc(rawHandle);
        const view = new DataView(memory.buffer);
        let nFds = 0;
        if (anc) {
          const senderPid = anc.senderPid;
          const toReceive = fdsPtr !== 0 && fdsCap > 0
            ? anc.fds.slice(0, fdsCap)
            : [];
          for (const dupFd of toReceive) {
            try {
              const newFd = opts.kernel.dupFromProcess(
                callerPid,
                senderPid,
                dupFd,
              );
              view.setInt32(fdsPtr + nFds * 4, newFd, true);
              nFds++;
            } finally {
              opts.kernel.closeFd(senderPid, dupFd);
            }
          }
          // Close excess sender-side duplicates that didn't fit in the control buffer.
          for (const dupFd of anc.fds.slice(toReceive.length)) {
            opts.kernel.closeFd(senderPid, dupFd);
          }
        }
        if (nFdsPtr !== 0) view.setInt32(nFdsPtr, nFds, true);
        return n;
      } catch {
        return -1;
      }
    },

    // host_socket_option(fd, option, has_value, value) -> i32
    // Applies or reports socket option state owned by the kernel.
    // Returns sync for the in-memory loopback fast-path and a Promise
    // when the bridge backend's setNoDelay routes through the bridge
    // worker — JSPI/Asyncify handles the suspension on the Promise path.
    host_socket_option(
      fd: number,
      option: number,
      hasValueRaw: number,
      value: number,
    ): number | Promise<number> {
      const hasValue = hasValueRaw !== 0;
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") {
        netLog("setsockopt", { fd, option, result: "EBADF" });
        return -9;
      }
      if (option !== 1) {
        // Many sockopt knobs (SO_LINGER, SO_REUSEADDR, SO_KEEPALIVE,
        // SO_RCVBUF, SO_SNDBUF, …) are advisory — ipykernel's
        // jupyter_client sets SO_LINGER to "off" before binding, which
        // is a no-op on our loopback registry. Accept the set silently
        // and return 0; reject only the read path where the caller
        // expects a real value back. This trades a strict POSIX
        // contract for not crashing every server that touches a
        // setsockopt we don't model yet.
        if (hasValue) {
          netLog("setsockopt", {
            fd,
            option,
            value,
            result: "ok (stubbed)",
          });
          return 0;
        }
        netLog("setsockopt", { fd, option, result: "ENOTSUP (get)" });
        return -95;
      }
      if (!hasValue) return target.noDelay ? 1 : 0;
      const enabled = value !== 0;
      if (target.socket !== null) {
        const setR = target.setNoDelay?.(target.socket, enabled) ??
          { ok: false as const, error: "TCP_NODELAY not supported" };
        if (typeof (setR as Promise<unknown>).then === "function") {
          return (setR as Promise<{ ok: boolean }>).then((r) => {
            if (!r.ok) return -95;
            target.noDelay = enabled;
            return 0;
          });
        }
        if (!(setR as { ok: boolean }).ok) return -95;
      }
      target.noDelay = enabled;
      return 0;
    },

    host_socket_set_no_delay(
      fd: number,
      enabledRaw: number,
    ): number | Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") return -9;
      const enabled = enabledRaw !== 0;
      if (target.socket !== null) {
        const setR = target.setNoDelay?.(target.socket, enabled) ??
          { ok: false as const, error: "TCP_NODELAY not supported" };
        if (typeof (setR as Promise<unknown>).then === "function") {
          return (setR as Promise<{ ok: boolean }>).then((r) => {
            if (!r.ok) return -95;
            target.noDelay = enabled;
            return 0;
          });
        }
        if (!(setR as { ok: boolean }).ok) return -95;
      }
      target.noDelay = enabled;
      return 0;
    },

    // host_socket_socketpair(family, type, sv_ptr) -> 0 | -1
    // Creates a connected AF_UNIX socket pair. Writes the two fd numbers as
    // i32 LE at sv_ptr and sv_ptr+4.
    host_socket_socketpair(
      _family: number,
      sockType: number,
      svPtr: number,
    ): number {
      if (!opts.kernel || !socketBackend) return -1;
      const fds = allocUnixSocketPair(
        opts.kernel,
        socketBackend,
        callerPid ?? 0,
        sockType,
      );
      if (!fds) return -1;
      const view = new DataView(memory.buffer);
      view.setInt32(svPtr, fds.fdA, true);
      view.setInt32(svPtr + 4, fds.fdB, true);
      return 0;
    },

    // host_socket_close(fd) -> i32
    // Closes an open socket. Returns sync for loopback, Promise for
    // bridge. Returns 0 on success, -1 on error.
    host_socket_close(fd: number): number | Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") return -9;
      const reap = (): number => opts.kernel?.closeFd(callerPid, fd) ? 0 : -9;
      if (target.socket !== null) {
        if (!socketBackend) return -5;
        const socket = target.socket;
        target.socket = null;
        const closeResult = socketBackend.close(socket);
        if (typeof (closeResult as Promise<unknown>).then === "function") {
          return (closeResult as Promise<unknown>).then(reap, reap);
        }
      }
      return reap();
    },

    // ── Extensions (Python only — shell routes through host_spawn) ──

    // host_extension_invoke(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Dynamic extension dispatch. Currently consumed by RustPython through the
    // auto-create virtual command machinery; this is Python-coupled debt
    // scheduled to clear with the CPython port. New host integrations should
    // register extensions through SandboxOptions/ExtensionRegistry and keep
    // userland-specific protocols outside the kernel.
    async host_extension_invoke(
      reqPtr: number,
      reqLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> {
      const readExtString = (
        base: number,
        size: number,
        off: number,
        len: number,
      ): string | null => {
        const bytes = readSpan(memory, base, size, off, len);
        return bytes === null ? null : new TextDecoder().decode(bytes);
      };
      const readSpanVector = (
        base: number,
        size: number,
        off: number,
        count: number,
      ): string[] | null => {
        const bytes = readSpan(memory, base, size, off, count * 8);
        if (bytes === null) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          const at = i * 8;
          const value = readExtString(
            base,
            size,
            view.getUint32(at, true),
            view.getUint32(at + 4, true),
          );
          if (value === null) return null;
          out.push(value);
        }
        return out;
      };
      const readPairVector = (
        base: number,
        size: number,
        off: number,
        count: number,
      ): Record<string, string> | null => {
        const bytes = readSpan(memory, base, size, off, count * 16);
        if (bytes === null) return null;
        const view = new DataView(bytes.buffer, bytes.byteOffset);
        const out: Record<string, string> = {};
        for (let i = 0; i < count; i++) {
          const at = i * 16;
          const key = readExtString(
            base,
            size,
            view.getUint32(at, true),
            view.getUint32(at + 4, true),
          );
          const value = readExtString(
            base,
            size,
            view.getUint32(at + 8, true),
            view.getUint32(at + 12, true),
          );
          if (key === null || value === null) return null;
          out[key] = value;
        }
        return out;
      };
      const writeExtensionResponse = (
        exitCode: number,
        stdout: string,
        stderr: string,
        payload = new Uint8Array(),
      ): number => {
        const encoder = new TextEncoder();
        const stdoutBytes = encoder.encode(stdout);
        const stderrBytes = encoder.encode(stderr);
        const headerSize = 36;
        const stdoutOffset = headerSize;
        const stderrOffset = stdoutOffset + stdoutBytes.byteLength;
        const payloadOffset = stderrOffset + stderrBytes.byteLength;
        const size = payloadOffset + payload.byteLength;
        if (outCap < size) return size;
        const out = new Uint8Array(memory.buffer, outPtr, size);
        const view = new DataView(memory.buffer, outPtr, size);
        out.fill(0);
        view.setUint32(0, size, true);
        view.setUint16(4, 1, true);
        view.setUint16(6, 0, true);
        view.setInt32(8, exitCode, true);
        view.setUint32(12, stdoutOffset, true);
        view.setUint32(16, stdoutBytes.byteLength, true);
        view.setUint32(20, stderrOffset, true);
        view.setUint32(24, stderrBytes.byteLength, true);
        view.setUint32(28, payloadOffset, true);
        view.setUint32(32, payload.byteLength, true);
        out.set(stdoutBytes, stdoutOffset);
        out.set(stderrBytes, stderrOffset);
        out.set(payload, payloadOffset);
        return size;
      };
      const decodeRequest = () => {
        const header = readRecordHeader(memory, reqPtr, reqLen);
        if (!header || header.version !== 1 || header.size < 56) {
          return null;
        }
        const view = new DataView(memory.buffer, reqPtr, header.size);
        const name = readExtString(
          reqPtr,
          header.size,
          view.getUint32(8, true),
          view.getUint32(12, true),
        );
        const args = readSpanVector(
          reqPtr,
          header.size,
          view.getUint32(16, true),
          view.getUint32(20, true),
        );
        const stdin = readExtString(
          reqPtr,
          header.size,
          view.getUint32(24, true),
          view.getUint32(28, true),
        );
        const cwd = readExtString(
          reqPtr,
          header.size,
          view.getUint32(32, true),
          view.getUint32(36, true),
        );
        const env = readPairVector(
          reqPtr,
          header.size,
          view.getUint32(40, true),
          view.getUint32(44, true),
        );
        if (name === null || args === null || stdin === null || env === null) {
          return null;
        }
        return { name, args, stdin, env, cwd: cwd || getCallerCwd() };
      };
      const req = decodeRequest();
      if (!req) {
        return writeExtensionResponse(1, "", "invalid extension request\n");
      }

      if (opts.extensionRegistry) {
        try {
          const result = await opts.extensionRegistry.invoke(req.name, {
            args: req.args,
            stdin: req.stdin,
            env: req.env,
            cwd: req.cwd,
          });

          return writeExtensionResponse(
            result.exitCode,
            result.stdout ?? "",
            result.stderr ?? "",
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeExtensionResponse(1, "", `${msg}\n`);
        }
      }

      // Fall back to legacy extensionHandler.
      if (opts.extensionHandler) {
        try {
          const result = await opts.extensionHandler(req);
          const response = result as {
            exitCode?: number;
            exit_code?: number;
            stdout?: string;
            stderr?: string;
          };
          return writeExtensionResponse(
            response.exitCode ?? response.exit_code ?? 0,
            response.stdout ?? "",
            response.stderr ?? "",
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeExtensionResponse(1, "", `${msg}\n`);
        }
      }

      return writeExtensionResponse(1, "", "extensions not available\n");
    },

    // ── Filesystem ──

    host_has_tool(namePtr: number, nameLen: number): number {
      const name = readString(memory, namePtr, nameLen);
      return opts.mgr?.hasTool(name) ? 1 : 0;
    },

    host_time(): number {
      return Date.now() / 1000;
    },

    host_stat(
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const s = asyncVfs.statAsync
              ? await asyncVfs.statAsync(path)
              : asyncVfs.stat(path);
            return writeStatRecord(memory, outPtr, outCap, s);
          } catch {
            return ERR_NOT_FOUND;
          }
        })();
      }
      try {
        const s = opts.vfs.stat(path);
        return writeStatRecord(memory, outPtr, outCap, s);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_read_file(
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const data = asyncVfs.readFileAsync
              ? await asyncVfs.readFileAsync(path)
              : asyncVfs.readFile(path);
            return writeBytes(memory, outPtr, outCap, data);
          } catch {
            return ERR_NOT_FOUND;
          }
        })();
      }
      try {
        const data = opts.vfs.readFile(path);
        return writeBytes(memory, outPtr, outCap, data);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_write_file(
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number,
      mode: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const path = readString(memory, pathPtr, pathLen);
      const data = readBytes(memory, dataPtr, dataLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            if (mode === 1) {
              try {
                const existing = asyncVfs.readFileAsync
                  ? await asyncVfs.readFileAsync(path)
                  : asyncVfs.readFile(path);
                const combined = new Uint8Array(existing.length + data.length);
                combined.set(existing);
                combined.set(data, existing.length);
                if (asyncVfs.writeFileAsync) {
                  await asyncVfs.writeFileAsync(path, combined);
                } else {
                  asyncVfs.writeFile(path, combined);
                }
              } catch {
                if (asyncVfs.writeFileAsync) {
                  await asyncVfs.writeFileAsync(path, data);
                } else {
                  asyncVfs.writeFile(path, data);
                }
              }
            } else if (asyncVfs.writeFileAsync) {
              await asyncVfs.writeFileAsync(path, data);
            } else {
              asyncVfs.writeFile(path, data);
            }
            return 0;
          } catch {
            return ERR_IO;
          }
        })();
      }
      try {
        if (mode === 1) {
          try {
            const existing = opts.vfs.readFile(path);
            const combined = new Uint8Array(existing.length + data.length);
            combined.set(existing);
            combined.set(data, existing.length);
            opts.vfs.writeFile(path, combined);
          } catch {
            opts.vfs.writeFile(path, data);
          }
        } else {
          opts.vfs.writeFile(path, data);
        }
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readdir(
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const entries = asyncVfs.readdirAsync
              ? await asyncVfs.readdirAsync(path)
              : asyncVfs.readdir(path);
            return writeStringListRecord(
              memory,
              outPtr,
              outCap,
              entries.map((e) => e.name),
            );
          } catch {
            return ERR_NOT_FOUND;
          }
        })();
      }
      try {
        const entries = opts.vfs.readdir(path).map((e) => e.name);
        return writeStringListRecord(memory, outPtr, outCap, entries);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_mkdir(pathPtr: number, pathLen: number): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const path = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            if (asyncVfs.mkdirAsync) await asyncVfs.mkdirAsync(path);
            else asyncVfs.mkdir(path);
            return 0;
          } catch {
            return ERR_IO;
          }
        })();
      }
      try {
        opts.vfs.mkdir(path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_remove(
      pathPtr: number,
      pathLen: number,
      recursive: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            if (recursive) {
              if (asyncVfs.rmdirAsync) await asyncVfs.rmdirAsync(path);
              else asyncVfs.rmdir(path);
            } else {
              try {
                if (asyncVfs.unlinkAsync) await asyncVfs.unlinkAsync(path);
                else asyncVfs.unlink(path);
              } catch {
                if (asyncVfs.rmdirAsync) await asyncVfs.rmdirAsync(path);
                else asyncVfs.rmdir(path);
              }
            }
            return 0;
          } catch {
            return ERR_NOT_FOUND;
          }
        })();
      }
      try {
        if (recursive) {
          opts.vfs.rmdir(path);
        } else {
          try {
            opts.vfs.unlink(path);
          } catch {
            opts.vfs.rmdir(path);
          }
        }
        return 0;
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_chmod(
      pathPtr: number,
      pathLen: number,
      mode: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const path = resolveCwdPath(getCallerCwd(), rawPath);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const credentials = getCallerCredentials();
            const authorized = await withVfsCallerCredentials(async () => {
              const stat = asyncVfs.statAsync
                ? await asyncVfs.statAsync(path)
                : asyncVfs.stat(path);
              if (
                credentials.euid !== ROOT_UID && stat.uid !== credentials.euid
              ) {
                return false;
              }
              if (asyncVfs.chmodAsync) await asyncVfs.chmodAsync(path, mode);
              else asyncVfs.chmod(path, mode);
              return true;
            });
            if (!authorized) return ERR_PERMISSION;
            return 0;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (msg.includes("ENOENT") || msg.includes("no such file")) {
              return ERR_NOT_FOUND;
            }
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            return ERR_IO;
          }
        })();
      }
      try {
        const credentials = getCallerCredentials();
        const authorized = withVfsCallerCredentials(() => {
          const stat = opts.vfs!.stat(path);
          if (credentials.euid !== ROOT_UID && stat.uid !== credentials.euid) {
            return false;
          }
          opts.vfs!.chmod(path, mode);
          return true;
        });
        if (!authorized) return ERR_PERMISSION;
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          return ERR_NOT_FOUND;
        }
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          return ERR_PERMISSION;
        }
        return ERR_IO;
      }
    },

    host_chown(
      pathPtr: number,
      pathLen: number,
      uid: number,
      gid: number,
      followSymlinks: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const path = resolveCwdPath(getCallerCwd(), rawPath);
      const targetUid = uid | 0;
      const targetGid = gid | 0;
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          const authorized = await authorizeChownAsync(
            asyncVfs,
            path,
            targetUid,
            targetGid,
            followSymlinks !== 0,
          );
          if (authorized !== 0) return authorized;
          try {
            await withVfsCallerCredentials(async () => {
              if (asyncVfs.chownAsync) {
                await asyncVfs.chownAsync(
                  path,
                  targetUid,
                  targetGid,
                  followSymlinks !== 0,
                );
              } else {
                asyncVfs.chown(
                  path,
                  targetUid,
                  targetGid,
                  followSymlinks !== 0,
                );
              }
            });
            return 0;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (msg.includes("ENOENT") || msg.includes("no such file")) {
              return ERR_NOT_FOUND;
            }
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            return ERR_IO;
          }
        })();
      }
      const authorized = authorizeChown(
        path,
        targetUid,
        targetGid,
        followSymlinks !== 0,
      );
      if (authorized !== 0) return authorized;
      try {
        withVfsCallerCredentials(() =>
          opts.vfs!.chown(path, targetUid, targetGid, followSymlinks !== 0)
        );
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          return ERR_NOT_FOUND;
        }
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          return ERR_PERMISSION;
        }
        return ERR_IO;
      }
    },

    host_fchown(
      fd: number,
      uid: number,
      gid: number,
    ): number | Promise<number> {
      if (!opts.vfs || !opts.kernel) return ERR_IO;
      const targetUid = uid | 0;
      const targetGid = gid | 0;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== "vfs_file") return ERR_NOT_FOUND;
      const path = target.fdTable.getPath(target.fd);
      if (!path) return ERR_NOT_FOUND;
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          const authorized = await authorizeChownAsync(
            asyncVfs,
            path,
            targetUid,
            targetGid,
          );
          if (authorized !== 0) return authorized;
          try {
            await withVfsCallerCredentials(async () => {
              if (asyncVfs.chownAsync) {
                await asyncVfs.chownAsync(path, targetUid, targetGid);
              } else {
                asyncVfs.chown(path, targetUid, targetGid);
              }
            });
            return 0;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : "";
            if (msg.includes("ENOENT") || msg.includes("no such file")) {
              return ERR_NOT_FOUND;
            }
            if (msg.includes("EACCES") || msg.includes("permission denied")) {
              return ERR_PERMISSION;
            }
            return ERR_IO;
          }
        })();
      }
      const authorized = authorizeChown(path, targetUid, targetGid);
      if (authorized !== 0) return authorized;
      try {
        withVfsCallerCredentials(() =>
          opts.vfs!.chown(path, targetUid, targetGid)
        );
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "";
        if (msg.includes("ENOENT") || msg.includes("no such file")) {
          return ERR_NOT_FOUND;
        }
        if (msg.includes("EACCES") || msg.includes("permission denied")) {
          return ERR_PERMISSION;
        }
        return ERR_IO;
      }
    },

    host_glob(
      patternPtr: number,
      patternLen: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.vfs) return writeStringListRecord(memory, outPtr, outCap, []);
      const pattern = readString(memory, patternPtr, patternLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            return writeStringListRecord(
              memory,
              outPtr,
              outCap,
              await globMatchAsync(asyncVfs, pattern),
            );
          } catch {
            return writeStringListRecord(memory, outPtr, outCap, []);
          }
        })();
      }
      try {
        return writeStringListRecord(
          memory,
          outPtr,
          outCap,
          globMatch(opts.vfs, pattern),
        );
      } catch {
        return writeStringListRecord(memory, outPtr, outCap, []);
      }
    },

    host_rename(
      fromPtr: number,
      fromLen: number,
      toPtr: number,
      toLen: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const from = readString(memory, fromPtr, fromLen);
      const to = readString(memory, toPtr, toLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            if (asyncVfs.renameAsync) await asyncVfs.renameAsync(from, to);
            else asyncVfs.rename(from, to);
            opts.kernel?.remapCwdAfterRename(from, to);
            return 0;
          } catch {
            return ERR_IO;
          }
        })();
      }
      try {
        opts.vfs.rename(from, to);
        opts.kernel?.remapCwdAfterRename(from, to);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_symlink(
      targetPtr: number,
      targetLen: number,
      linkPtr: number,
      linkLen: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_IO;
      const target = readString(memory, targetPtr, targetLen);
      const link = readString(memory, linkPtr, linkLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            if (asyncVfs.symlinkAsync) {
              await asyncVfs.symlinkAsync(target, link);
            } else asyncVfs.symlink(target, link);
            return 0;
          } catch {
            return ERR_IO;
          }
        })();
      }
      try {
        opts.vfs.symlink(target, link);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readlink(
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): number | Promise<number> {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
      const asyncVfs = asyncHostVfs(opts.vfs);
      if (asyncVfs) {
        return (async () => {
          try {
            const target = asyncVfs.readlinkAsync
              ? await asyncVfs.readlinkAsync(path)
              : asyncVfs.readlink(path);
            return writeString(memory, outPtr, outCap, target);
          } catch {
            return ERR_NOT_FOUND;
          }
        })();
      }
      try {
        return writeString(memory, outPtr, outCap, opts.vfs.readlink(path));
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    async host_register_tool(
      namePtr: number,
      nameLen: number,
      pathPtr: number,
      pathLen: number,
    ): Promise<number> {
      if (!opts.mgr || !opts.vfs) return ERR_IO;
      const name = readString(memory, namePtr, nameLen);
      const path = readString(memory, pathPtr, pathLen);
      try {
        if (name.startsWith("__native__")) {
          const moduleName = name.slice("__native__".length);
          const asyncVfs = asyncHostVfs(opts.vfs);
          const wasmBytes = asyncVfs?.readFileAsync
            ? await asyncVfs.readFileAsync(path)
            : opts.vfs.readFile(path);
          await opts.mgr.registerNativeModule(moduleName, wasmBytes);
          return 0;
        }
        await opts.mgr.registerAndLoadTool(name, path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_read_command(outPtr: number, outCap: number): number {
      void outPtr;
      void outCap;
      return 0;
    },

    host_write_result(resultPtr: number, resultLen: number): void {
      void resultPtr;
      void resultLen;
    },

    // ── Phase 1 shared-library loader ──
    // Spec: docs/superpowers/specs/2026-05-09-shared-libraries-design.md.
    // The four yurt_dl* imports back the dlfcn surface in
    // abi/include/dlfcn.h via the guest stubs in abi/src/yurt_dlfcn.c.
    // Errors set lastDlError; dlerror() drains it.

    yurt_dlopen(pathPtr: number, pathLen: number, flags: number): number {
      const path = readString(memory, pathPtr, pathLen);
      const vfs = opts.vfs;
      if (!vfs) {
        lastDlError = "dlopen: no vfs available";
        return 0;
      }
      try {
        const handle = loadSideModule(path, dlHandleTable, {
          flags,
          vfs: makeDlVfsLookup(vfs),
          yurtImports: getYurtImportSnapshot(),
          mainAccess: () => {
            const inst = opts.mainInstance?.() ?? null;
            if (inst === null) return undefined;
            // Thread-capable main modules import memory rather than
            // exporting it (target=wasm32-wasip1-threads + --import-memory).
            // `opts.mainImportedMemory` holds the SAB-backed reference
            // the kernel bound to `env.memory`; passing it lets the
            // loader satisfy the side module's `env.memory` import
            // even though `inst.exports.memory` is undefined.
            return mainAccessFromInstance(
              inst,
              opts.mainImportedMemory ?? undefined,
            );
          },
        });
        lastDlError = "";
        return handle;
      } catch (e) {
        lastDlError = e instanceof Error ? e.message : String(e);
        return 0;
      }
    },

    yurt_dlsym(handle: number, namePtr: number, nameLen: number): number {
      const loaded = dlHandleTable.get(handle);
      if (!loaded) {
        lastDlError = `dlsym: invalid handle ${handle}`;
        return -1;
      }
      const name = readString(memory, namePtr, nameLen);
      const result = lookupSymbol(loaded, name);
      if (result < 0) {
        lastDlError = `undefined symbol: ${name}`;
        return -1;
      }
      lastDlError = "";
      return result;
    },

    yurt_dlclose(handle: number): number {
      const result = dlHandleTable.release(handle);
      if (result < 0) {
        lastDlError = `dlclose: invalid handle ${handle}`;
        return -1;
      }
      lastDlError = "";
      return 0;
    },

    yurt_dlerror(outPtr: number, outCap: number): number {
      if (lastDlError === "") return 0;
      const buf = new TextEncoder().encode(lastDlError);
      const view = new Uint8Array(
        memory.buffer,
        outPtr,
        Math.min(buf.length, outCap),
      );
      view.set(buf.subarray(0, view.length));
      const written = buf.length;
      // POSIX dlerror semantics: drain on read.
      lastDlError = "";
      return written;
    },
  };

  if (opts.threadsBackend) {
    const tb = opts.threadsBackend;
    imports.host_thread_spawn = ((fnPtr: number, arg: number) =>
      tb.spawn(fnPtr, arg)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_join = (async (tid: number, outRetvalPtr: number) => {
      const retval = await tb.join(tid);
      if (retval < 0) {
        return retval;
      }
      const end = outRetvalPtr + 4;
      if (outRetvalPtr < 0 || end > memory.buffer.byteLength) {
        return ERR_IO;
      }
      new DataView(memory.buffer).setUint32(outRetvalPtr, retval >>> 0, true);
      return 0;
    }) as unknown as WebAssembly.ImportValue;
    imports.host_thread_detach = ((tid: number) =>
      tb.detach(tid)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_exit = ((retval: number) => {
      if (tb.self() === 0) {
        throw new WasiExitError(0);
      }
      return tb.exit(retval);
    }) as unknown as WebAssembly.ImportValue;
    imports.host_thread_self = (() =>
      tb.self()) as unknown as WebAssembly.ImportValue;
    imports.host_thread_yield = (() =>
      tb.yield_()) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_lock = ((mutexPtr: number) =>
      tb.mutexLock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_unlock = ((mutexPtr: number) =>
      tb.mutexUnlock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_trylock = ((mutexPtr: number) =>
      tb.mutexTryLock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_wait = ((condPtr: number, mutexPtr: number) =>
      tb.condWait(condPtr, mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_signal = ((condPtr: number) =>
      tb.condSignal(condPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_broadcast = ((condPtr: number) =>
      tb.condBroadcast(condPtr)) as unknown as WebAssembly.ImportValue;
  }

  return imports;
}

function defaultImportResourceLimit(
  resource: number,
): { soft: number; hard: number } | null {
  switch (resource) {
    case 0:
    case 1:
      return { soft: Infinity, hard: Infinity };
    case 2:
    case 5:
      return { soft: 64 * 1024 * 1024, hard: 64 * 1024 * 1024 };
    case 3:
      return { soft: 1024 * 1024, hard: 1024 * 1024 };
    case 4:
      return { soft: 0, hard: 0 };
    case 6:
    case 7:
      return { soft: 1024, hard: 1024 };
    default:
      return null;
  }
}
