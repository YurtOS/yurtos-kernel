/**
 * Phase 7.2c integration — proves Sandbox.create({kernelImpl:"wasm"})
 * overlays host_* imports with KernelHostInterface-backed wrappers and the
 * boot guest's calls land in the Rust kernel.wasm.
 *
 * Loads a tiny probe wasm (one `host_getuid` import, `_start` calls
 * it once) via Sandbox.spawn(). A spy on the overlay's host_getuid
 * confirms the call routed through the KernelHostInterface, not the TS
 * kernel implementation.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import {
  defaultHostState,
  KernelHostInterface,
} from "@yurt/kernel-host-interface-js";
import {
  buildWasmKernelImports,
  createWasmThreadHostRegistry,
  HOST_BINDINGS,
} from "../../../kernel-host-interface-deno/wasm-kernel-imports.ts";
import { NodeAdapter } from "../platform/node-adapter.ts";
import type { RunResult } from "../run-result.ts";
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

async function createTsSandbox(
  fixtureName: string,
  mountedFixture: Uint8Array,
): Promise<Sandbox> {
  return await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    mounts: [{ path: "/fixtures", files: { [fixtureName]: mountedFixture } }],
  });
}

async function createWasmSandbox(
  kernelBytes: Uint8Array,
  fixtureName: string,
  mountedFixture: Uint8Array,
): Promise<Sandbox> {
  const mk = await KernelHostInterface.load(kernelBytes, defaultHostState());
  const wasmThreadHostRegistry = createWasmThreadHostRegistry(mk);
  return await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    kernelImpl: "wasm",
    wasmKernelBytes: kernelBytes,
    wasmHostImports: (memory, callerPid, cwd) =>
      buildWasmKernelImports(mk, () => memory.buffer, callerPid, cwd),
    wasmOverrideNames: HOST_BINDINGS.map((b) => b.name),
    wasmThreadHostRegistry,
    mounts: [{ path: "/fixtures", files: { [fixtureName]: mountedFixture } }],
  });
}

async function runWithBothKernels(
  argv: string[],
  options?: { cwd?: string },
): Promise<{ ts: RunResult; wasm: RunResult }> {
  const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
  const fixtureName = argv[0].split("/").at(-1);
  if (!fixtureName) throw new Error(`invalid argv[0]: ${argv[0]}`);
  const fixture = await Deno.readFile(`${WASM_DIR}/${fixtureName}`);
  const tsSandbox = await createTsSandbox(fixtureName, fixture);
  const wasmSandbox = await createWasmSandbox(
    kernelBytes,
    fixtureName,
    fixture,
  );
  try {
    return {
      ts: await tsSandbox.runArgv(argv, options),
      wasm: await wasmSandbox.runArgv(argv, options),
    };
  } finally {
    tsSandbox.destroy();
    wasmSandbox.destroy();
  }
}

function expectSameRunResult(got: { ts: RunResult; wasm: RunResult }) {
  expect(got.wasm.exitCode).toBe(got.ts.exitCode);
  expect(got.wasm.stdout).toBe(got.ts.stdout);
  expect(got.wasm.stderr).toBe(got.ts.stderr);
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

  it("routes a probe wasm's host_getuid through the KernelHostInterface", async () => {
    if (!HAS_JSPI) return;
    const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
    const mk = await KernelHostInterface.load(kernelBytes, defaultHostState());
    const overrideNames = HOST_BINDINGS.map((b) => b.name);
    let getuidCalls = 0;
    const wasmHostImports = (
      memory: WebAssembly.Memory,
      callerPid: number,
      cwd: string,
    ) => {
      const base = buildWasmKernelImports(
        mk,
        () => memory.buffer,
        callerPid,
        cwd,
      );
      const original = base.host_getuid;
      base.host_getuid = async (...args: number[]) => {
        getuidCalls++;
        return await original(...args);
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

  for (
    const { name, argv, options } of [
      {
        name: "argv/stdout fixture",
        argv: ["/fixtures/echo-args.wasm", "alpha", "beta", "gamma"],
      },
      { name: "zero exit fixture", argv: ["/fixtures/true-cmd.wasm"] },
      { name: "nonzero exit fixture", argv: ["/fixtures/false-cmd.wasm"] },
      {
        name: "std env/process fixture",
        argv: ["/fixtures/std-env-process-canary.wasm"],
      },
      { name: "std paths fixture", argv: ["/fixtures/std-paths-canary.wasm"] },
      {
        name: "std fs fixture",
        argv: ["/fixtures/std-fs-canary.wasm"],
        options: { cwd: "/tmp" },
      },
    ]
  ) {
    it(`matches the TS kernel for ${name}`, async () => {
      if (!HAS_JSPI) return;
      expectSameRunResult(await runWithBothKernels(argv, options));
    });
  }

  it("runs the std fs fixture through the wasm kernel", async () => {
    if (!HAS_JSPI) return;
    const fixtureName = "std-fs-canary.wasm";
    const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
    const fixture = await Deno.readFile(`${WASM_DIR}/${fixtureName}`);
    const sandbox = await createWasmSandbox(kernelBytes, fixtureName, fixture);
    try {
      const result = await sandbox.runArgv([`/fixtures/${fixtureName}`], {
        cwd: "/tmp",
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        "canonical=/tmp/yurt-std-fs-canary.txt\ncontents=yurt\n",
      );
    } finally {
      sandbox.destroy();
    }
  });
});
