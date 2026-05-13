import type { YurtModuleProfile } from "../module-profile.js";
import type { ThreadsBackend } from "./backend.js";
import { CooperativeSerialBackend } from "./cooperative-serial.js";
import {
  WorkerSabThreadsBackend,
  type WorkerSabThreadsBackendOptions,
} from "./worker-sab.js";

export function createThreadsBackend(
  profile: YurtModuleProfile,
  options: {
    workerSab?: WorkerSabThreadsBackendOptions;
    workerSabMemory?: WebAssembly.Memory;
  } = {},
): ThreadsBackend {
  switch (profile.threadsBackend) {
    case "cooperative-serial":
      return new CooperativeSerialBackend();
    case "unsupported":
      throw new Error(
        "module declares yurt.features threads but host lacks Worker/SAB threads support",
      );
    case "worker-sab":
      if (options.workerSab && options.workerSabMemory) {
        return new WorkerSabThreadsBackend(
          options.workerSab,
          options.workerSabMemory,
        );
      }
      throw new Error(
        "module declares yurt.features threads but Worker/SAB threads backend is not wired into the loader yet",
      );
  }
}
