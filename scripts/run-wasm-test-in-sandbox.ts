#!/usr/bin/env -S deno run -A
//
// Runs a single wasm test (Open POSIX Test Suite case, or any guest wasm)
// inside a Yurt sandbox and forwards its exit/stdout/stderr.
//
// Slice B0: kernel selection via `YURT_KERNEL` (default `ts`):
//   YURT_KERNEL=ts    → TypeScript kernel (original behavior)
//   YURT_KERNEL=wasm  → Rust kernel.wasm via KernelHostInterface
// This is the canonical seam that lets the Open POSIX harness
// (scripts/open-posix-harness.ts) run the same corpus through either
// kernel for parity. `both` is handled one-kernel-per-process by the
// caller (run twice, diff), not here.
import { basename, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { Sandbox } from "../packages/kernel/src/sandbox.ts";
import { NodeAdapter } from "../packages/kernel/src/platform/node-adapter.ts";
import {
  defaultHostState,
  KernelHostInterface,
} from "@yurt/kernel-host-interface-js";
import {
  buildWasmKernelImports,
  createWasmForkLifecycle,
  createWasmProcessHostRegistry,
  createWasmThreadHostRegistry,
  HOST_BINDINGS,
} from "../packages/kernel-host-interface-deno/wasm-kernel-imports.ts";

const [wasmPathArg, ...testArgs] = Deno.args;
if (!wasmPathArg) {
  console.error(
    "Usage: run-wasm-test-in-sandbox.ts <test.wasm> [test-args...]",
  );
  Deno.exit(2);
}

const repoRoot = resolve(import.meta.dirname!, "..");
const wasmDir = resolve(
  repoRoot,
  "packages/kernel/src/platform/__tests__/fixtures",
);
const adapter = new NodeAdapter();

const kernelSel = (Deno.env.get("YURT_KERNEL") ?? "ts").toLowerCase();
if (kernelSel !== "ts" && kernelSel !== "wasm") {
  console.error(
    `YURT_KERNEL must be ts|wasm for this runner, got ${
      JSON.stringify(kernelSel)
    } ` +
      `(use the parity differ for both-kernel diffing)`,
  );
  Deno.exit(2);
}

async function createSelectedSandbox(): Promise<Sandbox> {
  const common = {
    wasmDir,
    adapter,
    timeoutMs: 30_000,
    fsLimitBytes: 768 * 1024 * 1024,
  };
  if (kernelSel === "ts") {
    return await Sandbox.create(common);
  }
  // Rust kernel.wasm path — mirrors the dual-kernel test harness
  // (packages/kernel/src/__tests__/_parity_harness.ts::createWasmSandbox).
  const kernelWasm = resolve(
    repoRoot,
    "target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  );
  let kernelBytes: Uint8Array;
  try {
    kernelBytes = new Uint8Array(readFileSync(kernelWasm));
  } catch {
    console.error(
      `YURT_KERNEL=wasm but ${kernelWasm} is missing. Build it first: ` +
        `cargo build --release -p yurt-kernel-wasm --target wasm32-wasip1`,
    );
    Deno.exit(2);
  }
  const mk = await KernelHostInterface.load(kernelBytes, defaultHostState());
  const wasmThreadHostRegistry = createWasmThreadHostRegistry(mk);
  const wasmProcessHostRegistry = createWasmProcessHostRegistry(mk);
  return await Sandbox.create({
    ...common,
    kernelImpl: "wasm",
    wasmKernelBytes: kernelBytes,
    wasmHostImports: (
      memory: WebAssembly.Memory,
      callerPid: number,
      cwd: string,
    ) =>
      buildWasmKernelImports(mk, () => memory.buffer, callerPid, cwd, 1, {
        processEvents: wasmProcessHostRegistry,
        threadEvents: wasmThreadHostRegistry,
      }),
    wasmOverrideNames: HOST_BINDINGS.map((b) => b.name),
    wasmThreadHostRegistry,
    // Keep the Rust kernel's process registry in sync with the TS
    // ProcessKernel mirror across guest fork()/exit. Without this,
    // fork / pthread_atfork POSIX cases under YURT_KERNEL=wasm diverge
    // from TS even though the runner is meant to cover the same corpus
    // under either kernel. (No forkEvents: substantive sync only.)
    wasmForkLifecycle: createWasmForkLifecycle(wasmProcessHostRegistry),
  });
}

const sandbox = await createSelectedSandbox();

try {
  const wasmPath = resolve(wasmPathArg);
  const guestPath = `/tmp/${basename(wasmPath)}`;
  sandbox.writeFile(guestPath, new Uint8Array(readFileSync(wasmPath)));

  const proc = await sandbox.spawn([guestPath, ...testArgs], {
    mode: "cli",
    env: {
      RUST_TEST_THREADS: "1",
      RAYON_NUM_THREADS: Deno.env.get("RAYON_NUM_THREADS") ?? "1",
    },
  });

  const stdout = proc.fdReadAndClear(1);
  const stderr = proc.fdReadAndClear(2);
  if (stdout.data) {
    await Deno.stdout.write(new TextEncoder().encode(stdout.data));
  }
  if (stderr.data) {
    await Deno.stderr.write(new TextEncoder().encode(stderr.data));
  }
  Deno.exit(proc.exitCode ?? 1);
} finally {
  sandbox.destroy();
}
