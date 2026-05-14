/**
 * Generic process loader. Instantiates a wasm guest, wires WASI + yurt
 * imports, runs _start, and returns a Process handle.
 */

import { Process, type ProcessMode } from "./handle.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import type { ProcessKernel } from "./kernel.js";
import type { SocketBackend } from "../network/socket-backend.js";
import { WasiHost } from "../wasi/wasi-host.js";
import {
  createBufferTarget,
  createNullTarget,
  createStaticTarget,
} from "../wasi/fd-target.js";
import {
  AsyncifyAsyncBridge,
  type AsyncifyForkSnapshot,
} from "../async-bridge.js";
import { CooperativeSerialBackend } from "./threads/cooperative-serial.js";
import { createThreadsBackend } from "./threads/backend-factory.js";
import {
  defaultSpawnThread,
  type WorkerSabThreadsBackendOptions,
} from "./threads/worker-sab.js";
import { makeIndirectCallTable } from "./threads/indirect-call-table.js";
import type {
  LinearStackSwitchingThreadsBackend,
  ThreadsBackend,
} from "./threads/backend.js";
import type { WorkerHostDispatcherBodies } from "./threads/worker-host-proxy.js";
import { makeWorkerDispatcherBodies } from "../host-imports/worker-bodies.js";
import {
  defaultWasmModuleCache,
  sha256Hex,
  type WasmModuleCache,
} from "./module-cache.js";
import {
  analyzeYurtModule,
  moduleNeedsAsyncifyBridge,
  validateYurtModuleProfile,
  validateYurtThreadMemory,
  type YurtModuleProfile,
} from "./module-profile.js";

/**
 * Default size (in 64KB wasm pages) for a SAB-backed memory allocated when a
 * threaded module imports `env.memory` but the caller didn't supply one. The
 * initial reservation matches a typical libc-style heap; the maximum is the
 * 32-bit wasm limit (4GB) so brk()/sbrk()/mmap() can grow up to that bound.
 */
const DEFAULT_WORKER_SAB_INITIAL_PAGES = 16;
const DEFAULT_WORKER_SAB_MAXIMUM_PAGES = 16384;

/**
 * Decide which SharedArrayBuffer-backed `WebAssembly.Memory` to hand to a
 * threaded module's import object and to the WorkerSabThreadsBackend.
 *
 * - If the profile isn't a threaded module with a memory import, returns
 *   undefined (caller may still pass workerSabMemory through, but the loader
 *   won't consume it for thread wiring).
 * - If the caller supplied `provided`, validate it has a SharedArrayBuffer
 *   backing and return it as-is.
 * - Otherwise allocate a fresh shared memory sized for a libc-style heap.
 */
export function resolveWorkerSabMemory(
  profile: YurtModuleProfile,
  provided: WebAssembly.Memory | undefined,
  importLimits?: { initial: number; maximum?: number } | null,
): WebAssembly.Memory | undefined {
  if (!profile.requiresSharedMemory || !profile.memoryImport) {
    return provided;
  }
  if (provided) {
    validateYurtThreadMemory(profile, provided);
    return provided;
  }
  const maximum = importLimits?.maximum ?? DEFAULT_WORKER_SAB_MAXIMUM_PAGES;
  const initial = Math.min(
    maximum,
    Math.max(DEFAULT_WORKER_SAB_INITIAL_PAGES, importLimits?.initial ?? 1),
  );
  return new WebAssembly.Memory({
    initial,
    maximum,
    shared: true,
  });
}

/**
 * Decide which WorkerSabThreadsBackendOptions to pass to the backend factory.
 *
 * If the caller supplied options, use them. Otherwise, for a threaded module
 * with a resolved SAB-backed memory, default-construct a spawner that boots a
 * Worker hosting a cloned WASM instance via `defaultSpawnThread(module,
 * memory, bodies)`. When `bodies` is supplied, each spawned worker also gets a
 * per-thread request SAB with the main-side dispatcher attached so it can
 * proxy host imports back to main; without `bodies` the worker instantiates
 * with `yurt: {}` (Task 4 behavior). Returns undefined when there's no memory
 * to back the spawner.
 */
