/**
 * Interface for virtual filesystem providers.
 *
 * Providers handle synthetic mount points like /dev and /proc,
 * intercepting VFS operations before they reach the inode tree.
 */

export interface VirtualProvider {
  /**
   * Filesystem type label, surfaced through /proc/mounts and df.
   * Real Linux filesystems use short lowercase identifiers
   * (proc, devtmpfs, tmpfs, ext4, ...); we follow that convention.
   * Optional for back-compat with older user-mount providers; the VFS
   * substitutes a sensible default ('virtfs') when absent.
   */
  readonly fsType?: string;

  /** Read the contents of a file at the given subpath (relative to mount point). */
  readFile(subpath: string): Uint8Array;

  /** Write data to a file at the given subpath. */
  writeFile(subpath: string, data: Uint8Array): void;

  /** Check whether a file or directory exists at the given subpath. */
  exists(subpath: string): boolean;

  /** Return type and size information for the given subpath. */
  stat(subpath: string): { type: 'file' | 'dir'; size: number };

  /** List entries in a directory at the given subpath. */
  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }>;

  /**
   * Optional: stream-aware read.  When present, the VFS / FdTable
   * routes per-syscall fd_read calls through this method so the
   * provider can produce content on demand — required for endless
   * devices (/dev/zero, /dev/urandom) where the read-once-and-slice
   * model would either truncate at a fixed buffer size or burn
   * memory.  Receives the byte count the caller asked for and
   * returns up to that many bytes (returning 0 bytes signals EOF).
   *
   * Providers that don't define this fall back to the static
   * readFile path, which is correct for finite synthetic files
   * like /proc/version or /proc/<pid>/status.
   */
  streamRead?(subpath: string, length: number): Uint8Array;

  /**
   * Optional: stream-aware write.  Pairs with streamRead for
   * devices that aren't well-modelled as "load file, slice, save".
   * /dev/null and /dev/full both define this — null silently
   * accepts everything, full reports zero bytes written so libc
   * surfaces ENOSPC.  Returns the byte count actually accepted
   * (Linux semantics: <length means partial-write back-pressure).
   */
  streamWrite?(subpath: string, data: Uint8Array): number;
}

/**
 * One entry in the mount table — the structured form behind /proc/mounts.
 * The fields match fstab(5) columns in the same order.
 */
export interface MountEntry {
  /** Source / "device" (typically the fs type name for synthetic mounts). */
  fsname: string;
  /** Mount point path (e.g. '/proc'). */
  mountPath: string;
  /** Filesystem type ('proc', 'devtmpfs', 'yurtfs', ...). */
  fsType: string;
  /** Mount options string (comma-joined, fstab-style). */
  options: string;
}
