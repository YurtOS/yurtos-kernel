export type YurtBridgeKind = "asyncify" | "jspi" | "sync";

export interface YurtModuleProfile {
  readonly importsSetjmp: boolean;
  readonly importsFork: boolean;
  readonly hasAsyncify: boolean;
  readonly hasSetjmpFeature: boolean;
  readonly hasContinuationsFeature: boolean;
  readonly requiresAsyncify: boolean;
  readonly bridge: YurtBridgeKind;
}

export interface AnalyzeYurtModuleOptions {
  readonly jspiAvailable?: boolean;
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
  const requiresAsyncify = importsFork || hasSetjmpFeature ||
    hasContinuationsFeature;
  const jspiAvailable = opts.jspiAvailable ??
    typeof WebAssembly.Suspending === "function";

  return {
    importsSetjmp,
    importsFork,
    hasAsyncify,
    hasSetjmpFeature,
    hasContinuationsFeature,
    requiresAsyncify,
    bridge: requiresAsyncify ? "asyncify" : jspiAvailable ? "jspi" : "sync",
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
      "module imports yurt continuation host calls but lacks yurt.features setjmp marker; rebuild with yurt-cc YURT_CC_USE_SETJMP=1",
    );
  }
  if (profile.requiresAsyncify && !profile.hasAsyncify) {
    throw new Error(
      "module declares yurt.features setjmp/continuations but is not asyncify-instrumented",
    );
  }
  return profile;
}

export function moduleNeedsAsyncifyBridge(profile: YurtModuleProfile): boolean {
  return profile.requiresAsyncify && profile.hasAsyncify;
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