export function resolveWorkerSabThreads(
  profile: YurtModuleProfile,
  module: WebAssembly.Module,
  memory: WebAssembly.Memory | undefined,
  provided: WorkerSabThreadsBackendOptions | undefined,
  bodies?: WorkerHostDispatcherBodies,
): WorkerSabThreadsBackendOptions | undefined {
  if (provided) return provided;
  if (!profile.requiresSharedMemory || !memory) return undefined;
  return { spawnThread: defaultSpawnThread(module, memory, bodies) };
}

type WasmCallable = (...args: unknown[]) => unknown;

// Only imports proven safe for today's JSPI and Asyncify binaries belong here.
// Do not add WASI path_* imports until the affected guests are built with those
// imports in their asyncify-imports set and JSPI path_open/i64 behavior is
// verified against file-conformance and ABI canaries.
const ASYNC_WASI_IMPORTS = [
  "fd_read",
  "fd_write",
  "poll_oneoff",
] as const;

const THREADED_ASYNC_WASI_IMPORTS = [
  ...ASYNC_WASI_IMPORTS,
  "fd_close",
  "fd_filestat_get",
  "fd_filestat_set_size",
  "fd_filestat_set_times",
  "fd_pwrite",
  "fd_readdir",
  "path_create_directory",
  "path_filestat_get",
  "path_filestat_set_times",
  "path_open",
  "path_readlink",
  "path_remove_directory",
  "path_rename",
  "path_symlink",
  "path_unlink_file",
] as const;

function bindSignalDeliverer(
  wasi: WasiHost,
  instance: WebAssembly.Instance,
): void {
  const deliverSignal = instance.exports.yurt_deliver_signal;
  if (typeof deliverSignal !== "function") return;
  wasi.setSignalDeliverer((sig) => {
    (deliverSignal as (sig: number) => unknown)(sig);
  });
}

export interface LoaderContext {
  vfs: VfsLike;
  adapter: PlatformAdapter;
  kernel: ProcessKernel;
  /**
   * Socket backend (registry-based loopback or network bridge). The
   * loader forwards this to `makeWorkerDispatcherBodies` so pthread
   * workers can satisfy AF_UNIX socketpair / send_unix via the same
   * registry the main thread uses.
   */
  socketBackend?: SocketBackend;
  allocatePid(argv: string[]): number;
  releasePid(pid: number, exitCode: number, signal?: number): void;
  buildWasiHost(
    pid: number,
    argv: string[],
    env: Record<string, string>,
    cwd: string,
  ): WasiHost;
  buildKernelImports(
    pid: number,
    memory: WebAssembly.Memory,
    wasiHost: WasiHost,
    threadsBackend: ThreadsBackend,
    mainInstance: () => WebAssembly.Instance | null,
    /**
     * For threaded modules, the actual `WebAssembly.Memory` bound to
     * `env.memory` (SAB-backed). `null` for non-threaded modules,
     * which export their own memory. The Phase 1 dlopen loader uses
     * this when the main module imports memory (no exported `memory`
     * on the instance) to satisfy a side module's `env.memory`
     * import.
     */
    mainImportedMemory: WebAssembly.Memory | null,
  ): Record<string, WebAssembly.ImportValue>;
  makeFdReadAndClear(
    pid: number,
  ): (fd: 1 | 2) => { data: string; truncated: boolean };
  moduleCache?: WasmModuleCache;
}

export interface LoadProcessOptions {
  argv: string[];
  wasiArgv?: string[];
  mode: ProcessMode;
  env?: Record<string, string>;
  cwd?: string;
  memoryBytes?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
  stderrToStdout?: boolean;
  workerSabAvailable?: boolean;
  workerSabMemory?: WebAssembly.Memory;
  workerSabThreads?: WorkerSabThreadsBackendOptions;
  extraYurtImports?: (
    memory: WebAssembly.Memory,
    wasiHost: WasiHost,
  ) => Record<string, WebAssembly.ImportValue>;
  /**
   * True when loadProcess owns the PID reservation. Async host_spawn callers
   * return the child PID before this promise settles, so they keep ownership
   * and release/register the child in their catch path.
   */
  rollbackOnFailure?: boolean;
}

