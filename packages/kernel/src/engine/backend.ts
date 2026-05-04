export type SchedulerBackendError =
  | "unsupported"
  | "permission"
  | "invalid"
  | "not_found"
  | "io";

export type SchedulerBackendResult =
  | { ok: true }
  | { ok: false; error: SchedulerBackendError };

export interface SchedulerPriorityRequest {
  callerPid: number;
  targetPid: number;
  nice: number;
}

export interface EngineSchedulerBackend {
  setPriority(request: SchedulerPriorityRequest): SchedulerBackendResult;
}

export interface RuntimeEngineBackend {
  scheduler?: EngineSchedulerBackend;
}

export const unsupportedRuntimeEngineBackend: RuntimeEngineBackend = Object.freeze({});

export function normalizeNice(nice: number): number {
  if (!Number.isFinite(nice)) return 0;
  return Math.max(0, Math.min(19, Math.trunc(nice)));
}

export function niceToEpochQuantum(nice: number): number {
  const n = normalizeNice(nice);
  return Math.max(1, 10 - Math.floor(n / 2));
}
