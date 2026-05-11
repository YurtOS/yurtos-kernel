/**
 * Phase 7.2 macro layer: factory that builds the legacy
 * TS-kernel-shaped `host_*` import object from the Rust
 * kernel.wasm via microkernel-deno's Microkernel. Hand-writing
 * each of the ~60 host_* wrappers would be a lot of code; this
 * module instead reads a small declarative table (HOST_BINDINGS)
 * and generates the wrapper functions.
 *
 * Each binding describes its argument shape with one of a small
 * set of `ArgSpec` kinds:
 *
 *   "scalar"      — a single u32; packed inline as LE bytes
 *   "scalar64"    — a single u64; packed inline as 8 LE bytes
 *   "ptr_len"     — a (ptr,len) pair; bytes read from user memory
 *                   and appended to the request
 *   "out_cap"     — a (ptr,cap) pair; the syscall's response
 *                   bytes are written back into user memory at
 *                   `ptr` (up to `cap`), and the function returns
 *                   bytes-written
 *
 * Bindings are async by construction — every wrapper returns
 * Promise<number> because the underlying Microkernel.syscallAsync
 * is async (JSPI / asyncify). The legacy TS Sandbox's
 * `WebAssembly.Suspending` wrap of host_* imports already
 * accepts Promise-returning functions.
 *
 * Imports without a Rust-side sys_* equivalent stay -ENOSYS;
 * those entries simply aren't in the table. As more sys_*
 * methods land on the Rust side, more rows go here.
 */

import { METHOD, type Microkernel } from "../microkernel-js/mod.ts";

export type ArgSpec =
  | "scalar"
  | "scalar64"
  | "ptr_len"
  | "out_cap"
  /**
   * (ptr) consumed from the call; the response is always
   * exactly `cap` bytes written into user memory at that ptr.
   * Used by C-ABI-shaped imports that don't pass a cap because
   * the record size is statically known (rlimit = 16,
   * clock_time = 8).
   */
  | { kind: "fixed_out"; cap: number };

export interface HostBinding {
  /** The legacy TS-kernel-shaped name, e.g. "host_pipe". */
  name: string;
  /** Method id the call forwards to, e.g. METHOD.SYS_PIPE. */
  method: number;
  /** Positional arg shape. */
  args: ArgSpec[];
  /**
   * Does the binding return bytes-written from the syscall
   * response? Most "out_cap"-shape calls do. When false, the
   * function returns the syscall's rc directly (0/-errno).
   */
  returnsBytes?: boolean;
}

/**
 * The starting binding table — covers the simple scalar surface
 * the Rust kernel already implements. The full surface fills
 * in as more sys_* methods land (signals, fcntl, etc.) and as
 * the wasm-mode integration tests demand them.
 */
export const HOST_BINDINGS: HostBinding[] = [
  // Identity — these take no args and return a scalar.
  { name: "host_getuid", method: METHOD.SYS_GETUID, args: [] },
  { name: "host_geteuid", method: METHOD.SYS_GETEUID, args: [] },
  { name: "host_getgid", method: METHOD.SYS_GETGID, args: [] },
  { name: "host_getegid", method: METHOD.SYS_GETEGID, args: [] },
  { name: "host_getpid", method: METHOD.SYS_GETPID, args: [] },
  { name: "host_getppid", method: METHOD.SYS_GETPPID, args: [] },

  // Single-scalar args returning a scalar.
  { name: "host_umask", method: METHOD.SYS_UMASK, args: ["scalar"] },
  { name: "host_setresuid", method: METHOD.SYS_SETRESUID, args: ["scalar", "scalar", "scalar"] },
  { name: "host_setresgid", method: METHOD.SYS_SETRESGID, args: ["scalar", "scalar", "scalar"] },
  { name: "host_kill", method: METHOD.SYS_KILL, args: ["scalar", "scalar"] },
  { name: "host_getpgid", method: METHOD.SYS_GETPGID, args: ["scalar"] },
  { name: "host_setpgid", method: METHOD.SYS_SETPGID, args: ["scalar", "scalar"] },
  { name: "host_getsid", method: METHOD.SYS_GETSID, args: ["scalar"] },
  { name: "host_setsid", method: METHOD.SYS_SETSID, args: [] },
  { name: "host_isatty", method: METHOD.SYS_ISATTY, args: ["scalar"] },
  { name: "host_sched_yield", method: METHOD.SYS_SCHED_YIELD, args: [] },
  { name: "host_nanosleep", method: METHOD.SYS_NANOSLEEP, args: ["scalar64"] },

  // fd ops.
  { name: "host_close_fd", method: METHOD.SYS_CLOSE, args: ["scalar"] },

  // path + payload: (ptr,len) → scalar.
  { name: "host_chdir", method: METHOD.SYS_CHDIR, args: ["ptr_len"] },

  // (ptr,cap) → bytes-written: response copied into user memory.
  {
    name: "host_getcwd",
    method: METHOD.SYS_GETCWD,
    args: ["out_cap"],
    returnsBytes: true,
  },

  // host_read_fd(fd, outPtr, outCap) → bytes
  {
    name: "host_read_fd",
    method: METHOD.SYS_READ,
    args: ["scalar", "out_cap"],
    returnsBytes: true,
  },
  // host_write_fd(fd, dataPtr, dataLen) → bytes
  {
    name: "host_write_fd",
    method: METHOD.SYS_WRITE,
    args: ["scalar", "ptr_len"],
    returnsBytes: true,
  },

  // ── fd ops ────────────────────────────────────────────────
  // host_pipe(outPtr, outCap) → writes 8 bytes (u32 read_fd + u32 write_fd)
  {
    name: "host_pipe",
    method: METHOD.SYS_PIPE,
    args: ["out_cap"],
    returnsBytes: true,
  },
  // host_dup(fd, outPtr, outCap) — TS shape writes the new fd
  // into outPtr; our sys_dup returns the new fd as rc. The
  // mapping needs an arg-spec variant that writes the rc back
  // into user memory ("rc_to_out"). Left out of the table
  // until that variant lands.

  // ── Resource limits ───────────────────────────────────────
  // host_getrlimit(resource, outPtr) — rlimit record is 16 bytes
  // (u64 soft + u64 hard) on the Rust side.
  {
    name: "host_getrlimit",
    method: METHOD.SYS_GETRLIMIT,
    args: ["scalar", { kind: "fixed_out", cap: 16 }],
    returnsBytes: true,
  },
  // host_clock_gettime(clockId, outPtr) — writes u64 ns (8 bytes).
  {
    name: "host_clock_gettime",
    method: METHOD.SYS_CLOCK_GETTIME,
    args: ["scalar", { kind: "fixed_out", cap: 8 }],
    returnsBytes: true,
  },
  // host_setrlimit(resource, soft, hard) → 3 scalars
  // soft and hard are typically u64. Use scalar64 to be safe.
  {
    name: "host_setrlimit",
    method: METHOD.SYS_SETRLIMIT,
    args: ["scalar", "scalar64", "scalar64"],
  },

  // ── File ops via path ─────────────────────────────────────
  // host_realpath(pathPtr, pathLen, outPtr, outCap) → bytes
  // No exact sys_* equivalent yet — kernel's path resolution stays
  // string-shaped within open(). Leave out until the kernel side
  // grows a dedicated method.

  // ── Wait / process tree ───────────────────────────────────
  // host_wait(pid, flags, outPtr, outCap) — sys_wait expects (pid, flags)
  // as u32s and writes (u32 exited_pid + i32 status) = 8 bytes.
  // Existing host_wait declares scalars + outPtr + outCap.
  {
    name: "host_wait",
    method: METHOD.SYS_WAIT,
    args: ["scalar", "scalar", "out_cap"],
    returnsBytes: true,
  },

  // ── Extensions / native invoke ────────────────────────────
  // host_native_invoke(reqPtr, reqLen, outPtr, outCap) — same wire
  // shape as kh_extension_invoke (just forwards bytes).
  {
    name: "host_native_invoke",
    method: METHOD.SYS_EXTENSION_INVOKE,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },

  // ── Signals ───────────────────────────────────────────────
  // sigaction(sig, actPtr, actLen) — TS host_sigaction shape.
  // Not in our common test path; left to a future expansion.

  // ── Clock ─────────────────────────────────────────────────
  // host_clock_gettime(clockId, outPtr) → 8 bytes (u64 ns)
  // Existing TS signature is (clockId, outPtr) without a cap. Same
  // fixed_out issue as host_getrlimit; defer.
];

