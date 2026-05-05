import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { NodeAdapter } from "../../platform/node-adapter.ts";
import { Sandbox } from "../../sandbox.ts";
import { MemoryWasmModuleCache } from "../module-cache.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../../platform/__tests__/fixtures",
);

Deno.test("Sandbox shares compiled boot modules through an injected module cache", async () => {
  let compiles = 0;
  const moduleCache = new MemoryWasmModuleCache(async (bytes) => {
    compiles++;
    return await WebAssembly.compile(bytes as BufferSource);
  });

  const a = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ["/bin/true"],
    bootWasmPath: `${WASM_DIR}/true-cmd.wasm`,
    moduleCache,
  });
  const compilesAfterFirstSandbox = compiles;
  const b = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: ["/bin/true"],
    bootWasmPath: `${WASM_DIR}/true-cmd.wasm`,
    moduleCache,
  });

  try {
    assertEquals(compiles, compilesAfterFirstSandbox);
    assertEquals(moduleCache.stats(), { modules: compilesAfterFirstSandbox });
  } finally {
    a.destroy();
    b.destroy();
  }
});
