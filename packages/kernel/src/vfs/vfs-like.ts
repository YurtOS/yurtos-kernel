/**
 * Common interface for VFS and VfsProxy.
 *
 * Used by WasiHost, ProcessManager, and worker-side process runners so they can
 * accept either the real VFS (main thread) or VfsProxy (Worker thread).
 */
import type { DirEntry, FsCredential, StatResult } from './inode.js';
import type { OverlayState } from './overlay-vfs.js';
import type { ProcessInfo } from './proc-provider.js';
import type { MountEntry, VirtualProvider } from './provider.js';

export interface VfsLike {
  readFile(path: string): Uint8Array;
  writeFile(path: string, data: Uint8Array, mode?: number): void;
  stat(path: string): StatResult;
  lstat(path: string): StatResult;
  readdir(path: string): DirEntry[];
  mkdir(path: string, mode?: number): void;
  mkdirp(path: string): void;
  unlink(path: string): void;
  rmdir(path: string): void;
  rename(oldPath: string, newPath: string): void;
  symlink(target: string, path: string): void;
  /**
   * POSIX hard link — make `newPath` an alias for `oldPath`'s
   * inode, so a write through either path appears at both.  Must
   * fail with EEXIST if newPath already exists, EACCES on
   * directories.  Optional on the proxy side: VfsProxy doesn't
   * implement it yet (worker-thread crossing requires the path-
   * link op to be added to proxy-protocol.ts).
   */
  link?(oldPath: string, newPath: string): void;
  readlink(path: string): string;
  chmod(path: string, mode: number): void;
  chown(path: string, uid: number, gid: number, followSymlinks?: boolean): void;
  withCredential?<T>(credential: FsCredential, fn: () => T): T;
  withWriteAccess(fn: () => void): void;
  /**
   * Optional: detect a streaming-capable provider entry (e.g.
   * /dev/urandom, /dev/zero) so the FdTable can skip the
   * materialize-at-open path and route every syscall through the
   * provider directly.  Returns null for ordinary files and for
   * VFS implementations (VfsProxy) that can't expose streaming
   * across their boundary.
   */
  streamFile?(path: string): {
    read?: (length: number) => Uint8Array;
    write?: (data: Uint8Array) => number;
  } | null;
  setOnChange?(cb: (() => void) | null): void;
  mount?(mountPath: string, provider: VirtualProvider): void;
  getMountList?(): MountEntry[];
  setProcessListProvider?(fn: (() => ProcessInfo[]) | null): void;
  snapshot?(): string;
  restore?(id: string): void;
  cowClone?(): VfsLike;
  getProviderPaths?(): string[];
  clearFileContents?(): void;
  exportOverlayState?(): OverlayState;
  importOverlayState?(state: OverlayState): void;
  exportUpperVfs?(): VfsLike;
}
