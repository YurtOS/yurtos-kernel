import { assertEquals } from "@std/assert";
import { tsKernelRecvmsgNfds } from "../kernel-imports.js";

Deno.test("legacy TS kernel sets CTRUNC bit when sender fds dropped", () => {
  // (delivered, senderTotal, fdsPtr) -> nFds out value
  assertEquals(tsKernelRecvmsgNfds(0, 0, 0), 0); // nothing sent
  assertEquals(tsKernelRecvmsgNfds(0, 1, 0), 0x40000000); // no ctrl buf, fds arrived
  assertEquals(tsKernelRecvmsgNfds(1, 3, 123), 1 | 0x40000000); // dropped 2
  assertEquals(tsKernelRecvmsgNfds(2, 2, 123), 2); // all delivered
});
