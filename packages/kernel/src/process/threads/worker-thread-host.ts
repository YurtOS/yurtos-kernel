import { SabMutex } from "./sab-primitives.ts";
import { WASI_EBUSY } from "../../wasi/types.ts";

interface StartMessage {
  type: "start";
  tid: number;
  fnPtr: number;
  arg: number;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
}

const workerSelf = self as unknown as {
  onmessage:
    | ((event: MessageEvent<StartMessage>) => void | Promise<void>)
    | null;
  postMessage(message: unknown): void;
};

workerSelf.onmessage = async (event: MessageEvent<StartMessage>) => {
  if (event.data.type !== "start") return;
  const { tid, fnPtr, arg, module, memory } = event.data;
  const sharedBuffer = memory.buffer;
  if (!(sharedBuffer instanceof SharedArrayBuffer)) {
    workerSelf.postMessage({ type: "done", tid, retval: -1 });
    return;
  }
  const mutex = (ptr: number) => new SabMutex(sharedBuffer, ptr);

  const instance = await WebAssembly.instantiate(module, {
    env: { memory },
    yurt: {
      host_thread_self: () => tid,
      host_mutex_lock: (ptr: number) => {
        if (mutex(ptr).owner() === tid) return -1;
        mutex(ptr).lock(tid);
        return 0;
      },
      host_mutex_unlock: (ptr: number) => {
        try {
          mutex(ptr).unlock(tid);
          return 0;
        } catch {
          return -1;
        }
      },
      host_mutex_trylock: (ptr: number) =>
        mutex(ptr).tryLock(tid) ? 0 : WASI_EBUSY,
    },
  });
  const table = instance.exports
    .__indirect_function_table as WebAssembly.Table;
  const fn = table.get(fnPtr) as ((arg: number) => number) | null;
  if (!fn) {
    workerSelf.postMessage({ type: "done", tid, retval: -1 });
    return;
  }

  workerSelf.postMessage({ type: "done", tid, retval: fn(arg) });
};
