/**
 * In-memory VFS with POSIX semantics.
 *
 * Provides a tree of inodes (files, directories, symlinks) that can back
 * WASI syscalls and Pyodide's filesystem. Designed to be snapshotable
 * (for fork simulation) and extensible with pipes (for shell pipelines).
 */

import type { DirEntry, DirInode, FsCredential, Inode, StatResult } from './inode.js';
import {
  VfsError,
  createDirInode,
  createFileInode,
  createSymlinkInode,
} from './inode.js';
import { deepCloneRoot } from './snapshot.js';
import type { MountEntry, VirtualProvider } from './provider.js';
import type { ProcessInfo } from './proc-provider.js';
import { DevProvider } from './dev-provider.js';
import { ProcProvider } from './proc-provider.js';

const MAX_SYMLINK_DEPTH = 40;
const ROOT_UID = 0;
const ROOT_GID = 0;
const USER_UID = 1000;
const USER_GID = 1000;

export interface VfsOptions {
  /** Maximum total bytes stored in the VFS. Undefined = no limit. */
  fsLimitBytes?: number;
  /** Maximum number of files/directories. Undefined = no limit. */
  fileCount?: number;
  /** Effective uid for normal VFS operations. Defaults to the sandbox user. */
  uid?: number;
  /** Effective gid for normal VFS operations. Defaults to the sandbox user group. */
  gid?: number;
  /** Default creates convenience dirs; empty creates only stored root plus virtual providers. */
  layout?: 'default' | 'empty';
}

/**
 * Split an absolute path into its component segments,
 * resolving '.' and '..' along the way.
 */
function parsePath(path: string): string[] {
  if (!path.startsWith('/')) {
    throw new VfsError('ENOENT', `not an absolute path: ${path}`);
  }

  const segments: string[] = [];

  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  return segments;
}

function parseResolutionPath(path: string): string[] {
  if (!path.startsWith('/')) {
    throw new VfsError('ENOENT', `not an absolute path: ${path}`);
  }
  return path.split('/').filter((part) => part !== '' && part !== '.');
}

function pathFromSegments(segments: string[]): string {
  return segments.length === 0 ? '/' : `/${segments.join('/')}`;
}

export class VFS {
  private root: DirInode;
  private snapshots: Map<string, DirInode> = new Map();
  private nextSnapId = 1;
  private totalBytes = 0;
  private fsLimitBytes: number | undefined;
  private fileCountLimit: number | undefined;
  private currentFileCount = 0;
  /** When true, bypass mode-bit permission checks (used during init and withWriteAccess). */
  private initializing = false;
  private uid = USER_UID;
  private gid = USER_GID;
  /** Mounted virtual providers keyed by mount path (e.g. '/dev', '/proc'). */
  private providers: Map<string, VirtualProvider> = new Map();
  /** Optional callback invoked after mutating VFS operations. */
  private onChangeCallback: (() => void) | null = null;
  /**
   * Source for /proc/<pid>/* entries.  The VFS itself doesn't own
   * a process kernel — the sandbox process runtime does — so this is a
   * callback set externally after the kernel is wired up.  Falls
   * back to an empty list if unset (e.g., during construction or
   * for raw VFS instances used in unit tests).
   */
  private processListProvider: (() => ProcessInfo[]) | null = null;

  constructor(options?: VfsOptions) {
    this.uid = options?.uid ?? USER_UID;
    this.gid = options?.gid ?? USER_GID;
    this.root = createDirInode(0o555, ROOT_UID, ROOT_GID);
    this.fsLimitBytes = options?.fsLimitBytes;
    this.fileCountLimit = options?.fileCount;
    this.initializing = true;
    if ((options?.layout ?? 'default') === 'default') {
      this.initDefaultLayout();
    }
    this.initializing = false;
    this.registerProvider('/dev', new DevProvider());
    this.registerProvider(
      '/proc',
      new ProcProvider(
        () => this.getStorageStats(),
        () => this.getMountList(),
        () => this.processListProvider?.() ?? [],
      ),
    );
  }

