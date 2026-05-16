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
import {
  defaultHostState,
  KernelHostInterface,
} from "@yurt/kernel-host-interface-js";
import {
  buildWasmKernelImports,
  HOST_BINDINGS,
} from "../../../kernel-host-interface-deno/wasm-kernel-imports.ts";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";
import {
  createWasmSandbox,
  expectSameRunResult,
  FORK_CANARY_URL,
  HAS_JSPI,
  KERNEL_WASM_URL,
  PTHREAD_CANARY_URL,
  readFixture,
  runWithBothKernels,
  WASM_DIR,
} from "./_parity_harness.ts";

// Probe wasm built by wat2wasm from:
//   (module
//     (import "yurt" "host_getuid" (func $g (result i32)))
//     (memory (export "memory") 1)
//     (func (export "_start") (drop (call $g))))
const PROBE_WASM_HEX =
  "0061736d010000000108026000017f60000002140104797572740b" +
  "686f73745f6765747569640000030201010503010001071302066d" +
  "656d6f72790200065f737461727400010a0701050010001a0b";

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
      const result = await runWithBothKernels(argv, options);
      if (!result) return;
      expectSameRunResult(result);
    });
  }

  it("runs the std fs fixture through the wasm kernel", async () => {
    if (!HAS_JSPI) return;
    const fixtureName = "std-fs-canary.wasm";
    const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
    const fixture = await readFixture(fixtureName);
    if (!fixture) return;
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

  it("runs the pthread canary through Rust-owned Worker/SAB threads", async () => {
    if (!HAS_JSPI) return;
    const fixtureName = "pthread-canary.wasm";
    const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
    const fixture = await Deno.readFile(PTHREAD_CANARY_URL);
    const sandbox = await createWasmSandbox(kernelBytes, fixtureName, fixture);
    try {
      const result = await sandbox.runArgv([`/fixtures/${fixtureName}`]);
      if (result.exitCode !== 0) {
        console.log(
          "--- wasm-kernel pthread-canary stdout ---\n" + result.stdout,
        );
        console.log(
          "--- wasm-kernel pthread-canary stderr ---\n" + result.stderr,
        );
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("pthread:ok");
    } finally {
      sandbox.destroy();
    }
  });

  it("runs fork continuations through Rust-owned process lifecycle", async () => {
    if (!HAS_JSPI) return;
    const fixtureName = "fork-canary.wasm";
    const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
    const fixture = await Deno.readFile(FORK_CANARY_URL);
    const forkEvents: string[] = [];
    const sandbox = await createWasmSandbox(
      kernelBytes,
      fixtureName,
      fixture,
      forkEvents,
    );
    try {
      const result = await sandbox.runArgv([
        `/fixtures/${fixtureName}`,
        "--case",
        "continuation-split",
      ]);
      if (result.exitCode !== 0) {
        console.log(
          "--- wasm-kernel fork-canary stdout ---\n" + result.stdout,
        );
        console.log(
          "--- wasm-kernel fork-canary stderr ---\n" + result.stderr,
        );
        console.log(
          "--- wasm-kernel fork lifecycle ---\n" + forkEvents.join("\n"),
        );
      }
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^fork-ok child=\d+ parent=\d+$/);
      expect(forkEvents.some((event) => event.startsWith("prepare:"))).toBe(
        true,
      );
      expect(forkEvents.some((event) => event.startsWith("commit:"))).toBe(
        true,
      );
      expect(forkEvents.some((event) => event.startsWith("exit:"))).toBe(
        true,
      );
      expect(forkEvents.some((event) => event.startsWith("rollback:"))).toBe(
        false,
      );
    } finally {
      sandbox.destroy();
    }
  });
});
