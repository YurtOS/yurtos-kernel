/**
 * End-to-end on Deno: real fetch + real TCP through the JSPI
 * pipeline. Confirms denoFetch wraps globalThis.fetch correctly
 * and DenoTcpSocket's connectAsync/recvAsync round-trip with
 * Deno.connect / Deno.listen.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  denoFetch,
  DenoTcpSocket,
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

const enc = new TextEncoder();
const dec = new TextDecoder();

function sockaddrIn(
  host: [number, number, number, number],
  port: number,
): Uint8Array {
  const addr = new Uint8Array(16);
  const view = new DataView(addr.buffer);
  view.setUint16(0, 2, true);
  view.setUint16(2, port & 0xffff, false);
  addr.set(host, 4);
  return addr;
}

function nativeFetchRequest(url: string, method: string): Uint8Array {
  const urlBytes = enc.encode(url);
  const methodBytes = enc.encode(method);
  const headerSize = 44;
  const urlOffset = headerSize;
  const methodOffset = urlOffset + urlBytes.byteLength;
  const size = methodOffset + methodBytes.byteLength;
  const record = new Uint8Array(size);
  const view = new DataView(record.buffer);
  view.setUint32(0, size, true);
  view.setUint16(4, 1, true);
  view.setUint32(8, urlOffset, true);
  view.setUint32(12, urlBytes.byteLength, true);
  view.setUint32(16, methodOffset, true);
  view.setUint32(20, methodBytes.byteLength, true);
  view.setUint32(24, headerSize, true);
  view.setUint32(28, 0, true);
  view.setUint32(32, size, true);
  view.setUint32(36, 0, true);
  record.set(urlBytes, urlOffset);
  record.set(methodBytes, methodOffset);
  return record;
}

function readSpan(record: Uint8Array, offset: number, len: number): Uint8Array {
  return record.subarray(offset, offset + len);
}

function decodeNativeFetchResponse(record: Uint8Array): {
  status: number;
  headers: Record<string, string>;
  body: string;
} {
  const view = new DataView(
    record.buffer,
    record.byteOffset,
    record.byteLength,
  );
  expect(view.getUint32(0, true)).toEqual(record.byteLength);
  expect(view.getUint16(4, true)).toEqual(1);
  const headersOffset = view.getUint32(12, true);
  const headersCount = view.getUint32(16, true);
  const headers: Record<string, string> = {};
  for (let idx = 0; idx < headersCount; idx++) {
    const at = headersOffset + idx * 16;
    const key = dec.decode(readSpan(
      record,
      view.getUint32(at, true),
      view.getUint32(at + 4, true),
    ));
    headers[key] = dec.decode(readSpan(
      record,
      view.getUint32(at + 8, true),
      view.getUint32(at + 12, true),
    ));
  }
  const bodyOffset = view.getUint32(20, true);
  const bodyLen = view.getUint32(24, true);
  return {
    status: view.getUint32(8, true),
    headers,
    body: dec.decode(readSpan(record, bodyOffset, bodyLen)),
  };
}

describe("DenoFetch + DenoTcpSocket via JSPI", () => {
  it("denoFetch performs real HTTP and the wasm caller suspends", async () => {
    if (!HAS_JSPI) return;
    // Spin up a mock HTTP server on a random port.
    const ac = new AbortController();
    const server = Deno.serve({
      port: 0,
      signal: ac.signal,
      onListen: () => {},
    }, (req) =>
      new Response(`hello ${new URL(req.url).pathname}`, {
        status: 200,
        headers: { "x-test": "yes" },
      }));
    const port = (server.addr as Deno.NetAddr).port;
    try {
      const host = defaultHostState();
      host.fetch = denoFetch;
      const mk = await KernelHostInterface.load(
        await Deno.readFile(KERNEL_WASM),
        host,
      );

      const out = await mk.syscallAsync(
        METHOD.SYS_FETCH,
        nativeFetchRequest(`http://127.0.0.1:${port}/greeting`, "GET"),
        16 * 1024,
      );
      const used = Number(out.rc);
      expect(used).toBeGreaterThan(0);
      const resp = decodeNativeFetchResponse(out.response.subarray(0, used));
      expect(resp.status).toEqual(200);
      expect(resp.body).toEqual("hello /greeting");
      expect(resp.headers["x-test"]).toEqual("yes");
    } finally {
      ac.abort();
      await server.finished;
    }
  });

  it("DenoTcpSocket connect + recv round-trips bytes via real TCP", async () => {
    if (!HAS_JSPI) return;
    // Echo server.
    const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
    const port = (listener.addr as Deno.NetAddr).port;
    const serverDone = (async () => {
      let conn: Deno.TcpConn;
      try {
        conn = await listener.accept();
      } catch {
        return;
      }
      const buf = new Uint8Array(64);
      const n = await conn.read(buf);
      if (n) await conn.write(buf.subarray(0, n));
      conn.close();
      listener.close();
    })();

    try {
      const tcp = new DenoTcpSocket();
      const host = defaultHostState();
      host.tcp = tcp;
      const mk = await KernelHostInterface.load(
        await Deno.readFile(KERNEL_WASM),
        host,
      );

      const openReq = new Uint8Array(8);
      openReq[0] = 2;
      openReq[1] = 1;
      const openOut = await mk.syscallAsync(
        METHOD.SYS_SOCKET_OPEN,
        openReq,
        0,
      );
      const handle = Number(openOut.rc);
      expect(handle).toBeGreaterThan(0);

      // sys_socket_connect.
      const addr = sockaddrIn([127, 0, 0, 1], port);
      const cReq = new Uint8Array(4 + addr.byteLength);
      new DataView(cReq.buffer).setUint32(0, handle, true);
      cReq.set(addr, 4);
      const cOut = await mk.syscallAsync(
        METHOD.SYS_SOCKET_CONNECT,
        cReq,
        0,
      );
      expect(Number(cOut.rc)).toEqual(0);

      const payload = new TextEncoder().encode("ping");
      const sReq = new Uint8Array(4 + payload.byteLength);
      new DataView(sReq.buffer).setUint32(0, handle, true);
      sReq.set(payload, 4);
      const sOut = await mk.syscallAsync(METHOD.SYS_SOCKET_SEND, sReq, 0);
      expect(Number(sOut.rc)).toEqual(payload.byteLength);

      // sys_socket_recv — should pull the echoed bytes.
      const rReq = new Uint8Array(8);
      new DataView(rReq.buffer).setUint32(0, handle, true);
      const rOut = await mk.syscallAsync(
        METHOD.SYS_SOCKET_RECV,
        rReq,
        64,
      );
      const used = Number(rOut.rc);
      expect(used).toEqual(4);
      expect(new TextDecoder().decode(rOut.response.subarray(0, used)))
        .toEqual("ping");
      const closeReq = new Uint8Array(4);
      new DataView(closeReq.buffer).setUint32(0, handle, true);
      expect(Number(
        await mk.syscallAsync(
          METHOD.SYS_SOCKET_CLOSE,
          closeReq,
          0,
        ).then((out) => out.rc),
      )).toEqual(0);
    } finally {
      try {
        listener.close();
      } catch { /* */ }
      await serverDone;
    }
  });

  it("DenoTcpSocket listen returns a real listener handle through the kernel", async () => {
    if (!HAS_JSPI) return;
    const tcp = new DenoTcpSocket();
    const host = defaultHostState();
    host.tcp = tcp;
    const mk = await KernelHostInterface.load(
      await Deno.readFile(KERNEL_WASM),
      host,
    );

    const openReq = new Uint8Array(8);
    openReq[0] = 2;
    openReq[1] = 1;
    const openOut = await mk.syscallAsync(METHOD.SYS_SOCKET_OPEN, openReq, 0);
    const handle = Number(openOut.rc);
    expect(handle).toBeGreaterThan(0);

    const addr = sockaddrIn([127, 0, 0, 1], 0);
    const bindReq = new Uint8Array(4 + addr.byteLength);
    new DataView(bindReq.buffer).setUint32(0, handle, true);
    bindReq.set(addr, 4);
    const bindOut = await mk.syscallAsync(METHOD.SYS_SOCKET_BIND, bindReq, 0);
    expect(Number(bindOut.rc)).toEqual(0);

    const listenReq = new Uint8Array(8);
    const listenView = new DataView(listenReq.buffer);
    listenView.setUint32(0, handle, true);
    listenView.setUint32(4, 16, true);
    const out = await mk.syscallAsync(METHOD.SYS_SOCKET_LISTEN, listenReq, 0);
    expect(Number(out.rc)).toEqual(0);
    const closeReq = new Uint8Array(4);
    new DataView(closeReq.buffer).setUint32(0, handle, true);
    const closed = await mk.syscallAsync(METHOD.SYS_SOCKET_CLOSE, closeReq, 0);
    expect(Number(closed.rc)).toEqual(0);
  });
});
