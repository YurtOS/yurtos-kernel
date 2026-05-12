import { assert, assertEquals } from "jsr:@std/assert@^1.0.19";
import { resolve } from "node:path";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);
const BOOT_RUNNER = "/bin/yurt-shell-exec";

Deno.test("Sandbox.create accepts bootArgv and exposes the boot process", async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: [BOOT_RUNNER],
  });
  try {
    const p = sb.process(2);
    assert(p, "sandbox.process(2) should return the boot Process");
    assertEquals(p.pid, 2);
    assertEquals(p.mode, "resident");
    assert(typeof p.callExport === "function");
  } finally {
    sb.destroy();
  }
});

Deno.test("Sandbox.create defaults bootArgv to the resident command runner", async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
  });
  try {
    const p = sb.process(2);
    assert(p, "boot process should exist with default bootArgv");
  } finally {
    sb.destroy();
  }
});

Deno.test("Sandbox boot process keeps synchronous allocator exports", async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: [BOOT_RUNNER],
  });
  try {
    const p = sb.process(2)!;
    const ptr = p.exports.__alloc(1);
    assertEquals(typeof ptr, "number");
    p.exports.__dealloc(ptr as number, 1);
  } finally {
    sb.destroy();
  }
});

Deno.test("Sandbox boot process handles run_command responses larger than initial buffer", async () => {
  const sb = await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    bootArgv: [BOOT_RUNNER],
  });
  try {
    const input = Array.from({ length: 1200 }, (_, i) => `${i + 1}`).join(
      "\n",
    ) + "\n";
    const result = await sb.run("cat", {
      stdinData: new TextEncoder().encode(input),
    });
    assertEquals(result.exitCode, 0);
    assert(result.stdout.startsWith("1\n2\n3\n"));
    assert(result.stdout.includes("1200\n"));
  } finally {
    sb.destroy();
  }
});
