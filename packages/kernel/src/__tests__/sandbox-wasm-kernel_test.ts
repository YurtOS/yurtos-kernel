/**
 * Phase 7.2c integration — proves Sandbox.create({kernelImpl:"wasm"})
 * overlays host_* imports with Microkernel-backed wrappers and the
 * boot guest's calls land in the Rust kernel.wasm.
 *
 * Loads a tiny probe wasm (one `host_getuid` import, `_start` calls
 * it once) via Sandbox.spawn(). A spy on the overlay's host_getuid
 * confirms the call routed through the Microkernel, not the TS
 * kernel implementation.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import { defaultHostState, Microkernel } from "@yurt/microkernel-js";
import {
  buildWasmKernelImports,
  HOST_BINDINGS,
} from "../../../microkernel-deno/wasm-kernel-imports.ts";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";

const WASM_DIR = resolve(
  decodeURIComponent(
    new URL("../platform/__tests__/fixtures", import.meta.url).pathname,
  ),
);

const KERNEL_WASM_URL = new URL(
  "../../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

// Probe wasm built by wat2wasm from:
//   (module
//     (import "yurt" "host_getuid" (func $g (result i32)))
//     (func (export "_start") (drop (call $g))))
const PROBE_WASM_HEX =
  "0061736d010000000108026000017f60000002140104797572740b" +
  "686f73745f676574756964000003020101070a01065f7374617274" +
  "00010a0701050010001a0b";

function probeBytes(): Uint8Array {
  return new Uint8Array(
    PROBE_WASM_HEX.match(/../g)!.map((h) => parseInt(h, 16)),
  );
}

describe("Sandbox kernelImpl='wasm' (Phase 7.2c integration)", () => {
  it("rejects kernelImpl='wasm' without wasmHostImports", async () => {
    await expect(
      Sandbox.create({
        wasmDir: WASM_DIR,
        adapter: new NodeAdapter(),
        kernelImpl: "wasm",
      }),
    ).rejects.toThrow(/wasmHostImports/);
  });

  it("routes a probe wasm's host_getuid through the Microkernel", async () => {
    if (!HAS_JSPI) return;
    const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
    const mk = await Microkernel.load(kernelBytes, defaultHostState());
    const overrideNames = HOST_BINDINGS.map((b) => b.name);
    let getuidCalls = 0;
    const wasmHostImports = (memory: WebAssembly.Memory) => {
      const base = buildWasmKernelImports(mk, () => memory.buffer);
      const original = base.host_getuid;
      base.host_getuid = async (...args: number[]) => {
        getuidCalls++;
        return original(...args);
      };
      return base;
    };
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      kernelImpl: "wasm",
      wasmKernelBytes: kernelBytes,
      wasmHostImports,
      wasmOverrideNames: overrideNames,
      mounts: [
        { path: "/probe", files: { "probe.wasm": probeBytes() } },
      ],
    });
    try {
      const proc = await sandbox.spawn(["/probe/probe.wasm"]);
      await proc.terminate();
      expect(getuidCalls).toBeGreaterThan(0);
    } finally {
      sandbox.destroy();
    }
  });
});
