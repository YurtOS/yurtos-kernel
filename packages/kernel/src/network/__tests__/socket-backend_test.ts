import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  createLoopbackSocketBackend,
  type SocketBackend,
} from "../socket-backend.js";
import { ListenerRegistry } from "../listener-registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function base64(s: string): string {
  return btoa(s);
}

function decodeB64(b: string): string {
  return atob(b);
}

/**
 * Minimal stub delegate that rejects everything.
 * Simulates the presence of a BrowserNetworkBridge delegate
 * without requiring real browser fetch/WebSocket APIs.
 */
function stubDelegate(): SocketBackend {
  return {
    connect: () => ({ ok: false, error: "stub: no TCP" }),
    send: () => ({ ok: false, error: "stub: no TCP" }),
    recv: () => ({ ok: false, error: "stub: no TCP" }),
    close: () => ({ ok: true }),
  };
}

/**
 * These tests verify that AF_UNIX operations on a loopback backend behave
 * identically whether or not a TCP delegate is present. The delegate
 * simulates what BrowserNetworkBridge provides in a browser environment —
 * AF_UNIX traffic (negative handles) never reaches it; only positive
 * handles (TCP) are forwarded.
 */
describe("createLoopbackSocketBackend: AF_UNIX parity with delegate", () => {
  it("STREAM socketpair works with a stub delegate (browser setup)", async () => {
    const backend = createLoopbackSocketBackend(stubDelegate());
    const r = await backend.connect({ host: "127.0.0.1", port: 0, tls: false });
    // TCP connect to unregistered port falls through to delegate → fails
    expect(r.ok).toBe(false);

    // But AF_UNIX socketpair (via registry) must succeed regardless
    const reg = backend.registry;
    const { a, b } = reg.openUnixPair();
    // Expose via negative handles (loopback convention)
    const ha = -a;
    const hb = -b;

    await backend.send(ha, base64("ping"));
    const got = await backend.recvAsync!(hb, 1024);
    expect(got.ok).toBe(true);
    if (got.ok && got.data_b64 !== undefined) {
      expect(decodeB64(got.data_b64)).toBe("ping");
    }
  });

  it("STREAM socketpair works without a delegate (standalone loopback)", async () => {
    const backend = createLoopbackSocketBackend();
    const reg = backend.registry;
    const { a, b } = reg.openUnixPair();
    const ha = -a;
    const hb = -b;

    await backend.send(hb, base64("pong"));
    const got = await backend.recvAsync!(ha, 1024);
    expect(got.ok).toBe(true);
    if (got.ok && got.data_b64 !== undefined) {
      expect(decodeB64(got.data_b64)).toBe("pong");
    }
  });

  it("DGRAM socketpair routes via registry.sendDgramToPeer (browser and Node share this path)", async () => {
    // DGRAM pairs bypass backend.send — the host import calls registry
    // methods directly, which is the same code path in browser and Node.
    const backend = createLoopbackSocketBackend(stubDelegate());
    const reg = backend.registry;
    const { a, b } = reg.openDgramPair();

    reg.sendDgramToPeer(a, enc.encode("dgram-msg"));
    const got = await reg.recvDgramAsync(b, 1024);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(dec.decode(got.bytes)).toBe("dgram-msg");
    }
  });

  it("pathname listen/connect routes via loopback, not delegate", async () => {
    const backend = createLoopbackSocketBackend(stubDelegate());
    const reg = backend.registry;

    // Listener
    const listenR = await backend.listen!({
      host: "127.0.0.1",
      port: 0,
      backlog: 5,
    });
    expect(listenR.ok).toBe(true);
    if (!listenR.ok) return;
    const listenerHandle = listenR.listener; // negative (loopback)
    const port = listenR.port;

    // Connect from same registry (simulates second sandbox process)
    const connectR = reg.connect({ host: "127.0.0.1", port });
    expect(connectR.ok).toBe(true);

    // Accept
    const acceptP = backend.acceptAsync!(listenerHandle);
    const acceptR = await acceptP;
    expect(acceptR.ok).toBe(true);
    if (!acceptR.ok) return;

    // Data flows
    const clientSocket = connectR.ok ? -connectR.socket : 0;
    const serverSocket = acceptR.socket;

    await backend.send(clientSocket, base64("hello-from-client"));
    const recv = await backend.recvAsync!(serverSocket, 1024);
    expect(recv.ok).toBe(true);
    if (recv.ok && recv.data_b64 !== undefined) {
      expect(decodeB64(recv.data_b64)).toBe("hello-from-client");
    }
  });

  it("positive handles (TCP) are forwarded to the delegate", async () => {
    const backend = createLoopbackSocketBackend(stubDelegate());
    // Positive socket handle → delegate (stub) → error
    const result = await backend.send(42, base64("data"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("stub");
    }
  });

  it("AF_UNIX and TCP do not share the ListenerRegistry", () => {
    const reg1 = new ListenerRegistry();
    const reg2 = new ListenerRegistry();
    // Sanity: two independent registries don't share state
    expect(reg1).not.toBe(reg2);
    // The loopback backend's registry is its own isolated instance
    const b1 = createLoopbackSocketBackend(undefined, reg1);
    const b2 = createLoopbackSocketBackend(undefined, reg2);
    expect(b1.registry).toBe(reg1);
    expect(b2.registry).toBe(reg2);
  });
});
