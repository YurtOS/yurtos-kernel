import { assertEquals } from "jsr:@std/assert@^1.0.19";
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
