/**
 * Sandboxed-kernel microkernel — Deno-specific extensions.
 *
 * This package is for capabilities only Deno (and Node) can provide
 * natively:
 *   - real TCP sockets (`Deno.connect`, `Deno.listen`)
 *   - real filesystem access (`Deno.readFile`, `Deno.open`)
 *   - subprocess invocation (`Deno.Command`)
 *   - terminal / TTY integration
 *
 * The portable JS+wasm core lives in `packages/microkernel-js/` and
 * is what browsers use directly — there is no `microkernel-browser`,
 * because browsers and Deno share the JS engine, WebAssembly, fetch,
 * crypto, IndexedDB, and WebSocket. Anything genuinely browser-only
 * (Service-Worker fetch routing into a sandbox, OPFS persistence,
 * postMessage glue to a host page) belongs in the application layer
 * above the microkernel, not as a parallel microkernel.
 *
 * Today this file is a thin re-export — every existing fixture parity
 * test runs through the portable core. Deno-only extensions land here
 * as we port real-IO syscalls (the TS kernel's `host_socket_*`,
 * `host_network_fetch`, real-fs paths).
 */

export {
  defaultHostState,
  type ExtensionRegistry,
  type HostFsImpl,
  type HostFsStat,
  type HostState,
  InMemoryHostFs,
  InMemoryKv,
  KERNEL_PID,
  KernelInstance,
  type KvBackend,
  type LogSink,
  METHOD,
  Microkernel,
  s,
  type TcpSocketImpl,
  UserProcess,
} from "../microkernel-js/mod.ts";

import type {
  HostFsImpl,
  HostFsStat,
  TcpSocketImpl,
} from "../microkernel-js/mod.ts";

const ENOENT = 2;
const EBADF = 9;
const EACCES = 13;
const EEXIST = 17;
const EIO = 5;

/**
 * Deno-backed [`HostFsImpl`] — wraps `Deno.openSync` and friends
 * with canonicalize-and-contain rooting against the configured
 * root directory. Mirrors the Rust `NativeHostFs`. Use this when
 * running yurt under Deno and you want real disk access; browser
 * embedders use a different impl (OPFS) since Deno's sync APIs
 * don't exist there.
 */
export class DenoHostFs implements HostFsImpl {
  private root: string;
  private rootCanon: string;
  private files = new Map<number, Deno.FsFile>();
  private nextFd = 1;

  constructor(root: string) {
    Deno.mkdirSync(root, { recursive: true });
    this.root = root;
    this.rootCanon = Deno.realPathSync(root);
  }

  /**
   * Resolve `path` (kernel-supplied, leading slash optional)
   * against the root, canonicalize, and reject any escape.
   * Returns the absolute resolved path or a negated POSIX errno.
   */
  private resolve(path: Uint8Array, allowMissing: boolean): string | number {
    const str = new TextDecoder("utf-8", { fatal: false }).decode(path);
    const rel = str.startsWith("/") ? str.slice(1) : str;
    const candidate = `${this.root}/${rel}`;
    try {
      const resolved = Deno.realPathSync(candidate);
      if (!resolved.startsWith(this.rootCanon)) return -EACCES;
      return resolved;
    } catch (_e) {
      if (!allowMissing) return -ENOENT;
      // Canonicalize parent and rebuild — same fallback as the
      // Rust NativeHostFs::resolve.
      const lastSlash = candidate.lastIndexOf("/");
      if (lastSlash <= 0) return -22; // -EINVAL
      const parent = candidate.slice(0, lastSlash);
      const leaf = candidate.slice(lastSlash + 1);
      try {
        const parentCanon = Deno.realPathSync(parent);
        if (!parentCanon.startsWith(this.rootCanon)) return -EACCES;
        return `${parentCanon}/${leaf}`;
      } catch {
        return -ENOENT;
      }
    }
  }

  open(path: Uint8Array, flags: number): number {
    const writable = (flags & 0b001) !== 0;
    const create = (flags & 0b010) !== 0;
    const trunc = (flags & 0b100) !== 0;
    const resolved = this.resolve(path, writable && create);
    if (typeof resolved === "number") return resolved;
    try {
      const f = Deno.openSync(resolved, {
        read: true,
        write: writable,
        create,
        truncate: trunc && writable,
      });
      const fd = this.nextFd++;
      this.files.set(fd, f);
      return fd;
    } catch (e) {
      return mapErrno(e);
    }
  }

  read(fd: number, buf: Uint8Array): number {
    const f = this.files.get(fd);
    if (!f) return -EBADF;
    try {
      return f.readSync(buf) ?? 0;
    } catch (e) {
      return mapErrno(e);
    }
  }

  write(fd: number, data: Uint8Array): number {
    const f = this.files.get(fd);
    if (!f) return -EBADF;
    try {
      return f.writeSync(data);
    } catch (e) {
      return mapErrno(e);
    }
  }

  close(fd: number): number {
    const f = this.files.get(fd);
    if (f) {
      try {
        f.close();
      } catch { /* best-effort */ }
      this.files.delete(fd);
    }
    return 0;
  }

  stat(path: Uint8Array): HostFsStat | number {
    const resolved = this.resolve(path, false);
    if (typeof resolved === "number") return resolved;
    try {
      const meta = Deno.statSync(resolved);
      const mode = meta.isDirectory ? 0o040_755 : 0o100_644;
      return {
        size: BigInt(meta.size),
        mode,
        mtimeNs: meta.mtime ? BigInt(meta.mtime.getTime()) * 1_000_000n : 0n,
        isDir: meta.isDirectory,
        isSymlink: meta.isSymlink,
      };
    } catch (e) {
      return mapErrno(e);
    }
  }

