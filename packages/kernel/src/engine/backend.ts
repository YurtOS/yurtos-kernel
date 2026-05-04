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

export interface SchedulerPolicyRequest {
  callerPid: number;
  targetPid: number;
  policy: number;
  priority: number;
}

export interface EngineSchedulerBackend {
  setPriority(request: SchedulerPriorityRequest): SchedulerBackendResult;
  setScheduler?(request: SchedulerPolicyRequest): SchedulerBackendResult;
}

export interface RuntimeEngineBackend {
  scheduler?: EngineSchedulerBackend;
}

export const unsupportedRuntimeEngineBackend: RuntimeEngineBackend = Object.freeze({});

export function normalizeNice(nice: number): number {
  if (!Number.isFinite(nice)) return 0;
  return Math.max(0, Math.min(19, Math.trunc(nice)));
}

export function normalizeSchedulerPolicy(policy: number): number {
  if (!Number.isFinite(policy)) return -1;
  const normalized = Math.trunc(policy);
  return normalized === 0 || normalized === 1 || normalized === 2 ? normalized : -1;
}

export function normalizeSchedulerPriority(policy: number, priority: number): number {
  if (!Number.isFinite(priority)) return -1;
  const normalized = Math.trunc(priority);
  if (policy === 0) return normalized === 0 ? 0 : -1;
  if (policy === 1 || policy === 2) return normalized >= 1 && normalized <= 99 ? normalized : -1;
  return -1;
}

export function niceToEpochQuantum(nice: number): number {
  const n = normalizeNice(nice);
  return Math.max(1, 10 - Math.floor(n / 2));
}
