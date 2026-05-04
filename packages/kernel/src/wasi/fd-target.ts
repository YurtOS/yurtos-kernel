import type { AsyncPipeReadEnd, AsyncPipeWriteEnd } from '../vfs/pipe.js';
import type { SocketBackendResult, SocketHandle, SocketListenerHandle } from '../network/socket-backend.js';
import type { FdTable } from '../vfs/fd-table.js';

/** Target for a file descriptor in a process's fd table. */
export type FdTarget =
  | { type: 'buffer'; buf: Uint8Array[]; total: number; limit: number; truncated: boolean; onChunk?: (data: Uint8Array) => void }
  | { type: 'pipe_read'; pipe: AsyncPipeReadEnd }
  | { type: 'pipe_write'; pipe: AsyncPipeWriteEnd }
  | { type: 'vfs_file'; fdTable: FdTable; fd: number; refs: number }
  | {
      type: 'socket';
      socket: SocketHandle | null;
      listener?: SocketListenerHandle | null;
      refs: number;
      boundHost?: '127.0.0.1' | 'localhost' | '0.0.0.0';
      boundPort?: number;
      peerHost?: string;
      peerPort?: number;
      localHost?: string;
      localPort?: number;
      noDelay?: boolean;
      peekBuffer?: Uint8Array;
      fdFlags?: number;
      readShutdown?: boolean;
      writeShutdown?: boolean;
      send: (socket: SocketHandle, dataB64: string) => SocketBackendResult;
      recv: (socket: SocketHandle, maxBytes: number, opts?: { nonblocking?: boolean }) => SocketBackendResult;
      setNoDelay?: (socket: SocketHandle, enabled: boolean) => SocketBackendResult;
      close: (socket: SocketHandle) => void;
      closeListener?: (listener: SocketListenerHandle) => void;
    }
  | { type: 'static'; data: Uint8Array; offset: number }
  | { type: 'null' };

export function createBufferTarget(limit = Infinity, onChunk?: (data: Uint8Array) => void): FdTarget & { type: 'buffer' } {
  return { type: 'buffer', buf: [], total: 0, limit, truncated: false, onChunk };
}

export function createStaticTarget(data: Uint8Array): FdTarget & { type: 'static' } {
  return { type: 'static', data, offset: 0 };
}

export function createNullTarget(): FdTarget & { type: 'null' } {
  return { type: 'null' };
}

export function createVfsFileTarget(fdTable: FdTable, fd: number): FdTarget & { type: 'vfs_file' } {
  return { type: 'vfs_file', fdTable, fd, refs: 1 };
}

/** Concatenate buffer target chunks into a string. */
export function bufferToString(target: FdTarget & { type: 'buffer' }): string {
  const total = target.buf.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of target.buf) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
