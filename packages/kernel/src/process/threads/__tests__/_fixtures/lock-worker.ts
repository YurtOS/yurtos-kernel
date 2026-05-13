import { SabMutex } from "../../sab-primitives.ts";

self.onmessage = (e: MessageEvent) => {
  const { sab, tid } = e.data as { sab: SharedArrayBuffer; tid: number };
  const m = new SabMutex(sab, 0);
  m.lock(tid);
  (self as unknown as Worker).postMessage({ type: "locked", tid });
};
