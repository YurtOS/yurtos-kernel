import { assertEquals, assertRejects } from "jsr:@std/assert@^1.0.19";
import { CooperativeSerialBackend } from "../threads/cooperative-serial.ts";

Deno.test("cooperative serial backend returns from spawn while spawned routines run", async () => {
  const backend = new CooperativeSerialBackend();
  let releaseThread!: () => void;
  const threadStarted = new Promise<void>((resolve) => {
    backend.setIndirectCallTable({
      async call(_fnPtr, arg) {
        resolve();
        await new Promise<void>((release) => {
          releaseThread = release;
        });
        return arg;
      },
    });
  });

  let spawnReturned = false;
  const spawnResult = backend.spawn(1, 7).then((tid) => {
    spawnReturned = true;
    return tid;
  });
  await Promise.resolve();

  assertEquals(spawnReturned, true);
  assertEquals(await spawnResult, 1);

  await threadStarted;
  const joinResult = backend.join(1);
  releaseThread();
  assertEquals(await joinResult, 7);
});

Deno.test("cooperative serial backend gives spawned threads a separate linear stack", async () => {
  const backend = new CooperativeSerialBackend();
  const memory = new WebAssembly.Memory({ initial: 2 });
  const stackPointer = new WebAssembly.Global(
    { value: "i32", mutable: true },
    65536,
  );
  backend.bindLinearStack(memory, stackPointer);

  let workerStackPointer = 0;
  let releaseThread!: () => void;
  const threadEntered = new Promise<void>((resolve) => {
    backend.setIndirectCallTable({
      async call() {
        workerStackPointer = stackPointer.value as number;
        resolve();
        await new Promise<void>((release) => {
          releaseThread = release;
        });
        return 0;
      },
    });
  });

  const spawnResult = backend.spawn(1, 0);
  assertEquals(stackPointer.value, 65536);
  const tid = await spawnResult;
  assertEquals(tid, 1);

  await threadEntered;
  assertEquals(workerStackPointer > 65536, true);

  const join = backend.join(tid);
  releaseThread();
  assertEquals(await join, 0);
  assertEquals(stackPointer.value, 65536);
});

Deno.test("cooperative serial backend maps thread exit to join retval", async () => {
  const backend = new CooperativeSerialBackend();
  backend.setIndirectCallTable({
    call() {
      return Promise.resolve().then(() => backend.exit(42));
    },
  });

  const tid = await backend.spawn(1, 0);
  assertEquals(tid, 1);
  assertEquals(await backend.join(tid), 42);
});

Deno.test("cooperative serial backend can create multiple live joinable threads", async () => {
  const backend = new CooperativeSerialBackend();
  backend.setIndirectCallTable({
    call(_fnPtr, arg) {
      return Promise.resolve(arg);
    },
  });

  const firstTid = await backend.spawn(1, 11);
  const secondTid = await backend.spawn(1, 12);

  assertEquals(firstTid, 1);
  assertEquals(secondTid, 2);
  assertEquals(await backend.join(firstTid), 11);
  assertEquals(await backend.join(secondTid), 12);
});

Deno.test("cooperative serial backend does not let detached threads block later spawns", async () => {
  const backend = new CooperativeSerialBackend();
  let releaseThread!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    backend.setIndirectCallTable({
      async call(_fnPtr, arg) {
        if (arg === 1) {
          resolve();
          await new Promise<void>((release) => {
            releaseThread = release;
          });
        }
        return arg;
      },
    });
  });

  const firstTid = await backend.spawn(1, 1);
  assertEquals(firstTid, 1);
  assertEquals(await backend.detach(firstTid), 0);
  await backend.yield_();
  await firstStarted;

  const secondTid = await backend.spawn(1, 2);
  assertEquals(secondTid, 2);
  assertEquals(await backend.join(secondTid), 2);

  releaseThread();
  await backend.yield_();
});

Deno.test("cooperative serial backend starts immediately detached threads", async () => {
  const backend = new CooperativeSerialBackend();
  let started = false;
  backend.setIndirectCallTable({
    call() {
      started = true;
      return Promise.resolve(0);
    },
  });

  const tid = await backend.spawn(1, 0);
  assertEquals(await backend.detach(tid), 0);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assertEquals(started, true);
});

Deno.test("cooperative serial backend cancels parked detached threads", async () => {
  const backend = new CooperativeSerialBackend();
  const parked = backend.parkDetachedThread();
  backend.cancelDetachedThreads();

  await assertRejects(() => parked);
});

Deno.test("cooperative serial backend keeps spawned thread stack growth bounded", async () => {
  const backend = new CooperativeSerialBackend();
  const memory = new WebAssembly.Memory({ initial: 2 });
  const stackPointer = new WebAssembly.Global(
    { value: "i32", mutable: true },
    65536,
  );
  backend.bindLinearStack(memory, stackPointer);
  backend.setIndirectCallTable({
    call(_fnPtr, arg) {
      return Promise.resolve(arg);
    },
  });

  for (let i = 0; i < 10; i++) {
    const tid = await backend.spawn(1, i + 11);
    assertEquals(await backend.join(tid), i + 11);
  }

  assertEquals(memory.buffer.byteLength / 65536, 2 + 8 * 16);
});
