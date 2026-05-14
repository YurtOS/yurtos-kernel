import {
  assert,
  assertEquals,
  assertInstanceOf,
} from "jsr:@std/assert@^1.0.19";
import {
  decodeRequest,
  encodeResponse,
  SAB_SIZE,
  STATUS_RESPONSE,
} from "../proxy-protocol.ts";
import { VfsProxy } from "../vfs-proxy.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

Deno.test("VfsProxy readFile waits asynchronously for worker-host responses", async () => {
  const originalWait = Atomics.wait;
  let blockingWaitUsed = false;
  Object.defineProperty(Atomics, "wait", {
    value: () => {
      blockingWaitUsed = true;
      throw new Error("blocking Atomics.wait used");
    },
    configurable: true,
  });

  try {
    const sab = new SharedArrayBuffer(SAB_SIZE);
    const int32 = new Int32Array(sab);
    const proxy = new VfsProxy(sab, {
      parentPort: {
        postMessage(msg: unknown) {
          assertEquals(msg, "proxy-request");
          queueMicrotask(() => {
            const request = decodeRequest(sab);
            assertEquals(request.metadata.op, "readFile");
            assertEquals(request.metadata.path, "/async.txt");
            encodeResponse(sab, {}, encoder.encode("async-data"));
            Atomics.store(int32, 0, STATUS_RESPONSE);
            Atomics.notify(int32, 0);
          });
        },
      },
    });

    const result = proxy.readFileAsync("/async.txt");
    assertInstanceOf(result, Promise);
    const data = await result as Uint8Array;
    assertEquals(decoder.decode(data), "async-data");
    assert(!blockingWaitUsed);
  } finally {
    Object.defineProperty(Atomics, "wait", {
      value: originalWait,
      configurable: true,
    });
  }
});
