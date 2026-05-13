export const WORKER_HOST_RESPONSE_BYTES = 8 + 4096;

const HEADER_STATUS = 0;
const HEADER_RESULT = 1;
const HEADER_BYTES = 8;
const STATUS_IDLE = 0;
const STATUS_REQUEST_READY = 1;
const STATUS_RESPONSE_READY = 2;
const STATUS_ERROR = -1;

export const enum WorkerHostOp {
  ThreadSelf = 1,
  ThreadYield = 2,
  ThreadExit = 3,
  WriteFd = 10,
  ReadFd = 11,
  SocketOpen = 20,
  SocketClose = 21,
  SocketRecv = 22,
  SocketSend = 23,
}

export interface WorkerHostImportProxy {
  requestSab: SharedArrayBuffer;
}

export interface WorkerHostProxyImports {
  host_write_fd(fd: number, dataPtr: number, dataLen: number): number;
}

export type WorkerHostDispatchImports = Partial<WorkerHostProxyImports>;

export function createWorkerHostImportProxy(): WorkerHostImportProxy {
  return { requestSab: new SharedArrayBuffer(WORKER_HOST_RESPONSE_BYTES) };
}

export function dispatchWorkerHostCall(
  proxy: WorkerHostImportProxy,
  imports: WorkerHostDispatchImports,
): void {
  const header = new Int32Array(proxy.requestSab, 0, 2);
  const payload = new Int32Array(proxy.requestSab, HEADER_BYTES);
  let result = -38;

  try {
    if (Atomics.load(header, HEADER_STATUS) !== STATUS_REQUEST_READY) {
      result = -22;
    } else {
      switch (payload[0]) {
        case WorkerHostOp.WriteFd:
          if (payload[1] !== 3 || !imports.host_write_fd) {
            result = -38;
          } else {
            result = imports.host_write_fd(payload[2], payload[3], payload[4]);
          }
          break;
      }
    }
    Atomics.store(header, HEADER_RESULT, result);
    Atomics.store(header, HEADER_STATUS, STATUS_RESPONSE_READY);
  } catch {
    Atomics.store(header, HEADER_RESULT, -1);
    Atomics.store(header, HEADER_STATUS, STATUS_ERROR);
  }
  Atomics.notify(header, HEADER_STATUS);
}

export function createWorkerHostProxyImports(
  memory: WebAssembly.Memory,
  proxy: WorkerHostImportProxy | undefined,
  postHostCall: (op: WorkerHostOp) => void,
): WorkerHostProxyImports {
  return {
    host_write_fd(fd: number, dataPtr: number, dataLen: number): number {
      if (!proxy) return -38;
      if (dataLen < 0) return -22;
      const data = new Uint8Array(memory.buffer, dataPtr, dataLen);
      return requestHostCall(
        proxy,
        postHostCall,
        WorkerHostOp.WriteFd,
        [fd, dataPtr, dataLen],
        data,
      );
    },
  };
}

function requestHostCall(
  proxy: WorkerHostImportProxy,
  postHostCall: (op: WorkerHostOp) => void,
  op: WorkerHostOp,
  args: readonly number[],
  bytes?: Uint8Array,
): number {
  const header = new Int32Array(proxy.requestSab, 0, 2);
  const payload = new Int32Array(proxy.requestSab, HEADER_BYTES);
  const payloadBytes = new Uint8Array(proxy.requestSab, HEADER_BYTES);
  const byteOffset = (2 + args.length) * Int32Array.BYTES_PER_ELEMENT;

  if (
    Atomics.compareExchange(
      header,
      HEADER_STATUS,
      STATUS_IDLE,
      STATUS_REQUEST_READY,
    ) !== STATUS_IDLE
  ) {
    return -16;
  }

  payload[0] = op;
  payload[1] = args.length;
  for (let i = 0; i < args.length; i++) payload[i + 2] = args[i];
  if (bytes) {
    if (byteOffset + bytes.byteLength > payloadBytes.byteLength) {
      Atomics.store(header, HEADER_STATUS, STATUS_IDLE);
      return -7;
    }
    payloadBytes.set(bytes, byteOffset);
  }
  Atomics.store(header, HEADER_RESULT, 0);

  postHostCall(op);
  Atomics.wait(header, HEADER_STATUS, STATUS_REQUEST_READY);

  const status = Atomics.load(header, HEADER_STATUS);
  const result = Atomics.load(header, HEADER_RESULT);
  Atomics.store(header, HEADER_STATUS, STATUS_IDLE);
  return status === STATUS_RESPONSE_READY ? result : STATUS_ERROR;
}
