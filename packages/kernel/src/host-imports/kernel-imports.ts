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
   * Legacy extension handler (sync, used by Worker proxy).
   * If both extensionRegistry and extensionHandler are provided,
   * extensionRegistry takes precedence.
   */
  extensionHandler?: (cmd: Record<string, unknown>) => Record<string, unknown>;

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
const ROOT_UID = 0;
const USER_UID = 1000;
const USER_GID = 1000;
const PRIO_PROCESS = 0;
const YURT_WAIT_NOHANG = 1;

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
const SPAWN_REQUEST_V1_MIN_SIZE = 80;
const SPAN_SIZE = 8;
const ENV_PAIR_SIZE = 16;
const FD_MAP_PAIR_SIZE = 8;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const FETCH_RECORD_VERSION_1 = 1;
const FETCH_FLAG_MANUAL_REDIRECT = 1;
const FETCH_RESPONSE_FLAG_OK = 1;
const FETCH_REQUEST_HEADER_SIZE = 20;
const FETCH_RESPONSE_HEADER_SIZE = 20;

interface FetchRequestRecord {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  redirect: FetchRedirectMode;
}

function parseHeaderLines(bytes: Uint8Array): Record<string, string> {
  const text = new TextDecoder().decode(bytes);
  const headers: Record<string, string> = {};
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const sep = line.indexOf(":");
    if (sep <= 0) throw new Error("invalid fetch header line");
    headers[line.slice(0, sep).trim()] = line.slice(sep + 1).trimStart();
  }
  return headers;
}

function encodeHeaderLines(headers: Record<string, string>): Uint8Array {
  return new TextEncoder().encode(
    Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join(
      "\n",
    ),
  );
}

