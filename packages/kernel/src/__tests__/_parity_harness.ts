/**
 * Shared dual-kernel test harness (slice B0).
 *
 * Extracted from sandbox-wasm-kernel_test.ts (and extended) so the
 * parity differ and the existing Phase 7.2c integration test share one
 * seam for running the same workload through the TS kernel and the Rust
 * kernel.wasm. Behavior-preserving for existing callers, with one
 * additive change: `readFixture` gained a third, last-checked fallback
 * (`abi/build/<name>`) for C canaries; the prior lookup order is
 * unchanged. `WASM_DIR` drops the no-op `resolve()` around an
 * already-absolute URL pathname (functionally identical).
 *
 * Filename lacks the `_test.ts` suffix, so the fast-tier test glob does
 * not pick it up as a test.
 */

import { expect } from "@std/expect";
import {
  defaultHostState,
  KernelHostInterface,
} from "@yurt/kernel-host-interface-js";
import {
  buildWasmKernelImports,
  createWasmProcessHostRegistry,
  createWasmThreadHostRegistry,
  HOST_BINDINGS,
} from "../../../kernel-host-interface-deno/wasm-kernel-imports.ts";
import { NodeAdapter } from "../platform/node-adapter.ts";
import type { RunResult } from "../run-result.ts";
import { Sandbox } from "../sandbox.ts";

export const WASM_DIR = resolveFixturesDir();

function resolveFixturesDir(): string {
  return decodeURIComponent(
    new URL("../platform/__tests__/fixtures", import.meta.url).pathname,
  );
}

export const KERNEL_WASM_URL = new URL(
  "../../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);
export const PTHREAD_CANARY_URL = new URL(
  "../../../../abi/build/pthread-canary.wasm",
  import.meta.url,
);
export const FORK_CANARY_URL = new URL(
  "../../../../abi/build/fork-canary.wasm",
  import.meta.url,
);

// deno-lint-ignore no-explicit-any
const W = (globalThis as any).WebAssembly;
export const HAS_JSPI = typeof W?.Suspending === "function" &&
  typeof W?.promising === "function";

/** True if the Rust kernel.wasm build artifact is present locally/in CI. */
export async function hasKernelWasm(): Promise<boolean> {
  try {
    await Deno.lstat(KERNEL_WASM_URL);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

export async function readFixture(
  name: string,
): Promise<Uint8Array | null> {
  for (
    const candidate of [
      `${WASM_DIR}/${name}`,
      new URL(`../../../../abi/build/rust/${name}`, import.meta.url),
      new URL(`../../../../abi/build/${name}`, import.meta.url),
    ]
  ) {
    try {
      return await Deno.readFile(candidate);
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
  }
  return null;
}

export async function createTsSandbox(
  fixtureName: string,
  mountedFixture: Uint8Array,
): Promise<Sandbox> {
  return await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    mounts: [{ path: "/fixtures", files: { [fixtureName]: mountedFixture } }],
  });
}

export async function createWasmSandbox(
  kernelBytes: Uint8Array,
  fixtureName: string,
  mountedFixture: Uint8Array,
  forkEvents?: string[],
): Promise<Sandbox> {
  const mk = await KernelHostInterface.load(kernelBytes, defaultHostState());
  const wasmThreadHostRegistry = createWasmThreadHostRegistry(mk);
  const wasmProcessHostRegistry = createWasmProcessHostRegistry(mk);
  return await Sandbox.create({
    wasmDir: WASM_DIR,
    adapter: new NodeAdapter(),
    kernelImpl: "wasm",
    wasmKernelBytes: kernelBytes,
    wasmHostImports: (memory, callerPid, cwd) =>
      buildWasmKernelImports(mk, () => memory.buffer, callerPid, cwd, 1, {
        processEvents: wasmProcessHostRegistry,
        threadEvents: wasmThreadHostRegistry,
      }),
    wasmOverrideNames: HOST_BINDINGS.map((b) => b.name),
    wasmThreadHostRegistry,
    wasmForkLifecycle: forkEvents
      ? {
        prepareFork(parentPid: number): number {
          const childPid = wasmProcessHostRegistry.prepareFork(parentPid);
          forkEvents.push(`prepare:${parentPid}:${childPid}`);
          return childPid;
        },
        commitFork(parentPid: number, childPid: number): number {
          wasmProcessHostRegistry.commitFork(parentPid, childPid);
          forkEvents.push(`commit:${parentPid}:${childPid}`);
          return 0;
        },
        rollbackFork(parentPid: number, childPid: number): number {
          wasmProcessHostRegistry.rollbackFork(parentPid, childPid);
          forkEvents.push(`rollback:${parentPid}:${childPid}`);
          return 0;
        },
        recordExit(pid: number, exitStatus: number): number {
          wasmProcessHostRegistry.recordExit(pid, exitStatus);
          forkEvents.push(`exit:${pid}:${exitStatus}`);
          return 0;
        },
      }
      : undefined,
    mounts: [{ path: "/fixtures", files: { [fixtureName]: mountedFixture } }],
  });
}

export async function runWithBothKernels(
  argv: string[],
  options?: { cwd?: string },
): Promise<{ ts: RunResult; wasm: RunResult } | null> {
  const kernelBytes = await Deno.readFile(KERNEL_WASM_URL);
  const fixtureName = argv[0].split("/").at(-1);
  if (!fixtureName) throw new Error(`invalid argv[0]: ${argv[0]}`);
  const fixture = await readFixture(fixtureName);
  if (!fixture) return null;
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

export function expectSameRunResult(
  got: { ts: RunResult; wasm: RunResult },
) {
  expect(got.wasm.exitCode).toBe(got.ts.exitCode);
  expect(got.wasm.stdout).toBe(got.ts.stdout);
  expect(got.wasm.stderr).toBe(got.ts.stderr);
}
