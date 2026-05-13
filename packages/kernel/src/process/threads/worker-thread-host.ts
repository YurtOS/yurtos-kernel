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

  const instance = await WebAssembly.instantiate(module, {
    env: { memory },
    yurt: {
      host_thread_self: () => tid,
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
