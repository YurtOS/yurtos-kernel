/**
 * JSPI end-to-end for sockets: kh_socket_connect/recv/accept all
 * suspend the calling wasm via WebAssembly.Suspending when the
 * host installs the matching *Async impls. Confirms the same
 * pattern that worked for kh_fetch_blocking generalizes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  METHOD,
  Microkernel,
  type TcpSocketImpl,
} from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

class FakeAsyncTcp implements TcpSocketImpl {
  private nextHandle = 1;
  private connected = new Set<number>();
  private recvQueue = new Map<number, Uint8Array[]>();

  enqueue(handle: number, bytes: Uint8Array): void {
    if (!this.recvQueue.has(handle)) this.recvQueue.set(handle, []);
    this.recvQueue.get(handle)!.push(bytes);
  }

  // Sync stubs — Suspending uses *Async only.
  connect(): number { return -38; }
  send(): number { return -38; }
  recv(): number { return -38; }
  close(handle: number): number {
    this.connected.delete(handle);
    return 0;
  }
  listen(): number { return -38; }
  accept(): number { return -38; }
  localAddr(): { host: string; port: number } | null { return null; }

  async connectAsync(_host: string, _port: number, _flags: number): Promise<number> {
    await new Promise<void>((r) => queueMicrotask(r));
    const h = this.nextHandle++;
    this.connected.add(h);
    return h;
  }

  async recvAsync(handle: number, buf: Uint8Array, _flags: number): Promise<number> {
    await new Promise<void>((r) => queueMicrotask(r));
    const queue = this.recvQueue.get(handle);
    if (!queue || queue.length === 0) return 0;
    const next = queue.shift()!;
    const n = Math.min(next.byteLength, buf.byteLength);
    buf.set(next.subarray(0, n));
    return n;
  }
}

describe("JSPI / kh_socket_*", () => {
  it("syscallAsync(SYS_SOCKET_CONNECT) suspends + returns the handle", async () => {
    if (!HAS_JSPI) return;
    const tcp = new FakeAsyncTcp();
    const host = defaultHostState();
    host.tcp = tcp;
    const mk = await Microkernel.load(await Deno.readFile(KERNEL_WASM), host);

    // sys_socket_connect request: u8 family + u8 sock_type + u16 pad +
    // u32 flags + addr "host:port".
    const addr = "127.0.0.1:0";
    const req = new Uint8Array(8 + addr.length);
    req[0] = 2; // AF_INET
    req[1] = 1; // SOCK_STREAM
    new TextEncoder().encodeInto(addr, req.subarray(8));
    const out = await mk.syscallAsync(METHOD.SYS_SOCKET_CONNECT, req, 0);
    expect(Number(out.rc)).toBeGreaterThan(0);
  });

  it("syscallAsync(SYS_SOCKET_RECV) suspends + returns enqueued bytes", async () => {
    if (!HAS_JSPI) return;
    const tcp = new FakeAsyncTcp();
    tcp.enqueue(7, new TextEncoder().encode("hello-async"));
    const host = defaultHostState();
    host.tcp = tcp;
    const mk = await Microkernel.load(await Deno.readFile(KERNEL_WASM), host);

    // sys_socket_recv request: u32 fd + u32 flags. Use handle=7
    // (matches our enqueue above).
    const req = new Uint8Array(8);
    new DataView(req.buffer).setUint32(0, 7, true);
    const out = await mk.syscallAsync(METHOD.SYS_SOCKET_RECV, req, 64);
    const used = Number(out.rc);
    expect(used).toEqual("hello-async".length);
    expect(new TextDecoder().decode(out.response.subarray(0, used)))
      .toEqual("hello-async");
  });
});
