/**
 * Unified host import implementations for the `yurt` WASM namespace.
 *
 * createKernelImports() returns a record of functions that form the `yurt`
 * import namespace consumed by ANY WASM process (shell, python, tool binaries).
 *
 * Syscalls provided:
 *   Process management (new):
 *   - host_pipe: create a pipe, returns read_fd and write_fd
 *   - host_spawn: spawn a child WASM process
 *   - host_waitpid: wait for a child process to exit (async, requires JSPI)
 *   - host_close_fd: close a file descriptor
 *
 *   Network / extensions:
 *   - host_network_fetch: HTTP fetch via NetworkBridge (async/JSPI)
 *   - host_extension_invoke: call a host extension (Python only; shell uses host_spawn)
 *   - host_run_command: run a shell command and collect output (async/JSPI, Python subprocess)
 */

import type { FetchRedirectMode, NetworkBridgeLike } from '../network/bridge.js';
import type { SocketBackend, SocketListenPolicy, SocketPortMapping } from '../network/socket-backend.js';
import { createLoopbackSocketBackend, createNetworkBridgeSocketBackend } from '../network/socket-backend.js';
import type { ExtensionRegistry } from '../extension/registry.js';
import type { NativeModuleRegistry } from '../process/native-modules.js';
import type { ProcessKernel, SpawnRequest } from '../process/kernel.js';
import type { WasiHost } from '../wasi/wasi-host.js';
import type { ThreadsBackend } from '../process/threads/backend.js';
import type { VfsLike } from '../vfs/vfs-like.js';
import type { FdTarget } from '../wasi/fd-target.js';
import { createStaticTarget } from '../wasi/fd-target.js';
import { WASI_FDFLAGS_NONBLOCK } from '../wasi/types.ts';
import { readString, writeJson } from './common.js';
import type { RunCommandHandler, RunRequest } from '../run-command.js';
import type { Sandbox } from '../sandbox.js';

export interface KernelImportsOptions {
  memory: WebAssembly.Memory;

  /** PID of the calling process (used for fd table lookups). */
  callerPid?: number;

  /** Process kernel for pipe/spawn/waitpid/close_fd. Optional until Task 8. */
  kernel?: ProcessKernel;

  /** VFS backing this process. Used by generic file metadata imports. */
  vfs?: VfsLike;

  /** Network bridge for synchronous HTTP fetch from WASM. */
  networkBridge?: NetworkBridgeLike;

  /** Backend for fd-based POSIX socket imports. Defaults to a NetworkBridge adapter. */
  socketBackend?: SocketBackend;

  /** Fake sandbox-local IPv4 address reported by getsockname()/socket_addr(). */
  socketLocalHost?: string;

  /** Prepared policy surface for future bind/listen/accept support. */
  serverSockets?: SocketListenPolicy;

  /**
   * Extension registry for host_extension_invoke (used by Python WASM).
   * The shell no longer calls host_extension_invoke — it routes everything
   * through host_spawn, and the ProcessManager dispatches to host commands.
   */
  extensionRegistry?: ExtensionRegistry;

  /**
   * Legacy extension handler (sync, used by Worker proxy).
   * If both extensionRegistry and extensionHandler are provided,
   * extensionRegistry takes precedence.
   */
  extensionHandler?: (cmd: Record<string, unknown>) => Record<string, unknown>;

  /** Run a shell command and collect output. Used by Python _yurt.spawn(). */
  runCommand?: (cmd: string, stdin: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

  /** Host-registered handler for guest-issued host_run_command. */
  runCommandHandler?: RunCommandHandler;

  /** Sandbox instance supplied to RunCommandContext when invoking runCommandHandler. */
  sandbox?: Sandbox;

  /**
   * Legacy synchronous spawn handler for the shell's 4-argument host_spawn ABI.
   * The generic process ABI is host_spawn(req_ptr, req_len) -> pid. The shell
   * test/legacy ABI is host_spawn(req_ptr, req_len, out_ptr, out_cap) -> bytes.
   */
  syncSpawn?: (
    cmd: string,
    args: string[],
    env: Record<string, string>,
    stdin: Uint8Array,
    cwd: string,
  ) => { exit_code: number; stdout: string; stderr: string };

  /** Called by host_spawn to actually create and start a WASM process.
   *  `parentPid` is the PID of the in-sandbox process making the spawn
   *  call — set on the child as ppid so getppid() inside the child
   *  resolves to its real spawning parent. */
  spawnProcess?: (req: SpawnRequest, fdTable: Map<number, FdTarget>, parentPid: number) => number;

  /** Registry of dynamically loaded native Python module WASMs. */
  nativeModules?: NativeModuleRegistry;

  /** Active WASI host for guest-side fd operations such as dup2 on stdio. */
  wasiHost?: WasiHost;

  /** Backend for guest pthread/std::thread host imports. */
  threadsBackend?: ThreadsBackend;
}

export function createKernelImports(opts: KernelImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { memory } = opts;
  const callerPid = opts.callerPid ?? 0;
  const bridgeSocketBackend = opts.networkBridge ? createNetworkBridgeSocketBackend(opts.networkBridge) : undefined;
  const socketBackend = opts.socketBackend ??
    (opts.serverSockets?.allowLoopback === true
      ? createLoopbackSocketBackend(bridgeSocketBackend)
      : bridgeSocketBackend);
  const socketLocalHost = opts.socketLocalHost ?? '10.0.2.15';
  const socketLocalPortForFd = (fd: number) => 49152 + (Math.max(0, fd - 3) % 16384);

  function bytesToBase64(data: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < data.byteLength; i++) {
      binary += String.fromCharCode(data[i]);
    }
    return btoa(binary);
  }

