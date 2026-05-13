import { assert, assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";
import type { KernelApi } from "../kernel-api.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const BOOT_RUNNER = "/bin/yurt-shell-exec";

Deno.test("bootImports receives the kernel API and merges userland imports", async () => {
  let apiSeen: KernelApi | undefined;
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: [BOOT_RUNNER],
    bootImports: (api) => {
      apiSeen = api;
      return {
        host_userland_canary: () => 0xC0DE,
      };
    },
  });
  try {
    assert(apiSeen, "bootImports should be invoked");
    assert(typeof apiSeen.vfs.readFile === "function");
    assert(typeof apiSeen.processManager.registerTool === "function");
    assert(typeof apiSeen.time.now === "function");
    assert(typeof apiSeen.memory.readString === "function");
    assert(sb.process(2));
  } finally {
    sb.destroy();
  }
});

Deno.test("KernelApi.memory throws if used during bootImports construction", async () => {
  await assertRejects(
    () =>
      Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        bootArgv: [BOOT_RUNNER],
        bootImports: (api) => {
          api.memory.readString(0, 0);
          return {};
        },
      }),
    Error,
    "memory not initialized",
  );
});

Deno.test("KernelApi.memory can be captured for import-handler use after instantiate", async () => {
  let handlerCalled = false;
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: [BOOT_RUNNER],
    bootImports: (api) => ({
      host_userland_inspect: (ptr: number, len: number) => {
        api.memory.readString(ptr, len);
        handlerCalled = true;
        return 0;
      },
    }),
  });
  try {
    assert(sb.process(2));
    assertEquals(handlerCalled, false);
  } finally {
    sb.destroy();
  }
});
