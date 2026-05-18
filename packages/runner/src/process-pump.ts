// The host-side run loop that drives a guest to completion against the Rust
// kernel through the thin h/k interface.
//
// Scope: single root process (every fixture and every leaf command) plus
// multi-process workloads that use sys_spawn + host_wait. Spawn/wait is
// wired via `mk.runPendingSpawns()`: children the root waited on are
// pumped re-entrantly from host_wait; any remaining un-waited children are
// drained idempotently after _start returns. host_fork is still out of
// scope — it is an -ENOSYS stub and surfaces as a guest errno, not a host
// throw.

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

  // Any children the root queued without itself waiting are drained here;
  // children the root *did* wait on were already pumped re-entrantly from
  // host_wait. Idempotent: drains to -ENOENT.
  mk.runPendingSpawns();

  return { exitCode };
}