  function base64ToBytes(value: string): Uint8Array {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  }

  function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
    const out = new Uint8Array(left.byteLength + right.byteLength);
    out.set(left, 0);
    out.set(right, left.byteLength);
    return out;
  }

  function authorizeListen(
    policy: SocketListenPolicy | undefined,
    host: '127.0.0.1' | 'localhost' | '0.0.0.0',
    port: number,
    backlog: number,
  ): { ok: true; mapping?: SocketPortMapping } | { ok: false; error: string } {
    if (!policy) {
      return { ok: false, error: `listen on ${host}:${port} is not allowed by sandbox policy` };
    }
    if (host === '127.0.0.1' || host === 'localhost') {
      if (policy.allowLoopback === true) return { ok: true };
      return { ok: false, error: `listen on ${host}:${port} is not allowed by sandbox policy` };
    }
    const mapping = policy.portMappings?.find((m) =>
      m.sandboxHost === '0.0.0.0' && m.sandboxPort === port
    );
    if (!mapping) {
      return { ok: false, error: `listen on 0.0.0.0:${port} requires an explicit port mapping` };
    }
    const allowed = policy.onListen?.({ host, port, backlog, mapping });
    if (allowed === false) {
      return { ok: false, error: `listen on 0.0.0.0:${port} was denied by sandbox policy` };
    }
    if (allowed && typeof (allowed as Promise<boolean>).then === 'function') {
      return { ok: false, error: 'async listen authorization is not supported by synchronous socket imports' };
    }
    return { ok: true, mapping };
  }

  const imports: Record<string, WebAssembly.ImportValue> = {
    // ── Process management (new) ──

    // host_pipe(out_ptr, out_cap) -> i32
    // Creates a pipe and writes { read_fd, write_fd } as JSON to the output buffer.
    host_pipe(outPtr: number, outCap: number): number {
      if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { error: 'kernel not available' });
      }
      const { readFd, writeFd } = opts.kernel.createPipe(callerPid);
      if (opts.wasiHost) {
        const ioFds = opts.wasiHost.getIoFds();
        const readTarget = opts.kernel.getFdTarget(callerPid, readFd);
        const writeTarget = opts.kernel.getFdTarget(callerPid, writeFd);
        if (readTarget) ioFds.set(readFd, readTarget);
        if (writeTarget) ioFds.set(writeFd, writeTarget);
      }
      return writeJson(memory, outPtr, outCap, { read_fd: readFd, write_fd: writeFd });
    },

    // host_spawn(req_ptr, req_len) -> i32 (pid or -1 on error)
    // Spawns a child WASM process. The request is a JSON SpawnRequest.
    //
    // Compatibility: shell-exec also imports a legacy synchronous
    // host_spawn(req_ptr, req_len, out_ptr, out_cap) ABI for tests. Keep
    // that branch here so shell-imports.ts remains shell-specific.
    host_spawn(reqPtr: number, reqLen: number, outPtr?: number, outCap?: number): number {
      const reqJson = readString(memory, reqPtr, reqLen);
      if (typeof outPtr === 'number' && typeof outCap === 'number') {
        let req: { program?: string; args?: string[]; env?: [string, string][]; cwd?: string; stdin?: string; stdin_fd?: number };
        try { req = JSON.parse(reqJson); } catch { req = {}; }

        const cmd = req.program ?? '';
        const args = req.args?.map(String) ?? [];
        const env: Record<string, string> = {};
        if (req.env) for (const [k, v] of req.env) env[k] = v;
        const cwd = req.cwd ?? '/';
        let stdinStr = req.stdin ?? '';
        if (!stdinStr && typeof req.stdin_fd === 'number' && opts.kernel) {
          const stdinTarget = opts.kernel.getFdTarget(callerPid, req.stdin_fd);
          if (stdinTarget?.type === 'static') {
            stdinStr = new TextDecoder().decode(stdinTarget.data.slice(stdinTarget.offset));
          } else if (stdinTarget?.type === 'pipe_read') {
            stdinStr = new TextDecoder().decode(stdinTarget.pipe.drainSync());
          }
        }
        const stdin = new TextEncoder().encode(stdinStr);

        if (opts.syncSpawn) {
          try {
            const result = opts.syncSpawn(cmd, args, env, stdin, cwd);
            return writeJson(memory, outPtr, outCap, result);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            return writeJson(memory, outPtr, outCap, {
              exit_code: 127,
              stdout: '',
              stderr: `${cmd}: ${msg}\n`,
            });
          }
        }

        return writeJson(memory, outPtr, outCap, {
          exit_code: 127,
          stdout: '',
          stderr: `${cmd}: sync spawn not available\n`,
        });
      }

      const req = JSON.parse(reqJson) as SpawnRequest;
      if (opts.spawnProcess && opts.kernel) {
        const fdTable = opts.kernel.buildFdTableForSpawn(callerPid, req);
        // If stdin_data is provided, override fd 0 with a static target
        if (req.stdin_data) {
          fdTable.set(0, createStaticTarget(new TextEncoder().encode(req.stdin_data)));
        }
        return opts.spawnProcess(req, fdTable, callerPid);
      }
      return -1;
    },

    // host_getpid() -> i32
    // Returns the pid of the calling process within the yurt kernel.
    host_getpid(): number {
      return callerPid;
    },

    // host_getppid() -> i32
    // Returns the parent pid of the calling process, or 0 if no
    // in-sandbox parent (the topmost process — typically the shell —
    // sees getppid() == 0, mirroring Linux init).
    host_getppid(): number {
      return opts.kernel ? opts.kernel.getPpid(callerPid) : 0;
    },

    // host_kill(pid, sig) -> i32
    // Best-effort signal delivery: cancels the target's WASI host so it
    // exits with WasiExitError(124).  This is enough for `kill -TERM` /
    // `kill -9` style termination from one in-sandbox process to another.
    // Returns 0 on success, -1 with errno=ESRCH (3) if no such process,
    // mirroring kill(2).
    host_kill(pid: number, sig: number): number {
      if (!opts.kernel) return -1;
      const exists = opts.kernel
        .listProcesses()
        .some(p => p.pid === pid && p.state !== 'exited');
      if (!exists) return -1;
      // sig 0 is the existence probe — POSIX requires no signal sent.
      if (sig === 0) return 0;
      return opts.kernel.killProcess(pid, sig) ? 0 : -1;
    },

    // host_waitpid(pid, out_ptr, out_cap) -> i32
    // Async — must be wrapped with WebAssembly.Suspending for JSPI.
    // Waits for the child process to exit and writes { exit_code } to the output buffer.
    async host_waitpid(pid: number, outPtr: number, outCap: number): Promise<number> {
      if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { exit_code: -1 });
      }
      const exitCode = await opts.kernel.waitpid(pid);
      return writeJson(memory, outPtr, outCap, { exit_code: exitCode });
    },

    // host_close_fd(fd) -> i32
    // Closes a file descriptor in the caller's fd table.
    host_close_fd(fd: number): number {
      if (!opts.kernel) return -1;
      opts.kernel.closeFd(callerPid, fd);
      opts.wasiHost?.getIoFds().delete(fd);
      return 0;
    },

    // host_file_lock(fd, operation) -> i32
    // flock(2)-style advisory locking for VFS file descriptors.
    host_file_lock(fd: number, operation: number): number {
      if (!opts.kernel) return -38; // ENOSYS
      const LOCK_SH = 1;
      const LOCK_EX = 2;
      const LOCK_UN = 8;
      if ((operation & LOCK_UN) !== 0) {
        const errno = opts.kernel.unlockFile(callerPid, fd);
        return errno === 0 ? 0 : -errno;
      }
      const exclusive = (operation & LOCK_EX) !== 0;
      if (!exclusive && (operation & LOCK_SH) === 0) return -22; // EINVAL
      const errno = opts.kernel.lockFile(callerPid, fd, exclusive);
      return errno === 0 ? 0 : -errno;
    },

    // host_read_fd(fd, out_ptr, out_cap) -> i32
    // Reads all available data from a pipe fd and writes it to the output buffer.
    host_read_fd(fd: number, outPtr: number, outCap: number): number {
      if (!opts.kernel) {
        return writeJson(memory, outPtr, outCap, { error: 'kernel not available' });
      }
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== 'pipe_read') {
        return writeJson(memory, outPtr, outCap, { error: `not a readable fd: ${fd}` });
      }
      const data = target.pipe.drainSync();
      const str = new TextDecoder().decode(data);
      const buf = new Uint8Array(memory.buffer, outPtr, outCap);
      const encoded = new TextEncoder().encode(str);
      if (encoded.length > outCap) return encoded.length; // signal retry with larger buffer
      buf.set(encoded);
      return encoded.length;
    },

    // host_write_fd(fd, data_ptr, data_len) -> i32
    // Writes data to a pipe fd. Returns bytes written, or negative error code.
    host_write_fd(fd: number, dataPtr: number, dataLen: number): number {
      if (!opts.kernel) return -1;
      const target = opts.kernel.getFdTarget(callerPid, fd);
      if (!target || target.type !== 'pipe_write') {
        return -1;
      }
      const data = new Uint8Array(memory.buffer, dataPtr, dataLen);
      target.pipe.write(new Uint8Array(data)); // copy since wasm memory may shift
      return dataLen;
    },

    // host_dup(fd, out_ptr, out_cap) -> i32
    // Duplicates a file descriptor, returning a new fd pointing to the same target.
    host_dup(fd: number, outPtr: number, outCap: number): number {
      if (!opts.kernel) return -1;
      try {
        const newFd = opts.kernel.dup(callerPid, fd);
        return writeJson(memory, outPtr, outCap, { fd: newFd });
      } catch { return -1; }
    },

    // host_dup2(src_fd, dst_fd) -> i32
    // Makes dst_fd point to the same target as src_fd.
    host_dup2(srcFd: number, dstFd: number): number {
      let wasiResult = 0;
      if (opts.wasiHost) {
        wasiResult = opts.wasiHost.renumberFd(srcFd, dstFd) === 0 ? 0 : -1;
      }
      if (!opts.kernel) return wasiResult;
      try {
        opts.kernel.dup2(callerPid, srcFd, dstFd);
        return wasiResult === -1 ? -1 : 0;
      } catch { return -1; }
    },

    // host_setjmp(env_ptr) -> i32
    // POSIX setjmp via Asyncify.  Phase 1 (this commit): a stub that
    // returns 0 on every call — sufficient for any guest binary that
    // links setjmp's prototype but never actually invokes it (most
    // applets), and for callers that ignore setjmp's return value.
    // Phase 2 will drive the Asyncify state machine to capture the
    // current save-state into env and return the matching longjmp val
    // on rewind.  Keeping a stub here unblocks the build so toolchain
    // changes (--asyncify pass, dropped -wasm-enable-sjlj) ship
    // alongside the host-side stub; the full impl is contained.
    host_setjmp(envPtr: number): number {
      void envPtr;
      return 0;
    },

    // host_longjmp(env_ptr, val) -> void
    // Phase 1 stub: a longjmp call without a matching setjmp save is
    // undefined behavior in POSIX — we surface it as a guest abort
    // (WasiExit 134, the SIGABRT exit code) rather than silently
    // returning, so a misuse during the stub period is loud rather
    // than a mysterious continuation.  Phase 2 replaces this with the
    // real Asyncify-driven unwind+rewind back to the matching
    // host_setjmp call site.
    host_longjmp(envPtr: number, val: number): void {
      void envPtr; void val;
      if (opts.wasiHost) opts.wasiHost.cancelExecution();
      throw new Error('longjmp without matching setjmp (Asyncify-based sjlj is Phase 2)');
    },

    // host_yield() -> void
    // Async — yields to the JS microtask queue, allowing other WASM stacks to run.
    // This is the cooperative scheduling primitive: sleep(0).
    async host_yield(): Promise<void> {
      await Promise.resolve();
    },

    // host_waitpid_nohang(pid) -> i32
    // Non-blocking: returns exit code if process exited, -1 if still running.
    host_waitpid_nohang(pid: number): number {
      if (!opts.kernel) return -1;
      return opts.kernel.waitpidNohang(pid);
    },

    // host_list_processes(out_ptr, out_cap) -> i32
    // Returns JSON array of all processes.
    host_list_processes(outPtr: number, outCap: number): number {
      if (!opts.kernel) return writeJson(memory, outPtr, outCap, []);
      const procs = opts.kernel.listProcesses();
      return writeJson(memory, outPtr, outCap, procs);
    },

    // ── Network ──

    // host_network_fetch(req_ptr, req_len, out_ptr, out_cap) -> i32
    // HTTP fetch via NetworkBridge. Async (JSPI) to support both SAB-based
    // bridges (Node/Deno) and direct fetch() in the browser.
    async host_network_fetch(reqPtr: number, reqLen: number, outPtr: number, outCap: number): Promise<number> {
      const reqJson = readString(memory, reqPtr, reqLen);

      const fetchError = (error: string) =>
        writeJson(memory, outPtr, outCap, { ok: false, status: 0, headers: {}, body: '', body_base64: null, error });

      if (!opts.networkBridge) {
        return fetchError('networking not configured');
      }

      try {
        const req = JSON.parse(reqJson) as {
          url?: string;
          method?: string;
          headers?: Record<string, string>;
          body?: string;
          redirect?: FetchRedirectMode;
        };
        const url = req.url as string;
        const method = (req.method as string) ?? 'GET';
        const headers = (req.headers as Record<string, string>) ?? {};
        const body = req.body as string | undefined;
        const redirect: FetchRedirectMode = req.redirect === 'manual' ? 'manual' : 'follow';

        // Use async fetch if available (browser), otherwise fall back to sync (SAB bridge)
        const result = opts.networkBridge.fetchAsync
          ? await opts.networkBridge.fetchAsync(url, method, headers, body, redirect)
          : opts.networkBridge.fetchSync(url, method, headers, body, redirect);
        return writeJson(memory, outPtr, outCap, {
          ok: !result.error && result.status >= 200 && result.status < 400,
          status: result.status,
          headers: result.headers,
          body: result.body,
          body_base64: result.body_base64 ?? null,
          error: result.error ?? null,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return fetchError(msg);
      }
    },

    // ── Native module bridge ──

    // host_native_invoke(module_ptr, module_len, method_ptr, method_len,
    //                    args_ptr, args_len, out_ptr, out_cap) -> i32
    // Dynamic native module dispatch. Currently consumed by RustPython's
    // native-module bridge; this is Python-coupled debt scheduled to clear
    // with the CPython port. New userlands should not depend on Python-specific
    // module invocation from the kernel.
    host_native_invoke(
      modulePtr: number, moduleLen: number,
      methodPtr: number, methodLen: number,
      argsPtr: number, argsLen: number,
      outPtr: number, outCap: number,
    ): number {
      if (!opts.nativeModules) {
        return writeJson(memory, outPtr, outCap, { error: 'native modules not available' });
      }
      const moduleName = readString(memory, modulePtr, moduleLen);
      const method = readString(memory, methodPtr, methodLen);
      const argsJson = readString(memory, argsPtr, argsLen);

      try {
        const result = opts.nativeModules.invoke(moduleName, method, argsJson);
        const encoded = new TextEncoder().encode(result);
        if (encoded.length > outCap) {
          return encoded.length; // signal need more space
        }
        new Uint8Array(memory.buffer, outPtr, encoded.length).set(encoded);
        return encoded.length;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { error: msg });
      }
    },

    // ── Sockets (full mode only) ──

    // host_socket_open(domain, type, protocol) -> fd
    // Allocates a kernel-owned socket fd. connect() fills in the backend handle later.
    host_socket_open(_domain: number, _type: number, _protocol: number): number {
      if (!opts.kernel) return -1;
      return opts.kernel.allocFd(callerPid, {
        type: 'socket',
        socket: null,
        refs: 1,
        send: (socket, dataB64) => socketBackend?.send(socket, dataB64) ?? { ok: false, error: 'networking not configured' },
        recv: (socket, maxBytes, recvOpts) => socketBackend?.recv(socket, maxBytes, recvOpts) ?? { ok: false, error: 'networking not configured' },
        setNoDelay: (socket, enabled) => socketBackend?.setNoDelay?.(socket, enabled) ?? { ok: false, error: 'TCP_NODELAY not supported by socket backend' },
        close: (socket) => {
          socketBackend?.close(socket);
        },
      });
    },

    // host_socket_connect(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Opens a TCP or TLS socket to the given host:port.
    // Request JSON: { fd, host, port, tls }
    // Response JSON: { ok: true } or { ok: false, error }
    host_socket_connect(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!socketBackend) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a socket fd: ${req.fd}` });
        }
        const result = socketBackend.connect({
          host: req.host, port: req.port, tls: req.tls ?? false,
        });
        if (result.ok) {
          if (target.noDelay) {
            const optionResult = target.setNoDelay?.(result.socket, true)
              ?? { ok: false, error: 'TCP_NODELAY not supported by socket backend' };
            if (!optionResult.ok) return writeJson(memory, outPtr, outCap, optionResult);
          }
          target.socket = result.socket;
          target.peerHost = typeof req.host === 'string' ? req.host : '0.0.0.0';
          target.peerPort = typeof req.port === 'number' ? req.port : 0;
          target.localHost = socketLocalHost;
          target.localPort = socketLocalPortForFd(req.fd);
          return writeJson(memory, outPtr, outCap, { ok: true });
        }
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_bind(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Records the sandbox-visible local address requested for a socket fd.
    host_socket_bind(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a socket fd: ${req.fd}` });
        }
        const host = req.host === 'localhost' ? 'localhost' : req.host;
        if (host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `unsupported bind host: ${String(req.host)}` });
        }
        if (typeof req.port !== 'number' || req.port < 0 || req.port > 65535) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `invalid bind port: ${String(req.port)}` });
        }
        target.boundHost = host;
        target.boundPort = req.port;
        target.localHost = host === '0.0.0.0' ? socketLocalHost : host;
        target.localPort = req.port;
        return writeJson(memory, outPtr, outCap, { ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_listen(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Creates a backend listener for a socket fd after sandbox policy authorizes it.
    host_socket_listen(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a socket fd: ${req.fd}` });
        }
        const host = target.boundHost ?? '127.0.0.1';
        const port = target.boundPort ?? 0;
        const backlog = typeof req.backlog === 'number' && req.backlog > 0 ? req.backlog : 128;
        const auth = authorizeListen(opts.serverSockets, host, port, backlog);
        if (!auth.ok) return writeJson(memory, outPtr, outCap, auth);
        if (!socketBackend?.listen) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'server sockets are not supported by this backend' });
        }
        const result = socketBackend.listen({ host, port, backlog, mapping: auth.mapping });
        if (!result.ok) return writeJson(memory, outPtr, outCap, result);
        target.listener = result.listener;
        target.boundHost = host;
        target.boundPort = port;
        target.localHost = result.host;
        target.localPort = result.port;
        target.closeListener = (listener) => { socketBackend.closeListener?.(listener); };
        return writeJson(memory, outPtr, outCap, { ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_accept(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Polls one accepted connection from a listening socket fd.
    async host_socket_accept(reqPtr: number, reqLen: number, outPtr: number, outCap: number): Promise<number> {
      if (!socketBackend?.accept) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'server sockets are not supported by this backend' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket' || target.listener == null) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a listening socket fd: ${req.fd}` });
        }
        let accepted = socketBackend.accept(target.listener);
        let attempts = 0;
        while (!accepted.ok && 'wouldBlock' in accepted && accepted.wouldBlock === true) {
          if (++attempts > 100000) return writeJson(memory, outPtr, outCap, accepted);
          await new Promise((resolve) => setTimeout(resolve, 0));
          accepted = socketBackend.accept(target.listener);
        }
        if (!accepted.ok) return writeJson(memory, outPtr, outCap, accepted);
        if (!opts.kernel) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'kernel not configured' });
        }
        const acceptedFd = opts.kernel.allocFd(callerPid, {
          type: 'socket',
          socket: accepted.socket,
          refs: 1,
          peerHost: accepted.peerHost,
          peerPort: accepted.peerPort,
          localHost: accepted.localHost,
          localPort: accepted.localPort,
          send: socketBackend.send.bind(socketBackend),
          recv: socketBackend.recv.bind(socketBackend),
          setNoDelay: socketBackend.setNoDelay?.bind(socketBackend),
          close: (socket) => { socketBackend.close(socket); },
        });
        return writeJson(memory, outPtr, outCap, {
          ok: true,
          fd: acceptedFd,
          peer_host: accepted.peerHost,
          peer_port: accepted.peerPort,
          local_host: accepted.localHost,
          local_port: accepted.localPort,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_addr(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Reports sandbox-visible socket address metadata.
    // Request JSON: { fd }
    // Response JSON: { ok, peer_host, peer_port, local_host, local_port } or { ok: false, error }
    host_socket_addr(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket' || target.socket === null) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a connected socket fd: ${req.fd}` });
        }
        return writeJson(memory, outPtr, outCap, {
          ok: true,
          peer_host: target.peerHost ?? '0.0.0.0',
          peer_port: target.peerPort ?? 0,
          local_host: target.localHost ?? socketLocalHost,
          local_port: target.localPort ?? socketLocalPortForFd(req.fd),
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_send(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Sends data on an open socket.
    // Request JSON: { fd, data_b64 }
    // Response JSON: { ok, bytes_sent } or { ok: false, error }
    host_socket_send(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!socketBackend) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket' || target.socket === null) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a connected socket fd: ${req.fd}` });
        }
        const result = socketBackend.send(target.socket, req.data_b64);
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_recv(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Receives data from an open socket.
    // Request JSON: { fd, max_bytes }
    // Response JSON: { ok, data_b64 } or { ok: false, error }
    host_socket_recv(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      if (!socketBackend) {
        return writeJson(memory, outPtr, outCap, { ok: false, error: 'networking not configured' });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket' || target.socket === null) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a connected socket fd: ${req.fd}` });
        }
        const maxBytes = req.max_bytes ?? 65536;
        const peek = req.peek === true;
        if (target.peekBuffer && target.peekBuffer.byteLength > 0) {
          const chunk = target.peekBuffer.slice(0, maxBytes);
          if (!peek) {
            target.peekBuffer = target.peekBuffer.slice(chunk.byteLength);
          }
          return writeJson(memory, outPtr, outCap, { ok: true, data_b64: bytesToBase64(chunk) });
        }
        if (((target.fdFlags ?? 0) & WASI_FDFLAGS_NONBLOCK) !== 0) {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'EAGAIN' });
        }
        const result = socketBackend.recv(target.socket, maxBytes, {
          nonblocking: false,
        });
        if (peek && result.ok) {
          const data = base64ToBytes(result.data_b64 ?? '');
          target.peekBuffer = target.peekBuffer ? concatBytes(target.peekBuffer, data) : data;
          return writeJson(memory, outPtr, outCap, { ok: true, data_b64: bytesToBase64(data) });
        }
        return writeJson(memory, outPtr, outCap, result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_option(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Applies or reports socket option state owned by the kernel.
    // Request JSON: { fd, option, value? }
    // Response JSON: { ok: true, value? } or { ok: false, error }
    host_socket_option(reqPtr: number, reqLen: number, outPtr: number, outCap: number): number {
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'missing socket fd' });
        }
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `not a socket fd: ${req.fd}` });
        }
        if (req.option !== 'no_delay') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: `unsupported socket option: ${req.option}` });
        }
        if (!('value' in req)) {
          return writeJson(memory, outPtr, outCap, { ok: true, value: target.noDelay ? 1 : 0 });
        }
        if (typeof req.value !== 'boolean') {
          return writeJson(memory, outPtr, outCap, { ok: false, error: 'socket option value must be boolean' });
        }
        if (target.socket !== null) {
          const result = target.setNoDelay?.(target.socket, req.value)
            ?? { ok: false, error: 'TCP_NODELAY not supported by socket backend' };
          if (!result.ok) return writeJson(memory, outPtr, outCap, result);
        }
        target.noDelay = req.value;
        return writeJson(memory, outPtr, outCap, { ok: true });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, { ok: false, error: msg });
      }
    },

    // host_socket_close(req_ptr, req_len) -> i32
    // Closes an open socket.
    // Request JSON: { fd }
    // Returns 0 on success, -1 on error.
    host_socket_close(reqPtr: number, reqLen: number): number {
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen));
        if (typeof req.fd !== 'number') return -1;
        const target = opts.kernel?.getFdTarget(callerPid, req.fd);
        if (!target || target.type !== 'socket') return -1;
        if (target.socket !== null) {
          if (!socketBackend) return -1;
          const socket = target.socket;
          target.socket = null;
          socketBackend.close(socket);
        }
        return opts.kernel?.closeFd(callerPid, req.fd) ? 0 : -1;
      } catch { return -1; }
    },

    // ── Extensions (Python only — shell routes through host_spawn) ──

    // host_extension_invoke(req_ptr, req_len, out_ptr, out_cap) -> i32
    // Dynamic extension dispatch. Currently consumed by RustPython through the
    // auto-create virtual command machinery; this is Python-coupled debt
    // scheduled to clear with the CPython port. New host integrations should
    // register extensions through SandboxOptions/ExtensionRegistry and keep
    // userland-specific protocols outside the kernel.
    async host_extension_invoke(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): Promise<number> {
      const reqJson = readString(memory, reqPtr, reqLen);

      if (opts.extensionRegistry) {
        try {
          const req = JSON.parse(reqJson) as {
            name?: string;
            extension?: string;
            // When called from Python _yurt.extension_call(**kwargs), the entire
            // kwargs dict is serialized as the `args` field. Unpack it here.
            args?: string[] | Record<string, unknown>;
            stdin?: string;
            env?: [string, string][];
            cwd?: string;
          };

          const name = (req.name ?? req.extension ?? '') as string;

          // Python kwargs arrive as `args: {args: [...], stdin: "...", ...}`.
          // Detect and unpack that shape; otherwise treat args as a string array.
          let args: string[];
          let stdin: string;
          if (Array.isArray(req.args)) {
            args = req.args as string[];
            stdin = req.stdin ?? '';
          } else if (req.args && typeof req.args === 'object') {
            const kw = req.args as Record<string, unknown>;
            args = Array.isArray(kw.args) ? (kw.args as string[]) : [];
            stdin = typeof kw.stdin === 'string' ? kw.stdin : (req.stdin ?? '');
          } else {
            args = [];
            stdin = req.stdin ?? '';
          }

          const envObj: Record<string, string> = {};
          if (req.env) for (const [k, v] of req.env) envObj[k] = v;
          const cwd = req.cwd ?? '/';

          const result = await opts.extensionRegistry.invoke(name, {
            args, stdin, env: envObj, cwd,
          });

          return writeJson(memory, outPtr, outCap, {
            exit_code: result.exitCode,
            stdout: result.stdout ?? '',
            stderr: result.stderr ?? '',
          });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeJson(memory, outPtr, outCap, {
            exit_code: 1, stdout: '', stderr: `${msg}\n`,
          });
        }
      }

      // Fall back to legacy extensionHandler (sync)
      if (opts.extensionHandler) {
        try {
          const req = JSON.parse(reqJson) as Record<string, unknown>;
          const result = opts.extensionHandler(req);
          return writeJson(memory, outPtr, outCap, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeJson(memory, outPtr, outCap, {
            exit_code: 1, stdout: '', stderr: `${msg}\n`,
          });
        }
      }

      return writeJson(memory, outPtr, outCap, {
        exit_code: 1, stdout: '', stderr: 'extensions not available\n',
      });
    },

    // host_run_command(req_ptr, req_len, out_ptr, out_cap) -> i32 (async/JSPI)
    // Runs a shell command and captures output. Used by Python _yurt.spawn().
    async host_run_command(
      reqPtr: number, reqLen: number,
      outPtr: number, outCap: number,
    ): Promise<number> {
      if (opts.runCommandHandler && opts.sandbox) {
        try {
          const req = JSON.parse(readString(memory, reqPtr, reqLen)) as RunRequest;
          const result = await opts.runCommandHandler(req, { sandbox: opts.sandbox });
          return writeJson(memory, outPtr, outCap, result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return writeJson(memory, outPtr, outCap, {
            exit_code: 1, stdout: '', stderr: `${msg}\n`,
          });
        }
      }
      if (!opts.runCommand) {
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: 'subprocess not available\n',
        });
      }
      try {
        const req = JSON.parse(readString(memory, reqPtr, reqLen)) as { cmd: string; stdin?: string };
        const result = await opts.runCommand(req.cmd, req.stdin ?? '');
        return writeJson(memory, outPtr, outCap, {
          exit_code: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return writeJson(memory, outPtr, outCap, {
          exit_code: 1, stdout: '', stderr: `${msg}\n`,
        });
      }
    },

  };

  if (opts.threadsBackend) {
    const tb = opts.threadsBackend;
    imports.host_thread_spawn = (async (fnPtr: number, arg: number) =>
      tb.spawn(fnPtr, arg)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_join = (async (tid: number) =>
      tb.join(tid)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_detach = (async (tid: number) =>
      tb.detach(tid)) as unknown as WebAssembly.ImportValue;
    imports.host_thread_self = (() => tb.self()) as unknown as WebAssembly.ImportValue;
    imports.host_thread_yield = (async () => tb.yield_()) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_lock = (async (mutexPtr: number) =>
      tb.mutexLock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_unlock = ((mutexPtr: number) =>
      tb.mutexUnlock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_mutex_trylock = ((mutexPtr: number) =>
      tb.mutexTryLock(mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_wait = (async (condPtr: number, mutexPtr: number) =>
      tb.condWait(condPtr, mutexPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_signal = ((condPtr: number) =>
      tb.condSignal(condPtr)) as unknown as WebAssembly.ImportValue;
    imports.host_cond_broadcast = ((condPtr: number) =>
      tb.condBroadcast(condPtr)) as unknown as WebAssembly.ImportValue;
  }

  return imports;
}
