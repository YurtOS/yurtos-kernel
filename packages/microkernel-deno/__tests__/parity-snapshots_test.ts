/**
 * Parity-gate scaffold (Phase 7.x). Pins each fixture's expected
 * stdout in `./snapshots/<name>.stdout` and asserts the Rust
 * kernel.wasm path produces identical bytes. The snapshots are
 * the freeze-point both kernels must match: while the TS kernel
 * still exists they're hand-derived from observed-good
 * behavior; once TS deletion lands, they remain as the pinned
 * contract for all future kernel changes.
 *
 * Adding a fixture: drop `<name>.stdout` (binary-faithful) into
 * `snapshots/` and add an entry to `FIXTURES` below. `stdin` is
 * a Uint8Array piped to the user process; `ramfsFiles` install
 * regular files into the kernel's ramfs before launch (used by
 * fixtures that read from a known path under /etc/, /proc/,
 * etc.).
 *
 * The cross-kernel switch (`Sandbox.create({kernelImpl:"wasm"})`)
 * that lets the legacy TS-kernel tests run through microkernel-
 * deno is its own multi-slice initiative — see
 * project_phase7_parity_gate memory.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { defaultHostState, Microkernel, s } from "../mod.ts";

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
  name: string;
  /** Filename under target/wasm32-wasip1/release/ (without .wasm). */
  wasm: string;
  argv: string[];
  stdin?: Uint8Array;
  /** Files installed into the kernel ramfs before launch. */
  ramfsFiles?: { path: string; content: Uint8Array }[];
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
  {
    name: "cat-stdin",
    wasm: "cat-stdin-wasm",
    argv: ["cat-stdin"],
    stdin: new TextEncoder().encode("sandboxed kernel input\n"),
    snapshot: "cat-stdin.stdout",
  },
  {
    name: "cat-ramfs",
    wasm: "cat-ramfs-wasm",
    argv: ["cat-ramfs"],
    ramfsFiles: [{
      path: "/etc/motd",
      content: new TextEncoder().encode("hello ramfs\n"),
    }],
    snapshot: "cat-ramfs.stdout",
  },
  {
    name: "wc-bytes",
    wasm: "wc-bytes-wasm",
    argv: ["wc-bytes"],
    stdin: new TextEncoder().encode("sandboxed kernel input\n"),
    snapshot: "wc-bytes.stdout",
  },
  {
    name: "proc-cmdline",
    wasm: "proc-cmdline-wasm",
    argv: ["/usr/bin/proc-cmdline", "--flag", "value"],
    snapshot: "proc-cmdline.stdout",
  },
  {
    name: "true-cmd",
    wasm: "true-cmd-wasm",
    argv: ["true"],
    snapshot: "true-cmd.stdout",
  },
  {
    name: "false-cmd",
    wasm: "false-cmd-wasm",
    argv: ["false"],
    snapshot: "false-cmd.stdout",
  },
];

async function loadSnapshot(name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(name, SNAPSHOTS_DIR));
}

async function loadFixture(wasm: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(`${wasm}.wasm`, FIXTURE_DIR));
}

describe("parity snapshots — Rust kernel.wasm path", () => {
  for (const fix of FIXTURES) {
    it(`${fix.name} matches snapshots/${fix.snapshot}`, async () => {
      const expected = await loadSnapshot(fix.snapshot);
      const wasm = await loadFixture(fix.wasm);
      const kernelBytes = await Deno.readFile(KERNEL_WASM);
      const mk = await Microkernel.load(kernelBytes, defaultHostState());

      // Stage ramfs files before spawn so they're visible to the
      // user process at sys_open time.
      for (const f of fix.ramfsFiles ?? []) {
        mk.registerRamfsFile(s(f.path), f.content);
      }

      const argv = fix.argv.map((a) => s(a));
      const user = fix.stdin
        ? mk.spawnUserProcessWithArgsAndStdin(wasm, argv, fix.stdin, true)
        : mk.spawnUserProcessWithArgs(wasm, argv);

      try {
        user.runStart();
      } catch {
        // proc_exit traps; expected for fixtures that exit via
        // proc_exit. Stdout is buffered in the kernel by then.
      }
      const got = user.capturedStdout();
      // Compare as bytes — proc-cmdline uses NULs that don't
      // round-trip through string conversion safely.
      expect(Array.from(got)).toEqual(Array.from(expected));
    });
  }
});
