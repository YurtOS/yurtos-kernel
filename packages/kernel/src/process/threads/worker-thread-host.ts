/**
 * Worker entry point that hosts a single spawned pthread.
 *
 * Receives a `start` message with the WebAssembly.Module, the
 * SharedArrayBuffer-backed Memory, the indirect-table index of the
 * thread's start function, and the i32 argument. Instantiates the
 * same module against the shared memory, calls the indexed function,
 * and posts back `{type:"done", tid, retval}`.
 *
 * This file runs INSIDE a Worker. It has no access to the main thread's
 * kernel imports — those are proxied through postMessage in Task 9.
 * For Task 4 we only need to prove that the module can run inside a
 * Worker against shared memory with an indirect-table call.
 */

interface StartMessage {
  type: "start";
  tid: number;
  fnPtr: number;
  arg: number;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
}

interface DoneMessage {
  type: "done";
  tid: number;
  retval: number;
}

declare const self: DedicatedWorkerGlobalScope & typeof globalThis;

self.onmessage = async (e: MessageEvent<StartMessage>) => {
  if (e.data?.type !== "start") return;
  const { tid, fnPtr, arg, module, memory } = e.data;

  let retval: number;
  try {
    const instance = await WebAssembly.instantiate(module, {
      env: { memory },
    });
    const table = instance.exports.__indirect_function_table;
    if (!(table instanceof WebAssembly.Table)) {
      retval = -1;
    } else {
      const fn = table.get(fnPtr) as ((arg: number) => number) | null;
      if (typeof fn !== "function") {
        retval = -1;
      } else {
        retval = fn(arg) | 0;
      }
    }
  } catch {
    // Instantiation failure or trap: report -1 and let the joining
    // side handle it. We don't propagate the error object across the
    // postMessage boundary in this scaffold; structured-clone of
    // WebAssembly errors is fiddly and not needed for Task 4.
    retval = -1;
  }

  const msg: DoneMessage = { type: "done", tid, retval };
  self.postMessage(msg);
};
