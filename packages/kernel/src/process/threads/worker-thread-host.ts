/**
 * Worker entry point that hosts a single spawned pthread.
 *
 * Receives a `start` message with the WebAssembly.Module, the
 * SharedArrayBuffer-backed Memory, the indirect-table index of the
 * thread's start function, and the i32 argument. Instantiates the
 * same module against the shared memory, calls the indexed function,
 * and posts back `{type:"done", tid, retval}`.
 *
 * Task 9: if the start message includes `requestSab`, the worker
 * constructs a `WorkerHostImportProxy` and builds the yurt-namespace
 * host imports via `createWorkerYurtImports`. The proxy's
 * `postHostCall` is built locally (functions don't structured-clone),
 * and just calls `self.postMessage({type:"host-call"})` so the
 * main-side dispatcher runs.
 */

import {
  createWorkerYurtImports,
  type WorkerHostImportProxy,
  WorkerHostOp,
} from "./worker-host-proxy.ts";

interface StartMessage {
  type: "start";
  tid: number;
  fnPtr: number;
  arg: number;
  module: WebAssembly.Module;
  memory: WebAssembly.Memory;
  /**
   * Optional per-thread request SAB. When present, the worker wires
   * yurt-namespace host imports through the SAB; main attaches a
   * dispatcher to handle the requests. When absent, the worker
   * instantiates with `yurt: {}` (Task 4 behavior).
   */
  requestSab?: SharedArrayBuffer;
}

interface DoneMessage {
  type: "done";
  tid: number;
  retval: number;
}

const workerSelf = self as unknown as {
  onmessage:
    | ((event: MessageEvent<StartMessage>) => void | Promise<void>)
    | null;
  postMessage(message: unknown): void;
};

workerSelf.onmessage = async (e: MessageEvent<StartMessage>) => {
  if (e.data?.type !== "start") return;
  const { tid, fnPtr, arg, module, memory, requestSab } = e.data;

  let yurtImports: WebAssembly.ModuleImports = {};
  if (requestSab) {
    const proxy: WorkerHostImportProxy = {
      requestSab,
      postHostCall: (_op: WorkerHostOp) =>
        workerSelf.postMessage({ type: "host-call" }),
    };
    yurtImports = createWorkerYurtImports(tid, memory, proxy);
  }

  let retval: number;
  try {
    const instance = await WebAssembly.instantiate(module, {
      env: { memory },
      yurt: yurtImports,
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
    // postMessage boundary; structured-clone of WebAssembly errors is
    // fiddly and not needed for the scaffold.
    retval = -1;
  }

  const msg: DoneMessage = { type: "done", tid, retval };
  workerSelf.postMessage(msg);
};
