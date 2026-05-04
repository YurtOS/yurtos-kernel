/**
 * Pipe implementation for shell pipeline execution.
 *
 * A pipe provides a unidirectional byte channel between a write end and
 * a read end. Data written to the write end can be consumed from the
 * read end in FIFO order. This is the building block for shell pipelines
 * like `cat file | grep pattern | wc -l`.
 */

export interface PipeReadEnd {
  read(buf: Uint8Array): number;
  close(): void;
  addRef?(): void;
}

export interface PipeWriteEnd {
  write(data: Uint8Array): number;
  close(): void;
  addRef?(): void;
}

interface PipeBuffer {
  chunks: Uint8Array[];
  totalBytes: number;
  writeClosed: boolean;
  readClosed: boolean;
}

/**
 * Create a pipe returning [readEnd, writeEnd].
 *
 * Both ends share an internal buffer. The write end appends data;
 * the read end consumes it. When the write end is closed and the
 * buffer is drained, reads return 0 (EOF).
 */
export function createPipe(): [PipeReadEnd, PipeWriteEnd] {
  const shared: PipeBuffer = {
    chunks: [],
    totalBytes: 0,
    writeClosed: false,
    readClosed: false,
  };

  const readEnd: PipeReadEnd = {
    read(buf: Uint8Array): number {
      if (shared.totalBytes === 0) {
        return 0;
      }

      let bytesRead = 0;
      const requested = buf.byteLength;

      while (bytesRead < requested && shared.chunks.length > 0) {
        const chunk = shared.chunks[0];
        const available = chunk.byteLength;
        const needed = requested - bytesRead;

        if (available <= needed) {
          buf.set(chunk, bytesRead);
          bytesRead += available;
          shared.chunks.shift();
        } else {
          buf.set(chunk.subarray(0, needed), bytesRead);
          shared.chunks[0] = chunk.subarray(needed);
          bytesRead += needed;
        }
      }

      shared.totalBytes -= bytesRead;
      return bytesRead;
    },

    close(): void {
      shared.readClosed = true;
    },

    addRef(): void {
      // No-op for sync pipe (no refcount)
    },
  };

  const writeEnd: PipeWriteEnd = {
    write(data: Uint8Array): number {
      if (shared.writeClosed) {
        throw new Error('write to closed pipe');
      }
      if (data.byteLength === 0) {
        return 0;
      }
      const copy = new Uint8Array(data);
      shared.chunks.push(copy);
      shared.totalBytes += copy.byteLength;
      return copy.byteLength;
    },

    close(): void {
      shared.writeClosed = true;
    },

    addRef(): void {
      // No-op for sync pipe (no refcount)
    },
  };

  return [readEnd, writeEnd];
}

// ---------------------------------------------------------------------------
// Async pipe with back-pressure, EOF, and EPIPE
// ---------------------------------------------------------------------------

const DEFAULT_PIPE_CAPACITY = 65536; // 64KB, matches Linux PIPE_BUF

export interface AsyncPipeReadEnd {
  /** Read up to buf.length bytes. Returns 0 on EOF. Suspends if empty. */
  read(buf: Uint8Array): Promise<number>;
  /**
   * Synchronous read — for non-JSPI environments where WASM cannot await.
   * Reads available buffered data (up to buf.length bytes) and returns the
   * number of bytes read, or 0 for EOF (write end closed, no data).
   * If no data is available but the write end is still open, returns 0 as well
   * (caller treats it as EOF — acceptable for pre-filled pipeline buffers).
   */
  readSync(buf: Uint8Array): number;
  /** Drain all currently buffered data synchronously. Does NOT wait for more data. */
  drainSync(): Uint8Array;
  close(): void;
  /** Increment reference count (for sharing across fd tables). */
  addRef(): void;
  readonly closed: boolean;
  /** Whether the pipe has buffered data available for a non-blocking read. */
  readonly hasData: boolean;
}

