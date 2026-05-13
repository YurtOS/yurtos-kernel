import { SabMutex } from "../../sab-primitives.ts";

self.onmessage = (event: MessageEvent<{ sab: SharedArrayBuffer }>) => {
  const mutex = new SabMutex(event.data.sab, 0);
  mutex.lock(2);
  self.postMessage("locked");
};
