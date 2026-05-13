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
  "makeWorkerDispatcherBodies: writeFd delivers bytes to buffer target in invocation order",
  () => {
    // This is the property we guarantee today: bodies are synchronous,
    // the main event loop serializes message-handler dispatch, and a
    // sequence of writeFd calls against the same buffer target lands
    // chunks in the buffer in the order the calls were issued. The
    // assertion is by per-chunk identity (one chunk per write, in
    // order) AND by concatenated payload — either alone would let a
    // buggy implementation pass (a single coalesced write would pass
    // the concat check; an out-of-order multi-chunk write would pass
    // the count check).
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
    const r1 = bodies.writeFd(1, ENC("alpha"));
    const r2 = bodies.writeFd(1, ENC("beta"));
    const r3 = bodies.writeFd(1, ENC("gamma"));
    assertEquals(r1, 5);
    assertEquals(r2, 4);
    assertEquals(r3, 5);

    // One chunk per writeFd call — the body pushes a copy per call,
    // it does not coalesce.
    assertEquals(buffer.buf.length, 3);
    assertEquals(new TextDecoder().decode(buffer.buf[0]), "alpha");
    assertEquals(new TextDecoder().decode(buffer.buf[1]), "beta");
    assertEquals(new TextDecoder().decode(buffer.buf[2]), "gamma");

    // Concatenated stream order matches issue order.
    const joined = new Uint8Array(buffer.total);
    let off = 0;
    for (const chunk of buffer.buf) {
      joined.set(chunk, off);
      off += chunk.byteLength;
    }
    assertEquals(new TextDecoder().decode(joined), "alphabetagamma");

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
