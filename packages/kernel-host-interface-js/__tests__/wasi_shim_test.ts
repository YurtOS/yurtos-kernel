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

Deno.test("fd_tell reports the current offset through SYS_LSEEK", () => {
  const memory = testMemory();
  new Uint8Array(memory.buffer).set(new TextEncoder().encode("seek.txt"), 64);
  const response = new Uint8Array(8);
  new DataView(response.buffer).setBigInt64(0, 9n, true);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      if (method === METHOD.SYS_OPEN) {
        return { rc: 7n, response: new Uint8Array() };
      }
      return { rc: 8n, response };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  assertEquals(shim.path_open(3, 0, 64, 8, 0, 0n, 0n, 0, 24), 0);
  const guestFd = new DataView(memory.buffer).getUint32(24, true);
  const rc = shim.fd_tell(guestFd, 32);

  assertEquals(rc, 0);
  assertEquals(calls[1].method, METHOD.SYS_LSEEK);
  const request = new DataView(calls[1].request.buffer);
  assertEquals(request.getUint32(0, true), 7);
  assertEquals(request.getBigInt64(4, true), 0n);
  assertEquals(request.getUint32(12, true), 1);
  assertEquals(new DataView(memory.buffer).getBigUint64(32, true), 9n);
});

Deno.test("path_open allocates guest fds above the preopen and fd ops map to kernel fds", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("file.txt"), 64);
  bytes.set(new TextEncoder().encode("data"), 96);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      if (method === METHOD.SYS_OPEN) {
        return { rc: 3n, response: new Uint8Array() };
      }
      return { rc: BigInt(request.byteLength - 4), response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });

  assertEquals(shim.path_open(3, 0, 64, 8, 0, 1n << 6n, 0n, 0, 32), 0);
  const guestFd = new DataView(memory.buffer).getUint32(32, true);
  assertEquals(guestFd, 4);

  const iov = new DataView(memory.buffer);
  iov.setUint32(128, 96, true);
  iov.setUint32(132, 4, true);
  assertEquals(shim.fd_write(guestFd, 128, 1, 140), 0);

  assertEquals(calls[1].method, METHOD.SYS_WRITE);
  assertEquals(new DataView(calls[1].request.buffer).getUint32(0, true), 3);
  assertEquals(new TextDecoder().decode(calls[1].request.slice(4)), "data");
});

Deno.test("fd_fdstat_set_flags accepts descriptor flag updates as a no-op", () => {
  const memory = testMemory();
  const kernel = {
    scratchLen: 4096,
    syscall() {
      throw new Error("fd_fdstat_set_flags should not call the kernel yet");
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  assertEquals(shim.fd_fdstat_set_flags(7, 0), 0);
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

Deno.test("path_filestat_get forwards preopen-relative paths to SYS_STAT", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("foo.txt"), 64);
  const response = new Uint8Array(16);
  const responseView = new DataView(response.buffer);
  responseView.setBigUint64(0, 4n, true);
  responseView.setUint32(8, 4, true); // regular file
  responseView.setUint32(12, 0o100644, true);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 16n, response };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_filestat_get(3, 0, 64, 7, 128);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_STAT);
  assertEquals(new TextDecoder().decode(calls[0].request), "/foo.txt");
  const view = new DataView(memory.buffer);
  assertEquals(new Uint8Array(memory.buffer, 128 + 16, 1)[0], 4);
  assertEquals(view.getBigUint64(128 + 24, true), 1n);
  assertEquals(view.getBigUint64(128 + 32, true), 4n);
});

Deno.test("path_unlink_file forwards preopen-relative paths to SYS_UNLINK", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("dead.txt"), 64);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 0n, response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_unlink_file(3, 64, 8);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_UNLINK);
  assertEquals(new TextDecoder().decode(calls[0].request), "/dead.txt");
});

Deno.test("path_create_directory forwards preopen-relative paths to SYS_MKDIR", () => {
  const memory = testMemory();
  new Uint8Array(memory.buffer).set(new TextEncoder().encode("made"), 64);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 0n, response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_create_directory(3, 64, 4);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_MKDIR);
  assertEquals(new TextDecoder().decode(calls[0].request), "/made");
});

Deno.test("path_remove_directory forwards preopen-relative paths to SYS_RMDIR", () => {
  const memory = testMemory();
  new Uint8Array(memory.buffer).set(new TextEncoder().encode("gone"), 64);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 0n, response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_remove_directory(3, 64, 4);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_RMDIR);
  assertEquals(new TextDecoder().decode(calls[0].request), "/gone");
});

Deno.test("path_symlink forwards target and preopen-relative linkpath to SYS_SYMLINK", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("../target"), 64);
  bytes.set(new TextEncoder().encode("link"), 96);
  const calls: { method: number; request: Uint8Array }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(method: number, _pid: number, request: Uint8Array) {
      calls.push({ method, request });
      return { rc: 0n, response: new Uint8Array() };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_symlink(64, 9, 3, 96, 4);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_SYMLINK);
  const request = calls[0].request;
  const targetLen = new DataView(request.buffer, request.byteOffset)
    .getUint32(0, true);
  assertEquals(targetLen, 9);
  assertEquals(new TextDecoder().decode(request.slice(4, 13)), "../target");
  assertEquals(new TextDecoder().decode(request.slice(13)), "/link");
});

Deno.test("path_readlink forwards preopen-relative paths to SYS_READLINK", () => {
  const memory = testMemory();
  const bytes = new Uint8Array(memory.buffer);
  bytes.set(new TextEncoder().encode("link.txt"), 64);
  const response = new TextEncoder().encode("/target.txt");
  const calls: { method: number; request: Uint8Array; cap: number }[] = [];
  const kernel = {
    scratchLen: 4096,
    syscall(
      method: number,
      _pid: number,
      request: Uint8Array,
      responseCap: number,
    ) {
      calls.push({ method, request, cap: responseCap });
      return { rc: BigInt(response.byteLength), response };
    },
  };
  const shim = buildWasiShim(42, kernel as never, [], { memory });
  const rc = shim.path_readlink(3, 64, 8, 128, 64, 48);

  assertEquals(rc, 0);
  assertEquals(calls[0].method, METHOD.SYS_READLINK);
  assertEquals(calls[0].cap, 64);
  assertEquals(new TextDecoder().decode(calls[0].request), "/link.txt");
  assertEquals(new DataView(memory.buffer).getUint32(48, true), 11);
  assertEquals(
    new TextDecoder().decode(new Uint8Array(memory.buffer, 128, 11)),
    "/target.txt",
  );
});
