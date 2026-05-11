/**
 * File descriptor table for WASI syscall support.
 *
 * WASI syscalls (fd_read, fd_write, fd_seek, etc.) operate on integer
 * file descriptors rather than paths. This module maps fd numbers to
 * open file state (path, content buffer, offset, mode) and mediates
 * all I/O through the underlying VFS.
 *
 * Fds 0, 1, 2 are reserved for stdin, stdout, stderr and are not
 * allocated by open().
 */

import type { VfsLike } from "./vfs-like.js";
import type { FsCredential } from "./inode.js";

export type OpenMode = "r" | "w" | "a" | "rw";
export type SeekWhence = "set" | "cur" | "end";

interface FdEntry {
  path: string;
  mode: OpenMode;
  buffer: Uint8Array;
  offset: number;
  dirty: boolean;
  refs: number;
  credential?: FsCredential;
  /**
   * Per-syscall stream callbacks for endless / device-style files
   * (/dev/urandom, /dev/zero, /dev/null, /dev/full).  When present,
   * read/write bypass the buffer-and-offset model entirely and
   * route to these closures, so we never materialize an infinite
   * stream into linear memory at open time.  Mutually exclusive
   * with `buffer` being meaningful (it stays empty in that case).
   */
  streamRead?: (length: number) => Uint8Array;
  streamWrite?: (data: Uint8Array) => number;
}

const FIRST_FD = 3; // 0 = stdin, 1 = stdout, 2 = stderr

/**
 * File descriptor table that maps integer fds to open file state.
 *
 * Reads snapshot file content at open time and serve reads from
 * that buffer. Writes are buffered in memory and flushed to the
 * VFS when the fd is closed.
 */
export class FdTable {
  private vfs: VfsLike;
  private entries: Map<number, FdEntry> = new Map();
  private nextFd: number = FIRST_FD;

  constructor(vfs: VfsLike, credential?: FsCredential) {
    this.vfs = vfs;
    this.credential = credential;
  }

  private credential?: FsCredential;

  /** Open a file and return its fd number. */
  open(path: string, mode: OpenMode): number {
    // Streaming providers (/dev/urandom, /dev/zero, /dev/null,
    // /dev/full) bypass the materialize-at-open path entirely:
    // every read/write per fd_read/fd_write syscall calls the
    // provider directly, so we never hold an infinite stream in
    // a Uint8Array.
    const stream = this.vfs.streamFile?.(path) ?? null;
    if (stream) {
      const fd = this.nextFd++;
      this.entries.set(fd, {
        path,
        mode,
        buffer: new Uint8Array(0),
        offset: 0,
        dirty: false,
        refs: 1,
        credential: this.credential,
        streamRead: stream.read,
        streamWrite: stream.write,
      });
      return fd;
    }

    let buffer: Uint8Array;

    if (mode === "r" || mode === "rw") {
      buffer = new Uint8Array(this.vfs.readFile(path));
    } else if (mode === "a") {
      // Append: load existing content so writes go after it
      try {
        const existing = this.vfs.readFile(path);
        buffer = new Uint8Array(existing);
      } catch {
        buffer = new Uint8Array(0);
      }
    } else {
      // Write mode: truncate (start with empty buffer)
      buffer = new Uint8Array(0);
    }

    const offset = mode === "a" ? buffer.byteLength : 0;

    const fd = this.nextFd++;
    this.entries.set(fd, {
      path,
      mode,
      buffer,
      offset,
      dirty: mode === "w" || mode === "a",
      refs: 1,
      credential: this.credential,
    });

    return fd;
  }

  /** Read from an open fd into buf. Returns the number of bytes read. */
  read(fd: number, buf: Uint8Array): number {
    const entry = this.getEntry(fd);
    if (entry.streamRead) {
      const data = entry.streamRead(buf.byteLength);
      buf.set(data);
      // No offset bookkeeping for streams — they're endless or
      // EOF-once (/dev/null returns 0 bytes) and don't seek.
      return data.byteLength;
    }
    const available = entry.buffer.byteLength - entry.offset;

    if (available <= 0) {
      return 0;
    }

    const toRead = Math.min(buf.byteLength, available);
    buf.set(entry.buffer.subarray(entry.offset, entry.offset + toRead));
    entry.offset += toRead;
    return toRead;
  }

