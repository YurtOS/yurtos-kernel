/**
 * JSPI end-to-end: kh_extension_invoke suspends the calling wasm
 * via WebAssembly.Suspending so extension handlers can use async
 * host I/O without blocking the dispatcher thread.
 *
 * Skipped automatically on hosts without JSPI.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  type ExtensionRegistry,
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

describe("JSPI / kh_extension_invoke", () => {
  it("syscallAsync(SYS_EXTENSION_INVOKE) awaits async extension bytes", async () => {
    if (!HAS_JSPI) {
      console.log("(no JSPI on this host — skipping)");
      return;
    }

    const bytes = await Deno.readFile(KERNEL_WASM);
    const host = defaultHostState();
    const seen: Uint8Array[] = [];
    host.extensions = {
      invoke(): number {
        throw new Error("sync extension path should not be used");
      },
      async invokeAsync(req: Uint8Array, _cap: number): Promise<Uint8Array> {
        seen.push(req);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        return enc.encode("async-extension-ok");
      },
    } satisfies ExtensionRegistry;
    const mk = await KernelHostInterface.load(bytes, host);

    const req = enc.encode("extension-request");
    const out = await mk.syscallAsync(METHOD.SYS_EXTENSION_INVOKE, req, 64);

    expect(Number(out.rc)).toEqual("async-extension-ok".length);
    expect(seen).toHaveLength(1);
    expect(dec.decode(seen[0])).toEqual("extension-request");
    expect(dec.decode(out.response.subarray(0, Number(out.rc)))).toEqual(
      "async-extension-ok",
    );
  });
});
