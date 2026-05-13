/**
 * JSPI for kh_real_*: HostFsImpl gains optional *Async variants
 * (openAsync / readAsync / writeAsync / etc.); when present AND
 * the host has JSPI, the matching kh_real_* import is wrapped
 * with WebAssembly.Suspending and userland's sys_open / sys_read
 * actually suspend. This rounds out the async-bridge story —
 * every pluggable surface (fs, fetch, tcp, kv) follows the same
 * pattern.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  type HostFsImpl,
  type HostFsStat,
  KernelHostInterface,
  METHOD,
} from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

class FakeAsyncFs implements HostFsImpl {
  private files = new Map<string, Uint8Array>();
  private fds = new Map<number, { path: string; cursor: number }>();
  private nextFd = 1;
  private bkey(b: Uint8Array): string {
    return Array.from(b).join(",");
  }
  install(path: Uint8Array, content: Uint8Array): void {
    this.files.set(this.bkey(path), content);
  }
  // Sync stubs.
  open(): number {
    return -38;
  }
  read(): number {
    return -38;
  }
  write(): number {
    return -38;
  }
  close(): number {
    return 0;
  }
  stat(): HostFsStat | number {
    return -38;
  }
  unlink(): number {
    return -38;
  }
  mkdir(): number {
    return -38;
  }
  symlink(): number {
    return -38;
  }
  rename(): number {
    return -38;
  }

  async openAsync(path: Uint8Array, _flags: number): Promise<number> {
    await new Promise<void>((r) => queueMicrotask(r));
    const key = this.bkey(path);
    if (!this.files.has(key)) return -2; // -ENOENT
    const fd = this.nextFd++;
    this.fds.set(fd, { path: key, cursor: 0 });
    return fd;
  }
  async readAsync(fd: number, buf: Uint8Array): Promise<number> {
    await new Promise<void>((r) => queueMicrotask(r));
    const e = this.fds.get(fd);
    if (!e) return -9;
    const c = this.files.get(e.path);
    if (!c) return -9;
    const start = Math.min(e.cursor, c.byteLength);
    const n = Math.min(buf.byteLength, c.byteLength - start);
    if (n > 0) buf.set(c.subarray(start, start + n));
    e.cursor += n;
    return n;
  }
  async statAsync(path: Uint8Array): Promise<HostFsStat | number> {
    await new Promise<void>((r) => queueMicrotask(r));
    const c = this.files.get(this.bkey(path));
    if (!c) return -2;
    return {
      size: BigInt(c.byteLength),
      mode: 0o100_644,
      mtimeNs: 0n,
      isDir: false,
      isSymlink: false,
    };
  }
}

describe("JSPI / kh_real_*", () => {
  it("syscallAsync exercises async open/read against a Suspending-wrapped FS", async () => {
    if (!HAS_JSPI) return;
    const fs = new FakeAsyncFs();
    // kernel.wasm's HostFsBackend strips the mount prefix
    // before calling kh_real_open, so the FS sees the path
    // *relative to the mount root*.
    fs.install(
      new TextEncoder().encode("/hello.txt"),
      new TextEncoder().encode("hello-async-fs"),
    );
    const host = defaultHostState();
    host.hostFs = fs;
    const mk = await KernelHostInterface.load(
      await Deno.readFile(KERNEL_WASM),
      host,
    );
    // Mount the host fs at /host, exactly as wasmtime tests do.
    const mountReq = new TextEncoder().encode("/host");
    // METHOD_KERNEL_INSTALL_HOST_FS_MOUNT in the toml is id 11.
    const KERNEL_INSTALL_HOST_FS = 11;
    const installOut = await mk.syscallAsync(
      KERNEL_INSTALL_HOST_FS,
      mountReq,
      0,
    );
    expect(Number(installOut.rc)).toEqual(0);

    // sys_open /host/hello.txt — flag 0 = read-only.
    const openReq = new Uint8Array(4 + "/host/hello.txt".length);
    new DataView(openReq.buffer).setUint32(0, 0, true);
    new TextEncoder().encodeInto("/host/hello.txt", openReq.subarray(4));
    const openOut = await mk.syscallAsync(METHOD.SYS_OPEN, openReq, 0);
    const fd = Number(openOut.rc);
    expect(fd).toBeGreaterThan(0);

    // sys_read fd into 64-byte response.
    const readReq = new Uint8Array(4);
    new DataView(readReq.buffer).setUint32(0, fd >>> 0, true);
    const readOut = await mk.syscallAsync(METHOD.SYS_READ, readReq, 64);
    const used = Number(readOut.rc);
    expect(used).toEqual("hello-async-fs".length);
    expect(new TextDecoder().decode(readOut.response.subarray(0, used)))
      .toEqual("hello-async-fs");
  });
});