  /** Write data to an open fd. Returns the number of bytes written. */
  write(fd: number, data: Uint8Array): number {
    const entry = this.getEntry(fd);
    if (entry.streamWrite) {
      // Stream-write returns bytes-accepted; can be 0 (e.g.
      // /dev/full) which libc translates into errno=ENOSPC.
      return entry.streamWrite(data);
    }
    const newLength = Math.max(
      entry.buffer.byteLength,
      entry.offset + data.byteLength,
    );

    if (newLength > entry.buffer.byteLength) {
      const grown = new Uint8Array(newLength);
      grown.set(entry.buffer);
      entry.buffer = grown;
    }

    entry.buffer.set(data, entry.offset);
    entry.offset += data.byteLength;
    entry.dirty = true;
    return data.byteLength;
  }

  /** Read from an open fd at a given offset without changing the fd's offset. */
  pread(fd: number, buf: Uint8Array, offset: number): number {
    const entry = this.getEntry(fd);
    const available = entry.buffer.byteLength - offset;
    if (available <= 0) return 0;
    const toRead = Math.min(buf.byteLength, available);
    buf.set(entry.buffer.subarray(offset, offset + toRead));
    return toRead;
  }

  /** Write data to an open fd at a given offset without changing the fd's offset. */
  pwrite(fd: number, data: Uint8Array, offset: number): number {
    const entry = this.getEntry(fd);
    const newLength = Math.max(
      entry.buffer.byteLength,
      offset + data.byteLength,
    );
    if (newLength > entry.buffer.byteLength) {
      const grown = new Uint8Array(newLength);
      grown.set(entry.buffer);
      entry.buffer = grown;
    }
    entry.buffer.set(data, offset);
    entry.dirty = true;
    return data.byteLength;
  }

  /** Truncate (or extend) an open fd's buffer to the given size. */
  truncate(fd: number, size: number): void {
    const entry = this.getEntry(fd);
    if (size === entry.buffer.byteLength) return;
    const newBuf = new Uint8Array(size);
    newBuf.set(
      entry.buffer.subarray(0, Math.min(size, entry.buffer.byteLength)),
    );
    entry.buffer = newBuf;
    if (entry.offset > size) entry.offset = size;
    entry.dirty = true;
  }

  /** Seek to a position in the file. Returns the new offset. */
  seek(fd: number, offset: number, whence: SeekWhence): number {
    const entry = this.getEntry(fd);

    if (whence === "set") {
      entry.offset = offset;
    } else if (whence === "cur") {
      entry.offset += offset;
    } else {
      entry.offset = entry.buffer.byteLength + offset;
    }

    entry.offset = Math.max(0, entry.offset);
    return entry.offset;
  }

  /** Return the current offset for an fd. */
  tell(fd: number): number {
    return this.getEntry(fd).offset;
  }

  /** Close an fd, flushing buffered writes to the VFS. */
  close(fd: number): void {
    const entry = this.getEntry(fd);
    entry.refs--;
    this.entries.delete(fd);

    if (entry.dirty) {
      this.withEntryCredential(
        entry,
        () => this.vfs.writeFile(entry.path, entry.buffer),
      );
      entry.dirty = false;
    }
  }

  /** Duplicate an fd, returning a new fd with independent offset. */
  dup(fd: number): number {
    const entry = this.getEntry(fd);
    const newFd = this.nextFd++;

    this.entries.set(newFd, {
      path: entry.path,
      mode: entry.mode,
      buffer: entry.buffer,
      offset: 0,
      dirty: entry.dirty,
      refs: 1,
      credential: entry.credential,
    });

    return newFd;
  }

