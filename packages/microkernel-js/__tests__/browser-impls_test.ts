/**
 * Universal browser-friendly impls — exercise the parts that run
 * cleanly under Deno. globalFetch wraps globalThis.fetch
 * (browsers, Deno, Bun, Node 18+); IndexedDbKv is browser-only
 * and the test confirms it throws cleanly when indexedDB is
 * absent. WebSocketTcp lands in this same module but its full
 * round-trip is exercised in real browser environments — Deno's
 * WebSocket / Deno.upgradeWebSocket teardown pipeline is too
 * brittle to test here without flakes.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  globalFetch,
  IndexedDbKv,
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

describe("browser-friendly impls", () => {
  it("globalFetch wraps globalThis.fetch — same shape as denoFetch", async () => {
    if (!HAS_JSPI) return;
    const ac = new AbortController();
    const server = Deno.serve(
      { port: 0, signal: ac.signal, onListen: () => {} },
      () => new Response("hello globalFetch", { status: 200 }),
    );
    const port = (server.addr as Deno.NetAddr).port;
    try {
      const host = defaultHostState();
      host.fetch = globalFetch;
      const mk = await Microkernel.load(await Deno.readFile(KERNEL_WASM), host);
      const reqJson = JSON.stringify({
        url: `http://127.0.0.1:${port}/`,
        method: "GET",
      });
      const out = await mk.syscallAsync(
        METHOD.SYS_FETCH,
        new TextEncoder().encode(reqJson),
        4096,
      );
      const used = Number(out.rc);
      expect(used).toBeGreaterThan(0);
      const resp = JSON.parse(
        new TextDecoder().decode(out.response.subarray(0, used)),
      );
      expect(resp.body).toEqual("hello globalFetch");
    } finally {
      ac.abort();
      await server.finished;
    }
  });

  it("IndexedDbKv refuses to construct without globalThis.indexedDB", () => {
    // On Deno, globalThis.indexedDB is undefined — confirms the
    // explicit error rather than a silent runtime trap. In a real
    // browser the constructor succeeds and put/get/delete/list
    // work via getAsync/putAsync/etc.
    expect(() => new IndexedDbKv()).toThrow(
      /globalThis\.indexedDB is not available/,
    );
  });
});