export async function loadProcess(
  ctx: LoaderContext,
  opts: LoadProcessOptions,
): Promise<Process> {
  const { argv, mode } = opts;
  const path = argv[0];
  if (!path) throw new Error("loadProcess: argv[0] is required");

  const bytes = ctx.vfs.readFile(path);
  if (
    bytes.length < 4 || bytes[0] !== 0x00 || bytes[1] !== 0x61 ||
    bytes[2] !== 0x73 || bytes[3] !== 0x6d
  ) {
    throw new Error(`loadProcess: ${path} is not a wasm binary`);
  }

  const digest = await sha256Hex(bytes);
  const module = await (ctx.moduleCache ?? defaultWasmModuleCache)
    .getOrCompile(digest, bytes);
  // Worker/SAB capability gating: callers opt in either explicitly via
  // `workerSabAvailable`, or implicitly by supplying a SAB memory or a
  // `WorkerSabThreadsBackend` spawner. Unopted callers (most of today's
  // code) leave the profile in `unsupported` for threaded modules.
  const workerSabAvailable = opts.workerSabAvailable ??
    Boolean(opts.workerSabMemory || opts.workerSabThreads);
  const profile = validateYurtModuleProfile(analyzeYurtModule(module, {
    workerSabAvailable,
  }));
  const workerSabMemory = resolveWorkerSabMemory(
    profile,
    opts.workerSabMemory,
    profile.memoryImport
      ? findMemoryImportLimits(bytes, profile.memoryImport)
      : null,
  );
  // Build worker-host dispatcher bodies once per process so every
  // spawned pthread shares the same kernel/threads-backend references
  // (and any future per-process lock state the bodies grow). The
  // bodies are passed through `defaultSpawnThread` so each Worker gets
  // a per-thread SAB with the same main-side dispatcher attached.
  //
  // Both `callerPid` (allocated later, after the backend is built so
  // pid-rollback semantics on threading-rejection are preserved) and
  // `threadsBackend` are late-bound via accessor closures. The body
  // factory itself runs eagerly so any per-process closure state is
  // shared across every worker that this process spawns.
  let pidRef: number | null = null;
  let threadsBackendRef: ThreadsBackend | null = null;
  const workerHostBodies: WorkerHostDispatcherBodies | undefined =
    profile.requiresSharedMemory
      ? makeWorkerDispatcherBodies({
        kernel: ctx.kernel,
        // The bodies pull callerPid through a closure rather than a
        // direct argument so we can finish building before pid alloc.
        // See `callerPid` doc-comment on MakeWorkerDispatcherBodiesOptions.
        callerPid: () => pidRef ?? 0,
        threadsBackend: () => threadsBackendRef,
        socketBackend: ctx.socketBackend ?? null,
      })
      : undefined;
  const workerSabThreads = resolveWorkerSabThreads(
    profile,
    module,
    workerSabMemory,
    opts.workerSabThreads,
    workerHostBodies,
  );
  const threadsBackend = createThreadsBackend(profile, {
    workerSab: workerSabThreads,
    workerSabMemory,
  });
  threadsBackendRef = threadsBackend;
  const wasiArgv = opts.wasiArgv ?? argv;
  const cwd = opts.cwd ?? "/";
  const env = { ...(opts.env ?? {}), PWD: cwd };
  const rollbackOnFailure = opts.rollbackOnFailure ?? true;
  const pid = ctx.allocatePid(argv);
  pidRef = pid;
  const rollback = () => {
    if (rollbackOnFailure) ctx.kernel.discardProcess(pid);
  };

  ctx.kernel.initProcess(pid);
  ctx.kernel.setCwd(pid, cwd);
  if (!ctx.kernel.getFdTarget(pid, 0)) {
    ctx.kernel.setFdTarget(pid, 0, createNullTarget());
  }
  if (!ctx.kernel.getFdTarget(pid, 1)) {
    ctx.kernel.setFdTarget(
      pid,
      1,
      createBufferTarget(opts.stdoutLimit ?? Infinity),
    );
  }
  if (opts.stderrToStdout) {
    const stdoutTarget = ctx.kernel.getFdTarget(pid, 1);
    if (stdoutTarget) ctx.kernel.setFdTarget(pid, 2, stdoutTarget);
  } else if (!ctx.kernel.getFdTarget(pid, 2)) {
    ctx.kernel.setFdTarget(
      pid,
      2,
      createBufferTarget(opts.stderrLimit ?? Infinity),
    );
  }

  const proc = Process.__forLoader({ pid, mode });
  const wasi = ctx.buildWasiHost(pid, wasiArgv, env, cwd);
  const wasiImports = wasi.getImports().wasi_snapshot_preview1;

  let memoryRef: WebAssembly.Memory | null = null;
  const memoryProxy = new Proxy({} as WebAssembly.Memory, {
    get(_target, prop) {
      if (!memoryRef) throw new Error("memory not initialized");
      const val =
        (memoryRef as unknown as Record<string | symbol, unknown>)[prop];
      return typeof val === "function" ? val.bind(memoryRef) : val;
    },
  });

  const asyncifyBridge = moduleNeedsAsyncifyBridge(profile) ||
      typeof WebAssembly.Suspending !== "function"
    ? new AsyncifyAsyncBridge()
    : null;
  let mainInstanceRef: WebAssembly.Instance | null = null;
  const yurtImports: Record<string, WebAssembly.ImportValue> = {
    ...ctx.buildKernelImports(
      pid,
      memoryProxy,
      wasi,
      threadsBackend,
      () => mainInstanceRef,
      workerSabMemory ?? null,
    ),
    ...(opts.extraYurtImports?.(memoryProxy, wasi) ?? {}),
  };
  if (asyncifyBridge) {
    yurtImports.host_setjmp = asyncifyBridge
      .hostSetjmp as unknown as WebAssembly.ImportValue;
    yurtImports.host_longjmp = asyncifyBridge
      .hostLongjmp as unknown as WebAssembly.ImportValue;
    yurtImports.host_fork = asyncifyBridge
      .hostFork as unknown as WebAssembly.ImportValue;
  }
  wrapAsyncImports(
    yurtImports,
    [
      "host_wait",
      "host_poll",
      "host_kill",
      "host_killpg",
      "host_yield",
      "host_chdir",
      "host_chmod",
      "host_chown",
      "host_fchdir",
      "host_fchown",
      "host_getcwd",
      "host_glob",
      "host_mkdir",
      "host_read_file",
      "host_readdir",
      "host_readlink",
      "host_realpath",
      "host_remove",
      "host_rename",
      "host_stat",
      "host_symlink",
      "host_write_file",
      "host_network_fetch",
      "host_dns_resolve",
      "host_register_tool",
      "host_socket_accept",
      "host_socket_recv",
      "host_socket_recvmsg",
      "host_socket_sendmsg",
      "host_socket_socketpair",
      "host_socket_bind_unix",
      "host_socket_connect_unix",
      "host_socket_recvfrom_unix",
      "host_socket_accept_unix",
      "host_socket_recv_unix",
      "host_extension_invoke",
      "host_run_command",
      "host_thread_spawn",
      "host_thread_join",
      "host_thread_detach",
      "host_thread_yield",
      "host_mutex_lock",
      "host_cond_wait",
    ],
    asyncifyBridge,
    threadsBackend,
  );
  wrapAsyncImports(
    wasiImports as Record<string, WebAssembly.ImportValue>,
    profile.requiresSharedMemory
      ? THREADED_ASYNC_WASI_IMPORTS
      : ASYNC_WASI_IMPORTS,
    asyncifyBridge,
    threadsBackend,
  );

  let instance: WebAssembly.Instance;
  try {
    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: wasiImports,
      yurt: yurtImports,
    };
    if (profile.memoryImport && workerSabMemory) {
      const namespace = imports[profile.memoryImport.module] ?? {};
      imports[profile.memoryImport.module] = {
        ...namespace,
        [profile.memoryImport.name]: workerSabMemory,
      };
    }
    instance = await ctx.adapter.instantiate(module, imports);
  } catch (e) {
    rollback();
    throw e;
  }
  // Wire the main-instance ref captured by the dlopen loader closure.
  mainInstanceRef = instance;
  const table = instance.exports.__indirect_function_table;
  if (table instanceof WebAssembly.Table) {
    const promising = typeof WebAssembly.promising === "function"
      ? ((fn: unknown) => WebAssembly.promising(fn as WasmCallable))
      : ((fn: unknown) => fn);
    threadsBackend.setIndirectCallTable(
      makeIndirectCallTable(table, promising),
    );
  }

  const exportedMemory = instance.exports.memory;
  memoryRef = exportedMemory instanceof WebAssembly.Memory
    ? exportedMemory
    : profile.memoryImport
    ? workerSabMemory ?? null
    : null;
  if (!memoryRef) {
    rollback();
    throw new Error("module did not export memory");
  }
  validateYurtThreadMemory(profile, memoryRef);
  if (
    instance.exports.__stack_pointer instanceof WebAssembly.Global &&
    "bindLinearStack" in threadsBackend
  ) {
    (threadsBackend as LinearStackSwitchingThreadsBackend).bindLinearStack(
      memoryRef,
      instance.exports.__stack_pointer,
    );
  }
  if (
    opts.memoryBytes !== undefined &&
    memoryRef.buffer.byteLength > opts.memoryBytes
  ) {
    rollback();
    throw new Error(
      `memory limit exceeded: ${memoryRef.buffer.byteLength} > ${opts.memoryBytes}`,
    );
  }
  proc.__setMemory(memoryRef);
  // Pre-bind WasiHost to the resolved memory. For threaded modules the memory
  // is imported (not exported), so WasiHost.startAsync can't infer it from
  // instance.exports.memory; binding here makes the resolution authoritative.
  wasi.setMemory(memoryRef);
  proc.__setFdReadAndClear(ctx.makeFdReadAndClear(pid));
  proc.__setStdin((data) => {
    ctx.kernel.setFdTarget(
      pid,
      0,
      data && data.byteLength > 0
        ? createStaticTarget(data)
        : createNullTarget(),
    );
  });

  let asyncifyInitialized: boolean;
  try {
    asyncifyInitialized = asyncifyBridge
      ? initAsyncifyBridge(asyncifyBridge, instance)
      : false;
  } catch (e) {
    rollback();
    throw e;
  }
  // Async pipe reads are a suspension capability, not a setjmp feature:
  // JSPI supports them for every module; non-JSPI runtimes need the current
  // module to be Asyncify-instrumented.
  wasi.setCanSuspendPipeReads(
    typeof WebAssembly.Suspending === "function" || asyncifyInitialized,
  );
  bindSignalDeliverer(wasi, instance);
  ctx.kernel.attachWasiHost(pid, wasi);

  const forkChildFromSnapshot = (
    parentPid: number,
    parentWasi: WasiHost,
    snapshot: AsyncifyForkSnapshot,
  ): number => {
    if (!asyncifyBridge || !asyncifyInitialized) return -38; // ENOSYS
    if (memoryRef?.buffer instanceof SharedArrayBuffer) return -11; // EAGAIN
    if (!ctx.kernel.canReserveProcessSlot()) return -11; // EAGAIN

    const childPid = ctx.kernel.allocPid(parentPid, path);
    const childFdTable = ctx.kernel.buildFdTableForFork(parentPid, childPid);
    ctx.kernel.adoptFdTable(childPid, childFdTable);
    const wasiSnapshot = parentWasi.snapshotForFork();

    const childPromise = (async () => {
      const childWasi = ctx.buildWasiHost(childPid, wasiArgv, env, cwd);
      childWasi.restoreForkSnapshot(wasiSnapshot);
      childWasi.bindKernelFileTargets();
      childWasi.setCanSuspendPipeReads(true);

      const childBridge = new AsyncifyAsyncBridge();
      const childThreadsBackend = new CooperativeSerialBackend();
      let childMemoryRef: WebAssembly.Memory | null = null;
      const childMemoryProxy = new Proxy({} as WebAssembly.Memory, {
        get(_target, prop) {
          if (!childMemoryRef) throw new Error("child memory not initialized");
          const val =
            (childMemoryRef as unknown as Record<string | symbol, unknown>)[
              prop
            ];
          return typeof val === "function" ? val.bind(childMemoryRef) : val;
        },
      });
      let childInstanceRef: WebAssembly.Instance | null = null;
      const childYurtImports: Record<string, WebAssembly.ImportValue> = {
        ...ctx.buildKernelImports(
          childPid,
          childMemoryProxy,
          childWasi,
          childThreadsBackend,
          () => childInstanceRef,
          // Child processes (fork+exec) under the cooperative-serial
          // backend export their own memory; no imported-memory
          // accessor needed.
          null,
        ),
        ...(opts.extraYurtImports?.(childMemoryProxy, childWasi) ?? {}),
      };
      childYurtImports.host_setjmp = childBridge
        .hostSetjmp as unknown as WebAssembly.ImportValue;
      childYurtImports.host_longjmp = childBridge
        .hostLongjmp as unknown as WebAssembly.ImportValue;
      childYurtImports.host_fork = childBridge
        .hostFork as unknown as WebAssembly.ImportValue;
      wrapAsyncImports(
        childYurtImports,
        [
          "host_wait",
          "host_poll",
          "host_kill",
          "host_killpg",
          "host_yield",
          "host_chdir",
          "host_chmod",
          "host_chown",
          "host_fchdir",
          "host_fchown",
          "host_getcwd",
          "host_glob",
          "host_mkdir",
          "host_read_file",
          "host_readdir",
          "host_readlink",
          "host_realpath",
          "host_remove",
          "host_rename",
          "host_stat",
          "host_symlink",
          "host_write_file",
          "host_network_fetch",
          "host_register_tool",
          "host_socket_accept",
          "host_socket_recv",
          "host_socket_recvmsg",
          "host_socket_sendmsg",
          "host_socket_socketpair",
          "host_socket_bind_unix",
          "host_socket_connect_unix",
          "host_socket_recvfrom_unix",
          "host_socket_accept_unix",
          "host_socket_recv_unix",
          "host_extension_invoke",
          "host_run_command",
          "host_thread_spawn",
          "host_thread_join",
          "host_thread_detach",
          "host_thread_yield",
          "host_mutex_lock",
          "host_cond_wait",
        ],
        childBridge,
        childThreadsBackend,
      );

      const childWasiImports = childWasi.getImports().wasi_snapshot_preview1;
      wrapAsyncImports(
        childWasiImports as Record<string, WebAssembly.ImportValue>,
        profile.requiresSharedMemory
          ? THREADED_ASYNC_WASI_IMPORTS
          : ASYNC_WASI_IMPORTS,
        childBridge,
        childThreadsBackend,
      );

      const childInstance = await ctx.adapter.instantiate(module, {
        wasi_snapshot_preview1: childWasiImports,
        yurt: childYurtImports,
      });
      // Wire the child's main-instance ref captured by the dlopen loader
      // closure for this child process.
      childInstanceRef = childInstance;
      bindSignalDeliverer(childWasi, childInstance);
      ctx.kernel.attachWasiHost(childPid, childWasi);
      childMemoryRef = childInstance.exports.memory as WebAssembly.Memory;
      if (
        childInstance.exports.__stack_pointer instanceof WebAssembly.Global &&
        "bindLinearStack" in childThreadsBackend
      ) {
        (childThreadsBackend as LinearStackSwitchingThreadsBackend)
          .bindLinearStack(
            childMemoryRef,
            childInstance.exports.__stack_pointer,
          );
      }
      while (
        childMemoryRef.buffer.byteLength < snapshot.memoryBytes.byteLength
      ) {
        childMemoryRef.grow(1);
      }
      new Uint8Array(childMemoryRef.buffer, 0, snapshot.memoryBytes.byteLength)
        .set(snapshot.memoryBytes);

      childBridge.initFromInstance(
        childInstance,
        snapshot.dataAddr,
        snapshot.dataSize,
      );
      childBridge.restoreForkSnapshot(snapshot, 0);
      childBridge.setForkController({
        forkFromContinuation: (childSnapshot) =>
          forkChildFromSnapshot(childPid, childWasi, childSnapshot),
      });

      const table = childInstance.exports.__indirect_function_table;
      if (table instanceof WebAssembly.Table) {
        const promising = typeof WebAssembly.promising === "function"
          ? ((fn: unknown) => WebAssembly.promising(fn as WasmCallable))
          : ((fn: unknown) => fn);
        childThreadsBackend.setIndirectCallTable(
          makeIndirectCallTable(table, promising),
        );
      }

      const childRawStart = childInstance.exports._start as
        | (() => number)
        | undefined;
      const childStartFn = childRawStart
        ? childBridge.wrapExport(childRawStart)
        : undefined;
      childBridge.startForkRewind();
      const exitCode = await childWasi.startAsync(childInstance, childStartFn);
      ctx.releasePid(childPid, exitCode, childWasi.getExitSignal());
    })().catch(() => {
      ctx.releasePid(childPid, 127);
    });
    void childPromise;
    return childPid;
  };

  if (asyncifyBridge && asyncifyInitialized) {
    asyncifyBridge.setForkController({
      forkFromContinuation: (snapshot) =>
        forkChildFromSnapshot(pid, wasi, snapshot),
    });
  }

  const rawStart = instance.exports._start as (() => unknown) | undefined;
  const startFn = rawStart
    ? asyncifyBridge && asyncifyInitialized
      ? asyncifyBridge.wrapExport(rawStart as () => number)
      : !asyncifyBridge && typeof WebAssembly.promising === "function"
      ? WebAssembly.promising(rawStart)
      : rawStart
    : undefined;
  let exitCode: number;
  try {
    exitCode = await wasi.startAsync(instance, startFn);
    threadsBackend.cancelDetachedThreads?.();
  } catch (e) {
    rollback();
    threadsBackend.cancelDetachedThreads?.();
    const stderr = proc.fdReadAndClear(2).data.trimEnd();
    if (stderr) {
      const message = e instanceof Error ? e.message : String(e);
      throw new Error(`${message}\n${stderr}`, { cause: e });
    }
    throw e;
  }
  if (mode === "cli") proc.exitCode = exitCode;

  const wrappedExports: Record<string, (...args: number[]) => unknown> = {};
  for (const [name, raw] of Object.entries(instance.exports)) {
    if (typeof raw !== "function") continue;
    if (
      !asyncifyBridge &&
      typeof WebAssembly.promising === "function" &&
      shouldAsyncWrapExport(name)
    ) {
      wrappedExports[name] = WebAssembly.promising(
        raw as (...args: number[]) => unknown,
      );
    } else if (
      asyncifyBridge && asyncifyInitialized && shouldAsyncifyWrapExport(name)
    ) {
      wrappedExports[name] = asyncifyBridge.wrapExport(
        raw as (...args: number[]) => number,
      );
    } else {
      wrappedExports[name] = raw as (...args: number[]) => unknown;
    }
  }
  proc.__setExports({ exports: wrappedExports });

  proc.__setTerminate(async () => {
    wasi.cancelExecution();
    threadsBackend.cancelDetachedThreads?.();
    ctx.releasePid(pid, proc.exitCode ?? 0, wasi.getExitSignal());
  });

  return proc;
}

