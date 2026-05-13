import { assertEquals } from "@std/assert";
import { SabMutex } from "../sab-primitives.ts";
import { WorkerSabThreadsBackend } from "../worker-sab.ts";

function sharedMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
}

Deno.test("worker SAB backend allows multiple live spawned threads", async () => {
  const pending: Array<() => void> = [];
  const backend = new WorkerSabThreadsBackend({
    spawnThread: ({ arg }) =>
      new Promise((resolve) => {
        pending.push(() => resolve(arg + 10));
      }),
  }, sharedMemory());

  const first = await backend.spawn(1, 1);
  const second = await backend.spawn(1, 2);

  assertEquals(first, 1);
  assertEquals(second, 2);

  pending.shift()!();
  pending.shift()!();

  assertEquals(await backend.join(first), 11);
  assertEquals(await backend.join(second), 12);
});

Deno.test("worker SAB backend rejects double join and detached join", async () => {
  const backend = new WorkerSabThreadsBackend({
    spawnThread: ({ arg }) => Promise.resolve(arg),
  }, sharedMemory());

  const joined = await backend.spawn(1, 7);
  assertEquals(await backend.join(joined), 7);
  assertEquals(await backend.join(joined), -1);

  const detached = await backend.spawn(1, 8);
  assertEquals(await backend.detach(detached), 0);
  assertEquals(await backend.join(detached), -1);
});

Deno.test("worker SAB backend preserves self across overlapping async thread scopes", async () => {
  const backend = new WorkerSabThreadsBackend({
    spawnThread: () => Promise.resolve(0),
  }, sharedMemory());
  let releaseFirst!: () => void;
  const firstBarrier = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = backend.runAsThread(7, async () => {
    assertEquals(backend.self(), 7);
    await firstBarrier;
    return backend.self();
  });

  const second = await backend.runAsThread(8, async () => {
    assertEquals(backend.self(), 8);
    await Promise.resolve();
    return backend.self();
  });
  releaseFirst();

  assertEquals(second, 8);
  assertEquals(await first, 7);
  assertEquals(backend.self(), 0);
});

Deno.test("WorkerSabThreadsBackend: mutexLock/Unlock against shared memory cell", () => {
  const memory = sharedMemory();
  const backend = new WorkerSabThreadsBackend({
    spawnThread: () => Promise.resolve(0),
  }, memory);

  const mutexPtr = 0; // first 4 bytes of linear memory
  const lockResult = backend.mutexLock(mutexPtr);
  // mutexLock is async; await it
  return lockResult.then((rc) => {
    if (rc !== 0) throw new Error(`expected 0, got ${rc}`);
    const view = new SabMutex(memory.buffer as SharedArrayBuffer, mutexPtr);
    if (view.owner() !== 1) {
      throw new Error(`expected owner=1, got ${view.owner()}`);
    }
    const unlockRc = backend.mutexUnlock(mutexPtr);
    if (unlockRc !== 0) throw new Error(`expected unlock 0, got ${unlockRc}`);
    if (view.owner() !== 0) {
      throw new Error(`expected owner=0 after unlock, got ${view.owner()}`);
    }
  });
});

Deno.test("WorkerSabThreadsBackend: rejects non-shared memory", () => {
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1 });
  try {
    new WorkerSabThreadsBackend(
      { spawnThread: () => Promise.resolve(0) },
      memory,
    );
    throw new Error("should have thrown");
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("SharedArrayBuffer")) {
      throw new Error(`unexpected error: ${e}`);
    }
  }
});
