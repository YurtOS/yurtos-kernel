/**
 * JSPI end-to-end: kh_fetch_blocking suspends the calling wasm
 * via WebAssembly.Suspending; kernel_dispatch returns Promise via
 * WebAssembly.promising; sys_fetch round-trips real bytes from a
 * fake async backend.
 *
 * Skipped automatically on hosts without JSPI.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defaultHostState, METHOD, Microkernel } from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

describe("JSPI / kh_fetch_blocking", () => {
  it("syscallAsync(SYS_FETCH) round-trips real bytes via Suspending", async () => {
    if (!HAS_JSPI) {
      console.log("(no JSPI on this host — skipping)");
      return;
    }
    const bytes = await Deno.readFile(KERNEL_WASM);
    const host = defaultHostState();
    // Fake fetch impl: takes the JSON request bytes, returns
    // canned JSON response bytes after a microtask.
    host.fetch = async (req: Uint8Array): Promise<Uint8Array> => {
      const reqStr = new TextDecoder().decode(req);
      // Yield to confirm the wasm stack actually suspends.
      await new Promise<void>((r) => queueMicrotask(r));
      const url = JSON.parse(reqStr).url;
      const body = JSON.stringify({
        ok: true,
        status: 200,
        headers: {},
        body: `echoed:${url}`,
        error: null,
      });
      return new TextEncoder().encode(body);
    };
    const mk = await Microkernel.load(bytes, host);

    const reqJson = JSON.stringify({
      url: "https://example.invalid/test",
      method: "GET",
    });
    const reqBytes = new TextEncoder().encode(reqJson);
    const out = await mk.syscallAsync(
      METHOD.SYS_FETCH,
      reqBytes,
      8 * 1024,
    );
    expect(Number(out.rc)).toBeGreaterThan(0);
    const used = Number(out.rc);
    const respStr = new TextDecoder().decode(out.response.subarray(0, used));
    const resp = JSON.parse(respStr);
    expect(resp.ok).toEqual(true);
    expect(resp.status).toEqual(200);
    expect(resp.body).toEqual("echoed:https://example.invalid/test");
  });

  it("fetch denied by mayFetch policy returns -EACCES", async () => {
    if (!HAS_JSPI) return;
    const bytes = await Deno.readFile(KERNEL_WASM);
    const host = defaultHostState();
    host.fetch = (_req: Uint8Array): Promise<Uint8Array> => {
      throw new Error("fetch should not be reached on deny");
    };
    host.policy = { mayFetch: () => "deny" };
    const mk = await Microkernel.load(bytes, host);
    const reqBytes = new TextEncoder().encode(
      JSON.stringify({ url: "https://x", method: "GET" }),
    );
    const out = await mk.syscallAsync(METHOD.SYS_FETCH, reqBytes, 1024);
    expect(Number(out.rc)).toEqual(-13);
  });
});