function wrapAsyncImports(
  imports: Record<string, WebAssembly.ImportValue>,
  names: readonly string[],
  asyncifyBridge: AsyncifyAsyncBridge | null,
  threadsBackend?: ThreadsBackend,
): void {
  const stackSwitcher =
    threadsBackend && "suspendCurrentLinearStack" in threadsBackend &&
      "restoreLinearStack" in threadsBackend
      ? threadsBackend as LinearStackSwitchingThreadsBackend
      : null;
  for (const name of names) {
    const value = imports[name];
    if (typeof value !== "function") continue;
    const withStackSwitching = (...args: number[]): unknown => {
      const result = (value as (...args: number[]) => unknown)(...args);
      if (!stackSwitcher || !(result instanceof Promise)) return result;
      const tid = stackSwitcher.suspendCurrentLinearStack();
      return result.then((resolved) => {
        stackSwitcher.restoreLinearStack(tid);
        return resolved;
      }, (error) => {
        stackSwitcher.restoreLinearStack(tid);
        throw error;
      });
    };

    if (asyncifyBridge) {
      imports[name] = asyncifyBridge.wrapImport(
        withStackSwitching as (...args: number[]) => Promise<number> | number,
      ) as WebAssembly.ImportValue;
    } else if (typeof WebAssembly.Suspending === "function") {
      imports[name] = new WebAssembly.Suspending(
        withStackSwitching as (...args: number[]) => unknown,
      ) as unknown as WebAssembly.ImportValue;
    }
  }
}

