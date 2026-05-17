// E2E test: spawn-wait parent fixture spawns child-exit7 and reads its exit
// code through the Runner (Rust kernel + JS host interface). Verifies the
// multi-process pump introduced in Task 5 (runPendingSpawns wired from
// pumpToCompletion).

import { assertEquals } from "@std/assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Runner } from "../index.ts";

function workspaceRoot(): string {
  return dirname(
    dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url))))),
  );
}

function releaseDir(): string {
  const targetDir = Deno.env.get("CARGO_TARGET_DIR") ??
    join(workspaceRoot(), "target");
  return join(targetDir, "wasm32-wasip1", "release");
}

async function buildAndRead(crate: string, artifact: string): Promise<Uint8Array> {
  const path = join(releaseDir(), `${artifact}.wasm`);
  try {
    return await Deno.readFile(path);
  } catch {
    const cmd = new Deno.Command("cargo", {
      args: [
        "build",
        "--release",
        "-p",
        crate,
        "--target",
        "wasm32-wasip1",
      ],
      cwd: workspaceRoot(),
    });
    const { code } = await cmd.output();
    if (code !== 0) {
      throw new Error(`cargo build of ${crate} failed`);
    }
    return await Deno.readFile(path);
  }
}

Deno.test("spawn-wait: parent reaps child exit code through Runner", async () => {
  const [kernelWasm, spawnWaitWasm, childExit7Wasm] = await Promise.all([
    buildAndRead("yurt-kernel-wasm", "yurt_kernel_wasm"),
    buildAndRead("spawn-wait-wasm", "spawn-wait-wasm"),
    buildAndRead("child-exit7-wasm", "child-exit7-wasm"),
  ]);

  const runner = await Runner.create({
    kernelWasm,
    mounts: [
      {
        path: "/",
        files: {
          "spawn-wait.wasm": spawnWaitWasm,
          "child-exit7.wasm": childExit7Wasm,
        },
      },
    ],
  });

  const r = runner.runArgv(["/spawn-wait.wasm"]);
  assertEquals(r.stdout.trim(), "child exited 7");
  assertEquals(r.exitCode, 0);
});
