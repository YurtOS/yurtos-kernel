/**
 * /dev virtual provider.
 *
 * Synthetic device files:
 * - /dev/null  — read returns 0 bytes (EOF); writes silently discarded.
 * - /dev/zero  — endless stream of zero bytes.  read returns the
 *                requested length; writes are EROFS.
 * - /dev/full  — like /dev/zero on read, but every write returns
 *                ENOSPC (zero bytes accepted) — POSIX testing tool
 *                for "device-full" failure paths.
 * - /dev/random, /dev/urandom — endless cryptographically random
 *                bytes via crypto.getRandomValues.  read returns
 *                exactly the requested length; writes are EROFS.
 *
 * All four "endless" devices implement streamRead so the FdTable
 * doesn't try to materialize an infinite buffer at open time.  The
 * legacy readFile() entrypoint still works (it returns one chunk
 * of LEGACY_READ_SIZE bytes) for callers that haven't been wired
 * up to streamRead — backwards-compat for anything that calls
 * vfs.readFile('/dev/urandom') directly.
 */

import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

/** Compatibility chunk size for the readFile fallback. */
const LEGACY_READ_SIZE = 4096;

const DEVICES = new Set(['null', 'zero', 'random', 'urandom', 'full']);

export class DevProvider implements VirtualProvider {
  readonly fsType = 'devtmpfs';

  readFile(subpath: string): Uint8Array {
    switch (subpath) {
      case 'null':
        return new Uint8Array(0);
      case 'zero':
      case 'full':
        return new Uint8Array(LEGACY_READ_SIZE);
      case 'random':
      case 'urandom': {
        const buf = new Uint8Array(LEGACY_READ_SIZE);
        crypto.getRandomValues(buf);
        return buf;
      }
      default:
        throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
    }
  }

  /**
   * Per-syscall streaming read.  Returns exactly `length` bytes for
   * the endless devices, or 0 bytes (EOF) for /dev/null.  Called by
   * FdTable on every fd_read so the device can produce fresh content
   * each time without holding any buffered state.
   */
  streamRead(subpath: string, length: number): Uint8Array {
    switch (subpath) {
      case 'null':
        return new Uint8Array(0);
      case 'zero':
      case 'full':
        // Pre-zeroed by Uint8Array allocator.
        return new Uint8Array(length);
      case 'random':
      case 'urandom': {
        // crypto.getRandomValues caps at 65536 bytes per call; chunk
        // larger requests so callers asking for bigger reads still
        // get exactly what they asked for.
        const out = new Uint8Array(length);
        const CRYPTO_MAX = 65536;
        let off = 0;
        while (off < length) {
          const n = Math.min(CRYPTO_MAX, length - off);
          crypto.getRandomValues(out.subarray(off, off + n));
          off += n;
        }
        return out;
      }
      default:
        throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
    }
  }

  writeFile(subpath: string, data: Uint8Array): void {
    // Re-route through streamWrite so devices report consistent
    // semantics regardless of which entry-point the caller hit.
    this.streamWrite(subpath, data);
  }

  /**
   * Per-syscall streaming write.  Returns the byte count actually
   * accepted: full == data.byteLength means "all bytes written",
   * 0 means "device full / EROFS / refused".  /dev/null accepts
   * everything; /dev/full accepts nothing (so libc surfaces ENOSPC);
   * the read-only devices throw EROFS.
   */
  streamWrite(subpath: string, data: Uint8Array): number {
    switch (subpath) {
      case 'null':
        return data.byteLength;
      case 'full':
        // Linux /dev/full returns ENOSPC on every write.  Throwing
        // here propagates through FdTable.write to WasiHost.fd_write,
        // which translates VfsError into the matching WASI errno —
        // surfacing to the guest as the standard POSIX failure path.
        // Returning 0 instead would risk callers spinning in retry
        // loops because "no progress made" isn't a hard error in
        // some libc implementations.
        throw new VfsError('ENOSPC', `no space left on device: /dev/${subpath}`);
      case 'zero':
      case 'random':
      case 'urandom':
        throw new VfsError('EROFS', `read-only device: /dev/${subpath}`);
      default:
        throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
    }
  }

  exists(subpath: string): boolean {
    if (subpath === '') return true; // /dev itself
    return DEVICES.has(subpath);
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    if (subpath === '') {
      return { type: 'dir', size: DEVICES.size };
    }
    if (DEVICES.has(subpath)) {
      // Linux reports 0 for character devices in stat.st_size.
      return { type: 'file', size: 0 };
    }
    throw new VfsError('ENOENT', `no such file or directory: /dev/${subpath}`);
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    if (subpath !== '') {
      throw new VfsError('ENOTDIR', `not a directory: /dev/${subpath}`);
    }
    return Array.from(DEVICES).map(name => ({ name, type: 'file' as const }));
  }
}
