import { assertEquals, assertInstanceOf, assertThrows } from "@std/assert";
import type { YurtModuleProfile } from "../../module-profile.ts";
import { createThreadsBackend } from "../backend-factory.ts";
import { CooperativeSerialBackend } from "../cooperative-serial.ts";
import { WorkerSabThreadsBackend } from "../worker-sab.ts";

function profile(
  threadsBackend: YurtModuleProfile["threadsBackend"],
): YurtModuleProfile {
  return {
    importsSetjmp: false,
    importsFork: false,
    hasAsyncify: false,
    hasSetjmpFeature: false,
    hasContinuationsFeature: false,
    hasThreadsFeature: threadsBackend !== "cooperative-serial",
    requiresAsyncify: false,
    requiresSharedMemory: threadsBackend !== "cooperative-serial",
    bridge: "jspi",
    threadsBackend,
    memoryImport: null,
  };
}

Deno.test("thread backend factory keeps plain modules on cooperative serial", () => {
  const backend = createThreadsBackend(profile("cooperative-serial"));

  assertInstanceOf(backend, CooperativeSerialBackend);
  assertEquals(backend.kind, "cooperative-serial");
});

Deno.test("thread backend factory rejects threaded modules without Worker/SAB", () => {
  assertThrows(
    () => createThreadsBackend(profile("unsupported")),
    Error,
    "module declares yurt.features threads but host lacks Worker/SAB threads support",
  );
});

Deno.test("thread backend factory rejects threaded modules until Worker/SAB backend is wired", () => {
  assertThrows(
    () => createThreadsBackend(profile("worker-sab")),
    Error,
    "module declares yurt.features threads but Worker/SAB threads backend is not wired into the loader yet",
  );
});

Deno.test("thread backend factory creates Worker/SAB backend when a spawner is wired", () => {
  const backend = createThreadsBackend(profile("worker-sab"), {
    workerSab: {
      spawnThread: () => Promise.resolve(0),
    },
  });

  assertInstanceOf(backend, WorkerSabThreadsBackend);
  assertEquals(backend.kind, "worker-sab");
});

Deno.test("thread loader backends do not statically import Node-only async hooks", async () => {
  const files = [
    "../backend-factory.ts",
    "../cooperative-serial.ts",
    "../worker-sab.ts",
    "../thread-id-scope.ts",
  ];

  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assertEquals(/^import .*node:async_hooks/m.test(source), false);
  }
});
