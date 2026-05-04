/**
 * Generic process loader. Instantiates a wasm guest, wires WASI + yurt
 * imports, runs _start, and returns a Process handle.
 */

import { Process, type ProcessMode } from "./handle.js";
import type { PlatformAdapter } from "../platform/adapter.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import type { ProcessKernel } from "./kernel.js";
import { WasiHost } from "../wasi/wasi-host.js";
import { createBufferTarget, createNullTarget, createStaticTarget } from "../wasi/fd-target.js";
import {
  AsyncifyAsyncBridge,
  type AsyncifyForkSnapshot,
} from "../async-bridge.js";
import { CooperativeSerialBackend } from "./threads/cooperative-serial.js";
import { makeIndirectCallTable } from "./threads/indirect-call-table.js";
import type { ThreadsBackend } from "./threads/backend.js";

export interface LoaderContext {
  vfs: VfsLike;
  adapter: PlatformAdapter;
  kernel: ProcessKernel;
  allocatePid(argv: string[]): number;
  releasePid(pid: number, exitCode: number): void;
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
  ): Record<string, WebAssembly.ImportValue>;
  makeFdReadAndClear(
    pid: number,
  ): (fd: 1 | 2) => { data: string; truncated: boolean };
}

export interface LoadProcessOptions {
  argv: string[];
  mode: ProcessMode;
  env?: Record<string, string>;
  cwd?: string;
  memoryBytes?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
  extraYurtImports?: (
    memory: WebAssembly.Memory,
    wasiHost: WasiHost,
  ) => Record<string, WebAssembly.ImportValue>;
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

  const module = await WebAssembly.compile(bytes as BufferSource);
  const importsSetjmp = moduleImportsSetjmp(module);
  const setjmpMarked = moduleHasYurtFeature(module, "setjmp");
  if (importsSetjmp && !setjmpMarked) {
    throw new Error(
      "module imports host_setjmp/host_longjmp but lacks yurt.features setjmp marker; rebuild with yurt-cc YURT_CC_USE_SETJMP=1",
    );
  }
  if (setjmpMarked && !moduleHasAsyncify(module)) {
    throw new Error("module declares yurt.features setjmp but is not asyncify-instrumented");
  }
  const env = opts.env ?? {};
  const cwd = opts.cwd ?? "/";
  const pid = ctx.allocatePid(argv);

  ctx.kernel.initProcess(pid);
  ctx.kernel.setCwd(pid, cwd);
  if (!ctx.kernel.getFdTarget(pid, 0)) {
    ctx.kernel.setFdTarget(pid, 0, createNullTarget());
  }
  if (!ctx.kernel.getFdTarget(pid, 1)) {
    ctx.kernel.setFdTarget(pid, 1, createBufferTarget(opts.stdoutLimit ?? Infinity));
  }
  if (!ctx.kernel.getFdTarget(pid, 2)) {
    ctx.kernel.setFdTarget(pid, 2, createBufferTarget(opts.stderrLimit ?? Infinity));
  }

  const proc = Process.__forLoader({ pid, mode });
  const wasi = ctx.buildWasiHost(pid, argv, env, cwd);
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

  const asyncifyBridge = needsSetjmpBridge(module) ||
      typeof WebAssembly.Suspending !== "function"
    ? new AsyncifyAsyncBridge()
    : null;
  const threadsBackend = new CooperativeSerialBackend();

