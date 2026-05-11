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
  METHOD,
  Microkernel,
} from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

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
      const mk = await Microkernel.load(await Deno.readFile(KERNEL_WASM), host);

      const reqJson = JSON.stringify({
        url: `http://127.0.0.1:${port}/greeting`,
        method: "GET",
      });
      const out = await mk.syscallAsync(
        METHOD.SYS_FETCH,
        new TextEncoder().encode(reqJson),
        16 * 1024,
      );
      const used = Number(out.rc);
      expect(used).toBeGreaterThan(0);
      const resp = JSON.parse(
        new TextDecoder().decode(out.response.subarray(0, used)),
      );
      expect(resp.ok).toEqual(true);
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
      const conn = await listener.accept();
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
      const mk = await Microkernel.load(await Deno.readFile(KERNEL_WASM), host);

      // sys_socket_connect.
      const addr = `127.0.0.1:${port}`;
      const cReq = new Uint8Array(8 + addr.length);
      cReq[0] = 2;
      cReq[1] = 1;
      new TextEncoder().encodeInto(addr, cReq.subarray(8));
      const cOut = await mk.syscallAsync(
        METHOD.SYS_SOCKET_CONNECT,
        cReq,
        0,
      );
      const handle = Number(cOut.rc);
      expect(handle).toBeGreaterThan(0);

      // sys_socket_send (send is sync — Deno.TcpConn.write is
      // promise-shaped but our DenoTcpSocket sync `send` is a
      // stub. So use the underlying tcp directly via
      // hostStateMut.tcp.) Easier: write directly through the
      // conn we have access to via the impl.
      // For this slice we just test recv after the server pre-
      // wrote; skip send by constructing a tcp where the conn
      // already has data pending.
      // Instead, send using sync syscall (will hit -ENOSYS) and
      // confirm — then directly use a separate Deno client to
      // push bytes for the recv path.
      //
      // Simpler plan: dial a separate raw client via Deno.connect
      // and use it to send into the SAME server, then exercise
      // recv on the server-side accepted handle. That requires
      // exposing the listener handle path; too much.
      //
      // Easiest: just test recv where the server-side echo wrote
      // bytes BEFORE we connected. Re-architect server to send
      // immediately on accept:

      // sys_socket_recv — should pull the echoed bytes.
      const rReq = new Uint8Array(8);
      new DataView(rReq.buffer).setUint32(0, handle, true);
      // Send something via raw Deno on the same conn.
      const conn = (tcp as unknown as {
        conns: Map<number, Deno.TcpConn>;
      }).conns.get(handle)!;
      await conn.write(new TextEncoder().encode("ping"));
      const rOut = await mk.syscallAsync(
        METHOD.SYS_SOCKET_RECV,
        rReq,
        64,
      );
      const used = Number(rOut.rc);
      expect(used).toEqual(4);
      expect(new TextDecoder().decode(rOut.response.subarray(0, used)))
        .toEqual("ping");
      // Close client-side handle so Deno's leak checker is happy.
      tcp.close(handle);
    } finally {
      try {
        listener.close();
      } catch { /* */ }
      await serverDone;
    }
  });
});
