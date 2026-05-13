import { assertEquals } from "@std/assert";
import { makeWorkerDispatcherBodies } from "../worker-bodies.ts";
import { ProcessKernel } from "../../process/kernel.ts";
import {
  createBufferTarget,
  createStaticTarget,
} from "../../wasi/fd-target.ts";
import type { ThreadsBackend } from "../../process/threads/backend.ts";

function nullThreadsBackend(): ThreadsBackend {
  return {
    kind: "cooperative-serial",
    setIndirectCallTable: () => {},
    spawn: () => Promise.resolve(0),
    join: () => Promise.resolve(0),
    detach: () => Promise.resolve(0),
    exit: () => {
      throw new Error("exit");
    },
    self: () => 0,
    yield_: () => Promise.resolve(0),
    mutexLock: () => Promise.resolve(0),
    mutexUnlock: () => 0,
    mutexTryLock: () => 0,
    condWait: () => Promise.resolve(0),
    condSignal: () => 0,
    condBroadcast: () => 0,
  };
}

Deno.test(
  "makeWorkerDispatcherBodies: writeFd appends to kernel buffer target",
  () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(0, "test");
    const buffer = createBufferTarget(Infinity);
    kernel.setFdTarget(pid, 1, buffer);

    const bodies = makeWorkerDispatcherBodies({
      kernel,
      callerPid: pid,
      threadsBackend: () => nullThreadsBackend(),
    });

    const payload = new TextEncoder().encode("hello-from-worker");
    const result = bodies.writeFd(1, payload);
    assertEquals(result, payload.byteLength);
    assertEquals(buffer.total, payload.byteLength);
    assertEquals(buffer.buf.length, 1);
    assertEquals(new TextDecoder().decode(buffer.buf[0]), "hello-from-worker");

    kernel.dispose();
  },
);

Deno.test(
  "makeWorkerDispatcherBodies: writeFd returns -1 for non-writable fd",
  () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(0, "test");

    const bodies = makeWorkerDispatcherBodies({
      kernel,
      callerPid: pid,
      threadsBackend: () => nullThreadsBackend(),
    });

    const result = bodies.writeFd(42, new Uint8Array([1, 2, 3]));
    assertEquals(result, -1);

    kernel.dispose();
  },
);

Deno.test(
  "makeWorkerDispatcherBodies: readFd drains static target bytes",
  () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(0, "test");
    kernel.setFdTarget(
      pid,
      0,
      createStaticTarget(new TextEncoder().encode("hi")),
    );

    const bodies = makeWorkerDispatcherBodies({
      kernel,
      callerPid: pid,
      threadsBackend: () => nullThreadsBackend(),
    });

    const { result, bytes } = bodies.readFd(0, 16);
    assertEquals(result, 2);
    assertEquals(bytes && new TextDecoder().decode(bytes), "hi");

    kernel.dispose();
  },
);

Deno.test(
  "makeWorkerDispatcherBodies: readFd reports needed cap on overflow",
  () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(0, "test");
    kernel.setFdTarget(
      pid,
      0,
      createStaticTarget(new TextEncoder().encode("abcdefgh")),
    );

    const bodies = makeWorkerDispatcherBodies({
      kernel,
      callerPid: pid,
      threadsBackend: () => nullThreadsBackend(),
    });

    const { result, bytes } = bodies.readFd(0, 4);
    // Body returns the needed size; caller is expected to retry with larger cap.
    assertEquals(result, 8);
    assertEquals(bytes, undefined);

    kernel.dispose();
  },
);

Deno.test(
  "makeWorkerDispatcherBodies: kernelMutex serializes body invocations",
  async () => {
    // Even though current bodies are synchronous, the lock keeps a
    // FIFO chain that any future async body will observe. Drive it
    // through the chain with concurrent calls and verify the order
    // they OBSERVE is the order they were issued.
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(0, "test");
    const buffer = createBufferTarget(Infinity);
    kernel.setFdTarget(pid, 1, buffer);

    const bodies = makeWorkerDispatcherBodies({
      kernel,
      callerPid: pid,
      threadsBackend: () => nullThreadsBackend(),
    });

    const ENC = (s: string) => new TextEncoder().encode(s);
    bodies.writeFd(1, ENC("a"));
    bodies.writeFd(1, ENC("b"));
    bodies.writeFd(1, ENC("c"));
    // Allow any chained Promise tails to settle.
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(buffer.buf.length, 3);
    assertEquals(new TextDecoder().decode(buffer.buf[0]), "a");
    assertEquals(new TextDecoder().decode(buffer.buf[1]), "b");
    assertEquals(new TextDecoder().decode(buffer.buf[2]), "c");

    kernel.dispose();
  },
);

Deno.test(
  "makeWorkerDispatcherBodies: socketOpen returns -1 (not wired)",
  () => {
    const kernel = new ProcessKernel();
    const pid = kernel.allocPid(0, "test");

    const bodies = makeWorkerDispatcherBodies({
      kernel,
      callerPid: pid,
      threadsBackend: () => nullThreadsBackend(),
    });

    assertEquals(bodies.socketOpen(2, 1, 0), -1);

    kernel.dispose();
  },
);
