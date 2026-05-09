import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";
import { ExtensionRegistry } from "../extension/registry.ts";
import { ProcessKernel } from "../process/kernel.ts";
import { CooperativeSerialBackend } from "../process/threads/cooperative-serial.ts";
import { VFS } from "../vfs/vfs.ts";
import { buildNativeSpawnRequest } from "../host-imports/__tests__/spawn-request-fixture.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);

Deno.test("sandbox.spawn returns a Process with the requested mode", async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter });
  try {
    sb.writeFile(
      "/tmp/true.wasm",
      await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`),
    );
    const child = await sb.spawn(["/tmp/true.wasm"], { mode: "resident" });
    assertEquals(child.mode, "resident");
    assert(
      child.pid > 1,
      "spawned child should have pid > 1 (PID 1 is the boot process)",
    );
    await child.terminate();
  } finally {
    sb.destroy();
  }
});

Deno.test("sandbox.spawn with mode: cli runs _start to completion", async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter });
  try {
    sb.writeFile(
      "/tmp/true.wasm",
      await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`),
    );
    const child = await sb.spawn(["/tmp/true.wasm"], { mode: "cli" });
    assertEquals(child.mode, "cli");
    assertEquals(child.exitCode, 0);
  } finally {
    sb.destroy();
  }
});

Deno.test("sandbox.spawn with mode: cli preserves captured stdout", async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({ wasmDir: WASM_DIR, adapter });
  try {
    sb.writeFile(
      "/tmp/echo-args.wasm",
      await adapter.readBytes(`${WASM_DIR}/echo-args.wasm`),
    );
    const child = await sb.spawn(["/tmp/echo-args.wasm", "hello", "world"], {
      mode: "cli",
    });
    assertEquals(child.exitCode, 0);
    assertEquals(child.fdReadAndClear(1).data, "hello\nworld\n");
  } finally {
    sb.destroy();
  }
});

Deno.test("sandbox.spawn with mode: cli releases process slot after exit", async () => {
  const adapter = new NodeAdapter();
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter,
    security: { limits: { processes: 2 } },
  });
  try {
    sb.writeFile(
      "/tmp/true.wasm",
      await adapter.readBytes(`${WASM_DIR}/true-cmd.wasm`),
    );

    const first = await sb.spawn(["/tmp/true.wasm"], { mode: "cli" });
    assertEquals(first.exitCode, 0);

    const second = await sb.spawn(["/tmp/true.wasm"], { mode: "cli" });
    assertEquals(second.exitCode, 0);
  } finally {
    sb.destroy();
  }
});

Deno.test("host_spawn rolls back pid reservation when executable validation fails", () => {
  const adapter = new NodeAdapter();
  const vfs = new VFS();
  const kernel = new ProcessKernel({ maxProcesses: 2 });
  const processes = new Map();
  const parentPid = kernel.allocPid(1, "/bin/parent");
  const loaderCtx = (
    Sandbox as unknown as {
      createLoaderContext(opts: Record<string, unknown>): {
        buildWasiHost(
          pid: number,
          argv: string[],
          env: Record<string, string>,
          cwd: string,
        ): unknown;
        buildKernelImports(
          pid: number,
          memory: WebAssembly.Memory,
          wasiHost: unknown,
          threadsBackend: CooperativeSerialBackend,
        ): Record<string, (...args: number[]) => unknown>;
      };
    }
  ).createLoaderContext({
    vfs,
    adapter,
    kernel,
    mgr: { nativeModules: undefined },
    processes,
    extensionRegistry: new ExtensionRegistry(),
    getSandbox: () => undefined,
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  const wasiHost = loaderCtx.buildWasiHost(parentPid, ["/bin/parent"], {}, "/");
  const imports = loaderCtx.buildKernelImports(
    parentPid,
    memory,
    wasiHost,
    new CooperativeSerialBackend(),
  );
  const encoded = buildNativeSpawnRequest({
    prog: "/missing",
    cwd: "/",
    stdin_fd: 0,
    stdout_fd: 1,
    stderr_fd: 2,
  });
  new Uint8Array(memory.buffer, 0, encoded.byteLength).set(encoded);

  assertEquals(imports.host_spawn(0, encoded.byteLength), -1);

  assertEquals(kernel.getReservedProcessCount(), 1);
  assertEquals(kernel.hasProcess(parentPid), true);
  assertEquals(kernel.hasProcess(parentPid + 1), false);
  kernel.dispose();
});