  /** Create a VFS from an already-populated root (used by cowClone). */
  private static fromRoot(root: DirInode, options?: {
    fsLimitBytes?: number;
    totalBytes?: number;
    fileCountLimit?: number;
    currentFileCount?: number;
    uid?: number;
    gid?: number;
    providers?: Map<string, VirtualProvider>;
  }): VFS {
    const vfs = Object.create(VFS.prototype) as VFS;
    vfs.root = root;
    vfs.snapshots = new Map();
    vfs.nextSnapId = 1;
    vfs.totalBytes = options?.totalBytes ?? 0;
    vfs.fsLimitBytes = options?.fsLimitBytes;
    vfs.fileCountLimit = options?.fileCountLimit;
    vfs.currentFileCount = options?.currentFileCount ?? 0;
    vfs.initializing = false;
    vfs.uid = options?.uid ?? USER_UID;
    vfs.gid = options?.gid ?? USER_GID;
    vfs.onChangeCallback = null;
    // Re-create built-in providers (fresh instances for independent state).
    // User-mounted providers are shared by reference (safe for read-only mounts).
    vfs.providers = new Map();
    if (options?.providers) {
      for (const [mount, provider] of options.providers) {
        if (mount === '/dev') {
          vfs.providers.set(mount, new DevProvider());
        } else if (mount === '/proc') {
          vfs.providers.set(mount, new ProcProvider(
            () => vfs.getStorageStats(),
            () => vfs.getMountList(),
            () => vfs.processListProvider?.() ?? [],
          ));
        } else {
          // User mounts: share the provider instance
          vfs.providers.set(mount, provider);
        }
      }
    }
    return vfs;
  }

  /** Populate the default directory tree with explicit mode bits. */
  private initDefaultLayout(): void {
    const dirs: Array<[string, number, number, number]> = [
      ['/home', 0o755, ROOT_UID, ROOT_GID],
      ['/home/user', 0o755, USER_UID, USER_GID],
      ['/tmp', 0o777, ROOT_UID, ROOT_GID],
      ['/bin', 0o555, ROOT_UID, ROOT_GID],
      ['/usr', 0o555, ROOT_UID, ROOT_GID],
      ['/usr/bin', 0o555, ROOT_UID, ROOT_GID],
      ['/usr/lib', 0o555, ROOT_UID, ROOT_GID],
      ['/usr/lib/python', 0o755, USER_UID, USER_GID],
      ['/etc', 0o555, ROOT_UID, ROOT_GID],
      ['/etc/yurt', 0o555, ROOT_UID, ROOT_GID],
      ['/usr/share', 0o555, ROOT_UID, ROOT_GID],
      ['/usr/share/pkg', 0o755, USER_UID, USER_GID],
      ['/mnt', 0o555, ROOT_UID, ROOT_GID],
    ];
    for (const [dir, mode, uid, gid] of dirs) {
      this.mkdirInternal(dir, mode, uid, gid);
    }
  }

  /** Register a virtual provider at the given mount path. */
  registerProvider(mountPath: string, provider: VirtualProvider): void {
    this.providers.set(mountPath, provider);
  }

  /**
   * Mount a virtual provider at the given path, creating the directory node
   * in the inode tree so the mount point appears in parent listings (e.g. `ls /mnt`).
   */
  mount(mountPath: string, provider: VirtualProvider): void {
    // Ensure parent dirs exist and create the mount-point dir node
    this.withWriteAccess(() => {
      this.mkdirInternal(mountPath);
    });
    this.providers.set(mountPath, provider);
  }

  /** Return all provider mount paths (e.g. ['/dev', '/proc', '/mnt/tools']). */
  getProviderPaths(): string[] {
    return Array.from(this.providers.keys());
  }

  /**
   * Build the live mount table — the structured form of /proc/mounts.
   * The root inode tree shows up as 'yurtfs / yurtfs ...'; each
   * registered provider contributes a row using its declared fsType
   * (defaulting to 'virtfs' for legacy providers without one).
   *
   * Mount options follow the kernel conventions: 'ro' on read-only
   * mounts, otherwise 'rw'.  We don't track per-mount options beyond
   * read/write today; if more granularity is needed (nosuid, nodev)
   * the providers can carry their own options string.
   */
  getMountList(): MountEntry[] {
    const entries: MountEntry[] = [
      { fsname: 'yurtfs', mountPath: '/', fsType: 'yurtfs', options: 'rw,relatime' },
    ];
    for (const [mountPath, provider] of this.providers) {
      const fsType = provider.fsType ?? 'virtfs';
      // Mount options reflect what the provider permits.  We don't
      // expose a writable flag generically yet, so use a sane default
      // per-fstype (proc/devtmpfs are conventionally rw).
      const options = (fsType === 'proc' || fsType === 'devtmpfs')
        ? 'rw,nosuid,nodev,relatime'
        : 'rw,relatime';
      entries.push({ fsname: fsType, mountPath, fsType, options });
    }
    return entries;
  }