/**
 * Build the host_*-shaped import object that drives the Rust
 * kernel via the supplied Microkernel. Each entry in
 * HOST_BINDINGS is materialized as one Promise-returning
 * wrapper. Imports not in the table are *absent* — callers
 * should fill any required gaps with their own stubs (or
 * accept the WebAssembly link error and add the binding).
 *
 * `memBuf()` resolves the calling wasm's `memory` export at
 * call time (it's set after instantiation).
 */
export function buildWasmKernelImports(
  mk: Microkernel,
  memBuf: () => ArrayBuffer,
): Record<string, (...args: number[]) => Promise<number>> {
  const imports: Record<string, (...args: number[]) => Promise<number>> = {};
  for (const b of HOST_BINDINGS) {
    imports[b.name] = makeWrapper(b, mk, memBuf);
  }
  return imports;
}

function makeWrapper(
  b: HostBinding,
  mk: Microkernel,
  memBuf: () => ArrayBuffer,
): (...args: number[]) => Promise<number> {
  return async (...args: number[]): Promise<number> => {
    // Build the request bytes by walking the arg spec. Track
    // where (if anywhere) the response should be written.
    const reqParts: Uint8Array[] = [];
    let outPtr = 0;
    let outCap = 0;
    let ai = 0;
    for (const spec of b.args) {
      if (spec === "scalar") {
        const v = args[ai++] >>> 0;
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, v, true);
        reqParts.push(bytes);
      } else if (spec === "scalar64") {
        // u64 can arrive as bigint or number; normalize.
        const raw = args[ai++];
        const v = typeof raw === "bigint" ? raw : BigInt(raw >>> 0);
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, v as bigint, true);
        reqParts.push(bytes);
      } else if (spec === "ptr_len") {
        const ptr = args[ai++] >>> 0;
        const len = args[ai++] >>> 0;
        const slice = new Uint8Array(memBuf(), ptr, len).slice();
        reqParts.push(slice);
      } else if (spec === "out_cap") {
        outPtr = args[ai++] >>> 0;
        outCap = args[ai++] >>> 0;
      } else if (typeof spec === "object" && spec.kind === "fixed_out") {
        outPtr = args[ai++] >>> 0;
        outCap = spec.cap;
      } else {
        throw new Error(`unknown arg spec ${JSON.stringify(spec)}`);
      }
    }
    // Concatenate request parts.
    let total = 0;
    for (const p of reqParts) total += p.byteLength;
    const req = new Uint8Array(total);
    let cursor = 0;
    for (const p of reqParts) {
      req.set(p, cursor);
      cursor += p.byteLength;
    }
    const out = await mk.syscallAsync(b.method, req, outCap);
    const rc = Number(out.rc);
    if (b.returnsBytes && rc > 0 && outCap > 0) {
      new Uint8Array(memBuf(), outPtr, rc).set(out.response.subarray(0, rc));
    }
    return rc;
  };
}
