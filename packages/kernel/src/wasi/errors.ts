/** Map VFS errno strings to WASI error code numbers. */

import type { Errno } from '../vfs/inode.js';
import {
  WASI_EACCES,
  WASI_EBADF,
  WASI_EEXIST,
  WASI_EIO,
  WASI_EISDIR,
  WASI_ENOENT,
  WASI_ENOSPC,
  WASI_ENOTDIR,
  WASI_ENOTEMPTY,
  WASI_EROFS,
} from './types.js';

export function vfsErrnoToWasi(errno: Errno): number {
  switch (errno) {
    case 'ENOENT':
      return WASI_ENOENT;
    case 'EEXIST':
      return WASI_EEXIST;
    case 'ENOTDIR':
      return WASI_ENOTDIR;
    case 'EISDIR':
      return WASI_EISDIR;
    case 'ENOTEMPTY':
      return WASI_ENOTEMPTY;
    case 'EROFS':
      return WASI_EROFS;
    case 'EACCES':
      return WASI_EACCES;
    case 'ENOSPC':
      return WASI_ENOSPC;
    default:
      return WASI_EIO;
  }
}

export function fdErrorToWasi(err: unknown): number {
  if (err instanceof Error && err.message.startsWith('EBADF')) {
    return WASI_EBADF;
  }
  return WASI_EIO;
}
