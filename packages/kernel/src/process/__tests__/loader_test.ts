import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { createKernelImports } from "../../host-imports/kernel-imports.ts";
import type { PlatformAdapter } from "../../platform/adapter.ts";
import { NodeAdapter } from "../../platform/node-adapter.ts";
import { VFS } from "../../vfs/vfs.ts";
import {
  bufferToString,
  createBufferTarget,
  createNullTarget,
  type FdTarget,
} from "../../wasi/fd-target.ts";
import { WasiHost } from "../../wasi/wasi-host.ts";
import { INIT_PID, ProcessKernel } from "../kernel.ts";
import {
  type LoaderContext,
  loadProcess,
  resolveWorkerSabMemory,
  resolveWorkerSabThreads,
} from "../loader.ts";
import { Sandbox } from "../../sandbox.ts";
import type { WasmModuleCache } from "../module-cache.ts";
import type { YurtModuleProfile } from "../module-profile.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../../platform/__tests__/fixtures",
);

async function makeLoaderContext(
  options: Partial<LoaderContext> & { maxProcesses?: number } = {},
): Promise<LoaderContext> {
  const vfs = new VFS();
  const adapter = new NodeAdapter();
  const kernel = new ProcessKernel({ maxProcesses: options.maxProcesses });
  const bytes = await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`);

  vfs.withWriteAccess(() => {
    vfs.mkdirp("/bin");
    vfs.writeFile("/bin/true", bytes);
    vfs.chmod("/bin/true", 0o755);
  });

  return {
    vfs,
    adapter,
    kernel,
    allocatePid: (argv: string[]) => kernel.allocPid(INIT_PID, argv[0]),
    releasePid: (pid: number, exitCode: number) =>
      kernel.releaseProcess(pid, exitCode),
    buildWasiHost: (
      pid: number,
      argv: string[],
      env: Record<string, string>,
      cwd: string,
    ) => {
      assertEquals(cwd, "/");
      const ioFds = new Map<number, FdTarget>();
      ioFds.set(0, kernel.getFdTarget(pid, 0)!);
      ioFds.set(1, kernel.getFdTarget(pid, 1)!);
      ioFds.set(2, kernel.getFdTarget(pid, 2)!);
      return new WasiHost({
        vfs,
        args: argv,
        env,
        preopens: { "/": "/" },
        ioFds,
        pid,
      });
    },
    buildKernelImports: (
      pid: number,
      memory: WebAssembly.Memory,
      wasiHost: WasiHost,
    ) =>
      createKernelImports({
        memory,
        callerPid: pid,
        kernel,
        wasiHost,
      }),
    makeFdReadAndClear: (pid: number) => (fd: 1 | 2) => {
      const target = kernel.getFdTarget(pid, fd);
      if (!target || target.type !== "buffer") {
        return { data: "", truncated: false };
      }
      const data = bufferToString(target);
      const truncated = !!target.truncated;
      target.buf.length = 0;
      target.total = 0;
      target.truncated = false;
      return { data, truncated };
    },
    ...options,
  };
}

function throwingInstantiateAdapter(base: PlatformAdapter): PlatformAdapter {
  return {
    ...base,
    instantiate: () => {
      throw new Error("instantiate failed");
    },
  };
}

function encodeU32(value: number): number[] {
  const out: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    out.push(byte);
  } while (value !== 0);
  return out;
}

function wasmBytes(value: string): number[] {
  return [...new TextEncoder().encode(value)];
}

function wasmSection(id: number, payload: number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function customSection(name: string, payload: string): number[] {
  const body = [
    ...encodeU32(name.length),
    ...wasmBytes(name),
    ...wasmBytes(payload),
  ];
  return wasmSection(0, body);
}

function wasmVec(items: number[][]): number[] {
  return [...encodeU32(items.length), ...items.flat()];
}

function makeModuleWithFeatures(features: string[]): WebAssembly.Module {
  return new WebAssembly.Module(
    new Uint8Array([
      0x00,
      0x61,
      0x73,
      0x6d,
      0x01,
      0x00,
      0x00,
      0x00,
      ...customSection("yurt.features", JSON.stringify({ features })),
    ]),
  );
}

function makeThreadedImportedSharedMemoryModule(
  initialPages = 1,
  maximumPages = 1,
): WebAssembly.Module {
  return new WebAssembly.Module(
    makeThreadedImportedSharedMemoryBytes(initialPages, maximumPages),
  );
}

function makeThreadedImportedSharedMemoryBytes(
  initialPages = 1,
  maximumPages = 1,
): Uint8Array<ArrayBuffer> {
  const typeSection = wasmSection(1, wasmVec([[0x60, 0x00, 0x00]]));
  const importSection = wasmSection(
    2,
    wasmVec([[
      ...encodeU32("env".length),
      ...wasmBytes("env"),
      ...encodeU32("memory".length),
      ...wasmBytes("memory"),
      0x02,
      0x03,
      ...encodeU32(initialPages),
      ...encodeU32(maximumPages),
    ]]),
  );
  const functionSection = wasmSection(3, wasmVec([[0x00]]));
  const exportSection = wasmSection(
    7,
    wasmVec([[
      ...encodeU32("_start".length),
      ...wasmBytes("_start"),
      0x00,
      0x00,
    ]]),
  );
  const codeSection = wasmSection(10, wasmVec([[0x02, 0x00, 0x0b]]));
  const bytes = new Uint8Array([
    0x00,
    0x61,
    0x73,
    0x6d,
    0x01,
    0x00,
    0x00,
    0x00,
    ...customSection(
      "yurt.features",
      JSON.stringify({ features: ["threads"] }),
    ),
    ...typeSection,
    ...importSection,
    ...functionSection,
    ...exportSection,
    ...codeSection,
  ]);
  return bytes as Uint8Array<ArrayBuffer>;
}

function fixedModuleCache(module: WebAssembly.Module): WasmModuleCache {
  return {
    getOrCompile: () => Promise.resolve(module),
    stats: () => ({ modules: 1 }),
  };
}

Deno.test("loadProcess instantiates a CLI wasm at a VFS path and returns a Process", async () => {
  const ctx = await makeLoaderContext();
  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
  });

  assertEquals(proc.mode, "cli");
  assert(proc.pid > 0);
  assertEquals(proc.exitCode, 0);

  await proc.terminate();
  assertEquals(await ctx.kernel.waitpid(proc.pid), 0);
});

Deno.test("loadProcess rolls back pid and fd state when instantiation fails", async () => {
  const ctx = await makeLoaderContext({ maxProcesses: 1 });
  const adapter = throwingInstantiateAdapter(ctx.adapter);

  await assertRejects(
    () =>
      loadProcess({ ...ctx, adapter }, {
        argv: ["/bin/true"],
        mode: "cli",
      }),
    Error,
    "instantiate failed",
  );

  assertEquals(ctx.kernel.getReservedProcessCount(), 0);
  assertEquals(ctx.kernel.canReserveProcessSlot(), true);
  assertEquals(ctx.kernel.getFdTarget(2, 0), null);
});

Deno.test("loadProcess rejects threaded modules when Worker/SAB is unavailable", async () => {
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeModuleWithFeatures(["threads"])),
  });

  await assertRejects(
    () =>
      loadProcess(ctx, {
        argv: ["/bin/true"],
        mode: "cli",
        workerSabAvailable: false,
      }),
    Error,
    "module declares yurt.features threads but host lacks Worker/SAB threads support",
  );

  assertEquals(ctx.kernel.getReservedProcessCount(), 0);
});

Deno.test("loadProcess accepts threaded modules when Worker/SAB spawner is wired", async () => {
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeThreadedImportedSharedMemoryModule()),
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
    workerSabAvailable: true,
    workerSabMemory: new WebAssembly.Memory({
      initial: 1,
      maximum: 1,
      shared: true,
    }),
    workerSabThreads: {
      spawnThread: () => Promise.resolve(0),
    },
  });

  assertEquals(proc.exitCode, 0);
  assertEquals(proc.memory?.buffer instanceof SharedArrayBuffer, true);
  await proc.terminate();
});

Deno.test("loadProcess wires imported shared memory for threaded modules", async () => {
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeThreadedImportedSharedMemoryModule()),
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
    workerSabAvailable: true,
    workerSabMemory: memory,
    workerSabThreads: {
      spawnThread: () => Promise.resolve(0),
    },
  });

  assertEquals(proc.memory, memory);
  await proc.terminate();
});

Deno.test("loadProcess rejects threaded modules without a memory import or caller-provided spawner", async () => {
  // Module has no env.memory import, so the loader cannot auto-allocate SAB
  // memory or default-construct the WorkerSabThreadsBackend. The caller must
  // supply both `workerSabMemory` and `workerSabThreads`, or rely on a module
  // that imports its memory.
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeModuleWithFeatures(["threads"])),
  });

  await assertRejects(
    () =>
      loadProcess(ctx, {
        argv: ["/bin/true"],
        mode: "cli",
        workerSabAvailable: true,
      }),
    Error,
    "Worker/SAB threads backend is not wired into the loader yet",
  );

  assertEquals(ctx.kernel.getReservedProcessCount(), 0);
});

Deno.test("loadProcess can preserve pre-registered child state when caller owns rollback", async () => {
  const ctx = await makeLoaderContext();
  const parentPid = ctx.kernel.allocPid(INIT_PID, "parent");
  const childPid = ctx.kernel.allocPid(parentPid, "/bin/true");
  const stderrTarget = createBufferTarget(Infinity);
  ctx.kernel.registerPending(childPid, "/bin/true", parentPid);
  ctx.kernel.adoptFdTable(
    childPid,
    new Map<number, FdTarget>([
      [0, createNullTarget()],
      [1, createBufferTarget(Infinity)],
      [2, stderrTarget],
    ]),
  );
  const adapter = throwingInstantiateAdapter(ctx.adapter);

  await assertRejects(
    () =>
      loadProcess({
        ...ctx,
        adapter,
        allocatePid: () => childPid,
      }, {
        argv: ["/bin/true"],
        mode: "cli",
        rollbackOnFailure: false,
      }),
    Error,
    "instantiate failed",
  );

  assertEquals(ctx.kernel.getReservedProcessCount(), 2);
  assertEquals(ctx.kernel.getFdTarget(childPid, 2), stderrTarget);
  ctx.kernel.releaseProcess(childPid, 127);
  assertEquals(await ctx.kernel.waitpid(childPid, parentPid), 127);
  ctx.kernel.discardProcess(parentPid);
});

Deno.test("loader-backed resident shell supports Asyncify fallback without JSPI", async () => {
  const originalSuspending = WebAssembly.Suspending;
  const originalPromising = WebAssembly.promising;
  Object.defineProperty(WebAssembly, "Suspending", {
    value: undefined,
    configurable: true,
  });
  Object.defineProperty(WebAssembly, "promising", {
    value: undefined,
    configurable: true,
  });

  let sandbox: Sandbox | undefined;
  try {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR });
    // Test pipe: echo (builtin) → cat (registered tool)
    const result = await sandbox.run("echo hello | cat");
    assertEquals(result.exitCode, 0);
    assertEquals(result.stdout, "hello\n");

    // Test file write + read via pipe
    const fileResult = await sandbox.run(
      "echo file-data > /tmp/asyncify-loader.txt; cat < /tmp/asyncify-loader.txt",
    );
    assertEquals(fileResult.exitCode, 0);
    assertEquals(fileResult.stdout, "file-data\n");

    // Test multi-stage pipe using builtins only
    const multiStageResult = await sandbox.run(
      "printf '1\\n2\\n3\\n4\\n5\\n' | { count=0; while IFS= read -r line; do count=$((count+1)); done; echo $count; }",
    );
    assertEquals(multiStageResult.exitCode, 0);
    assertEquals(multiStageResult.stdout.trim(), "5");
  } finally {
    sandbox?.destroy();
    Object.defineProperty(WebAssembly, "Suspending", {
      value: originalSuspending,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, "promising", {
      value: originalPromising,
      configurable: true,
    });
  }
});

Deno.test("loadProcess keeps JSPI WASI wrapping to imports proven safe", async () => {
  const ctx = await makeLoaderContext();
  const originalSuspending = WebAssembly.Suspending;
  const originalPromising = WebAssembly.promising;
  type ImportFunction = (...args: unknown[]) => unknown;
  const wrapped = new WeakSet<ImportFunction>();
  class FakeSuspending {
    constructor(fn: ImportFunction) {
      wrapped.add(fn);
      return fn;
    }
  }
  Object.defineProperty(WebAssembly, "Suspending", {
    value: FakeSuspending,
    configurable: true,
  });
  Object.defineProperty(WebAssembly, "promising", {
    value: undefined,
    configurable: true,
  });

  let wasiImports:
    | Record<string, WebAssembly.ImportValue>
    | undefined;
  const adapter: PlatformAdapter = {
    ...ctx.adapter,
    instantiate: (_module, imports) => {
      wasiImports = imports.wasi_snapshot_preview1 as Record<
        string,
        WebAssembly.ImportValue
      >;
      return Promise.resolve({
        exports: {
          memory: new WebAssembly.Memory({ initial: 1 }),
          _start: () => {},
        },
      } as WebAssembly.Instance);
    },
  };

  try {
    await loadProcess({ ...ctx, adapter }, {
      argv: ["/bin/true"],
      mode: "cli",
    });
  } finally {
    Object.defineProperty(WebAssembly, "Suspending", {
      value: originalSuspending,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, "promising", {
      value: originalPromising,
      configurable: true,
    });
  }

  assert(wasiImports);
  for (
    const name of [
      "fd_read",
      "fd_write",
      "poll_oneoff",
    ]
  ) {
    assertEquals(
      wrapped.has(wasiImports[name] as ImportFunction),
      true,
      `${name} should be wrapped for JSPI suspension`,
    );
  }
  for (
    const name of [
      "fd_filestat_get",
      "fd_readdir",
      "path_create_directory",
      "path_filestat_get",
      "path_filestat_set_times",
      "path_link",
      "path_open",
      "path_readlink",
      "path_remove_directory",
      "path_rename",
      "path_symlink",
      "path_unlink_file",
    ]
  ) {
    assertEquals(
      wrapped.has(wasiImports[name] as ImportFunction),
      false,
      `${name} should stay sync under JSPI until path imports are JSPI-safe`,
    );
  }
});

Deno.test("loadProcess wraps threaded JSPI WASI path imports", async () => {
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeThreadedImportedSharedMemoryModule()),
  });
  const originalSuspending = WebAssembly.Suspending;
  const originalPromising = WebAssembly.promising;
  type ImportFunction = (...args: unknown[]) => unknown;
  const wrapped = new WeakSet<ImportFunction>();
  class FakeSuspending {
    constructor(fn: ImportFunction) {
      wrapped.add(fn);
      return fn;
    }
  }
  Object.defineProperty(WebAssembly, "Suspending", {
    value: FakeSuspending,
    configurable: true,
  });
  Object.defineProperty(WebAssembly, "promising", {
    value: undefined,
    configurable: true,
  });

  let wasiImports:
    | Record<string, WebAssembly.ImportValue>
    | undefined;
  let yurtImports:
    | Record<string, WebAssembly.ImportValue>
    | undefined;
  const adapter: PlatformAdapter = {
    ...ctx.adapter,
    instantiate: (_module, imports) => {
      wasiImports = imports.wasi_snapshot_preview1 as Record<
        string,
        WebAssembly.ImportValue
      >;
      yurtImports = imports.yurt as Record<
        string,
        WebAssembly.ImportValue
      >;
      return Promise.resolve({
        exports: {
          memory: new WebAssembly.Memory({
            initial: 1,
            maximum: 1,
            shared: true,
          }),
          _start: () => {},
        },
      } as WebAssembly.Instance);
    },
  };

  try {
    await loadProcess({ ...ctx, adapter }, {
      argv: ["/bin/true"],
      mode: "cli",
      workerSabAvailable: true,
      workerSabMemory: new WebAssembly.Memory({
        initial: 1,
        maximum: 1,
        shared: true,
      }),
      workerSabThreads: {
        spawnThread: () => Promise.resolve(0),
      },
    });
  } finally {
    Object.defineProperty(WebAssembly, "Suspending", {
      value: originalSuspending,
      configurable: true,
    });
    Object.defineProperty(WebAssembly, "promising", {
      value: originalPromising,
      configurable: true,
    });
  }

  assert(wasiImports);
  for (
    const name of [
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
    ]
  ) {
    assertEquals(
      wrapped.has(wasiImports[name] as ImportFunction),
      true,
      `${name} should be wrapped for threaded JSPI suspension`,
    );
  }

  assert(yurtImports);
  for (
    const name of [
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
    ]
  ) {
    assertEquals(
      wrapped.has(yurtImports[name] as ImportFunction),
      true,
      `${name} should be wrapped for threaded JSPI suspension`,
    );
  }
});

function nonThreadedProfile(): YurtModuleProfile {
  return {
    importsSetjmp: false,
    importsFork: false,
    hasAsyncify: false,
    hasSetjmpFeature: false,
    hasContinuationsFeature: false,
    hasThreadsFeature: false,
    requiresAsyncify: false,
    requiresSharedMemory: false,
    bridge: "jspi",
    threadsBackend: "cooperative-serial",
    memoryImport: null,
  };
}

function threadedImportedMemoryProfile(): YurtModuleProfile {
  return {
    importsSetjmp: false,
    importsFork: false,
    hasAsyncify: false,
    hasSetjmpFeature: false,
    hasContinuationsFeature: false,
    hasThreadsFeature: true,
    requiresAsyncify: false,
    requiresSharedMemory: true,
    bridge: "jspi",
    threadsBackend: "worker-sab",
    memoryImport: { module: "env", name: "memory" },
  };
}

Deno.test("resolveWorkerSabMemory: returns provided memory for non-threaded profile", () => {
  assertEquals(
    resolveWorkerSabMemory(nonThreadedProfile(), undefined),
    undefined,
  );
  const provided = new WebAssembly.Memory({ initial: 1 });
  assertEquals(
    resolveWorkerSabMemory(nonThreadedProfile(), provided),
    provided,
  );
});

Deno.test("resolveWorkerSabMemory: allocates SAB memory when threaded module imports memory and caller did not", () => {
  const memory = resolveWorkerSabMemory(
    threadedImportedMemoryProfile(),
    undefined,
  );
  assert(memory, "expected a memory to be allocated");
  assertEquals(memory.buffer instanceof SharedArrayBuffer, true);
});

Deno.test("resolveWorkerSabMemory: passes caller-provided shared memory through", () => {
  const provided = new WebAssembly.Memory({
    initial: 1,
    maximum: 16,
    shared: true,
  });
  assertEquals(
    resolveWorkerSabMemory(threadedImportedMemoryProfile(), provided),
    provided,
  );
});

Deno.test("resolveWorkerSabMemory: rejects non-shared caller-provided memory for a threaded module", () => {
  const provided = new WebAssembly.Memory({ initial: 1 });
  assertThrows(
    () => resolveWorkerSabMemory(threadedImportedMemoryProfile(), provided),
    Error,
    "shared memory",
  );
});

Deno.test("resolveWorkerSabThreads: returns undefined for non-threaded profile when no caller-provided", () => {
  const module = makeModuleWithFeatures([]);
  assertEquals(
    resolveWorkerSabThreads(nonThreadedProfile(), module, undefined, undefined),
    undefined,
  );
});

Deno.test("resolveWorkerSabThreads: passes caller-provided options through", () => {
  const module = makeModuleWithFeatures([]);
  const provided = { spawnThread: () => Promise.resolve(0) };
  assertEquals(
    resolveWorkerSabThreads(nonThreadedProfile(), module, undefined, provided),
    provided,
  );
});

Deno.test("resolveWorkerSabThreads: default-constructs spawnThread for threaded module + SAB memory", () => {
  const module = makeThreadedImportedSharedMemoryModule();
  const memory = new WebAssembly.Memory({
    initial: 1,
    maximum: 1,
    shared: true,
  });
  const resolved = resolveWorkerSabThreads(
    threadedImportedMemoryProfile(),
    module,
    memory,
    undefined,
  );
  assert(resolved, "expected a default WorkerSabThreadsBackendOptions");
  assertEquals(typeof resolved.spawnThread, "function");
});

Deno.test("resolveWorkerSabThreads: returns undefined when memory is missing for threaded profile", () => {
  const module = makeModuleWithFeatures(["threads"]);
  assertEquals(
    resolveWorkerSabThreads(
      threadedImportedMemoryProfile(),
      module,
      undefined,
      undefined,
    ),
    undefined,
  );
});

Deno.test("loadProcess auto-allocates SAB memory + spawner for a threaded module importing env.memory", async () => {
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(
      makeThreadedImportedSharedMemoryModule(16, 16384),
    ),
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
    workerSabAvailable: true,
  });

  assertEquals(proc.exitCode, 0);
  assertEquals(proc.memory?.buffer instanceof SharedArrayBuffer, true);
  await proc.terminate();
});

Deno.test("loadProcess auto-allocates SAB memory compatible with imported memory limits", async () => {
  const bytes = makeThreadedImportedSharedMemoryBytes(1, 1);
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(new WebAssembly.Module(bytes)),
  });
  ctx.vfs.withWriteAccess(() => {
    ctx.vfs.writeFile("/bin/true", bytes);
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
    workerSabAvailable: true,
  });

  assertEquals(proc.exitCode, 0);
  assertEquals(proc.memory?.buffer instanceof SharedArrayBuffer, true);
  await proc.terminate();
});
