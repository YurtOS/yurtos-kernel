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
  /**
   * Like ptr_len but prefixes the consumed bytes with a u32 LE
   * length on the wire. Used by multi-path syscalls (rename,
   * symlink, link) whose kernel-side decoder needs an embedded
   * length to split the parts.
   */
  | "prefixed_ptr_len"
  | "out_cap"
  /**
   * (ptr) consumed from the call; the response is always
   * exactly `cap` bytes written into user memory at that ptr.
   * Used by C-ABI-shaped imports that don't pass a cap because
   * the record size is statically known (rlimit = 16,
   * clock_time = 8).
   */
  | { kind: "fixed_out"; cap: number }
  /**
   * Consumes (ptr, cap). After the call: if rc >= 0 and cap >= 4,
   * the rc is written as i32 LE into user memory at ptr and the
   * wrapper returns 4 (bytes written). If rc < 0 or cap < 4, the
   * wrapper returns rc directly. Used by host_dup-style imports
   * where the kernel returns the new fd as rc but the TS-side
   * caller expects it written into an out pointer.
   */
  | "rc_to_out"
  /**
   * Consumes one scalar slot from the incoming args and emits
   * nothing on the wire. Used when the TS-side host_* declares an
   * extra scalar that the kernel doesn't need (e.g. host_remove's
   * `recursive` flag — SYS_UNLINK is non-recursive by design).
   */
  | "ignore_scalar";

/**
 * Custom builder escape hatch. Used for host_* whose
 * wire-format requirements don't fit the ArgSpec vocabulary
 * (e.g. host_time needs to read 8 bytes from a clock_gettime
 * response and convert ns→seconds-as-float). When supplied,
 * the factory ignores `method`/`args` for this binding and
 * uses the builder's returned function directly.
 */
export type CustomBuilder = (
  mk: Microkernel,
  memBuf: () => ArrayBuffer,
) => (...args: number[]) => Promise<number>;

