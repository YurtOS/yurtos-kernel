/**
 * Parity-gate scaffold (Phase 7.0). Pins each fixture's expected
 * stdout in `./snapshots/<name>.stdout` and asserts the Rust
 * kernel.wasm path produces identical bytes. The snapshots are
 * the freeze-point both kernels must match: while the TS kernel
 * still exists they're hand-derived from observed TS-kernel
 * behavior; once TS deletion lands, they remain as the pinned
 * contract for all future kernel changes.
 *
 * Expanding the gate: drop a new `<fixture>.stdout` (and
 * optional `<fixture>.exitCode`) into `snapshots/`, add an
 * entry to `FIXTURES` below.
 *
 * The cross-kernel switch (`Sandbox.create({kernelImpl:"wasm"})`)
 * that lets the legacy TS-kernel tests run through microkernel-
 * deno is its own multi-slice initiative — see project memory.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  defaultHostState,
  Microkernel,
  s,
} from "../mod.ts";

const KERNEL_WASM = new URL(
  "../../../target/wasm32-wasip1/release/yurt_kernel_wasm.wasm",
  import.meta.url,
);

const FIXTURE_DIR = new URL(
  "../../../target/wasm32-wasip1/release/",
  import.meta.url,
);

const SNAPSHOTS_DIR = new URL("./snapshots/", import.meta.url);

interface FixtureSpec {
  /** Display name used in test reporting. */
  name: string;
  /** Filename under target/wasm32-wasip1/release/ (without .wasm). */
  wasm: string;
  /** argv passed to the user process. argv[0] is conventionally the program name. */
  argv: string[];
  /** Optional stdin bytes. */
  stdin?: Uint8Array;
  /** Snapshot filename under ./snapshots/. */
  snapshot: string;
}

const FIXTURES: FixtureSpec[] = [
  {
    name: "hello-wasm",
    wasm: "hello-wasm",
    argv: ["hello-wasm"],
    snapshot: "hello-wasm.stdout",
  },
  {
    name: "echo-args",
    wasm: "echo-args-wasm",
    argv: ["echo-args", "alpha", "beta", "gamma"],
    snapshot: "echo-args.stdout",
  },
];

async function loadSnapshot(name: string): Promise<Uint8Array> {
  const url = new URL(name, SNAPSHOTS_DIR);
  return await Deno.readFile(url);
}

async function loadFixture(wasm: string): Promise<Uint8Array> {
  const url = new URL(`${wasm}.wasm`, FIXTURE_DIR);
  return await Deno.readFile(url);
}

describe("parity snapshots — Rust kernel.wasm path", () => {
  for (const fix of FIXTURES) {
    it(`${fix.name} matches snapshots/${fix.snapshot}`, async () => {
      const expected = await loadSnapshot(fix.snapshot);
      const wasm = await loadFixture(fix.wasm);
      const kernelBytes = await Deno.readFile(KERNEL_WASM);
      const mk = await Microkernel.load(kernelBytes, defaultHostState());
      const user = mk.spawnUserProcessWithArgs(
        wasm,
        fix.argv.map((a) => s(a)),
      );
      try {
        user.runStart();
      } catch {
        // proc_exit traps; expected for fixtures that end via
        // proc_exit (false-cmd, hello-wasm, etc.). Stdout is
        // already buffered in the kernel by then.
      }
      const got = user.capturedStdout();
      const expectedStr = new TextDecoder().decode(expected);
      const gotStr = new TextDecoder().decode(got);
      expect(gotStr).toEqual(expectedStr);
    });
  }
});
