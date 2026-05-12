import { assertEquals } from "@std/assert";
import { METHOD } from "../mod.ts";
import { buildWasiShim } from "../wasi_shim.ts";

function testMemory(): WebAssembly.Memory {
  return new WebAssembly.Memory({ initial: 1 });
}

Deno.test("fd_readdir converts kernel directory records to WASI dirents", () => {
  const memory = testMemory();
  const response = new Uint8Array([
    1,
    0,
    0,
    0, // count
    5,
    0,
    0,
    0, // name length
    4, // directory filetype
    ...new TextEncoder().encode("child"),
  ]);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: BigInt(response.byteLength), response };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.fd_readdir(3, 64, 128, 0, 32);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_READDIR);
  assertEquals(new TextDecoder().decode(calls[0].request), "/");
  const view = new DataView(memory.buffer);
  assertEquals(view.getUint32(32, true), 29);
  assertEquals(view.getBigUint64(64, true), 1n);
  assertEquals(view.getUint32(64 + 16, true), 5);
  assertEquals(new Uint8Array(memory.buffer, 64 + 20, 1)[0], 4);
  assertEquals(
    new TextDecoder().decode(new Uint8Array(memory.buffer, 64 + 24, 5)),
    "child",
  );
});

Deno.test("path_rename forwards preopen-relative paths to SYS_RENAME", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("old.txt"), 64);
  bytes.set(new TextEncoder().encode("new.txt"), 96);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 0n, response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_rename(3, 64, 7, 3, 96, 7);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_RENAME);
  const request = calls[0].request;
  const oldLen = new DataView(request.buffer, request.byteOffset)
    .getUint32(0, true);
  assertEquals(oldLen, 8);
  assertEquals(new TextDecoder().decode(request.slice(4, 12)), "/old.txt");
  assertEquals(new TextDecoder().decode(request.slice(12)), "/new.txt");
});

Deno.test("path_link forwards preopen-relative paths to SYS_LINK", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("old.txt"), 64);
  bytes.set(new TextEncoder().encode("link.txt"), 96);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 0n, response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_link(3, 0, 64, 7, 3, 96, 8);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_LINK);
  const request = calls[0].request;
  const oldLen = new DataView(request.buffer, request.byteOffset)
    .getUint32(0, true);
  assertEquals(oldLen, 8);
  assertEquals(new TextDecoder().decode(request.slice(4, 12)), "/old.txt");
  assertEquals(new TextDecoder().decode(request.slice(12)), "/link.txt");
});