export interface HostBinding {
  /** The legacy TS-kernel-shaped name, e.g. "host_pipe". */
  name: string;
  /** Method id the call forwards to, e.g. METHOD.SYS_PIPE. */
  method: number;
  /** Positional arg shape. */
  args: ArgSpec[];
  /**
   * When set, overrides the macro factory entirely — the
   * builder's returned function becomes the binding. `method`
   * and `args` are still required (for documentation) but
   * unused at call time.
   */
  custom?: CustomBuilder;
  /**
   * Permutation applied to the wrapper's incoming `args` before
   * walking the `args` spec. Each entry is the index of the
   * incoming arg to consume at that wire position. Used when the
   * TS-side host_* declares args in a different order than the
   * kernel's request layout (e.g. host_chmod takes
   * (pathPtr,pathLen,mode) but SYS_CHMOD packs mode first).
   *
   * Length must match the number of incoming arg slots — i.e. the
   * sum of slots consumed by each ArgSpec.
   */
  argOrder?: number[];
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
  {
    name: "host_setresuid",
    method: METHOD.SYS_SETRESUID,
    args: ["scalar", "scalar", "scalar"],
  },
  {
    name: "host_setresgid",
    method: METHOD.SYS_SETRESGID,
    args: ["scalar", "scalar", "scalar"],
  },
  { name: "host_kill", method: METHOD.SYS_KILL, args: ["scalar", "scalar"] },
  { name: "host_getpgid", method: METHOD.SYS_GETPGID, args: ["scalar"] },
  {
    name: "host_setpgid",
    method: METHOD.SYS_SETPGID,
    args: ["scalar", "scalar"],
  },
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
  // host_wait(pid, flags, outPtr, outCap) — SYS_WAIT writes the kernel-internal
  // 8-byte record (u32 pid + i32 status). The C ABI expects
  // yurt_wait_result_v1: i32 pid + i32 exit_code + i32 signal + i32 flags.
  {
    name: "host_wait",
    method: METHOD.SYS_WAIT,
    args: [],
    custom: (mk, memBuf) =>
    async (
      pid: number,
      flags: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> => {
      const req = new Uint8Array(8);
      const reqView = new DataView(req.buffer);
      reqView.setUint32(0, pid >>> 0, true);
      reqView.setUint32(4, flags >>> 0, true);
      const out = await mk.syscallAsync(METHOD.SYS_WAIT, req, 8);
      const rc = Number(out.rc);
      if (rc < 0) return rc;
      if (rc !== 8 || outCap < 16) return -7; // -E2BIG/malformed for this ABI.
      const kernelView = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        8,
      );
      const exitedPid = kernelView.getUint32(0, true);
      const status = kernelView.getInt32(4, true);
      const signal = (status >>> 8) & 0xff;
      const exitCode = signal === 0 ? status : status & 0xff;
      const result = new DataView(memBuf(), outPtr, 16);
      result.setInt32(0, exitedPid, true);
      result.setInt32(4, exitCode, true);
      result.setInt32(8, signal, true);
      result.setInt32(12, 0, true);
      return 16;
    },
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

  // ── fd duplication ────────────────────────────────────────
  // host_dup2(srcFd, dstFd) → newfd or -EBADF.
  { name: "host_dup2", method: METHOD.SYS_DUP2, args: ["scalar", "scalar"] },

  // ── Path-based fs ops (single path) ────────────────────────
  // host_mkdir(pathPtr, pathLen) → 0 / -errno.
  { name: "host_mkdir", method: METHOD.SYS_MKDIR, args: ["ptr_len"] },
  // host_rmdir doesn't have a TS-side counterpart of identical
  // shape — bash uses host_remove for both. Leave SYS_RMDIR
  // unbound until a caller materializes.
  // host_stat(pathPtr, pathLen, outPtr, outCap) → bytes-written
  // (kernel writes a 16-byte fstat record).
  {
    name: "host_stat",
    method: METHOD.SYS_STAT,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_readlink(pathPtr, pathLen, outPtr, outCap) → bytes-written.
  {
    name: "host_readlink",
    method: METHOD.SYS_READLINK,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_readdir(pathPtr, pathLen, outPtr, outCap) → bytes-written.
  {
    name: "host_readdir",
    method: METHOD.SYS_READDIR,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },

  // ── Chmod / chown / utimens ───────────────────────────────
  // host_chmod(pathPtr, pathLen, mode) → 0 / -errno. Kernel wire
  // expects (u32 mode, path); permute the incoming args.
  {
    name: "host_chmod",
    method: METHOD.SYS_CHMOD,
    args: ["scalar", "ptr_len"],
    argOrder: [2, 0, 1],
  },

  // ── Multi-path ops (rename, symlink, link) ────────────────
  // host_rename(fromPtr, fromLen, toPtr, toLen) → 0 / -errno.
  // Kernel wire: u32 old_len + old + new.
  {
    name: "host_rename",
    method: METHOD.SYS_RENAME,
    args: ["prefixed_ptr_len", "ptr_len"],
  },
  // host_symlink(targetPtr, targetLen, linkPtr, linkLen) → 0/-errno.
  // Kernel wire: u32 target_len + target + linkpath.
  {
    name: "host_symlink",
    method: METHOD.SYS_SYMLINK,
    args: ["prefixed_ptr_len", "ptr_len"],
  },

  // ── Misc ──────────────────────────────────────────────────
  // host_yield() — async fairness hint. Maps to SYS_SCHED_YIELD;
  // TS host_yield returns void, our wrapper returns Promise<number>
  // (rc), but wasm-side discards rc here.
  { name: "host_yield", method: METHOD.SYS_SCHED_YIELD, args: [] },

  // ── fd duplicate (rc_to_out shape) ────────────────────────
  // host_dup(fd, outPtr, outCap) — kernel SYS_DUP returns the
  // new fd as rc; the rc_to_out spec writes it into outPtr as
  // i32 LE and returns bytes-written (4).
  {
    name: "host_dup",
    method: METHOD.SYS_DUP,
    args: ["scalar", "rc_to_out"],
  },

  // ── Path-with-ignored-flag ─────────────────────────────────
  // host_remove(pathPtr, pathLen, recursive). SYS_UNLINK is
  // non-recursive; recursive scalar is consumed and dropped.
  // Bash callers that want recursive removal walk readdir
  // themselves — same as TS behavior on the platform.
  {
    name: "host_remove",
    method: METHOD.SYS_UNLINK,
    args: ["ptr_len", "ignore_scalar"],
  },

  // ── Networking ────────────────────────────────────────────
  // host_network_fetch(reqPtr, reqLen, outPtr, outCap) → bytes.
  // Same wire shape as host_native_invoke; SYS_FETCH consumes
  // the JSON request and writes the JSON response.
  {
    name: "host_network_fetch",
    method: METHOD.SYS_FETCH,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_socket_connect(addrPtr, addrLen, flags) → handle / -errno.
  // SYS_SOCKET_CONNECT currently keeps an 8-byte header for future
  // family/type expansion: u8 family + u8 sock_type + u16 pad +
  // u32 flags, followed by UTF-8 "host:port" bytes.
  {
    name: "host_socket_connect",
    method: METHOD.SYS_SOCKET_CONNECT,
    args: [],
    custom: (mk, memBuf) =>
    async (
      addrPtr: number,
      addrLen: number,
      flags: number,
    ): Promise<number> => {
      const addr = new Uint8Array(memBuf(), addrPtr, addrLen).slice();
      const req = new Uint8Array(8 + addr.length);
      new DataView(req.buffer).setUint32(4, flags >>> 0, true);
      req.set(addr, 8);
      const out = await mk.syscallAsync(METHOD.SYS_SOCKET_CONNECT, req, 0);
      return Number(out.rc);
    },
  },
  // host_socket_listen(backlog, addrPtr, addrLen) → handle / -errno.
  // SYS_SOCKET_LISTEN accepts u32 backlog + UTF-8 "host:port" bytes.
  {
    name: "host_socket_listen",
    method: METHOD.SYS_SOCKET_LISTEN,
    args: ["scalar", "ptr_len"],
  },
  // host_socket_accept(fd, flags) → handle / -errno.
  // SYS_SOCKET_ACCEPT accepts u32 handle + u32 flags.
  {
    name: "host_socket_accept",
    method: METHOD.SYS_SOCKET_ACCEPT,
    args: ["scalar", "scalar"],
  },
  // host_socket_addr(fd, outPtr, outCap) → bytes.
  // SYS_SOCKET_ADDR accepts u32 handle and writes the packed address record.
  {
    name: "host_socket_addr",
    method: METHOD.SYS_SOCKET_ADDR,
    args: ["scalar", "out_cap"],
    returnsBytes: true,
  },
  // host_socket_send(fd, dataPtr, dataLen, flags) → bytes.
  // SYS_SOCKET_SEND accepts u32 handle + payload bytes. The
  // direct host ABI still carries flags, but this syscall method
  // has no flags slot.
  {
    name: "host_socket_send",
    method: METHOD.SYS_SOCKET_SEND,
    args: ["scalar", "ptr_len"],
    argOrder: [0, 1, 2],
  },
  // host_socket_recv(fd, outPtr, outCap, flags) → bytes.
  // SYS_SOCKET_RECV accepts u32 handle + u32 flags and returns
  // recv bytes in the response buffer.
  {
    name: "host_socket_recv",
    method: METHOD.SYS_SOCKET_RECV,
    args: ["scalar", "scalar", "out_cap"],
    argOrder: [0, 3, 1, 2],
    returnsBytes: true,
  },
  // host_socket_close(fd) → 0 / -errno.
  // SYS_SOCKET_CLOSE: u32 handle in request, no response.
  {
    name: "host_socket_close",
    method: METHOD.SYS_SOCKET_CLOSE,
    args: ["scalar"],
  },

  // ── Durable KV / IndexedDB-shaped persistence ─────────────
  // host_idb_get(reqPtr, reqLen, outPtr, outCap) → bytes.
  {
    name: "host_idb_get",
    method: METHOD.SYS_IDB_GET,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },
  // host_idb_put(reqPtr, reqLen) → 0 / -errno.
  {
    name: "host_idb_put",
    method: METHOD.SYS_IDB_PUT,
    args: ["ptr_len"],
  },
  // host_idb_delete(reqPtr, reqLen) → 0 / -errno.
  {
    name: "host_idb_delete",
    method: METHOD.SYS_IDB_DELETE,
    args: ["ptr_len"],
  },
  // host_idb_list(reqPtr, reqLen, outPtr, outCap) → bytes.
  {
    name: "host_idb_list",
    method: METHOD.SYS_IDB_LIST,
    args: ["ptr_len", "out_cap"],
    returnsBytes: true,
  },

  // ── Custom builders (wire-format adapters) ────────────────
  // host_time() → seconds-as-float. TS impl returns
  // `Date.now() / 1000`. We route through SYS_CLOCK_GETTIME
  // with CLOCK_REALTIME (=0) and divide the u64 ns response
  // by 1e9 to match. Demonstrates the `custom` escape hatch
  // for bindings whose shape doesn't fit ArgSpec.
  {
    name: "host_time",
    method: METHOD.SYS_CLOCK_GETTIME,
    args: [],
    custom: (mk) => async (): Promise<number> => {
      const req = new Uint8Array(4); // CLOCK_REALTIME = 0
      const out = await mk.syscallAsync(METHOD.SYS_CLOCK_GETTIME, req, 8);
      if (Number(out.rc) !== 8) return 0;
      const ns = new DataView(
        out.response.buffer,
        out.response.byteOffset,
        8,
      ).getBigUint64(0, true);
      return Number(ns) / 1e9;
    },
  },

  // host_read_file(pathPtr, pathLen, outPtr, outCap) → bytes.
  // Compound: SYS_OPEN(flags=0, path) → fd → SYS_READ(fd) →
  // SYS_CLOSE(fd). Close happens even if read fails.
  {
    name: "host_read_file",
    method: METHOD.SYS_OPEN, // first hop; documentation only
    args: [],
    custom: (mk, memBuf) =>
    async (
      pathPtr: number,
      pathLen: number,
      outPtr: number,
      outCap: number,
    ): Promise<number> => {
      const path = new Uint8Array(memBuf(), pathPtr, pathLen).slice();
      const openReq = new Uint8Array(4 + path.length);
      // flags=0 → read-only.
      openReq.set(path, 4);
      const openOut = await mk.syscallAsync(METHOD.SYS_OPEN, openReq, 0);
      const fd = Number(openOut.rc);
      if (fd < 0) return fd;
      try {
        const readReq = new Uint8Array(4);
        new DataView(readReq.buffer).setUint32(0, fd, true);
        const readOut = await mk.syscallAsync(METHOD.SYS_READ, readReq, outCap);
        const n = Number(readOut.rc);
        if (n > 0) {
          new Uint8Array(memBuf(), outPtr, n).set(
            readOut.response.subarray(0, n),
          );
        }
        return n;
      } finally {
        const closeReq = new Uint8Array(4);
        new DataView(closeReq.buffer).setUint32(0, fd, true);
        await mk.syscallAsync(METHOD.SYS_CLOSE, closeReq, 0);
      }
    },
  },

  // host_write_file(pathPtr, pathLen, dataPtr, dataLen, mode) → bytes.
  // Compound: SYS_OPEN(O_WRITE|O_CREAT [|O_TRUNC]) → optional
  // SYS_LSEEK(SEEK_END) for mode=1 (append) → SYS_WRITE →
  // SYS_CLOSE.
  {
    name: "host_write_file",
    method: METHOD.SYS_OPEN,
    args: [],
    custom: (mk, memBuf) =>
    async (
      pathPtr: number,
      pathLen: number,
      dataPtr: number,
      dataLen: number,
      mode: number,
    ): Promise<number> => {
      const path = new Uint8Array(memBuf(), pathPtr, pathLen).slice();
      // mode 0 = overwrite (truncate); mode 1 = append.
      const flags = mode === 1 ? 0b011 : 0b111; // W|C [|T]
      const openReq = new Uint8Array(4 + path.length);
      new DataView(openReq.buffer).setUint32(0, flags, true);
      openReq.set(path, 4);
      const openOut = await mk.syscallAsync(METHOD.SYS_OPEN, openReq, 0);
      const fd = Number(openOut.rc);
      if (fd < 0) return fd;
      try {
        if (mode === 1) {
          // Seek to end. Request: u32 fd + i64 offset (0) + u32
          // whence (SEEK_END=2). Response: 8-byte new offset.
          const lseekReq = new Uint8Array(16);
          const lv = new DataView(lseekReq.buffer);
          lv.setUint32(0, fd, true);
          lv.setBigInt64(4, 0n, true);
          lv.setUint32(12, 2, true);
          await mk.syscallAsync(METHOD.SYS_LSEEK, lseekReq, 8);
        }
        const data = new Uint8Array(memBuf(), dataPtr, dataLen).slice();
        const writeReq = new Uint8Array(4 + data.length);
        new DataView(writeReq.buffer).setUint32(0, fd, true);
        writeReq.set(data, 4);
        const writeOut = await mk.syscallAsync(METHOD.SYS_WRITE, writeReq, 0);
        return Number(writeOut.rc);
      } finally {
        const closeReq = new Uint8Array(4);
        new DataView(closeReq.buffer).setUint32(0, fd, true);
        await mk.syscallAsync(METHOD.SYS_CLOSE, closeReq, 0);
      }
    },
  },
  // ── Signals ───────────────────────────────────────────────
  // sigaction(sig, actPtr, actLen) — TS host_sigaction shape.
  // Not in our common test path; left to a future expansion.

  // ── Clock ─────────────────────────────────────────────────
  // host_clock_gettime(clockId, outPtr) → 8 bytes (u64 ns)
  // Existing TS signature is (clockId, outPtr) without a cap;
  // the fixed_out arg spec supplies the 8-byte response capacity.
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
    imports[b.name] = b.custom
      ? b.custom(mk, memBuf)
      : makeWrapper(b, mk, memBuf);
  }
  return imports;
}

function makeWrapper(
  b: HostBinding,
  mk: Microkernel,
  memBuf: () => ArrayBuffer,
): (...args: number[]) => Promise<number> {
  return async (...args: number[]): Promise<number> => {
    // Apply optional argument permutation. The reordered view is
    // what the spec walker consumes; the original `args` is the
    // shape bash (or any TS-host-shaped caller) passes.
    const ordered = b.argOrder ? b.argOrder.map((i) => args[i]) : args;
    const reqParts: Uint8Array[] = [];
    let outPtr = 0;
    let outCap = 0;
    let rcToOutPtr: number | null = null;
    let rcToOutCap = 0;
    let ai = 0;
    for (const spec of b.args) {
      if (spec === "scalar") {
        const v = ordered[ai++] >>> 0;
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, v, true);
        reqParts.push(bytes);
      } else if (spec === "scalar64") {
        const raw = ordered[ai++];
        const v = typeof raw === "bigint" ? raw : BigInt(raw >>> 0);
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, v as bigint, true);
        reqParts.push(bytes);
      } else if (spec === "ptr_len") {
        const ptr = ordered[ai++] >>> 0;
        const len = ordered[ai++] >>> 0;
        const slice = new Uint8Array(memBuf(), ptr, len).slice();
        reqParts.push(slice);
      } else if (spec === "prefixed_ptr_len") {
        const ptr = ordered[ai++] >>> 0;
        const len = ordered[ai++] >>> 0;
        const lenBytes = new Uint8Array(4);
        new DataView(lenBytes.buffer).setUint32(0, len, true);
        reqParts.push(lenBytes);
        reqParts.push(new Uint8Array(memBuf(), ptr, len).slice());
      } else if (spec === "out_cap") {
        outPtr = ordered[ai++] >>> 0;
        outCap = ordered[ai++] >>> 0;
      } else if (typeof spec === "object" && spec.kind === "fixed_out") {
        outPtr = ordered[ai++] >>> 0;
        outCap = spec.cap;
      } else if (spec === "rc_to_out") {
        rcToOutPtr = ordered[ai++] >>> 0;
        rcToOutCap = ordered[ai++] >>> 0;
      } else if (spec === "ignore_scalar") {
        ai++;
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
    if (rcToOutPtr !== null) {
      if (rc >= 0 && rcToOutCap >= 4) {
        const view = new DataView(memBuf(), rcToOutPtr, 4);
        view.setInt32(0, rc, true);
        return 4;
      }
      return rc;
    }
    return rc;
  };
}
