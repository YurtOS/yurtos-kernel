/**
 * Minimal unit test for KernelHostInterface.runPendingSpawns().
 *
 * Verifies:
 * 1. The method exists on KernelHostInterface.
 * 2. Calling it on a freshly-loaded kernel with nothing queued returns
 *    normally (the drain hits -ENOENT immediately and the loop exits).
 *
 * Deeper reaping behaviour (spawning a real child and reaping its exit
 * code) is exercised by a later E2E task.
 */

import { assertEquals } from "@std/assert";
import { KernelHostInterface, defaultHostState } from "../mod.ts";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function workspaceRoot(): string {
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

let cachedKernelWasm: Uint8Array | undefined;
async function kernelWasm(): Promise<Uint8Array> {
  if (cachedKernelWasm) return cachedKernelWasm;
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  const path = join(
    targetDir,
    "wasm32-wasip1",
    "release",
    "yurt_kernel_wasm.wasm",
  );
  try {
    cachedKernelWasm = await Deno.readFile(path);
    return cachedKernelWasm;
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        "yurt-kernel-wasm",
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) throw new Error("cargo build of yurt-kernel-wasm failed");
    cachedKernelWasm = await Deno.readFile(path);
    return cachedKernelWasm;
  }
}

async function freshKernelHostInterface(): Promise<KernelHostInterface> {
  return await KernelHostInterface.load(await kernelWasm(), defaultHostState());
}

Deno.test("runPendingSpawns: method exists on KernelHostInterface", async () => {
  const mk = await freshKernelHostInterface();
  assertEquals(typeof mk.runPendingSpawns, "function");
});

Deno.test("runPendingSpawns: returns normally with nothing queued", async () => {
  const mk = await freshKernelHostInterface();
  // No child spawned — drain should hit -ENOENT immediately and exit cleanly.
  mk.runPendingSpawns();
  // If we reach here the method completed without throwing.
  assertEquals(true, true);
});