  unlink(path: Uint8Array): number {
    const resolved = this.resolve(path, false);
    if (typeof resolved === "number") return resolved;
    try {
      Deno.removeSync(resolved);
      return 0;
    } catch (e) {
      return mapErrno(e);
    }
  }

  mkdir(path: Uint8Array, _mode: number): number {
    const resolved = this.resolve(path, true);
    if (typeof resolved === "number") return resolved;
    try {
      Deno.mkdirSync(resolved);
      return 0;
    } catch (e) {
      return mapErrno(e);
    }
  }

  symlink(target: Uint8Array, linkPath: Uint8Array): number {
    const linkResolved = this.resolve(linkPath, true);
    if (typeof linkResolved === "number") return linkResolved;
    try {
      Deno.symlinkSync(
        new TextDecoder().decode(target),
        linkResolved,
      );
      return 0;
    } catch (e) {
      return mapErrno(e);
    }
  }

  rename(oldPath: Uint8Array, newPath: Uint8Array): number {
    const oldResolved = this.resolve(oldPath, false);
    if (typeof oldResolved === "number") return oldResolved;
    const newResolved = this.resolve(newPath, true);
    if (typeof newResolved === "number") return newResolved;
    try {
      Deno.renameSync(oldResolved, newResolved);
      return 0;
    } catch (e) {
      return mapErrno(e);
    }
  }
}

function mapErrno(e: unknown): number {
  if (e instanceof Deno.errors.NotFound) return -ENOENT;
  if (e instanceof Deno.errors.PermissionDenied) return -EACCES;
  if (e instanceof Deno.errors.AlreadyExists) return -EEXIST;
  return -EIO;
}

/**
 * Deno-backed implementation of `HostState.fetch`. The Deno
 * impl is identical to the universal `globalFetch` in
 * microkernel-js (both wrap `globalThis.fetch`), so this is
 * just a re-export under the Deno-named alias for embedder
 * ergonomics. Embedders writing portable JS can use either name.
 */
export { globalFetch as denoFetch } from "../microkernel-js/mod.ts";

/**
 * Deno-backed [`TcpSocketImpl`]. Implements only the *Async
 * variants — Deno's TCP primitives are inherently async, so the
 * sync stubs return -ENOSYS. When the host has JSPI (Deno does)
 * the matching kh_socket_* imports are wrapped with
 * `WebAssembly.Suspending` and userland's syscall actually
 * suspends until the I/O completes.
 *
 * Holds two handle tables internally — one for connected
 * `Deno.TcpConn`s, one for `Deno.TcpListener`s — so the trait
 * surface (`close`) can route a handle to whichever side it is.
 */
export class DenoTcpSocket implements TcpSocketImpl {
  private nextHandle = 1;
  private conns = new Map<number, Deno.TcpConn>();
  private listeners = new Map<number, Deno.TcpListener>();

  // Sync stubs — JSPI takes the *Async path.
  connect(): number {
    return -38;
  }
  send(): number {
    return -38;
  }
  recv(): number {
    return -38;
  }
  listen(): number {
    return -38;
  }
  accept(): number {
    return -38;
  }
  localAddr(handle: number): { host: string; port: number } | null {
    const l = this.listeners.get(handle);
    if (l && l.addr.transport === "tcp") {
      return { host: l.addr.hostname, port: l.addr.port };
    }
    const c = this.conns.get(handle);
    if (c && c.localAddr.transport === "tcp") {
      return { host: c.localAddr.hostname, port: c.localAddr.port };
    }
    return null;
  }

  close(handle: number): number {
    const c = this.conns.get(handle);
    if (c) {
      try {
        c.close();
      } catch { /* */ }
      this.conns.delete(handle);
      return 0;
    }
    const l = this.listeners.get(handle);
    if (l) {
      try {
        l.close();
      } catch { /* */ }
      this.listeners.delete(handle);
      return 0;
    }
    return 0;
  }

  async connectAsync(
    host: string,
    port: number,
    _flags: number,
  ): Promise<number> {
    try {
      const conn = await Deno.connect({
        hostname: host,
        port,
        transport: "tcp",
      });
      const h = this.nextHandle++;
      this.conns.set(h, conn);
      return h;
    } catch (e) {
      return mapErrno(e);
    }
  }

  async recvAsync(
    handle: number,
    buf: Uint8Array,
    _flags: number,
  ): Promise<number> {
    const conn = this.conns.get(handle);
    if (!conn) return -EBADF;
    try {
      const n = await conn.read(buf);
      return n ?? 0;
    } catch (e) {
      return mapErrno(e);
    }
  }

  async acceptAsync(handle: number, _flags: number): Promise<number> {
    const l = this.listeners.get(handle);
    if (!l) return -EBADF;
    try {
      const conn = await l.accept();
      const h = this.nextHandle++;
      this.conns.set(h, conn);
      return h;
    } catch (e) {
      return mapErrno(e);
    }
  }

  /**
   * Convenience: the sync `listen` is -ENOSYS but Deno's
   * Deno.listen IS sync (the listener returns a Promise on
   * `accept`). Embedders that want listen-via-async create a
   * listener directly through this method and pass the handle
   * to userland.
   */
  bindListener(host: string, port: number): number {
    try {
      const listener = Deno.listen({ hostname: host, port, transport: "tcp" });
      const h = this.nextHandle++;
      this.listeners.set(h, listener);
      return h;
    } catch (e) {
      return mapErrno(e);
    }
  }
}