  /** Check whether an fd is currently open. */
  isOpen(fd: number): boolean {
    return this.entries.has(fd);
  }

  countOpen(): number {
    return this.entries.size;
  }

  /** Return the currently open fd numbers. */
  openFds(): number[] {
    return Array.from(this.entries.keys());
  }

  /** Retain another process/kernel descriptor reference to an fd entry. */
  retain(fd: number): void {
    const entry = this.getEntry(fd);
    entry.refs++;
  }

  /** Move an fd entry from one number to another. Closes toFd if open. */
  renumber(fromFd: number, toFd: number): void {
    const entry = this.entries.get(fromFd);
    if (entry === undefined) {
      throw new Error(`EBADF: bad file descriptor ${fromFd}`);
    }

    // Close target fd if it's open (flushes writes)
    if (this.entries.has(toFd)) {
      this.close(toFd);
    }

    // Move entry
    this.entries.set(toFd, entry);
    this.entries.delete(fromFd);

    // Prevent future open() from reusing toFd
    if (toFd >= this.nextFd) {
      this.nextFd = toFd + 1;
    }
  }

  /** Duplicate an fd to an exact number, sharing the same open file description. */
  dupToShared(fromFd: number, toFd: number): void {
    const entry = this.getEntry(fromFd);
    if (fromFd === toFd) return;
    if (this.entries.has(toFd)) {
      this.close(toFd);
    }
    entry.refs++;
    this.entries.set(toFd, entry);
    if (toFd >= this.nextFd) {
      this.nextFd = toFd + 1;
    }
  }

  /** Duplicate an fd to the next available number, sharing the same open file description. */
  dupShared(fd: number): number {
    const entry = this.getEntry(fd);
    let newFd = this.nextFd;
    while (this.entries.has(newFd)) newFd++;
    entry.refs++;
    this.entries.set(newFd, entry);
    this.nextFd = newFd + 1;
    return newFd;
  }

  /** Return the VFS path for an open fd, or undefined if not open. */
  getPath(fd: number): string | undefined {
    return this.entries.get(fd)?.path;
  }

  getMode(fd: number): OpenMode | undefined {
    return this.entries.get(fd)?.mode;
  }

  /** Duplicate an fd into a detached table over the same VFS. */
  duplicateDetached(fd: number): { table: FdTable; fd: number } {
    const entry = this.getEntry(fd);
    const table = new FdTable(this.vfs, entry.credential);
    const childFd = table.open(entry.path, entry.mode);
    table.seek(childFd, entry.offset, "set");
    return { table, fd: childFd };
  }

  /** Duplicate an fd into a detached table, sharing the same open file description. */
  duplicateSharedDetached(
    fd: number,
    preferredFd = fd,
  ): { table: FdTable; fd: number } {
    const entry = this.getEntry(fd);
    const table = new FdTable(this.vfs, entry.credential);
    let childFd = preferredFd;
    while (table.entries.has(childFd)) childFd++;
    entry.refs++;
    table.entries.set(childFd, entry);
    table.nextFd = childFd + 1;
    return { table, fd: childFd };
  }

  /** Clone the fd table for fork, sharing POSIX open file descriptions. */
  clone(): FdTable {
    const cloned = new FdTable(this.vfs, this.credential);
    cloned.nextFd = this.nextFd;

    for (const [fd, entry] of this.entries) {
      entry.refs++;
      cloned.entries.set(fd, entry);
    }

    return cloned;
  }

  /** Look up an fd entry, throwing if the fd is not open. */
  private getEntry(fd: number): FdEntry {
    const entry = this.entries.get(fd);
    if (entry === undefined) {
      throw new Error(`EBADF: bad file descriptor ${fd}`);
    }
    return entry;
  }

  private withEntryCredential<T>(entry: FdEntry, fn: () => T): T {
    if (!entry.credential || !this.vfs.withCredential) return fn();
    return this.vfs.withCredential(entry.credential, fn);
  }
}
