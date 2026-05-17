// E2E test: spawn-wait parent fixture spawns child-exit7 and reads its exit
// code through the Runner (Rust kernel + JS host interface). Verifies the
// multi-process pump introduced in Task 5 (runPendingSpawns wired from
// pumpToCompletion).

import { assertEquals } from "@std/assert";
import { Runner } from "../index.ts";
import { buildFixture } from "./_build_fixture.ts";

Deno.test("spawn-wait: parent reaps child exit code through Runner", async () => {
  const [kernelWasm, spawnWaitWasm, childExit7Wasm] = await Promise.all([
    buildFixture("yurt-kernel-wasm", "yurt_kernel_wasm"),
    buildFixture("spawn-wait-wasm", "spawn-wait-wasm"),
    buildFixture("child-exit7-wasm", "child-exit7-wasm"),
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
