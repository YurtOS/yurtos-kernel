import { SabCondvar, SabMutex } from "../../sab-primitives.ts";

interface StartMsg {
  sab: SharedArrayBuffer;
  tid: number;
  mutexOffset: number;
  condvarOffset: number;
}

self.onmessage = (e: MessageEvent) => {
  const { sab, tid, mutexOffset, condvarOffset } = e.data as StartMsg;
  const m = new SabMutex(sab, mutexOffset);
  const cv = new SabCondvar(sab, condvarOffset);
  m.lock(tid);
  // Signal readiness so the main thread knows we've entered wait
  // before it broadcasts.
  (self as unknown as Worker).postMessage({ type: "ready", tid });
  cv.wait(m, tid);
  m.unlock(tid);
  (self as unknown as Worker).postMessage({ type: "woke", tid });
};