  /** Set a callback to be invoked after mutating VFS operations. */
  setOnChange(cb: (() => void) | null): void {
    this.onChangeCallback = cb;
  }

  /**
   * Wire the source of /proc/<pid>/* entries.  Called by the
   * sandbox once its ProcessKernel exists; the ProcProvider
   * built at VFS-construction time queries through this on every
   * read so newly-spawned processes appear without re-registration.
   */
  setProcessListProvider(fn: (() => ProcessInfo[]) | null): void {
    this.processListProvider = fn;
  }

  /**
   * If `path` resolves to a streaming provider entry — one whose
   * provider implements streamRead/streamWrite — return a pair of
   * functions that the FdTable can call per syscall.  Otherwise
   * return null and the caller falls back to the static
   * load-and-slice path through readFile/writeFile.
   *
   * Used by FdTable.open: streaming files don't materialize a
   * buffer at open time, so /dev/urandom can be read forever
   * without holding any backing memory.
   */
  streamFile(path: string): {
    read?: (length: number) => Uint8Array;
    write?: (data: Uint8Array) => number;
  } | null {
    const match = this.matchProvider(path);
    if (!match) return null;
    const { provider, subpath } = match;
    if (!provider.streamRead && !provider.streamWrite) return null;
    return {
      read: provider.streamRead ? (n: number) => provider.streamRead!(subpath, n) : undefined,
      write: provider.streamWrite ? (d: Uint8Array) => provider.streamWrite!(subpath, d) : undefined,
    };
  }

  /** Notify the onChange callback if set and not during init/restore. */
  private notifyChange(): void {
    if (!this.initializing && this.onChangeCallback) {
      this.onChangeCallback();
    }
  }

  /**
   * Match a path against mounted providers.
   * Returns the provider and the subpath relative to the mount point,
   * or undefined if no provider matches.
   */
  private matchProvider(path: string): { provider: VirtualProvider; subpath: string } | undefined {
    const normalized = '/' + parsePath(path).join('/');
    for (const [mount, provider] of this.providers) {
      if (normalized === mount) {
        return { provider, subpath: '' };
      }
      if (normalized.startsWith(mount + '/')) {
        return { provider, subpath: normalized.slice(mount.length + 1) };
      }
    }
    return undefined;
  }

  private isProviderMountPath(path: string): boolean {
    const normalized = '/' + parsePath(path).join('/');
    return this.providers.has(normalized);
  }

  private currentOwner(): { uid: number; gid: number } {
    return { uid: this.uid, gid: this.gid };
  }

  private canAccess(inode: Inode, ownerBit: number, groupBit: number, otherBit: number): boolean {
    if (this.initializing || this.uid === ROOT_UID) return true;
    const mode = inode.metadata.permissions;
    if (inode.metadata.uid === this.uid) return (mode & ownerBit) !== 0;
    if (inode.metadata.gid === this.gid) return (mode & groupBit) !== 0;
    return (mode & otherBit) !== 0;
  }

  private canRead(inode: Inode): boolean {
    return this.canAccess(inode, 0o400, 0o040, 0o004);
  }

  private canWrite(inode: Inode): boolean {
    return this.canAccess(inode, 0o200, 0o020, 0o002);
  }

  private canExecute(inode: Inode): boolean {
    return this.canAccess(inode, 0o100, 0o010, 0o001);
  }

  private assertReadPermission(inode: Inode): void {
    if (!this.canRead(inode)) {
      throw new VfsError('EACCES', 'permission denied');
    }
  }

  /** Throw EACCES if the effective user cannot write the inode. Bypassed during init/withWriteAccess. */
  private assertWritePermission(inode: Inode): void {
    if (!this.canWrite(inode)) {
      throw new VfsError('EACCES', 'permission denied');
    }
  }

  private assertSearchPermission(inode: Inode): void {
    if (!this.canExecute(inode)) {
      throw new VfsError('EACCES', 'permission denied');
    }
  }

  private assertDirectoryMutationPermission(inode: Inode): void {
    if (!this.canWrite(inode) || !this.canExecute(inode)) {
      throw new VfsError('EACCES', 'permission denied');
    }
  }