function initAsyncifyBridge(
  bridge: AsyncifyAsyncBridge,
  instance: WebAssembly.Instance,
): boolean {
  const exports = instance.exports;
  const hasAsyncifyState =
    typeof exports.asyncify_start_unwind === "function" &&
    typeof exports.asyncify_stop_unwind === "function" &&
    typeof exports.asyncify_start_rewind === "function" &&
    typeof exports.asyncify_stop_rewind === "function" &&
    typeof exports.asyncify_get_state === "function";
  if (!hasAsyncifyState) return false;

  const addrExport = exports.yurt_asyncify_buf_addr as
    | (() => number)
    | undefined;
  const sizeExport = exports.yurt_asyncify_buf_size as
    | (() => number)
    | undefined;
  const alloc = exports.__alloc as ((size: number) => number) | undefined;

  let dataAddr: number;
  let asyncifyBufSize: number;
  if (typeof addrExport === "function" && typeof sizeExport === "function") {
    dataAddr = addrExport();
    asyncifyBufSize = sizeExport();
  } else if (alloc) {
    asyncifyBufSize = 65536;
    dataAddr = alloc(asyncifyBufSize);
  } else {
    throw new Error(
      "asyncify requires yurt_asyncify_buf_addr/size or __alloc exports",
    );
  }

  const memory = exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);
  view.setUint32(dataAddr, dataAddr + 8, true);
  view.setUint32(dataAddr + 4, dataAddr + asyncifyBufSize, true);
  bridge.initFromInstance(instance, dataAddr, asyncifyBufSize);
  return true;
}

