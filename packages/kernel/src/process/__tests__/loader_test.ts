import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
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
import { type LoaderContext, loadProcess } from "../loader.ts";
import { Sandbox } from "../../sandbox.ts";
import type { WasmModuleCache } from "../module-cache.ts";

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

function makeModuleImportingEnvFunctions(names: string[]): WebAssembly.Module {
  const typeSection = wasmSection(1, wasmVec([[0x60, 0x00, 0x00]]));
  const importEntries = names.map((name) => [
    ...encodeU32("env".length),
    ...wasmBytes("env"),
    ...encodeU32(name.length),
    ...wasmBytes(name),
    0x00,
    0x00,
  ]);
  const importSection = wasmSection(2, wasmVec(importEntries));
  const functionSection = wasmSection(3, wasmVec([[0x00]]));
  const memorySection = wasmSection(5, wasmVec([[0x00, 0x01]]));
  const exportSection = wasmSection(
    7,
    wasmVec([
      [
        ...encodeU32("_start".length),
        ...wasmBytes("_start"),
        0x00,
        ...encodeU32(names.length),
      ],
      [
        ...encodeU32("memory".length),
        ...wasmBytes("memory"),
        0x02,
        0x00,
      ],
    ]),
  );

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
      ...typeSection,
      ...importSection,
      ...functionSection,
      ...memorySection,
      ...exportSection,
      ...wasmSection(10, wasmVec([[0x02, 0x00, 0x0b]])),
    ]),
  );
}

function makeThreadedSharedMemoryModule(): WebAssembly.Module {
  const typeSection = wasmSection(1, wasmVec([[0x60, 0x00, 0x00]]));
  const functionSection = wasmSection(3, wasmVec([[0x00]]));
  const memorySection = wasmSection(5, wasmVec([[0x03, 0x01, 0x01]]));
  const exportSection = wasmSection(
    7,
    wasmVec([
      [
        ...encodeU32("memory".length),
        ...wasmBytes("memory"),
        0x02,
        0x00,
      ],
      [
        ...encodeU32("_start".length),
        ...wasmBytes("_start"),
        0x00,
        0x00,
      ],
    ]),
  );
  const codeSection = wasmSection(10, wasmVec([[0x02, 0x00, 0x0b]]));
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
      ...customSection(
        "yurt.features",
        JSON.stringify({ features: ["threads"] }),
      ),
      ...typeSection,
      ...functionSection,
      ...memorySection,
      ...exportSection,
      ...codeSection,
    ]),
  );
}

function makeThreadedImportedSharedMemoryModule(): WebAssembly.Module {
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
      0x01,
      0x01,
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
      ...customSection(
        "yurt.features",
        JSON.stringify({ features: ["threads"] }),
      ),
      ...typeSection,
      ...importSection,
      ...functionSection,
      ...exportSection,
      ...codeSection,
    ]),
  );
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

Deno.test("loadProcess stubs statically linked env sys_socket imports", async () => {
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeModuleImportingEnvFunctions([
      "sys_socket_open",
      "sys_socket_connect",
      "sys_socket_bind",
      "sys_socket_listen",
      "sys_socket_accept",
      "sys_socket_addr",
      "sys_socket_close",
      "sys_socket_recv",
      "sys_socket_send",
      "sys_socket_sendto",
      "sys_socket_sendmsg",
      "sys_socket_recvmsg",
      "sys_socketpair",
    ])),
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
  });

  assertEquals(proc.exitCode, 0);
  await proc.terminate();
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
    moduleCache: fixedModuleCache(makeThreadedSharedMemoryModule()),
  });

  const proc = await loadProcess(ctx, {
    argv: ["/bin/true"],
    mode: "cli",
    workerSabAvailable: true,
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

Deno.test("loadProcess creates shared imported memory and Worker/SAB backend for threaded modules", async () => {
  const ctx = await makeLoaderContext({
    moduleCache: fixedModuleCache(makeThreadedImportedSharedMemoryModule()),
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

Deno.test("loadProcess rejects threaded modules until Worker/SAB backend is wired", async () => {
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
    "module declares yurt.features threads but Worker/SAB threads backend is not wired into the loader yet",
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
