import { assertEquals } from "@std/assert";
import { WorkerSabThreadsBackend } from "../worker-sab.ts";

Deno.test("worker SAB backend allows multiple live spawned threads", async () => {
  const pending: Array<() => void> = [];
  const backend = new WorkerSabThreadsBackend({
    spawnThread: ({ arg }) =>
      new Promise((resolve) => {
        pending.push(() => resolve(arg + 10));
      }),
  });

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
  });

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
  });
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
