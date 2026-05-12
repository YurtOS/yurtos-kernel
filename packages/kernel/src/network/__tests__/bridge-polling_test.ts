import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createNetworkBridgeSocketBackend } from "../socket-backend.js";

// These tests cover the kernel-side polling logic in
// createNetworkBridgeSocketBackend's recvAsync/acceptAsync — the actual
// SAB worker is mocked so we can assert termination conditions without
// the timing fragility of real Node streams in the bridge worker.

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

// deno-lint-ignore no-explicit-any
function mockBridge(responses: Array<Record<string, unknown>>): any {
  const queue = [...responses];
  return {
    requestSync(_req: Record<string, unknown>) {
      if (queue.length === 0) {
        return { ok: false, error: "mock bridge exhausted" };
      }
      return queue.shift()!;
    },
    fetchSync() {
      throw new Error("fetchSync not used by these tests");
    },
  };
}

describe("createNetworkBridgeSocketBackend polling", () => {
  it("recvAsync polls past EAGAIN and surfaces buffered bytes", async () => {
    const bridge = mockBridge([
      { ok: false, error: "EAGAIN" },
      { ok: false, error: "EAGAIN" },
      { ok: true, data: Array.from(encode("pong")) },
    ]);
    const backend = createNetworkBridgeSocketBackend(bridge);
    const r = await backend.recvAsync!(1, 64);
    expect(r).toEqual({ ok: true, data: encode("pong") });
  });

  it("recvAsync exits with EOF (ok+empty) on peer close", async () => {
    // Worker's nonblocking handleRecv reports `{ok: true}` (no data
    // fields) when the underlying socket has FIN'd with nothing
    // buffered. The polling loop must treat that as a terminal result
    // rather than recurse on it.
    const bridge = mockBridge([
      { ok: false, error: "EAGAIN" },
      { ok: true }, // EOF marker from the worker
    ]);
    const backend = createNetworkBridgeSocketBackend(bridge);
    const r = await backend.recvAsync!(1, 64);
    expect(r.ok).toBe(true);
  });

  it("recvAsync surfaces non-EAGAIN errors immediately", async () => {
    const bridge = mockBridge([
      { ok: false, error: "recv: invalid socket_id" },
    ]);
    const backend = createNetworkBridgeSocketBackend(bridge);
    const r = await backend.recvAsync!(1, 64);
    expect(r).toEqual({ ok: false, error: "recv: invalid socket_id" });
  });

  it("acceptAsync polls past wouldBlock and returns the accepted socket", async () => {
    const bridge = mockBridge([
      { ok: false, would_block: true, error: "accept would block" },
      { ok: false, would_block: true, error: "accept would block" },
      {
        ok: true,
        socket_id: 42,
        peer_host: "127.0.0.1",
        peer_port: 50001,
        local_host: "127.0.0.1",
        local_port: 8080,
      },
    ]);
    const backend = createNetworkBridgeSocketBackend(bridge);
    const r = await backend.acceptAsync!(1);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.socket).toBe(42);
  });

  it("acceptAsync exits when the listener is closed mid-poll", async () => {
    const bridge = mockBridge([
      { ok: false, would_block: true, error: "accept would block" },
      { ok: false, error: "accept: invalid listener_id" },
    ]);
    const backend = createNetworkBridgeSocketBackend(bridge);
    const r = await backend.acceptAsync!(1);
    expect(r.ok).toBe(false);
  });
});
