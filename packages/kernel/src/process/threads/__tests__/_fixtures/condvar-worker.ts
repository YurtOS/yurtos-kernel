import { SabCondvar, SabMutex } from "../../sab-primitives.ts";

self.onmessage = (
  event: MessageEvent<{
    sab: SharedArrayBuffer;
    tid: number;
    mutexOffset: number;
    condOffset: number;
    readyOffset: number;
  }>,
) => {
  const { sab, tid, mutexOffset, condOffset, readyOffset } = event.data;
  const mutex = new SabMutex(sab, mutexOffset);
  const condvar = new SabCondvar(sab, condOffset);
  const ready = new Int32Array(sab, readyOffset, 1);

  mutex.lock(tid);
  Atomics.add(ready, 0, 1);
  Atomics.notify(ready, 0);
  condvar.wait(mutex, tid);
  mutex.unlock(tid);
  self.postMessage(tid);
};
