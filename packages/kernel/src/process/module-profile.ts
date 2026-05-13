export type YurtBridgeKind = "asyncify" | "jspi" | "sync";
export type YurtThreadsBackendKind =
  | "cooperative-serial"
  | "worker-sab"
  | "unsupported";

export interface YurtMemoryImport {
  readonly module: string;
  readonly name: string;
}

export interface YurtModuleProfile {
  readonly importsSetjmp: boolean;
  readonly importsFork: boolean;
  readonly hasAsyncify: boolean;
  readonly hasSetjmpFeature: boolean;
  readonly hasContinuationsFeature: boolean;
  readonly hasThreadsFeature: boolean;
  readonly requiresAsyncify: boolean;
  readonly requiresSharedMemory: boolean;
  readonly bridge: YurtBridgeKind;
  readonly threadsBackend: YurtThreadsBackendKind;
  readonly memoryImport: YurtMemoryImport | null;
}

export interface AnalyzeYurtModuleOptions {
  readonly jspiAvailable?: boolean;
  readonly workerSabAvailable?: boolean;
}

const ASYNCIFY_EXPORTS = [
  "asyncify_start_unwind",
  "asyncify_stop_unwind",
  "asyncify_start_rewind",
  "asyncify_stop_rewind",
  "asyncify_get_state",
] as const;

export function analyzeYurtModule(
  module: WebAssembly.Module,
  opts: AnalyzeYurtModuleOptions = {},
): YurtModuleProfile {
  const imports = WebAssembly.Module.imports(module);
  const importsSetjmp = imports.some((imp) =>
    imp.module === "yurt" &&
    (imp.name === "host_setjmp" || imp.name === "host_longjmp")
  );
  const importsFork = imports.some((imp) =>
    imp.module === "yurt" && imp.name === "host_fork"
  );
  const hasAsyncify = moduleHasAsyncify(module);
  const hasSetjmpFeature = moduleHasYurtFeature(module, "setjmp");
  const hasContinuationsFeature = moduleHasYurtFeature(module, "continuations");
  const hasThreadsFeature = moduleHasYurtFeature(module, "threads");
  const requiresAsyncify = importsFork || hasSetjmpFeature ||
    hasContinuationsFeature;
  const requiresSharedMemory = hasThreadsFeature;
  const jspiAvailable = opts.jspiAvailable ??
    typeof (WebAssembly as unknown as { Suspending?: unknown }).Suspending ===
      "function";
  const workerSabAvailable = opts.workerSabAvailable ??
    detectWorkerSabAvailable();
  const memoryImport = imports.find((imp) => imp.kind === "memory") ?? null;

  return {
    importsSetjmp,
    importsFork,
    hasAsyncify,
    hasSetjmpFeature,
    hasContinuationsFeature,
    hasThreadsFeature,
    requiresAsyncify,
    requiresSharedMemory,
    bridge: requiresAsyncify ? "asyncify" : jspiAvailable ? "jspi" : "sync",
    threadsBackend: hasThreadsFeature
      ? workerSabAvailable ? "worker-sab" : "unsupported"
      : "cooperative-serial",
    memoryImport: memoryImport
      ? { module: memoryImport.module, name: memoryImport.name }
      : null,
  };
}

export function validateYurtModuleProfile(
  profile: YurtModuleProfile,
): YurtModuleProfile {
  if (
    (profile.importsSetjmp || profile.importsFork) &&
    !hasAnyAsyncifyFeature(profile)
  ) {
    throw new Error(
      "module imports yurt continuation host calls but lacks yurt.features continuations marker; rebuild with yurt-cc YURT_CC_USE_CONTINUATION=1",
    );
  }
  if (profile.requiresAsyncify && !profile.hasAsyncify) {
    throw new Error(
      "module declares yurt.features continuations but is not asyncify-instrumented",
    );
  }
  return profile;
}

export function moduleNeedsAsyncifyBridge(profile: YurtModuleProfile): boolean {
  return profile.requiresAsyncify && profile.hasAsyncify;
}

export function validateYurtThreadMemory(
  profile: YurtModuleProfile,
  memory: WebAssembly.Memory,
): void {
  if (
    profile.requiresSharedMemory &&
    !(memory.buffer instanceof SharedArrayBuffer)
  ) {
    throw new Error(
      "module declares yurt.features threads but did not instantiate with shared memory",
    );
  }
}

export function moduleHasAsyncify(module: WebAssembly.Module): boolean {
  const exports = WebAssembly.Module.exports(module);
  return ASYNCIFY_EXPORTS.every((name) =>
    exports.some((exp) => exp.kind === "function" && exp.name === name)
  );
}

export function moduleHasYurtFeature(
  module: WebAssembly.Module,
  feature: string,
): boolean {
  for (
    const section of WebAssembly.Module.customSections(module, "yurt.features")
  ) {
    try {
      const decoded = JSON.parse(new TextDecoder().decode(section)) as {
        features?: unknown;
      };
      if (
        Array.isArray(decoded.features) && decoded.features.includes(feature)
      ) {
        return true;
      }
    } catch {
      // Malformed custom sections are ignored here; required-feature checks
      // still fail closed when the marker is absent.
    }
  }
  return false;
}

function hasAnyAsyncifyFeature(profile: YurtModuleProfile): boolean {
  return profile.hasSetjmpFeature || profile.hasContinuationsFeature;
}

function detectWorkerSabAvailable(): boolean {
  if (typeof SharedArrayBuffer !== "function") return false;
  if (typeof Atomics.wait !== "function") return false;
  return typeof Worker === "function";
}