  private assertChmodPermission(inode: Inode): void {
    if (this.initializing || this.uid === ROOT_UID || inode.metadata.uid === this.uid) return;
    throw new VfsError('EACCES', 'permission denied');
  }

  private assertChownPermission(inode: Inode, uid: number, gid: number): void {
    if (this.initializing || this.uid === ROOT_UID) return;
    const requestedUid = uid === -1 ? inode.metadata.uid : uid;
    const requestedGid = gid === -1 ? inode.metadata.gid : gid;
    if (
      inode.metadata.uid === this.uid &&
      requestedUid === inode.metadata.uid &&
      (requestedGid === inode.metadata.gid || requestedGid === this.gid)
    ) {
      return;
    }
    throw new VfsError('EACCES', 'permission denied');
  }

  /** Throw ENOSPC if the file-count limit has been reached. */
  private assertFileCountLimit(): void {
    if (this.fileCountLimit !== undefined && this.currentFileCount >= this.fileCountLimit) {
      throw new VfsError('ENOSPC', 'file count limit exceeded');
    }
  }

  /** Internal mkdir that silently skips existing directories. Used during init. */
  private mkdirInternal(path: string, mode?: number, uid = this.uid, gid = this.gid): void {
    const segments = parsePath(path);
    let current: DirInode = this.root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const existing = current.children.get(segment);
      if (existing !== undefined) {
        if (existing.type !== 'dir') {
          throw new VfsError('ENOTDIR', `not a directory: ${path}`);
        }
        current = existing;
      } else {
        // Apply specified mode only to the final segment
        const dirMode = (mode !== undefined && i === segments.length - 1) ? mode : undefined;
        const newDir = createDirInode(dirMode, uid, gid);
        current.children.set(segment, newDir);
        this.currentFileCount++;
        current = newDir;
      }
    }
  }

  /**
   * Walk the inode tree to resolve a path.
   * Returns the parent directory and the final segment name,
   * or the resolved inode when `resolveLeaf` is true.
   */
  private resolve(path: string, followSymlinks = true, depth = 0): Inode {
    let queue = parseResolutionPath(path);
    if (queue.length === 0) {
      return this.root;
    }

    let current: Inode = this.root;
    const resolvedSegments: string[] = [];

    while (queue.length > 0) {
      const segment = queue.shift()!;
      if (segment === '..') {
        if (resolvedSegments.length > 0) {
          resolvedSegments.pop();
          current = this.resolve(pathFromSegments(resolvedSegments), true, depth);
        } else {
          current = this.root;
        }
        continue;
      }

      if (current.type !== 'dir') {
        throw new VfsError('ENOTDIR', `not a directory: ${path}`);
      }
      this.assertSearchPermission(current);

      const child = current.children.get(segment);
      if (child === undefined) {
        throw new VfsError('ENOENT', `no such file or directory: ${path}`);
      }

      if (child.type === 'symlink' && (queue.length > 0 || followSymlinks)) {
        if (depth >= MAX_SYMLINK_DEPTH) {
          throw new VfsError('ENOENT', `too many symlinks: ${path}`);
        }
        const targetQueue = child.target.startsWith('/')
          ? parseResolutionPath(child.target)
          : [...resolvedSegments, ...child.target.split('/').filter((part) => part !== '' && part !== '.')];
        queue = [...targetQueue, ...queue];
        resolvedSegments.length = 0;
        current = this.root;
        depth++;
        continue;
      }

      current = child;
      resolvedSegments.push(segment);
    }

    return current;
  }

  /**
   * Resolve the parent directory and return it along with the leaf name.
   * Throws if the parent does not exist or is not a directory.
   */
  private resolveParent(path: string): { parent: DirInode; name: string } {
    const segments = parsePath(path);

    if (segments.length === 0) {
      throw new VfsError('EEXIST', `cannot operate on root: ${path}`);
    }

    const name = segments[segments.length - 1];
    const current = this.resolve(pathFromSegments(segments.slice(0, -1)));
    if (current.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    }
    this.assertSearchPermission(current);

    return { parent: current, name };
  }

  stat(path: string): StatResult {
    const match = this.matchProvider(path);
    if (match) {
      const ps = match.provider.stat(match.subpath);
      const now = new Date();
      return {
        type: ps.type,
        size: ps.size,
        permissions: ps.type === 'dir' ? 0o755 : 0o444,
        uid: ROOT_UID,
        gid: ROOT_GID,
        mtime: now,
        ctime: now,
        atime: now,
      };
    }

    const inode = this.resolve(path);
    const { metadata } = inode;

    let size: number;
    if (inode.type === 'file') {
      size = inode.content.byteLength;
    } else if (inode.type === 'dir') {
      size = inode.children.size;
    } else {
      size = inode.target.length;
    }

    return {
      type: inode.type,
      size,
      permissions: metadata.permissions,
      uid: metadata.uid,
      gid: metadata.gid,
      mtime: metadata.mtime,
      ctime: metadata.ctime,
      atime: metadata.atime,
    };
  }

  /** Like stat but does not follow symlinks at the leaf. */
  lstat(path: string): StatResult {
    const match = this.matchProvider(path);
    if (match) {
      return this.stat(path);
    }

    const inode = this.resolve(path, false);
    const { metadata } = inode;

    let size: number;
    if (inode.type === 'file') {
      size = inode.content.byteLength;
    } else if (inode.type === 'dir') {
      size = inode.children.size;
    } else {
      size = inode.target.length;
    }

    return {
      type: inode.type,
      size,
      permissions: metadata.permissions,
      uid: metadata.uid,
      gid: metadata.gid,
      mtime: metadata.mtime,
      ctime: metadata.ctime,
      atime: metadata.atime,
    };
  }

  readFile(path: string): Uint8Array {
    const match = this.matchProvider(path);
    if (match) {
      return match.provider.readFile(match.subpath);
    }

    const inode = this.resolve(path);

    if (inode.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }
    if (inode.type === 'symlink') {
      // Should not happen after resolve with followSymlinks, but guard anyway
      return this.readFile(inode.target);
    }
    this.assertReadPermission(inode);

    inode.metadata.atime = new Date();
    return inode.content;
  }

  /** Run a callback with mode-bit permission checks disabled (root mode). */
  withWriteAccess(fn: () => void): void {
    const prev = this.initializing;
    const prevUid = this.uid;
    const prevGid = this.gid;
    this.initializing = true;
    this.uid = ROOT_UID;
    this.gid = ROOT_GID;
    try { fn(); } finally {
      this.initializing = prev;
      this.uid = prevUid;
      this.gid = prevGid;
    }
  }

  withCredential<T>(credential: FsCredential, fn: () => T): T {
    const prevUid = this.uid;
    const prevGid = this.gid;
    this.uid = credential.uid;
    this.gid = credential.gid;
    try {
      return fn();
    } finally {
      this.uid = prevUid;
      this.gid = prevGid;
    }
  }

  writeFile(path: string, data: Uint8Array, mode = 0o644): void {
    if (this.isProviderMountPath(path)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${path}`);
    }
    const match = this.matchProvider(path);
    if (match) {
      match.provider.writeFile(match.subpath, data);
      return;
    }

    const { parent, name } = this.resolveParent(path);
    const existing = parent.children.get(name);

    if (existing !== undefined && existing.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }

    // New file → check parent dir write bit; overwrite → check file write bit
    if (existing !== undefined && existing.type === 'file') {
      this.assertWritePermission(existing);
    } else {
      this.assertDirectoryMutationPermission(parent);
    }

    const oldSize = (existing !== undefined && existing.type === 'file') ? existing.content.byteLength : 0;
    const newSize = data.byteLength;
    const delta = newSize - oldSize;

    if (this.fsLimitBytes !== undefined && this.totalBytes + delta > this.fsLimitBytes) {
      throw new VfsError('ENOSPC', `no space left on device (limit: ${this.fsLimitBytes} bytes)`);
    }

    if (existing !== undefined && existing.type === 'file') {
      existing.content = data;
      existing.metadata.mtime = new Date();
    } else {
      this.assertFileCountLimit();
      const owner = this.currentOwner();
      parent.children.set(name, createFileInode(data, normalizeMode(mode), owner.uid, owner.gid));
      this.currentFileCount++;
    }
    this.totalBytes += delta;
    this.notifyChange();
  }

  mkdir(path: string, mode = 0o755): void {
    if (this.isProviderMountPath(path)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${path}`);
    }
    const { parent, name } = this.resolveParent(path);

    if (parent.children.has(name)) {
      throw new VfsError('EEXIST', `file exists: ${path}`);
    }

    this.assertDirectoryMutationPermission(parent);
    this.assertFileCountLimit();
    const owner = this.currentOwner();
    parent.children.set(name, createDirInode(normalizeMode(mode), owner.uid, owner.gid));
    this.currentFileCount++;
    this.notifyChange();
  }

  mkdirp(path: string): void {
    if (this.isProviderMountPath(path)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${path}`);
    }
    const segments = parsePath(path);
    let current: DirInode = this.root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const existing = current.children.get(segment);

      if (existing !== undefined) {
        if (existing.type !== 'dir') {
          const partial = '/' + segments.slice(0, i + 1).join('/');
          throw new VfsError('ENOTDIR', `not a directory: ${partial}`);
        }
        current = existing;
      } else {
        this.assertDirectoryMutationPermission(current);
        this.assertFileCountLimit();
        const owner = this.currentOwner();
        const newDir = createDirInode(0o755, owner.uid, owner.gid);
        current.children.set(segment, newDir);
        this.currentFileCount++;
        current = newDir;
      }
    }
    this.notifyChange();
  }

  readdir(path: string): DirEntry[] {
    const match = this.matchProvider(path);
    if (match) {
      return match.provider.readdir(match.subpath);
    }

    const inode = this.resolve(path);

    if (inode.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    }
    this.assertReadPermission(inode);

    inode.metadata.atime = new Date();
    const entries: DirEntry[] = [];

    for (const [name, child] of inode.children) {
      entries.push({ name, type: child.type });
    }
    if (parsePath(path).length === 0) {
      for (const mountPath of this.providers.keys()) {
        const [name, rest] = mountPath.slice(1).split('/');
        if (name && rest === undefined && !inode.children.has(name)) {
          entries.push({ name, type: 'dir' });
        }
      }
    }

    return entries;
  }

  unlink(path: string): void {
    if (this.isProviderMountPath(path)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${path}`);
    }
    const { parent, name } = this.resolveParent(path);
    this.assertDirectoryMutationPermission(parent);
    const child = parent.children.get(name);

    if (child === undefined) {
      throw new VfsError('ENOENT', `no such file or directory: ${path}`);
    }
    if (child.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${path}`);
    }

    if (child.type === 'file') {
      this.totalBytes -= child.content.byteLength;
    }
    parent.children.delete(name);
    this.currentFileCount--;
    this.notifyChange();
  }

  rmdir(path: string): void {
    if (this.isProviderMountPath(path)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${path}`);
    }
    const { parent, name } = this.resolveParent(path);
    this.assertDirectoryMutationPermission(parent);
    const child = parent.children.get(name);

    if (child === undefined) {
      throw new VfsError('ENOENT', `no such file or directory: ${path}`);
    }
    if (child.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    }
    if (child.children.size > 0) {
      throw new VfsError('ENOTEMPTY', `directory not empty: ${path}`);
    }

    parent.children.delete(name);
    this.currentFileCount--;
    this.notifyChange();
  }

  rename(oldPath: string, newPath: string): void {
    if (this.isProviderMountPath(oldPath)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${oldPath}`);
    }
    if (this.isProviderMountPath(newPath)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${newPath}`);
    }
    const { parent: oldParent, name: oldName } = this.resolveParent(oldPath);
    this.assertDirectoryMutationPermission(oldParent);
    const child = oldParent.children.get(oldName);

    if (child === undefined) {
      throw new VfsError('ENOENT', `no such file or directory: ${oldPath}`);
    }

    const { parent: newParent, name: newName } = this.resolveParent(newPath);
    this.assertDirectoryMutationPermission(newParent);

    oldParent.children.delete(oldName);
    newParent.children.set(newName, child);
    this.notifyChange();
  }

  /**
   * POSIX hard link — make `newPath` an alias for `oldPath`'s
   * underlying inode.  Both names index the same FileInode, so a
   * write through either appears in both.  Linux semantics:
   *   - oldPath must exist
   *   - newPath must not exist (EEXIST otherwise)
   *   - oldPath must be a regular file (EPERM on directories;
   *     symlink target follows the conventional behavior of
   *     linking the symlink's referent, not the symlink itself)
   * Wired to the WASI path_link syscall in wasi-host so guest
   * binaries that call link(2) (BusyBox `ln` without -s, etc.)
   * see the new path immediately.
   */
  link(oldPath: string, newPath: string): void {
    if (this.isProviderMountPath(newPath)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${newPath}`);
    }
    const { parent: newParent, name: newName } = this.resolveParent(newPath);
    this.assertDirectoryMutationPermission(newParent);
    if (newParent.children.has(newName)) {
      throw new VfsError('EEXIST', `file exists: ${newPath}`);
    }

    // Resolve oldPath following symlinks to the underlying file.
    let inode = this.resolve(oldPath);
    if (inode.type === 'symlink') {
      // Conventional: hard-link the symlink's target, not the
      // symlink itself.  resolve() doesn't auto-follow at the
      // leaf, so do it here.
      inode = this.resolve(inode.target);
    }
    if (inode.type === 'dir') {
      throw new VfsError('EACCES', `hard link not allowed for directory: ${oldPath}`);
    }

    this.assertFileCountLimit();
    newParent.children.set(newName, inode);
    this.currentFileCount++;
    this.notifyChange();
  }

  symlink(target: string, path: string): void {
    if (this.isProviderMountPath(path)) {
      throw new VfsError('EROFS', `virtual mount path is read-only: ${path}`);
    }
    const { parent, name } = this.resolveParent(path);
    this.assertDirectoryMutationPermission(parent);

    if (parent.children.has(name)) {
      throw new VfsError('EEXIST', `file exists: ${path}`);
    }

    this.assertFileCountLimit();
    const owner = this.currentOwner();
    parent.children.set(name, createSymlinkInode(target, owner.uid, owner.gid));
    this.currentFileCount++;
    this.notifyChange();
  }

  chmod(path: string, mode: number): void {
    const inode = this.resolve(path);
    this.assertChmodPermission(inode);
    inode.metadata.permissions = normalizeMode(mode);
    inode.metadata.ctime = new Date();
    this.notifyChange();
  }

  chown(path: string, uid: number, gid: number, followSymlinks = true): void {
    const inode = this.resolve(path, followSymlinks);
    this.assertChownPermission(inode, uid, gid);
    if (uid !== -1) inode.metadata.uid = uid;
    if (gid !== -1) inode.metadata.gid = gid;
    inode.metadata.ctime = new Date();
    this.notifyChange();
  }

  readlink(path: string): string {
    const inode = this.resolve(path, false);

    if (inode.type !== 'symlink') {
      throw new VfsError('ENOENT', `not a symlink: ${path}`);
    }

    return inode.target;
  }

  /**
   * Capture a snapshot of the current filesystem state.
   * Returns a snapshot ID that can be passed to restore().
   */
  snapshot(): string {
    const id = String(this.nextSnapId++);
    this.snapshots.set(id, deepCloneRoot(this.root));
    return id;
  }

  /**
   * Restore the filesystem to a previously captured snapshot.
   * The snapshot remains available for future restores.
   */
  restore(id: string): void {
    const saved = this.snapshots.get(id);
    if (saved === undefined) {
      throw new Error(`no such snapshot: ${id}`);
    }
    this.root = deepCloneRoot(saved);
    this.notifyChange();
  }

  /**
   * Create an independent copy-on-write clone of this VFS.
   *
   * The clone shares file content by reference but has its own
   * directory structure. Since writeFile replaces (rather than
   * mutates) content arrays, writes in either VFS are invisible
   * to the other — natural COW semantics.
   */
  getStorageStats(): {
    totalBytes: number;
    limitBytes: number | undefined;
    fileCount: number;
    fileCountLimit: number | undefined;
  } {
    return {
      totalBytes: this.totalBytes,
      limitBytes: this.fsLimitBytes,
      fileCount: this.currentFileCount,
      fileCountLimit: this.fileCountLimit,
    };
  }

  /** Clear all file content buffers to free memory. Directory structure and metadata are preserved. */
  clearFileContents(): void {
    const walk = (node: DirInode): void => {
      for (const child of node.children.values()) {
        if (child.type === 'file') {
          this.totalBytes -= child.content.byteLength;
          child.content = new Uint8Array(0);
        } else if (child.type === 'dir') {
          walk(child);
        }
      }
    };
    walk(this.root);
  }

  cowClone(options?: { uid?: number; gid?: number }): VFS {
    return VFS.fromRoot(deepCloneRoot(this.root), {
      fsLimitBytes: this.fsLimitBytes,
      totalBytes: this.totalBytes,
      fileCountLimit: this.fileCountLimit,
      currentFileCount: this.currentFileCount,
      uid: options?.uid ?? this.uid,
      gid: options?.gid ?? this.gid,
      providers: this.providers,
    });
  }
}

function normalizeMode(mode: number): number {
  return Math.trunc(mode) & 0o7777;
}
