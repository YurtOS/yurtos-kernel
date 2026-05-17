import { assertEquals } from "@std/assert";
import { recvmsgPackNfds } from "../sys_shim.ts";

Deno.test("sys_shim recvmsgPackNfds packs CTRUNC bit30", () => {
  assertEquals(recvmsgPackNfds(0, 1, 4), { copyFds: 0, nFds: 0x40000000 });
  assertEquals(recvmsgPackNfds(2, 1, 4), { copyFds: 2, nFds: 2 | 0x40000000 });
  assertEquals(recvmsgPackNfds(3, 0, 4), { copyFds: 3, nFds: 3 });
  assertEquals(recvmsgPackNfds(5, 0, 4), { copyFds: 4, nFds: 4 | 0x40000000 });
  assertEquals(recvmsgPackNfds(0, 0, 4), { copyFds: 0, nFds: 0 });
});