export interface AsyncPipeWriteEnd {
  /** Write data. Returns bytes written (0 if pipe full), or -1 on EPIPE (read end closed). */
  write(data: Uint8Array): number;
  /** Write data, waiting for space if pipe is full. Returns total bytes written, or -1 on EPIPE. */
  writeAsync(data: Uint8Array): Promise<number>;
  close(): void;
  /** Increment reference count (for sharing across fd tables). */
  addRef(): void;
  readonly closed: boolean;
  /** Whether the pipe has space for a non-blocking write. */
  readonly hasCapacity: boolean;
}

interface AsyncPipeBuffer {
  chunks: Uint8Array[];
  totalBytes: number;
  writeClosed: boolean;
  readClosed: boolean;
  writeRefs: number;
  readRefs: number;
  capacity: number;
  pendingReader: ((n: number) => void) | null;
  pendingReaderBuf: Uint8Array | null;
  pendingWriter: ((n: number) => void) | null;
  pendingWriterData: Uint8Array | null;
}

/**
 * Create an async pipe returning [readEnd, writeEnd].
 *
 * Like `createPipe` but with Promise-based I/O:
 * - Reads suspend (return a Promise) when the buffer is empty.
 * - Writes can apply back-pressure when the buffer exceeds `capacity`.
 * - Closing the write end signals EOF to readers.
 * - Closing the read end signals EPIPE (-1) to writers.
 */
