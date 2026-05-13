import type { AsyncPipeReadEnd, AsyncPipeWriteEnd } from "../vfs/pipe.js";
import type {
  Awaitable,
  SocketBackendResult,
  SocketHandle,
  SocketListenerHandle,
} from "../network/socket-backend.js";
import type { FdTable } from "../vfs/fd-table.js";

/** Shared state between the master and slave sides of a TTY pair. */
export interface TtyState {
  ttyId: number;
  controllingSid: number | null; // session that owns this controlling terminal
  toSlave: Uint8Array[]; // bytes queued for the slave to read (master → slave)
  toSlaveWaiters: (() => void)[];
  toMaster: Uint8Array[]; // bytes queued for the master to read (slave → master)
  toMasterWaiters: (() => void)[];
  fgPgid: number; // foreground process group
  cols: number;
  rows: number;
  masterClosed: boolean; // set when the master fd is closed (signals EOF to slave)
}

/** Target for a file descriptor in a process's fd table. */
export type FdTarget =
  | {
    type: "buffer";
    buf: Uint8Array[];
    total: number;
    limit: number;
    truncated: boolean;
    onChunk?: (data: Uint8Array) => void;
  }
  | { type: "pipe_read"; pipe: AsyncPipeReadEnd }
  | { type: "pipe_write"; pipe: AsyncPipeWriteEnd }
  | { type: "vfs_file"; fdTable: FdTable; fd: number; refs: number }
  | { type: "vfs_dir"; path: string }
  | {
    type: "socket";
    socket: SocketHandle | null;
    listener?: SocketListenerHandle | null;
    refs: number;
    family?: "AF_INET" | "AF_UNIX";
    boundHost?: "127.0.0.1" | "localhost" | "0.0.0.0";
    boundPort?: number;
    boundPath?: string;
    peerHost?: string;
    peerPort?: number;
    localHost?: string;
    localPort?: number;
    peerPath?: string;
    noDelay?: boolean;
    peekBuffer?: Uint8Array;
    fdFlags?: number;
    readShutdown?: boolean;
    writeShutdown?: boolean;
    /** SOCK_DGRAM socket — set when the fd is a datagram socket (Slice 4). */
    isDgram?: boolean;
    /** SO_PEERCRED fields (Slice 6) */
    peerPid?: number;
    peerUid?: number;
    peerGid?: number;
    send: (
      socket: SocketHandle,
      data: Uint8Array,
    ) => Awaitable<SocketBackendResult>;
    recv: (
      socket: SocketHandle,
      maxBytes: number,
      opts?: { nonblocking?: boolean },
    ) => Awaitable<SocketBackendResult>;
    recvAsync: (
      socket: SocketHandle,
      maxBytes: number,
    ) => Promise<SocketBackendResult>;
    setNoDelay?: (
      socket: SocketHandle,
      enabled: boolean,
    ) => Awaitable<SocketBackendResult>;
    close: (socket: SocketHandle) => Awaitable<void>;
    closeListener?: (listener: SocketListenerHandle) => Awaitable<void>;
  }
  | { type: "static"; data: Uint8Array; offset: number }
  | { type: "null" }
  | { type: "tty_master"; ttyId: number; state: TtyState }
  | { type: "tty_slave"; ttyId: number; state: TtyState };

export function createBufferTarget(
  limit = Infinity,
  onChunk?: (data: Uint8Array) => void,
): FdTarget & { type: "buffer" } {
  return {
    type: "buffer",
    buf: [],
    total: 0,
    limit,
    truncated: false,
    onChunk,
  };
}

export function createStaticTarget(
  data: Uint8Array,
): FdTarget & { type: "static" } {
  return { type: "static", data, offset: 0 };
}

export function createNullTarget(): FdTarget & { type: "null" } {
  return { type: "null" };
}

export function createTtyState(ttyId: number): TtyState {
  return {
    ttyId,
    controllingSid: null,
    toSlave: [],
    toSlaveWaiters: [],
    toMaster: [],
    toMasterWaiters: [],
    fgPgid: 0,
    cols: 80,
    rows: 24,
    masterClosed: false,
  };
}

export function createTtyMasterTarget(
  state: TtyState,
): FdTarget & { type: "tty_master" } {
  return { type: "tty_master", ttyId: state.ttyId, state };
}

export function createTtySlaveTarget(
  state: TtyState,
): FdTarget & { type: "tty_slave" } {
  return { type: "tty_slave", ttyId: state.ttyId, state };
}

export function createVfsFileTarget(
  fdTable: FdTable,
  fd: number,
): FdTarget & { type: "vfs_file" } {
  return { type: "vfs_file", fdTable, fd, refs: 1 };
}

export function createVfsDirTarget(
  path: string,
): FdTarget & { type: "vfs_dir" } {
  return { type: "vfs_dir", path };
}

/** Host-side handle for I/O on one end of a TTY pair.
 *  The host writes bytes into the slave's stdin (master→slave direction) and
 *  reads the slave's stdout/stderr (slave→master direction). */
export class TtyHandle {
  constructor(private readonly state: TtyState) {}

  /** Write bytes into the slave's stdin queue and wake any waiting reads. */
  write(data: Uint8Array): void {
    this.state.toSlave.push(data.slice());
    for (const w of this.state.toSlaveWaiters.splice(0)) w();
  }

  /** Read the next output chunk from the slave.
   *  Resolves immediately if data is buffered; suspends until data arrives or
   *  the slave side closes (returns null on close). */
  async read(): Promise<Uint8Array | null> {
    if (this.state.toMaster.length > 0) return this.state.toMaster.shift()!;
    if (this.state.masterClosed) return null;
    return new Promise<Uint8Array | null>((resolve) => {
      this.state.toMasterWaiters.push(() => {
        resolve(this.state.toMaster.shift() ?? null);
      });
    });
  }

  /** Drain all currently buffered output without suspending. */
  drainSync(): Uint8Array {
    const chunks = this.state.toMaster.splice(0);
    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.byteLength;
    }
    return out;
  }

  /** Update the reported terminal dimensions. */
  resize(rows: number, cols: number): void {
    this.state.rows = rows;
    this.state.cols = cols;
  }

  get rows(): number {
    return this.state.rows;
  }
  get cols(): number {
    return this.state.cols;
  }
  get fgPgid(): number {
    return this.state.fgPgid;
  }
}

/** Concatenate buffer target chunks into a string. */
export function bufferToString(target: FdTarget & { type: "buffer" }): string {
  const total = target.buf.reduce((sum, b) => sum + b.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of target.buf) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}