function decodeFetchRequest(bytes: Uint8Array): FetchRequestRecord {
  if (bytes.byteLength < FETCH_REQUEST_HEADER_SIZE) {
    throw new Error("fetch request too short");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(0, true);
  if (version !== FETCH_RECORD_VERSION_1) {
    throw new Error(`unsupported fetch request version: ${version}`);
  }
  const flags = view.getUint16(2, true);
  const urlLen = view.getUint32(4, true);
  const methodLen = view.getUint32(8, true);
  const headersLen = view.getUint32(12, true);
  const bodyLen = view.getUint32(16, true);
  const total = FETCH_REQUEST_HEADER_SIZE + urlLen + methodLen + headersLen +
    bodyLen;
  if (total > bytes.byteLength) throw new Error("truncated fetch request");
  let offset = FETCH_REQUEST_HEADER_SIZE;
  const decode = (len: number): string => {
    const value = new TextDecoder().decode(
      bytes.subarray(offset, offset + len),
    );
    offset += len;
    return value;
  };
  const url = decode(urlLen);
  const method = methodLen === 0 ? "GET" : decode(methodLen);
  const headers = parseHeaderLines(bytes.subarray(offset, offset + headersLen));
  offset += headersLen;
  const body = bodyLen === 0 ? undefined : decode(bodyLen);
  return {
    url,
    method,
    headers,
    body,
    redirect: (flags & FETCH_FLAG_MANUAL_REDIRECT) !== 0 ? "manual" : "follow",
  };
}

function encodeFetchResponse(record: {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: string | Uint8Array;
  error?: string | null;
}): Uint8Array {
  const headers = encodeHeaderLines(record.headers);
  const body = typeof record.body === "string"
    ? new TextEncoder().encode(record.body)
    : record.body;
  const error = record.error == null ? new Uint8Array() : new TextEncoder()
    .encode(record.error);
  const bytes = new Uint8Array(
    FETCH_RESPONSE_HEADER_SIZE + headers.byteLength + body.byteLength +
      error.byteLength,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(0, FETCH_RECORD_VERSION_1, true);
  view.setUint16(2, record.ok ? FETCH_RESPONSE_FLAG_OK : 0, true);
  view.setUint32(4, record.status, true);
  view.setUint32(8, headers.byteLength, true);
  view.setUint32(12, body.byteLength, true);
  view.setUint32(16, error.byteLength, true);
  let offset = FETCH_RESPONSE_HEADER_SIZE;
  bytes.set(headers, offset);
  offset += headers.byteLength;
  bytes.set(body, offset);
  offset += body.byteLength;
  bytes.set(error, offset);
  return bytes;
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

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
  if (bytes.byteLength < SPAWN_REQUEST_V1_MIN_SIZE) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const logicalSize = view.getUint32(0, true);
  const version = view.getUint16(4, true);
  if (
    version !== NATIVE_RECORD_VERSION_1 ||
    logicalSize < SPAWN_REQUEST_V1_MIN_SIZE
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
  const fdMap = logicalSize >= 88 ? readFdMap(readU32(80), readU32(84)) : [];
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
    // Supports two output formats depending on capacity:
    //   - cap >= 8: binary struct {read_fd: i32, write_fd: i32} (new ABI, returns 8)
    //   - cap >= 16 AND old-ABI probe: ASCII "READ_FD\nWRITE_FD\n" (legacy busybox, returns byte count)
    // Legacy busybox passes cap=64 and expects ASCII decimal text.
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
      // Legacy binaries (busybox in standard image) pass outCap=64 and expect
      // JSON {"read_fd":N,"write_fd":M}. Detect via cap > 8.
      if (outCap > 8) {
        const json = `{"read_fd":${readFd},"write_fd":${writeFd}}`;
        const bytes = new TextEncoder().encode(json);
        if (outCap < bytes.length) return ERR_IO;
        if (outPtr < 0 || outPtr + bytes.length > memory.buffer.byteLength) {
          return ERR_IO;
        }
        new Uint8Array(memory.buffer, outPtr, bytes.length).set(bytes);
        return bytes.length;
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
    // form (host_spawn_async) returns the pid directly. There is no JSON
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

    host_getcwd(outPtr: number, outCap: number): number {
      const cwd = getCallerPhysicalCwd();
      const bytes = new TextEncoder().encode(cwd);
      const required = bytes.byteLength + 1;
      if (outCap < required) return required;
      new Uint8Array(memory.buffer, outPtr, bytes.byteLength).set(bytes);
      new Uint8Array(memory.buffer)[outPtr + bytes.byteLength] = 0;
      return required;
    },

    host_realpath(
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): number {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      try {
        const real = withVfsCallerCredentials(() =>
          resolveRealpath(opts.vfs!, getCallerCwd(), rawPath)
        );
        const bytes = new TextEncoder().encode(real);
        const required = bytes.byteLength + 1;
        if (outCap < required) return required;
        new Uint8Array(memory.buffer, outPtr, bytes.byteLength).set(bytes);
        new Uint8Array(memory.buffer)[outPtr + bytes.byteLength] = 0;
        return required;
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

    host_chdir(pathPtr: number, pathLen: number): number {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const path = resolveCwdPath(getCallerCwd(), rawPath);
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

    host_fchdir(fd: number): number {
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

    // host_waitpid_nohang(pid, wstatus_ptr, wstatus_len) -> i32
    // Non-blocking waitpid: returns waited pid, 0 if no child exited yet, or -errno.
    // Writes POSIX wstatus (exitCode << 8) to wstatus_ptr if non-zero and child exited.
    host_waitpid_nohang(
      pid: number,
      wstatusPtr: number,
      wstatusLen: number,
    ): number {
      if (!opts.kernel) return ERR_CHILD;
      opts.wasiHost?.drainPendingSignals();
      const kernel = opts.kernel;
      if (pid <= 0) {
        const result = kernel.waitAnyChildNohang(callerPid);
        if (result.state === "running") return 0;
        if (result.state === "none") return ERR_CHILD;
        if (wstatusPtr !== 0 && wstatusLen >= 4) {
          new DataView(memory.buffer).setInt32(
            wstatusPtr,
            result.exitCode << 8,
            true,
          );
        }
        return result.pid!;
      }
      const exitCode = kernel.waitpidNohang(pid, callerPid);
      if (exitCode === -1) return 0;
      if (exitCode < 0) return ERR_CHILD;
      if (wstatusPtr !== 0 && wstatusLen >= 4) {
        new DataView(memory.buffer).setInt32(wstatusPtr, exitCode << 8, true);
      }
      return pid;
    },

    // host_waitpid(pid, wstatus_ptr, wstatus_len) -> i32 | Promise<i32>
    // Blocking waitpid: suspends until child exits. Returns waited pid or -errno.
    // Writes POSIX wstatus (exitCode << 8) to wstatus_ptr if non-zero.
    host_waitpid(
      pid: number,
      wstatusPtr: number,
      wstatusLen: number,
    ): number | Promise<number> {
      if (!opts.kernel) return ERR_CHILD;
      const kernel = opts.kernel;

      return (async () => {
        await yieldToScheduler();
        const signalWait = opts.wasiHost?.waitForSignalDelivery();
        const interrupt = signalWait?.promise ?? new Promise<void>(() => {});

        const writeStatus = (waitedPid: number, code: number): number => {
          if (wstatusPtr !== 0 && wstatusLen >= 4) {
            new DataView(memory.buffer).setInt32(wstatusPtr, code << 8, true);
          }
          return waitedPid;
        };

        if (pid <= 0) {
          // Do NOT call drainPendingSignals() here: the asyncify buffer holds a
          // saved WASM stack.  If the SIGCHLD handler calls host_waitpid (async),
          // wrapImport would overwrite the buffer and corrupt the outer waitpid
          // resume point.  The interrupt promise (from waitForSignalDelivery) is
          // sufficient — it fires when any signal is queued.
          const waitedPromise = kernel.waitAnyChildInterruptible(
            callerPid,
            interrupt,
          );
          const waited = await waitedPromise;
          signalWait?.cancel();
          if (waited.interrupted) {
            const result = kernel.waitAnyChildNohang(callerPid);
            if (result.state === "exited") {
              return writeStatus(result.pid!, result.exitCode);
            }
            return ERR_INTERRUPTED;
          }
          const result = waited.result;
          if (!result) return ERR_CHILD;
          return writeStatus(result.pid, result.exitCode);
        }

        // Same safety rule: no drainPendingSignals() while asyncify buffer is live.
        const waitedPromise = kernel.waitpidInterruptible(
          pid,
          callerPid,
          interrupt,
        );
        const waited = await waitedPromise;
        signalWait?.cancel();
        if (waited.interrupted) {
          const exitCode = kernel.waitpidNohang(pid, callerPid);
          if (exitCode >= 0) return writeStatus(pid, exitCode);
          return ERR_INTERRUPTED;
        }
        if (waited.exitCode < 0) return ERR_CHILD;
        return writeStatus(pid, waited.exitCode);
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
      if (minFd < 0) return -1;
      try {
        const kernelTarget = opts.kernel?.getFdTarget(callerPid, srcFd);
        if (opts.kernel && kernelTarget) {
          const newFd = opts.kernel.dupMin(callerPid, srcFd, minFd);
          return newFd;
        }
        const newFd = opts.wasiHost?.duplicateFdMin(srcFd, minFd, false);
        return newFd ?? -1;
      } catch {
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

    // ── Network ──

    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    // HTTP fetch via NetworkBridge. Async (JSPI) to support both SAB-based
    // bridges (Node/Deno) and direct fetch() in the browser.
    async host_network_fetch(
      reqPtr: number,
      reqLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> {
      const fetchError = (error: string) =>
        writeBytes(
          memory,
          outPtr,
          outCap,
          encodeFetchResponse({
            ok: false,
            status: 0,
            headers: {},
            body: "",
            error,
          }),
        );

      if (!opts.networkBridge) {
        return fetchError("networking not configured");
      }

      try {
        const req = decodeFetchRequest(readBytes(memory, reqPtr, reqLen));

        // Use async fetch if available (browser), otherwise fall back to sync (SAB bridge)
        const result = opts.networkBridge.fetchAsync
          ? await opts.networkBridge.fetchAsync(
            req.url,
            req.method,
            req.headers,
            req.body,
            req.redirect,
          )
          : opts.networkBridge.fetchSync(
            req.url,
            req.method,
            req.headers,
            req.body,
            req.redirect,
          );
        return writeBytes(
          memory,
          outPtr,
          outCap,
          encodeFetchResponse({
            ok: !result.error && result.status >= 200 && result.status < 400,
            status: result.status,
            headers: result.headers,
            body: result.body_base64 == null
              ? result.body
              : decodeBase64Bytes(result.body_base64),
            error: result.error ?? null,
          }),
        );
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return fetchError(msg);
      }
    },

    // ── DNS ──

    // host_dns_resolve(host_ptr, host_len, out_ptr, out_cap) -> i32
    // Resolves a hostname to a dotted-decimal IPv4 address string.
    // Returns bytes written into out_ptr, or -1 if the name cannot be resolved.
    // Async (JSPI): used by yurt_netdb_addr_for_host in the guest.
    async host_dns_resolve(
      hostPtr: number,
      hostLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> {
      const hostname = readString(memory, hostPtr, hostLen);
      if (!hostname) return -1;
      // Loopback — always resolved locally regardless of platform.
      if (hostname === "localhost" || hostname === "127.0.0.1") {
        return writeBytes(
          memory,
          outPtr,
          outCap,
          new TextEncoder().encode("127.0.0.1"),
        );
      }
      // Sandbox's own address — matches the configured local IP without a syscall.
      if (hostname === socketLocalHost) {
        return writeBytes(
          memory,
          outPtr,
          outCap,
          new TextEncoder().encode(socketLocalHost),
        );
      }
      const addr = await resolveHostname(hostname);
      if (!addr && socketBackend) {
        return writeBytes(
          memory,
          outPtr,
          outCap,
          new TextEncoder().encode(syntheticAddressForHost(hostname)),
        );
      }
      if (!addr) return -1;
      return writeBytes(memory, outPtr, outCap, new TextEncoder().encode(addr));
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

    // host_socket_connect(addr_ptr, addr_len, flags) -> fd / -errno
    host_socket_connect(
      addrPtr: number,
      addrLen: number,
      _flags: number,
    ): number {
      if (!opts.kernel || !socketBackend) return ERR_IO;
      const targetText = readString(memory, addrPtr, addrLen);
      const sep = targetText.lastIndexOf(":");
      if (sep <= 0 || sep === targetText.length - 1) return ERR_INVALID;
      const host = targetText.slice(0, sep);
      const port = Number.parseInt(targetText.slice(sep + 1), 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return ERR_INVALID;
      }
      const result = socketBackend.connect({ host, port, tls: false });
      if (!result.ok) return ERR_IO;
      return opts.kernel.allocFd(callerPid, {
        type: "socket",
        socket: result.socket,
        refs: 1,
        peerHost: result.peerHost ?? host,
        peerPort: result.peerPort ?? port,
        localHost: result.localHost ?? socketLocalHost,
        localPort: result.localPort ?? socketLocalPortForFd(result.socket),
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

    // host_socket_listen(backlog, addr_ptr, addr_len) -> fd / -errno
    host_socket_listen(
      backlogRaw: number,
      addrPtr: number,
      addrLen: number,
    ): number {
      if (!opts.kernel || !socketBackend?.listen) return ERR_IO;
      const targetText = readString(memory, addrPtr, addrLen);
      const sep = targetText.lastIndexOf(":");
      if (sep <= 0 || sep === targetText.length - 1) return ERR_INVALID;
      const hostText = targetText.slice(0, sep);
      if (
        hostText !== "127.0.0.1" && hostText !== "localhost" &&
        hostText !== "0.0.0.0"
      ) {
        return ERR_PERMISSION;
      }
      const host = hostText as "127.0.0.1" | "localhost" | "0.0.0.0";
      const port = Number.parseInt(targetText.slice(sep + 1), 10);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        return ERR_INVALID;
      }
      const backlog = Number.isInteger(backlogRaw) && backlogRaw > 0
        ? backlogRaw
        : 128;
      const auth = authorizeListen(opts.serverSockets, host, port, backlog);
      if (!auth.ok) return ERR_PERMISSION;
      const result = socketBackend.listen({
        host,
        port,
        backlog,
        mapping: auth.mapping,
      });
      if (!result.ok) return ERR_IO;
      return opts.kernel.allocFd(callerPid, {
        type: "socket",
        socket: null,
        listener: result.listener,
        refs: 1,
        boundHost: host,
        boundPort: port,
        localHost: result.host,
        localPort: result.port,
        send: socketBackend.send.bind(socketBackend),
        recv: socketBackend.recv.bind(socketBackend),
        recvAsync: (socket, maxBytes) =>
          recvSocketAsync(socketBackend, socket, maxBytes),
        setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
        close: (socket) => {
          socketBackend.close(socket);
        },
        closeListener: (listener) => {
          socketBackend.closeListener?.(listener);
        },
      });
    },

    // host_socket_accept(fd, flags) -> fd / -errno
    async host_socket_accept(fd: number, _flags: number): Promise<number> {
      if (!opts.kernel || !socketBackend?.accept) return ERR_IO;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket" || target.listener == null) {
        return ERR_INVALID;
      }
      const accepted = await acceptSocketAsync(socketBackend, target.listener);
      if (!accepted.ok) {
        return "wouldBlock" in accepted && accepted.wouldBlock
          ? ERR_AGAIN
          : ERR_IO;
      }
      return opts.kernel.allocFd(callerPid, {
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
    },

    // host_socket_addr(fd, out_ptr, out_cap) -> bytes / -errno
    host_socket_addr(fd: number, outPtr: number, outCap: number): number {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") return ERR_INVALID;
      const host = target.localHost ?? socketLocalHost;
      const port = target.localPort ?? socketLocalPortForFd(fd);
      const hostBytes = new TextEncoder().encode(host);
      const out = new Uint8Array(2 + hostBytes.byteLength);
      new DataView(out.buffer).setUint16(0, port, true);
      out.set(hostBytes, 2);
      return writeBytes(memory, outPtr, outCap, out);
    },

    // host_socket_set_no_delay(fd, enabled) -> 0 / -errno
    host_socket_set_no_delay(fd: number, enabledRaw: number): number {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (
        !socketBackend || !target || target.type !== "socket" ||
        target.socket === null
      ) {
        return ERR_INVALID;
      }
      const enabled = enabledRaw !== 0;
      target.noDelay = enabled;
      const result = target.setNoDelay?.(target.socket, enabled) ?? {
        ok: true as const,
      };
      return result.ok ? 0 : ERR_IO;
    },

    // host_socket_send(fd, data_ptr, data_len, flags) -> bytes / -errno
    host_socket_send(
      fd: number,
      dataPtr: number,
      dataLen: number,
      _flags: number,
    ): number {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (
        !socketBackend || !target || target.type !== "socket" ||
        target.socket === null
      ) {
        return ERR_INVALID;
      }
      const data = readBytes(memory, dataPtr, dataLen);
      const result = socketBackend.send(target.socket, bytesToBase64(data));
      if (!result.ok) return ERR_IO;
      return result.bytes_sent ?? data.byteLength;
    },

    // host_socket_recv(fd, out_ptr, out_cap, flags) -> bytes / -errno
    host_socket_recv(
      fd: number,
      outPtr: number,
      outCap: number,
      flags: number,
    ): number | Promise<number> {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (
        !socketBackend || !target || target.type !== "socket" ||
        target.socket === null
      ) {
        return ERR_INVALID;
      }
      const peek = (flags & 0x02) !== 0;
      const nonblocking = (flags & 0x04) !== 0 || Boolean(
        (
          opts.kernel?.getFdDescriptorFlags(callerPid, fd) ??
            target.fdFlags ?? 0
        ) & WASI_FDFLAGS_NONBLOCK,
      );
      const writeRecv = (result: ReturnType<SocketBackend["recv"]>): number => {
        if (!result.ok) return result.error === "EAGAIN" ? ERR_AGAIN : ERR_IO;
        const data = base64ToBytes(result.data_b64 ?? "");
        return writeBytes(memory, outPtr, outCap, data);
      };
      if (target.peekBuffer && target.peekBuffer.byteLength > 0) {
        const chunk = target.peekBuffer.slice(0, outCap);
        if (!peek) {
          target.peekBuffer = target.peekBuffer.slice(chunk.byteLength);
        }
        return writeBytes(memory, outPtr, outCap, chunk);
      }
      if (peek) {
        const probe = socketBackend.recv(target.socket, outCap, {
          nonblocking: true,
        });
        if (probe.ok) {
          const data = base64ToBytes(probe.data_b64 ?? "");
          target.peekBuffer = target.peekBuffer
            ? concatBytes(target.peekBuffer, data)
            : data;
        }
        return writeRecv(probe);
      }
      if (nonblocking) {
        return writeRecv(socketBackend.recv(target.socket, outCap, {
          nonblocking: true,
        }));
      }
      return target.recvAsync(target.socket, outCap).then(writeRecv);
    },

    // host_socket_close(fd) -> 0 / -errno
    host_socket_close(fd: number): number {
      const target = opts.kernel?.getFdTarget(callerPid, fd);
      if (!target || target.type !== "socket") return ERR_INVALID;
      if (target.socket !== null) {
        if (!socketBackend) return ERR_IO;
        const socket = target.socket;
        target.socket = null;
        socketBackend.close(socket);
      }
      if (target.listener != null) {
        target.closeListener?.(target.listener);
      }
      return opts.kernel?.closeFd(callerPid, fd) ? 0 : ERR_INVALID;
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

      // Fall back to legacy extensionHandler (sync)
      if (opts.extensionHandler) {
        try {
          const result = opts.extensionHandler(req);
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
    ): number {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
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
    ): number {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
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
    ): number {
      if (!opts.vfs) return ERR_IO;
      const path = readString(memory, pathPtr, pathLen);
      const data = readBytes(memory, dataPtr, dataLen);
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
    ): number {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
      try {
        const entries = opts.vfs.readdir(path);
        return writeStringListRecord(
          memory,
          outPtr,
          outCap,
          entries.map((entry) => entry.name),
        );
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_mkdir(pathPtr: number, pathLen: number): number {
      if (!opts.vfs) return ERR_IO;
      const path = readString(memory, pathPtr, pathLen);
      try {
        opts.vfs.mkdir(path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_remove(pathPtr: number, pathLen: number, recursive: number): number {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
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

    host_chmod(pathPtr: number, pathLen: number, mode: number): number {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const path = resolveCwdPath(getCallerCwd(), rawPath);
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
    ): number {
      if (!opts.vfs) return ERR_IO;
      const rawPath = readString(memory, pathPtr, pathLen);
      const path = resolveCwdPath(getCallerCwd(), rawPath);
      const targetUid = uid | 0;
      const targetGid = gid | 0;
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

    host_fchown(fd: number, uid: number, gid: number): number {
      if (!opts.vfs || !opts.kernel) return ERR_IO;
      const targetUid = uid | 0;
      const targetGid = gid | 0;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== "vfs_file") return ERR_NOT_FOUND;
      const path = target.fdTable.getPath(target.fd);
      if (!path) return ERR_NOT_FOUND;
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
    ): number {
      if (!opts.vfs) {
        return writeStringListRecord(memory, outPtr, outCap, []);
      }
      const pattern = readString(memory, patternPtr, patternLen);
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
    ): number {
      if (!opts.vfs) return ERR_IO;
      const from = readString(memory, fromPtr, fromLen);
      const to = readString(memory, toPtr, toLen);
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
    ): number {
      if (!opts.vfs) return ERR_IO;
      const target = readString(memory, targetPtr, targetLen);
      const link = readString(memory, linkPtr, linkLen);
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
    ): number {
      if (!opts.vfs) return ERR_NOT_FOUND;
      const path = readString(memory, pathPtr, pathLen);
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
          const wasmBytes = opts.vfs.readFile(path);
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
            return inst === null ? undefined : mainAccessFromInstance(inst);
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
    imports.host_thread_spawn = (async (fnPtr: number, arg: number) =>
      tb.spawn(fnPtr, arg)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_join = (async (tid: number) =>
      tb.join(tid)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_detach = (async (tid: number) =>
      tb.detach(tid)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_exit = ((retval: number) => {
      if (tb.self() === 0) {
        throw new WasiExitError(0);
      }
      return tb.exit(retval);
    }) as unknown as WebAssembly.ImportValue;
    imports.host_thread_self = (() =>
      tb.self()) as unknown as WebAssembly.ImportValue;
    imports.host_thread_yield = (async () =>
      tb.yield_()) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_lock = (async (mutexPtr: number) =>
      tb.mutexLock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_unlock = ((mutexPtr: number) =>
      tb.mutexUnlock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_trylock = ((mutexPtr: number) =>
      tb.mutexTryLock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_wait = (async (condPtr: number, mutexPtr: number) =>
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