export function createAsyncPipe(
  capacity = DEFAULT_PIPE_CAPACITY,
): [AsyncPipeReadEnd, AsyncPipeWriteEnd] {
  const shared: AsyncPipeBuffer = {
    chunks: [],
    totalBytes: 0,
    writeClosed: false,
    readClosed: false,
    writeRefs: 1,
    readRefs: 1,
    capacity,
    pendingReader: null,
    pendingReaderBuf: null,
    pendingWriter: null,
    pendingWriterData: null,
  };

  /** Drain buffered chunks into `buf`, returning bytes copied. */
  function drainChunks(buf: Uint8Array): number {
    let offset = 0;
    while (offset < buf.length && shared.chunks.length > 0) {
      const chunk = shared.chunks[0];
      const needed = buf.length - offset;
      if (chunk.length <= needed) {
        buf.set(chunk, offset);
        offset += chunk.length;
        shared.totalBytes -= chunk.length;
        shared.chunks.shift();
      } else {
        buf.set(chunk.subarray(0, needed), offset);
        shared.chunks[0] = chunk.subarray(needed);
        shared.totalBytes -= needed;
        offset += needed;
      }
    }
    return offset;
  }

  /** If a writer is blocked and space is now available, unblock it. */
  function tryFlushPendingWriter(): void {
    if (!shared.pendingWriter || !shared.pendingWriterData) return;
    if (shared.readClosed) {
      const resolve = shared.pendingWriter;
      shared.pendingWriter = null;
      shared.pendingWriterData = null;
      resolve(-1); // EPIPE
      return;
    }
    const spaceAvailable = shared.capacity - shared.totalBytes;
    if (spaceAvailable <= 0) return;
    const data = shared.pendingWriterData;
    const toWrite = Math.min(data.length, spaceAvailable);
    shared.chunks.push(data.slice(0, toWrite));
    shared.totalBytes += toWrite;
    const resolve = shared.pendingWriter;
    shared.pendingWriter = null;
    shared.pendingWriterData = null;
    resolve(toWrite);
  }

  const readEnd: AsyncPipeReadEnd = {
    get closed() {
      return shared.readClosed;
    },

    get hasData() {
      return shared.totalBytes > 0 || shared.writeClosed;
    },

    async read(buf: Uint8Array): Promise<number> {
      if (shared.pendingReader) {
        throw new Error('concurrent read on async pipe');
      }
      // Data available — drain immediately.
      if (shared.totalBytes > 0) {
        const n = drainChunks(buf);
        tryFlushPendingWriter();
        return n;
      }
      // No data and write end closed — EOF.
      if (shared.writeClosed) return 0;
      // No data yet — suspend until writer pushes data or closes.
      return new Promise<number>((resolve) => {
        shared.pendingReader = resolve;
        shared.pendingReaderBuf = buf;
      });
    },

    readSync(buf: Uint8Array): number {
      if (shared.totalBytes > 0) {
        const n = drainChunks(buf);
        tryFlushPendingWriter();
        return n;
      }
      // No data: return 0 (EOF) for both closed and open write end.
      return 0;
    },

    drainSync(): Uint8Array {
      if (shared.totalBytes === 0) return new Uint8Array(0);
      const buf = new Uint8Array(shared.totalBytes);
      drainChunks(buf);
      tryFlushPendingWriter();
      return buf;
    },

    close() {
      if (--shared.readRefs > 0) return;
      shared.readClosed = true;
      // Wake blocked writer with EPIPE.
      if (shared.pendingWriter) {
        const resolve = shared.pendingWriter;
        shared.pendingWriter = null;
        shared.pendingWriterData = null;
        resolve(-1);
      }
    },

    addRef() {
      shared.readRefs++;
    },
  };

  const writeEnd: AsyncPipeWriteEnd = {
    get closed() {
      return shared.writeClosed;
    },

    get hasCapacity() {
      return shared.totalBytes < shared.capacity || shared.readClosed;
    },

    write(data: Uint8Array): number {
      if (shared.readClosed) return -1;
      if (shared.writeClosed) return -1;
      const spaceAvailable = shared.capacity - shared.totalBytes;
      const toWrite = Math.min(data.length, spaceAvailable);
      if (toWrite > 0) {
        shared.chunks.push(data.slice(0, toWrite));
        shared.totalBytes += toWrite;
      }
      // Wake a pending reader if one exists.
      if (shared.pendingReader && shared.pendingReaderBuf) {
        const n = drainChunks(shared.pendingReaderBuf);
        const resolve = shared.pendingReader;
        shared.pendingReader = null;
        shared.pendingReaderBuf = null;
        resolve(n);
      }
      return toWrite;
    },

    async writeAsync(data: Uint8Array): Promise<number> {
      // Contract: writeAsync(data) where data.length > 0 always
      // resolves with either -1 (EPIPE) or a value ≥ 1.  It never
      // returns 0, since 0 from a non-empty write would loop the
      // wasi-host caller forever.  fdWritePipe in wasi-host.ts
      // depends on this — if you change the resolve sites below,
      // keep them honest with the asserts.  Zero-length writes
      // legitimately resolve with 0 ("wrote all of nothing"); the
      // wasi-host caller guards against passing those.
      if (shared.readClosed) return -1;
      if (shared.writeClosed) return -1;
      if (shared.pendingWriter) {
        throw new Error('concurrent writeAsync on async pipe');
      }
      const spaceAvailable = shared.capacity - shared.totalBytes;
      if (spaceAvailable >= data.length) {
        const n = this.write(data);
        // Forward-progress invariant: n>0 whenever data.length>0.
        if (data.length > 0 && n === 0) {
          throw new Error('writeAsync: write() returned 0 for a non-empty buffer');
        }
        return n;
      }
      // Partially fill what we can, then block for the remainder.
      let written = 0;
      if (spaceAvailable > 0) {
        this.write(data.subarray(0, spaceAvailable));
        written = spaceAvailable;
        data = data.subarray(spaceAvailable);
      }
      return new Promise<number>((resolve) => {
        shared.pendingWriter = (n: number) => {
          // Resolve with EPIPE, or written + the most recent flush
          // chunk (which tryFlushPendingWriter guarantees is ≥ 1).
          // Net result must be ≥ 1 for non-empty inputs.
          const result = n === -1 ? -1 : written + n;
          if (result === 0) {
            throw new Error('writeAsync: pending resolve produced 0 for a non-empty buffer');
          }
          resolve(result);
        };
        shared.pendingWriterData = data;
      });
    },

    close() {
      if (--shared.writeRefs > 0) return;
      shared.writeClosed = true;
      // Wake a pending reader with EOF.
      if (shared.pendingReader) {
        const resolve = shared.pendingReader;
        shared.pendingReader = null;
        shared.pendingReaderBuf = null;
        resolve(0);
      }
    },

    addRef() {
      shared.writeRefs++;
    },
  };

  return [readEnd, writeEnd];
}