function findMemoryImportLimits(
  bytes: Uint8Array,
  memoryImport: { module: string; name: string },
): { initial: number; maximum?: number } | null {
  let offset = 8;
  while (offset < bytes.length) {
    const sectionId = bytes[offset++];
    const sectionSize = readVarUint32(bytes, offset);
    offset = sectionSize.next;
    const sectionEnd = offset + sectionSize.value;
    if (sectionId !== 2) {
      offset = sectionEnd;
      continue;
    }

    const count = readVarUint32(bytes, offset);
    offset = count.next;
    for (let i = 0; i < count.value; i++) {
      const module = readName(bytes, offset);
      offset = module.next;
      const name = readName(bytes, offset);
      offset = name.next;
      const kind = bytes[offset++];
      if (kind === 2) {
        const flags = readVarUint32(bytes, offset);
        offset = flags.next;
        const initial = readVarUint32(bytes, offset);
        offset = initial.next;
        let maximum: number | undefined;
        if ((flags.value & 0x01) !== 0) {
          const max = readVarUint32(bytes, offset);
          offset = max.next;
          maximum = max.value;
        }
        if (
          module.value === memoryImport.module &&
          name.value === memoryImport.name
        ) {
          return { initial: initial.value, maximum };
        }
        continue;
      }

      if (kind === 0) {
        const typeIndex = readVarUint32(bytes, offset);
        offset = typeIndex.next;
      } else if (kind === 1) {
        const elementType = readVarUint32(bytes, offset);
        offset = elementType.next;
        const limits = readLimits(bytes, offset);
        offset = limits.next;
      } else if (kind === 3) {
        offset++;
      } else {
        return null;
      }
    }
    return null;
  }
  return null;
}

function readLimits(bytes: Uint8Array, offset: number): { next: number } {
  const flags = readVarUint32(bytes, offset);
  offset = flags.next;
  const initial = readVarUint32(bytes, offset);
  offset = initial.next;
  if ((flags.value & 0x01) !== 0) {
    const maximum = readVarUint32(bytes, offset);
    offset = maximum.next;
  }
  return { next: offset };
}

function readName(
  bytes: Uint8Array,
  offset: number,
): { value: string; next: number } {
  const length = readVarUint32(bytes, offset);
  const start = length.next;
  const end = start + length.value;
  return {
    value: new TextDecoder().decode(bytes.subarray(start, end)),
    next: end,
  };
}

function readVarUint32(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  while (true) {
    const byte = bytes[offset++];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: value >>> 0, next: offset };
    shift += 7;
  }
}

function shouldAsyncifyWrapExport(name: string): boolean {
  return shouldAsyncWrapExport(name);
}

function shouldAsyncWrapExport(name: string): boolean {
  return ![
    "__alloc",
    "__dealloc",
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
    "asyncify_get_state",
    "yurt_asyncify_buf_addr",
    "yurt_asyncify_buf_size",
  ].includes(name);
}
