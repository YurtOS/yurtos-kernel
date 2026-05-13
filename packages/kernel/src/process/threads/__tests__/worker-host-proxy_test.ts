import { assertEquals } from "@std/assert";
import {
  createWorkerHostImportProxy,
  dispatchWorkerHostCall,
  WorkerHostOp,
} from "../worker-host-proxy.ts";

Deno.test("dispatchWorkerHostCall decodes WriteFd and writes typed response cells", () => {
  const proxy = createWorkerHostImportProxy();
  const header = new Int32Array(proxy.requestSab, 0, 2);
  const payload = new Int32Array(proxy.requestSab, 8);
  const calls: number[][] = [];

  payload[0] = WorkerHostOp.WriteFd;
  payload[1] = 3;
  payload[2] = 1;
  payload[3] = 256;
  payload[4] = 5;
  Atomics.store(header, 0, 1);

  dispatchWorkerHostCall(proxy, {
    host_write_fd: (...args: number[]) => {
      calls.push(args);
      return 5;
    },
  });

  assertEquals(calls, [[1, 256, 5]]);
  assertEquals(Atomics.load(header, 1), 5);
  assertEquals(Atomics.load(header, 0), 2);
});
