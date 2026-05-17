// The host-side run loop that drives a guest to completion against the Rust
// kernel through the thin h/k interface.
//
// Scope today: a single root process (the common case — every fixture in
// test-fixtures/wasm/ and every leaf command). Multi-process workloads
// (sys_spawn / fork / pthread) require the kernel-host-interface-deno
// process/thread/fork registries; until those are wired here, a queued
// spawn raises a clear error instead of silently producing a wrong result.

import type {
  KernelHostInterface,
  UserProcess,
} from "@yurt/kernel-host-interface-js";

export interface PumpResult {
  exitCode: number;
}

const PROC_EXIT_RE = /proc_exit\((-?\d+)\)/;

/**
 * Run `root` to completion and return its exit code.
 *
 * WASI `proc_exit(n)` is delivered as a thrown Error by the wasi shim; a
 * `_start` that returns without calling proc_exit is a normal exit 0. Any
 * other thrown error is a genuine trap and is propagated to the caller.
 */
export function pumpToCompletion(
  mk: KernelHostInterface,
  root: UserProcess,
): PumpResult {
  let exitCode = 0;
  try {
    root.runStart();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    const m = PROC_EXIT_RE.exec(msg);
    if (m) {
      exitCode = Number(m[1]) | 0;
    } else {
      throw e;
    }
  }

  // The single-process contract: nothing should be queued. If something is,
  // the workload needs the multi-process registries — fail loudly rather
  // than mis-execute.
  const pending = mk.drainPendingSpawn();
  if (pending !== null) {
    throw new Error(
      "runner: guest requested a child process (sys_spawn/fork), which " +
        "requires the kernel-host-interface-deno process registry — not yet " +
        "wired into the Runner. Tracked as the multi-process pump follow-up.",
    );
  }

  return { exitCode };
}