  const yurtImports: Record<string, WebAssembly.ImportValue> = {
    ...ctx.buildKernelImports(pid, memoryProxy, wasi, threadsBackend),
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
  wrapAsyncImports(yurtImports, [
    "host_waitpid",
    "host_yield",
    "host_network_fetch",
    "host_register_tool",
    "host_socket_accept",
    "host_extension_invoke",
    "host_run_command",
    "host_thread_spawn",
    "host_thread_join",
    "host_thread_detach",
    "host_thread_yield",
    "host_mutex_lock",
    "host_cond_wait",
  ], asyncifyBridge);
  wrapAsyncImports(
    wasiImports as Record<string, WebAssembly.ImportValue>,
    ["fd_read", "fd_write", "poll_oneoff"],
    asyncifyBridge,
  );

  const instance = await ctx.adapter.instantiate(module, {
    wasi_snapshot_preview1: wasiImports,
    yurt: yurtImports,
  });
  const table = instance.exports.__indirect_function_table;
  if (table instanceof WebAssembly.Table) {
    const promising =
      typeof WebAssembly.promising === "function"
        ? ((fn: unknown) => WebAssembly.promising(fn as Function))
        : ((fn: unknown) => fn);
    threadsBackend.setIndirectCallTable(
      makeIndirectCallTable(table, promising),
    );
  }

  memoryRef = instance.exports.memory as WebAssembly.Memory;
  if (opts.memoryBytes !== undefined && memoryRef.buffer.byteLength > opts.memoryBytes) {
    throw new Error(`memory limit exceeded: ${memoryRef.buffer.byteLength} > ${opts.memoryBytes}`);
  }
  proc.__setMemory(memoryRef);
  proc.__setFdReadAndClear(ctx.makeFdReadAndClear(pid));
  proc.__setStdin((data) => {
    ctx.kernel.setFdTarget(
      pid,
      0,
      data && data.byteLength > 0 ? createStaticTarget(data) : createNullTarget(),
    );
  });

  const asyncifyInitialized = asyncifyBridge
    ? initAsyncifyBridge(asyncifyBridge, instance)
    : false;
  // Async pipe reads are a suspension capability, not a setjmp feature:
  // JSPI supports them for every module; non-JSPI runtimes need the current
  // module to be Asyncify-instrumented.
  wasi.setCanSuspendPipeReads(
    typeof WebAssembly.Suspending === "function" || asyncifyInitialized,
  );

  const forkChildFromSnapshot = (
    parentPid: number,
    parentWasi: WasiHost,
    snapshot: AsyncifyForkSnapshot,
  ): number => {
    if (!asyncifyBridge || !asyncifyInitialized) return -38; // ENOSYS
    if (memoryRef?.buffer instanceof SharedArrayBuffer) return -11; // EAGAIN

    const childPid = ctx.kernel.allocPid(parentPid, path);
    const childFdTable = ctx.kernel.buildFdTableForFork(parentPid);
    ctx.kernel.adoptFdTable(childPid, childFdTable);
    const wasiSnapshot = parentWasi.snapshotForFork();

    const childPromise = (async () => {
      const childWasi = ctx.buildWasiHost(childPid, argv, env, cwd);
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
            (childMemoryRef as unknown as Record<string | symbol, unknown>)[prop];
          return typeof val === "function" ? val.bind(childMemoryRef) : val;
        },
      });
      const childYurtImports: Record<string, WebAssembly.ImportValue> = {
        ...ctx.buildKernelImports(childPid, childMemoryProxy, childWasi, childThreadsBackend),
        ...(opts.extraYurtImports?.(childMemoryProxy, childWasi) ?? {}),
      };
      childYurtImports.host_setjmp = childBridge
        .hostSetjmp as unknown as WebAssembly.ImportValue;
      childYurtImports.host_longjmp = childBridge
        .hostLongjmp as unknown as WebAssembly.ImportValue;
      childYurtImports.host_fork = childBridge
        .hostFork as unknown as WebAssembly.ImportValue;
      wrapAsyncImports(childYurtImports, [
        "host_waitpid",
        "host_yield",
        "host_network_fetch",
        "host_register_tool",
        "host_socket_accept",
        "host_extension_invoke",
        "host_run_command",
        "host_thread_spawn",
        "host_thread_join",
        "host_thread_detach",
        "host_thread_yield",
        "host_mutex_lock",
        "host_cond_wait",
      ], childBridge);

      const childWasiImports = childWasi.getImports().wasi_snapshot_preview1;
      wrapAsyncImports(
        childWasiImports as Record<string, WebAssembly.ImportValue>,
        ["fd_read", "fd_write", "poll_oneoff"],
        childBridge,
      );

      const childInstance = await ctx.adapter.instantiate(module, {
        wasi_snapshot_preview1: childWasiImports,
        yurt: childYurtImports,
      });
      childMemoryRef = childInstance.exports.memory as WebAssembly.Memory;
      while (childMemoryRef.buffer.byteLength < snapshot.memoryBytes.byteLength) {
        childMemoryRef.grow(1);
      }
      new Uint8Array(childMemoryRef.buffer, 0, snapshot.memoryBytes.byteLength)
        .set(snapshot.memoryBytes);

      childBridge.initFromInstance(childInstance, snapshot.dataAddr, snapshot.dataSize);
      childBridge.restoreForkSnapshot(snapshot, 0);
      childBridge.setForkController({
        forkFromContinuation: (childSnapshot) =>
          forkChildFromSnapshot(childPid, childWasi, childSnapshot),
      });

      const table = childInstance.exports.__indirect_function_table;
      if (table instanceof WebAssembly.Table) {
        const promising =
          typeof WebAssembly.promising === "function"
            ? ((fn: unknown) => WebAssembly.promising(fn as Function))
            : ((fn: unknown) => fn);
        childThreadsBackend.setIndirectCallTable(
          makeIndirectCallTable(table, promising),
        );
      }

      const childRawStart = childInstance.exports._start as (() => number) | undefined;
      const childStartFn = childRawStart
        ? childBridge.wrapExport(childRawStart)
        : undefined;
      childBridge.startForkRewind();
      const exitCode = await childWasi.startAsync(childInstance, childStartFn);
      ctx.releasePid(childPid, exitCode);
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
  } catch (e) {
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
    ctx.releasePid(pid, proc.exitCode ?? 0);
  });

  return proc;
}

