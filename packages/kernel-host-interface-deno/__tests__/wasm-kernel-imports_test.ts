/**
 * Phase 7.2 macro layer — direct tests of the wrapper functions
 * buildWasmKernelImports produces. Each binding is exercised by
 * calling the generated function with the right shape of args
 * and asserting the result equals what KernelHostInterface.syscallAsync
 * would return on its own. No probe wasm needed; the wrappers
 * are JS functions.
 *
 * When the kernelImpl="wasm" Sandbox option lands, the same
 * wrappers (Suspending-wrapped on the way to user wasm) carry
 * every host_* call. This test is the contract.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  KernelHostInterface,
  type KvBackend,
  METHOD,
} from "../../kernel-host-interface-js/mod.ts";
import {
  buildWasmKernelImports,
  HOST_BINDINGS,
} from "../wasm-kernel-imports.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

async function freshMk(): Promise<KernelHostInterface> {
  return await KernelHostInterface.load(
    await Deno.readFile(KERNEL_WASM),
    defaultHostState(),
  );
}

interface CapturedCall {
  method: number;
  callerPid: number;
  request: Uint8Array;
  responseCap: number;
}

function capturingMk(rc = 0, response = new Uint8Array()): {
  mk: KernelHostInterface;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const mk = {
    kernelSyscall(
      method: number,
      callerPid: number,
      request: Uint8Array,
      responseCap: number,
    ): { rc: bigint; response: Uint8Array } {
      calls.push({ method, callerPid, request: request.slice(), responseCap });
      return { rc: BigInt(rc), response };
    },
    kernelSyscallAsync(
      method: number,
      callerPid: number,
      request: Uint8Array,
      responseCap: number,
    ): Promise<{ rc: bigint; response: Uint8Array }> {
      calls.push({ method, callerPid, request: request.slice(), responseCap });
      return Promise.resolve({ rc: BigInt(rc), response });
    },
  } as unknown as KernelHostInterface;
  return { mk, calls };
}

function kvKey(store: Uint8Array, key: Uint8Array): string {
  return `${new TextDecoder().decode(store)}\0${new TextDecoder().decode(key)}`;
}

class FakeKv implements KvBackend {
  private values = new Map<string, Uint8Array>();

  get(store: Uint8Array, key: Uint8Array): Uint8Array | number {
    return this.values.get(kvKey(store, key)) ?? -2;
  }

  put(store: Uint8Array, key: Uint8Array, value: Uint8Array): number {
    this.values.set(kvKey(store, key), value);
    return 0;
  }

  delete(store: Uint8Array, key: Uint8Array): number {
    this.values.delete(kvKey(store, key));
    return 0;
  }

  list(store: Uint8Array, prefix: Uint8Array): Uint8Array[] {
    const storeName = new TextDecoder().decode(store);
    const prefixText = new TextDecoder().decode(prefix);
    const keys: Uint8Array[] = [];
    for (const fullKey of this.values.keys()) {
      const [stored, key] = fullKey.split("\0");
      if (stored === storeName && key.startsWith(prefixText)) {
        keys.push(new TextEncoder().encode(key));
      }
    }
    return keys.sort((a, b) =>
      new TextDecoder().decode(a).localeCompare(new TextDecoder().decode(b))
    );
  }
}

describe("buildWasmKernelImports (Phase 7.2 macro)", () => {
  it("covers the legacy socket host import names that have Rust syscalls", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    for (
      const name of [
        "host_socket_connect",
        "host_socket_open",
        "host_socket_bind",
        "host_socket_listen",
        "host_socket_accept",
        "host_socket_addr",
        "host_socket_send",
        "host_socket_recv",
        "host_socket_close",
        "host_socket_bind_unix",
        "host_socket_connect_unix",
        "host_socket_listen_unix",
        "host_socket_socketpair",
        "host_socket_sendmsg",
        "host_socket_recvmsg",
      ]
    ) {
      expect(names.has(name)).toEqual(true);
    }
  });

  it("covers the legacy durable KV host import names that have Rust syscalls", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    for (
      const name of [
        "host_idb_get",
        "host_idb_put",
        "host_idb_delete",
        "host_idb_list",
      ]
    ) {
      expect(names.has(name)).toEqual(true);
    }
  });

  it("covers host_realpath through a Rust-kernel syscall", () => {
    const names = new Set(HOST_BINDINGS.map((b) => b.name));
    expect(names.has("host_realpath")).toEqual(true);
  });

  it("scalar-zero-arg: host_getuid → sys_getuid via factory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    const uid = await imports.host_getuid();
    // Default credentials UID (1000); confirms the factory's
    // zero-arg scalar-return path returns the syscall's actual
    // value, not a stub.
    expect(uid).toEqual(1000);
  });

  it("initializes the Rust-kernel caller cwd for Sandbox-hosted guests", async () => {
    const { mk, calls } = capturingMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf, 77, "/tmp");

    await imports.host_getuid();

    expect(calls.length).toEqual(2);
    expect(calls[0].method).toEqual(METHOD.SYS_CHDIR);
    expect(calls[0].callerPid).toEqual(77);
    expect(new TextDecoder().decode(calls[0].request)).toEqual("/tmp");
    expect(calls[1].method).toEqual(METHOD.SYS_GETUID);
    expect(calls[1].callerPid).toEqual(77);
  });

  it("multi-scalar-arg: host_kill with args packed inline", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const fakeBuf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => fakeBuf);
    const rc = await imports.host_kill(999_999, 0);
    expect(rc).toEqual(-3);
  });

  it("host_wait converts the kernel wait record to yurt_wait_result_v1", async () => {
    const kernelWait = new Uint8Array(8);
    const kernelView = new DataView(kernelWait.buffer);
    kernelView.setUint32(0, 42, true);
    kernelView.setInt32(4, 7, true);
    const { mk, calls } = capturingMk(8, kernelWait);
    const memory = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => memory);

    const rc = await imports.host_wait(0, 0, 16, 16);

    expect(rc).toEqual(16);
    expect(calls.length).toEqual(1);
    expect(calls[0].method).toEqual(METHOD.SYS_WAIT);
    expect(calls[0].responseCap).toEqual(8);
    const req = new DataView(calls[0].request.buffer);
    expect(req.getUint32(0, true)).toEqual(0);
    expect(req.getUint32(4, true)).toEqual(0);

    const result = new DataView(memory, 16, 16);
    expect(result.getInt32(0, true)).toEqual(42);
    expect(result.getInt32(4, true)).toEqual(7);
    expect(result.getInt32(8, true)).toEqual(0);
    expect(result.getInt32(12, true)).toEqual(0);
  });

  it("host_wait reports kernel signal deaths as wait signals", async () => {
    const kernelWait = new Uint8Array(8);
    const kernelView = new DataView(kernelWait.buffer);
    kernelView.setUint32(0, 42, true);
    kernelView.setInt32(4, 128 + 15, true);
    const { mk } = capturingMk(8, kernelWait);
    const memory = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => memory);

    const rc = await imports.host_wait(0, 0, 16, 16);

    expect(rc).toEqual(16);
    const result = new DataView(memory, 16, 16);
    expect(result.getInt32(0, true)).toEqual(42);
    expect(result.getInt32(4, true)).toEqual(0);
    expect(result.getInt32(8, true)).toEqual(15);
    expect(result.getInt32(12, true)).toEqual(0);
  });

  it("ptr_len arg: host_chdir reads bytes from user memory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    // Stage "/" at offset 0 in a fake user-memory buffer.
    const buf = new ArrayBuffer(64);
    new Uint8Array(buf).set(new TextEncoder().encode("/"));
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_chdir(pathPtr=0, pathLen=1) → 0 (root always exists).
    const rc = await imports.host_chdir(0, 1);
    expect(rc).toEqual(0);
  });

  it("ptr_len arg returns -EFAULT for out-of-bounds user memory", async () => {
    const { mk } = capturingMk(0);
    const buf = new ArrayBuffer(8);
    const imports = buildWasmKernelImports(mk, () => buf);

    let rc: number | undefined;
    let threw = false;
    try {
      rc = await imports.host_chdir(16, 4);
    } catch {
      threw = true;
    }

    expect(threw).toEqual(false);
    expect(rc).toEqual(-14);
  });

  it("out_cap arg: host_getcwd writes bytes back into user memory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    const imports = buildWasmKernelImports(mk, () => buf);
    // chdir / first so cwd is "/".
    new Uint8Array(buf).set(new TextEncoder().encode("/"));
    const cdRc = await imports.host_chdir(0, 1);
    expect(cdRc).toEqual(0);
    // Now read it back via host_getcwd. The factory's out_cap
    // path writes the response bytes into the user-memory
    // buffer at the supplied offset.
    new Uint8Array(buf).fill(0);
    const n = await imports.host_getcwd(0, 64);
    expect(n).toBeGreaterThan(0);
    // Trim any trailing NUL the kernel may include (POSIX-style
    // C-string convention).
    const raw = new Uint8Array(buf, 0, n);
    let end = raw.byteLength;
    while (end > 0 && raw[end - 1] === 0) end--;
    const got = new TextDecoder().decode(raw.subarray(0, end));
    expect(got).toEqual("/");
  });

  it("out_cap arg: host_realpath canonicalizes through the Rust kernel", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(128);
    const u = new Uint8Array(buf);
    const imports = buildWasmKernelImports(mk, () => buf);

    u.set(new TextEncoder().encode("/work"), 0);
    expect(await imports.host_mkdir(0, 5)).toEqual(0);
    expect(await imports.host_chdir(0, 5)).toEqual(0);
    u.fill(0);
    u.set(new TextEncoder().encode("/work/file.txt"), 0);
    u.set(new TextEncoder().encode("hello"), 32);
    expect(await imports.host_write_file(0, 14, 32, 5, 0)).toEqual(5);

    u.fill(0);
    u.set(new TextEncoder().encode("./file.txt"), 0);
    const n = await imports.host_realpath(0, 10, 64, 64);

    expect(n).toEqual("/work/file.txt".length + 1);
    expect(
      new TextDecoder().decode(new Uint8Array(buf, 64, n - 1)),
    ).toEqual("/work/file.txt");
    expect(new Uint8Array(buf)[64 + n - 1]).toEqual(0);
  });

  it("out_cap arg: host_pipe writes 8 bytes (read_fd + write_fd)", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(16);
    const imports = buildWasmKernelImports(mk, () => buf);
    const n = await imports.host_pipe(0, 8);
    expect(n).toEqual(8);
    const view = new DataView(buf);
    const readFd = view.getUint32(0, true);
    const writeFd = view.getUint32(4, true);
    expect(readFd).toBeGreaterThan(0);
    expect(writeFd).toBeGreaterThan(readFd);
  });

  it("argOrder: host_chmod permutes (path,len,mode) → (mode,path)", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    // Use the root path so chmod can find an extant inode. The
    // point of this test is the *wire format* — that mode arrives
    // ahead of the path on the request bytes. Returning -EINVAL
    // would mean wire mismatch; any other rc (0 or path-specific
    // errno) means the kernel decoded our bytes.
    new Uint8Array(buf).set(new TextEncoder().encode("/"));
    const imports = buildWasmKernelImports(mk, () => buf);
    const rc = await imports.host_chmod(0, 1, 0o755);
    // -EINVAL would mean our wire format was wrong. Any other
    // rc means chmod parsed (mode=0o755, path="/") successfully.
    expect(rc).not.toEqual(-22);
  });

  it("prefixed_ptr_len: host_symlink emits u32 len + target + linkpath", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    // Stage "/dst" at 0 (target = /dst), "/lnk" at 16 (linkpath).
    const u = new Uint8Array(buf);
    u.set(new TextEncoder().encode("/dst"), 0);
    u.set(new TextEncoder().encode("/lnk"), 16);
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_symlink(targetPtr=0, targetLen=4, linkPtr=16, linkLen=4)
    const rc = await imports.host_symlink(0, 4, 16, 4);
    expect(rc).toEqual(0);
    // Confirm: readlink resolves the link back to the target.
    new Uint8Array(buf, 32, 32).fill(0);
    u.set(new TextEncoder().encode("/lnk"), 0);
    const n = await imports.host_readlink(0, 4, 32, 32);
    expect(n).toEqual(4);
    const got = new TextDecoder().decode(new Uint8Array(buf, 32, n));
    expect(got).toEqual("/dst");
  });

  it("rc_to_out: host_dup writes new fd into out memory", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(16);
    const imports = buildWasmKernelImports(mk, () => buf);
    // pipe() to get two real fds we can dup.
    const n = await imports.host_pipe(0, 8);
    expect(n).toEqual(8);
    const readFd = new DataView(buf).getUint32(0, true);
    // host_dup(fd, outPtr=8, outCap=4). Writes the new fd as
    // i32 LE at offset 8 and returns 4 (bytes-written).
    const r = await imports.host_dup(readFd, 8, 4);
    expect(r).toEqual(4);
    const newFd = new DataView(buf).getInt32(8, true);
    expect(newFd).toBeGreaterThan(readFd);
  });

  it("ignore_scalar: host_remove discards `recursive` flag", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(64);
    new Uint8Array(buf).set(new TextEncoder().encode("/tmpfile"));
    const imports = buildWasmKernelImports(mk, () => buf);
    // Unlink on a non-existent file returns -ENOENT; the test is
    // that the call decodes the wire (path bytes only) and that
    // the recursive scalar didn't poison the wire.
    const rc = await imports.host_remove(0, 8, 1);
    expect(rc).toEqual(-2); // -ENOENT, not -EINVAL
  });

  it("custom builder: host_time returns seconds-as-float from SYS_CLOCK_GETTIME", async () => {
    if (!HAS_JSPI) return;
    // Build a KernelHostInterface with a pinned now-time so the test is
    // deterministic. defaultHostState() supplies 0 by default;
    // we want a non-zero ns value to confirm the conversion.
    const bytes = await Deno.readFile(KERNEL_WASM);
    const mk = await KernelHostInterface.load(bytes, {
      ...defaultHostState(),
      nowRealtimeNs: 1_500_000_000n, // 1.5 seconds
    });
    const imports = buildWasmKernelImports(mk, () => new ArrayBuffer(0));
    const t = await imports.host_time();
    expect(t).toEqual(1.5);
  });

  it("compound custom: host_write_file then host_read_file round-trips bytes", async () => {
    if (!HAS_JSPI) return;
    const mk = await freshMk();
    const buf = new ArrayBuffer(128);
    const u = new Uint8Array(buf);
    // Stage "/data" at offset 0, "hello" at offset 16.
    u.set(new TextEncoder().encode("/data"), 0);
    u.set(new TextEncoder().encode("hello"), 16);
    const imports = buildWasmKernelImports(mk, () => buf);
    // host_write_file(pathPtr=0, pathLen=5, dataPtr=16, dataLen=5, mode=0)
    const written = await imports.host_write_file(0, 5, 16, 5, 0);
    expect(written).toEqual(5);
    // host_read_file(pathPtr=0, pathLen=5, outPtr=32, outCap=32)
    u.subarray(32, 64).fill(0);
    const n = await imports.host_read_file(0, 5, 32, 32);
    expect(n).toEqual(5);
    const got = new TextDecoder().decode(new Uint8Array(buf, 32, n));
    expect(got).toEqual("hello");
  });

  it("does not expose the defunct host_native_invoke wrapper", () => {
    const { mk } = capturingMk(0);
    const imports = buildWasmKernelImports(mk, () => new ArrayBuffer(64));

    expect("host_native_invoke" in imports).toEqual(false);
    expect(
      HOST_BINDINGS.some((binding) => binding.name === "host_native_invoke"),
    )
      .toEqual(false);
  });

  it("socket wrappers use the direct yurt_abi socket signatures", async () => {
    const buf = new ArrayBuffer(128);
    const u = new Uint8Array(buf);
    const { mk, calls } = capturingMk(0, new Uint8Array([9, 8, 7, 6]));
    const imports = buildWasmKernelImports(mk, () => buf);

    await imports.host_socket_open(1, 6, 0);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_OPEN,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      1,
      6,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    u.set(new TextEncoder().encode("127.0.0.1"), 0);
    await imports.host_socket_connect(7, 0, 9, 8080, 0x40);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_CONNECT,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request.slice(0, 4))).toEqual([
      7,
      0,
      0,
      0,
    ]);
    expect(new TextDecoder().decode(calls.at(-1)!.request.slice(4)))
      .toEqual("127.0.0.1:8080");

    await imports.host_socket_bind(7, 0, 9, 9090);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_BIND,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request.slice(0, 4))).toEqual([
      7,
      0,
      0,
      0,
    ]);
    expect(new TextDecoder().decode(calls.at(-1)!.request.slice(4)))
      .toEqual("127.0.0.1:9090");

    u.set(new TextEncoder().encode("payload"), 32);
    await imports.host_socket_send(7, 32, 7, 0x02);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_SEND,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request.slice(0, 4))).toEqual([
      7,
      0,
      0,
      0,
    ]);
    expect(new TextDecoder().decode(calls.at(-1)!.request.slice(4)))
      .toEqual("payload");

    const received = await imports.host_socket_recv(7, 64, 4, 0x04);
    expect(received).toEqual(0);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_RECV,
      responseCap: 4,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      7,
      0,
      0,
      0,
      0x04,
      0,
      0,
      0,
    ]);

    await imports.host_socket_listen(7, 128);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_LISTEN,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      7,
      0,
      0,
      0,
      128,
      0,
      0,
      0,
    ]);

    const acceptOut = new Uint8Array(16);
    new DataView(acceptOut.buffer).setInt32(0, 11, true);
    const { mk: acceptMk, calls: acceptCalls } = capturingMk(11, acceptOut);
    const acceptImports = buildWasmKernelImports(acceptMk, () => buf);
    const acceptRc = await acceptImports.host_socket_accept(9, 80, 16);
    expect(acceptRc).toEqual(16);
    const accepted = new DataView(buf, 80, 16);
    expect(accepted.getInt32(0, true)).toEqual(11);
    expect(acceptCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_ACCEPT,
      responseCap: 0,
    });
    expect(Array.from(acceptCalls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    await imports.host_socket_addr(9, 0, 80, 16);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_ADDR,
      responseCap: 16,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    ]);

    const unixPath = new TextEncoder().encode("/tmp/yurt-name.sock");
    const { mk: unixAddrMk, calls: unixAddrCalls } = capturingMk(
      unixPath.byteLength,
      unixPath,
    );
    const unixAddrBuf = new ArrayBuffer(128);
    const unixAddrImports = buildWasmKernelImports(
      unixAddrMk,
      () => unixAddrBuf,
    );
    const unixAddrRc = await unixAddrImports.host_socket_addr_unix(
      9,
      1,
      80,
      32,
      64,
    );
    expect(unixAddrRc).toEqual(unixPath.byteLength);
    expect(unixAddrCalls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_ADDR,
      responseCap: 32,
    });
    expect(Array.from(unixAddrCalls.at(-1)!.request)).toEqual([
      9,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
    ]);
    expect(new TextDecoder().decode(new Uint8Array(unixAddrBuf, 80, 19)))
      .toEqual("/tmp/yurt-name.sock");
    expect(new DataView(unixAddrBuf).getInt32(64, true)).toEqual(0);

    const abstractName = new Uint8Array([
      0,
      ...new TextEncoder().encode("yurt-abstract"),
    ]);
    const { mk: abstractAddrMk } = capturingMk(
      abstractName.byteLength,
      abstractName,
    );
    const abstractAddrBuf = new ArrayBuffer(128);
    const abstractAddrImports = buildWasmKernelImports(
      abstractAddrMk,
      () => abstractAddrBuf,
    );
    const abstractAddrRc = await abstractAddrImports.host_socket_addr_unix(
      9,
      1,
      80,
      32,
      64,
    );
    expect(abstractAddrRc).toEqual("yurt-abstract".length);
    expect(new TextDecoder().decode(
      new Uint8Array(abstractAddrBuf, 80, "yurt-abstract".length),
    )).toEqual("yurt-abstract");
    expect(new DataView(abstractAddrBuf).getInt32(64, true)).toEqual(1);

    await imports.host_socket_close(9);
    expect(calls.at(-1)).toMatchObject({
      method: METHOD.SYS_SOCKET_CLOSE,
      responseCap: 0,
    });
    expect(Array.from(calls.at(-1)!.request)).toEqual([9, 0, 0, 0]);
  });

  it("returns required byte count without partial out_cap writes", async () => {
    const response = new TextEncoder().encode("/too/long\0");
    const { mk } = capturingMk(response.byteLength, response);
    const buf = new ArrayBuffer(32);
    const u = new Uint8Array(buf);
    u.fill(0xAA, 8, 12);
    const imports = buildWasmKernelImports(mk, () => buf);

    const rc = await imports.host_getcwd(8, 4);

    expect(rc).toEqual(response.byteLength);
    expect(Array.from(u.slice(8, 12))).toEqual([0xAA, 0xAA, 0xAA, 0xAA]);
  });

  it("durable KV wrappers round-trip put/get/list/delete", async () => {
    if (!HAS_JSPI) return;
    const host = defaultHostState();
    host.kv = new FakeKv();
    const mk = await KernelHostInterface.load(
      await Deno.readFile(KERNEL_WASM),
      host,
    );
    const buf = new ArrayBuffer(256);
    const u = new Uint8Array(buf);
    const imports = buildWasmKernelImports(mk, () => buf);

    const store = new TextEncoder().encode("sessions");
    const key = new TextEncoder().encode("alice");
    const value = new TextEncoder().encode("AAA");
    const putReq = new Uint8Array(
      1 + store.byteLength + 4 + key.byteLength + value.byteLength,
    );
    putReq[0] = store.byteLength;
    putReq.set(store, 1);
    new DataView(putReq.buffer).setUint32(
      1 + store.byteLength,
      key.byteLength,
      true,
    );
    putReq.set(key, 1 + store.byteLength + 4);
    putReq.set(value, 1 + store.byteLength + 4 + key.byteLength);
    u.set(putReq, 0);

    expect(await imports.host_idb_put(0, putReq.byteLength)).toEqual(0);

    const getReq = new Uint8Array(1 + store.byteLength + key.byteLength);
    getReq[0] = store.byteLength;
    getReq.set(store, 1);
    getReq.set(key, 1 + store.byteLength);
    u.set(getReq, 64);

    const gotLen = await imports.host_idb_get(64, getReq.byteLength, 128, 64);
    expect(gotLen).toEqual(3);
    expect(new TextDecoder().decode(new Uint8Array(buf, 128, gotLen)))
      .toEqual("AAA");

    const listLen = await imports.host_idb_list(
      64,
      store.byteLength + 1,
      128,
      64,
    );
    const listView = new DataView(buf, 128, listLen);
    expect(listView.getUint32(0, true)).toEqual(1);
    const keyLen = listView.getUint32(4, true);
    expect(new TextDecoder().decode(new Uint8Array(buf, 136, keyLen)))
      .toEqual("alice");

    expect(await imports.host_idb_delete(64, getReq.byteLength)).toEqual(0);
    expect(await imports.host_idb_get(64, getReq.byteLength, 128, 64))
      .toEqual(-2);
  });
});

// Re-import METHOD so the unused-import lint stays quiet for
// embedders reading this test as documentation.
void METHOD;
