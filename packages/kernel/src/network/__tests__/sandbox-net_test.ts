import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { SandboxNet } from "../sandbox-net.js";
import { type ListenerInfo, ListenerRegistry } from "../listener-registry.js";
import { createLoopbackSocketBackend } from "../socket-backend.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Integration test for the SandboxNet ↔ kernel SocketBackend contract that
 * the browser harness will use end-to-end.
 *
 * The browser harness uses ONE registry that is wrapped two ways:
 *   - createLoopbackSocketBackend(undefined, registry)  → kernel SocketBackend
 *   - new SandboxNet(registry)                          → host-page facade
 *
 * From the kernel's perspective every guest socket call goes through the
 * SocketBackend. From the host page's perspective every call goes through
 * SandboxNet. The two sides exchange bytes via the shared registry without
 * touching real OS sockets, JSPI, or service workers.
 */

describe("SandboxNet ↔ SocketBackend round trip", () => {
  function setup() {
    const registry = new ListenerRegistry();
    const backend = createLoopbackSocketBackend(undefined, registry);
    const net = new SandboxNet(registry);
    return { registry, backend, net };
  }

  it("host page connects to a sandbox-side listener and exchanges bytes", async () => {
    const { backend, net } = setup();

    // Sandbox-side: a guest opens a listener via the kernel SocketBackend.
    const listen = backend.listen!({
      host: "127.0.0.1",
      port: 8888,
      backlog: 16,
    });
    if (!listen.ok) throw new Error("listen failed");

    // Sandbox-side: the guest blocks on accept (via JSPI/Asyncify in real life).
    const acceptPromise = backend.acceptAsync!(listen.listener);

    // Host-side: the harness opens a connection through sandbox.net.
    const hostSock = net.connect({ host: "127.0.0.1", port: 8888 });
    expect(hostSock.addrInfo?.peerPort).toBe(8888);

    const accepted = await acceptPromise;
    if (!accepted.ok) throw new Error("accept failed");

    // Host → sandbox.
    hostSock.send(enc.encode("GET / HTTP/1.1\r\n\r\n"));
    const guestRecv = await backend.recvAsync!(accepted.socket, 4096);
    if (!guestRecv.ok) throw new Error("guest recv failed");
    expect(dec.decode(base64ToBytes(guestRecv.data_b64 ?? ""))).toBe(
      "GET / HTTP/1.1\r\n\r\n",
    );

    // Sandbox → host.
    const reply = enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi");
    backend.send(accepted.socket, bytesToBase64(reply));
    const hostRecv = await hostSock.recv(4096);
    expect(dec.decode(hostRecv)).toBe(
      "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi",
    );

    // Sandbox closes; host sees EOF.
    backend.close(accepted.socket);
    const eof = await hostSock.recv(4096);
    expect(eof.length).toBe(0);

    backend.closeListener!(listen.listener);
  });

  it("listListeners and lifecycle events expose sandbox state to the harness", () => {
    const { backend, net } = setup();
    const events: Array<["listen" | "unlisten", number]> = [];
    net.on(
      "listen",
      (info: ListenerInfo) => events.push(["listen", info.port]),
    );
    net.on(
      "unlisten",
      (info: ListenerInfo) => events.push(["unlisten", info.port]),
    );

    const a = backend.listen!({ host: "127.0.0.1", port: 9001, backlog: 16 });
    const b = backend.listen!({ host: "127.0.0.1", port: 9002, backlog: 16 });
    if (!a.ok || !b.ok) throw new Error("listen failed");

    expect(net.listListeners().map((l: ListenerInfo) => l.port).sort())
      .toEqual([9001, 9002]);

    backend.closeListener!(a.listener);
    expect(net.listListeners().map((l: ListenerInfo) => l.port)).toEqual([
      9002,
    ]);

    expect(events).toEqual([
      ["listen", 9001],
      ["listen", 9002],
      ["unlisten", 9001],
    ]);
  });

  it("host connect to an unbound port throws", () => {
    const { net } = setup();
    expect(() => net.connect({ host: "127.0.0.1", port: 1 }))
      .toThrow(/connection refused/);
  });

  it("multiple host connections each get their own accepted socket", async () => {
    const { backend, net } = setup();
    const listen = backend.listen!({
      host: "127.0.0.1",
      port: 9100,
      backlog: 16,
    });
    if (!listen.ok) throw new Error("listen failed");

    const h1 = net.connect({ host: "127.0.0.1", port: 9100 });
    const h2 = net.connect({ host: "127.0.0.1", port: 9100 });
    const a1 = await backend.acceptAsync!(listen.listener);
    const a2 = await backend.acceptAsync!(listen.listener);
    if (!a1.ok || !a2.ok) throw new Error("accept failed");
    expect(a1.socket).not.toBe(a2.socket);

    h1.send(enc.encode("one"));
    h2.send(enc.encode("two"));
    const r1 = await backend.recvAsync!(a1.socket, 1024);
    const r2 = await backend.recvAsync!(a2.socket, 1024);
    if (!r1.ok || !r2.ok) throw new Error("recv failed");
    expect(dec.decode(base64ToBytes(r1.data_b64 ?? ""))).toBe("one");
    expect(dec.decode(base64ToBytes(r2.data_b64 ?? ""))).toBe("two");
  });
});

function bytesToBase64(b: Uint8Array): string {
  if (b.byteLength === 0) return "";
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

function base64ToBytes(s: string): Uint8Array {
  if (s === "") return new Uint8Array(0);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