function wrapAsyncImports(
  imports: Record<string, WebAssembly.ImportValue>,
  names: string[],
  asyncifyBridge: AsyncifyAsyncBridge | null,
): void {
  for (const name of names) {
    const value = imports[name];
    if (typeof value !== "function") continue;

    if (asyncifyBridge) {
      imports[name] = asyncifyBridge.wrapImport(
        value as (...args: number[]) => Promise<number> | number,
      ) as WebAssembly.ImportValue;
    } else if (typeof WebAssembly.Suspending === "function") {
      imports[name] = new WebAssembly.Suspending(
        value as (...args: number[]) => unknown,
      ) as unknown as WebAssembly.ImportValue;
    }
  }
}

function needsSetjmpBridge(module: WebAssembly.Module): boolean {
  if (!moduleHasYurtFeature(module, "setjmp")) return false;
  return moduleHasAsyncify(module);
}

function moduleHasAsyncify(module: WebAssembly.Module): boolean {
  const exports = WebAssembly.Module.exports(module);
  return [
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
    "asyncify_get_state",
  ].every((name) =>
    exports.some((exp: WebAssembly.ModuleExportDescriptor) =>
      exp.kind === "function" && exp.name === name
    )
  );
}

function moduleImportsSetjmp(module: WebAssembly.Module): boolean {
  return WebAssembly.Module.imports(module).some((imp) =>
    imp.module === "yurt" &&
    (imp.name === "host_setjmp" ||
      imp.name === "host_longjmp" ||
      imp.name === "host_fork")
  );
}

function moduleHasYurtFeature(module: WebAssembly.Module, feature: string): boolean {
  for (const section of WebAssembly.Module.customSections(module, "yurt.features")) {
    try {
      const decoded = JSON.parse(new TextDecoder().decode(section)) as {
        features?: unknown;
      };
      if (Array.isArray(decoded.features) && decoded.features.includes(feature)) {
        return true;
      }
    } catch {
      // Malformed custom sections are ignored here; required-feature checks
      // still fail closed when the marker is absent.
    }
  }
  return false;
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

  const addrExport = exports.yurt_asyncify_buf_addr as (() => number) | undefined;
  const sizeExport = exports.yurt_asyncify_buf_size as (() => number) | undefined;
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
    throw new Error("asyncify requires yurt_asyncify_buf_addr/size or __alloc exports");
  }

  const memory = exports.memory as WebAssembly.Memory;
  const view = new DataView(memory.buffer);
  view.setUint32(dataAddr, dataAddr + 8, true);
  view.setUint32(dataAddr + 4, dataAddr + asyncifyBufSize, true);
  bridge.initFromInstance(instance, dataAddr, asyncifyBufSize);
  return true;
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
