import type { YurtModuleProfile } from "../module-profile.js";
import type { ThreadsBackend } from "./backend.js";
import { CooperativeSerialBackend } from "./cooperative-serial.js";
import {
  WorkerSabThreadsBackend,
  type WorkerSabThreadsBackendOptions,
} from "./worker-sab.js";

export function createThreadsBackend(
  profile: YurtModuleProfile,
  options: { workerSab?: WorkerSabThreadsBackendOptions } = {},
): ThreadsBackend {
  switch (profile.threadsBackend) {
    case "cooperative-serial":
      return new CooperativeSerialBackend();
    case "unsupported":
      throw new Error(
        "module declares yurt.features threads but host lacks Worker/SAB threads support",
      );
    case "worker-sab":
      if (options.workerSab) {
        return new WorkerSabThreadsBackend(options.workerSab);
      }
      throw new Error(
        "module declares yurt.features threads but Worker/SAB threads backend is not wired into the loader yet",
      );
  }
}
