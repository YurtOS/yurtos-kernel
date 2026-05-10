/**
 * Process manager for spawning and running Wasm binaries in the sandbox.
 *
 * Handles command resolution, module caching, WASI host setup, and
 * execution lifecycle. Each spawn() call creates an isolated WasiHost
 * with its own file descriptor table, args, and environment.
 */

import type { PlatformAdapter } from "../platform/adapter.js";
import type { VfsLike } from "../vfs/vfs-like.js";
import { WasiHost } from "../wasi/wasi-host.js";
import type { NetworkBridgeLike } from "../network/bridge.js";
import { createKernelImports } from "../host-imports/kernel-imports.js";
import { AsyncifyAsyncBridge } from "../async-bridge.js";

import type { SpawnOptions, SpawnResult } from "./process.js";
import { NativeModuleRegistry } from "./native-modules.js";
import {
  defaultWasmModuleCache,
  sha256Hex,
  type WasmModuleCache,
} from "./module-cache.js";

export type ToolSource =
  | { kind: "host"; path: string }
  | { kind: "vfs"; path: string };

export class ProcessManager {
  private vfs: VfsLike;
  private adapter: PlatformAdapter;
  private registry: Map<string, ToolSource> = new Map();
  private moduleCache: Map<string, WebAssembly.Module> = new Map();
  private wasmModuleCache: WasmModuleCache;
  private networkBridge: NetworkBridgeLike | null;
  private currentHost: WasiHost | null = null;
  private toolAllowlist: Set<string> | null = null;
  private extensionHandler:
    | ((cmd: Record<string, unknown>) => Record<string, unknown>)
    | null = null;

  /** Registry for dynamically loaded native Python module WASMs. */
  readonly nativeModules: NativeModuleRegistry;

  constructor(
    vfs: VfsLike,
    adapter: PlatformAdapter,
    networkBridge?: NetworkBridgeLike,
    toolAllowlist?: string[],
    wasmModuleCache: WasmModuleCache = defaultWasmModuleCache,
  ) {
    this.vfs = vfs;
    this.adapter = adapter;
    this.wasmModuleCache = wasmModuleCache;
    this.networkBridge = networkBridge ?? null;
    this.toolAllowlist = toolAllowlist ? new Set(toolAllowlist) : null;
    this.nativeModules = new NativeModuleRegistry();
  }

  /** Register a tool name to a .wasm file path. */
  /** Register a native Python module WASM (loaded for _yurt.native_call bridge). */
  async registerNativeModule(
    name: string,
    wasmBytes: Uint8Array,
  ): Promise<void> {
    await this.nativeModules.loadModule(name, wasmBytes);
  }

  registerTool(name: string, source: string | ToolSource): void {
    this.registry.set(
      name,
      typeof source === "string" ? { kind: "host", path: source } : source,
    );
  }

  /**
   * Register a multicall binary and make each applet resolve to that binary.
   *
   * The VFS links mirror `busybox --install -s`: `/usr/bin/<applet>` points at
   * `/usr/bin/<name>`, while the registry override keeps bare command dispatch
   * on the multicall wasm even if a standalone applet wasm was scanned earlier.
   */
  registerMulticallTool(
    name: string,
    wasmPath: string,
    applets: string[],
  ): void {
    this.registerTool(name, wasmPath);
    const source: ToolSource = { kind: "host", path: wasmPath };

    this.vfs.withWriteAccess(() => {
      for (const applet of applets) {
        this.registry.set(applet, source);
        const linkPath = `/usr/bin/${applet}`;
        try {
          this.vfs.unlink(linkPath);
        } catch {
          // No pre-existing standalone stub.
        }
        this.vfs.symlink(`/usr/bin/${name}`, linkPath);
        const binLinkPath = `/bin/${applet}`;
        try {
          this.vfs.unlink(binLinkPath);
        } catch {
          // No pre-existing /bin applet link.
        }
        this.vfs.symlink(`/usr/bin/${name}`, binLinkPath);
      }
    });
  }

  /** Register and preload a tool from VFS. */
  async registerAndLoadTool(name: string, wasmPath: string): Promise<void> {
    const source: ToolSource = { kind: "vfs", path: wasmPath };
    this.registerTool(name, source);
    // Load WASM bytes from VFS and compile directly (not from host filesystem)
    const wasmBytes = this.vfs.readFile(wasmPath);
    const module = await this.compileBytes(wasmBytes);
    this.moduleCache.set(this.cacheKey(source), module);
  }

  /** Return the names of all registered tools. */
  getRegisteredTools(): string[] {
    return Array.from(this.registry.keys());
  }

  /** Cancel the currently running WASI process, if any. */
  cancelCurrent(): void {
    this.currentHost?.cancelExecution();
  }

  /** Set the extension handler for Python package → host extension bridge. */
  setExtensionHandler(
    handler: (cmd: Record<string, unknown>) => Record<string, unknown>,
  ): void {
    this.extensionHandler = handler;
  }

  /** Check if a tool name is registered. */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  /** Check if a tool is allowed by the security policy. */
  isToolAllowed(name: string): boolean {
    if (!this.toolAllowlist) return true;
    return this.toolAllowlist.has(name);
  }

  /** Resolve a tool name to its .wasm path, or throw if not registered. */
  resolveTool(name: string): string {
    return this.resolveToolSource(name).path;
  }

  private resolveToolSource(name: string): ToolSource {
    const direct = this.registry.get(name);
    if (direct !== undefined) return direct;

    const candidatePaths = name.includes("/")
      ? [name]
      : ["/usr/extensions", "/usr/bin", "/bin"].map((dir) => `${dir}/${name}`);

    for (const filePath of candidatePaths) {
      try {
        const st = this.vfs.stat(filePath);
        if (st.type === "file" && (st.permissions & 0o111)) {
          return { kind: "vfs", path: filePath };
        }
      } catch {
        // Try the next PATH entry.
      }
    }

    throw new Error(`Tool not found: ${name}`);
  }

  /** Return the VFS instance for external use (e.g. spawnAsyncProcess). */
  getVfs(): VfsLike {
    return this.vfs;
  }

  /** Return the platform adapter for external use (e.g. spawnAsyncProcess). */
  getAdapter(): PlatformAdapter {
    return this.adapter;
  }

  /**
   * Resolve a tool name to a pre-loaded WebAssembly.Module, or null if not
   * registered or not yet loaded.
   */
  getModule(prog: string): WebAssembly.Module | null {
    let source: ToolSource;
    try {
      source = this.resolveToolSource(prog);
    } catch {
      return null;
    }
    return this.moduleCache.get(this.cacheKey(source)) ?? null;
  }

  /**
   * Spawn a Wasm process: resolve the command, load (or reuse) the
   * compiled module, wire up a fresh WasiHost, run _start, and
   * return the captured output.
   */
  async spawn(command: string, opts: SpawnOptions): Promise<SpawnResult> {
    if (this.toolAllowlist && !this.toolAllowlist.has(command)) {
      return {
        exitCode: 126,
        stdout: "",
        stderr: `${command}: tool not allowed by security policy\n`,
        executionTimeMs: 0,
      };
    }
    const source = this.resolveToolSource(command);
    const module = await this.loadModule(source);

    // Collect stdin data: prefer explicit stdinData, otherwise drain the stdin pipe
    let stdinData: Uint8Array | undefined = opts.stdinData;
    if (stdinData === undefined && opts.stdin !== undefined) {
      stdinData = drainReadEnd(opts.stdin);
    }

    const cwd = opts.cwd ?? "/";
    const host = new WasiHost({
      vfs: this.vfs,
      args: [command, ...opts.args],
      env: { ...opts.env, PWD: cwd },
      preopens: { "/": "/" },
      cwd,
      stdin: stdinData,
      stdoutLimit: opts.stdoutLimit,
      stderrLimit: opts.stderrLimit,
      deadlineMs: opts.deadlineMs,
    });

    // If memoryBytes is set, inject a bounded memory into the import object
    const imports = host.getImports() as
      & WebAssembly.Imports
      & Record<string, WebAssembly.ModuleImports>;
    if (opts.memoryBytes !== undefined) {
      const maxPages = Math.ceil(opts.memoryBytes / 65536);
      const moduleImports = WebAssembly.Module.imports(module);
      for (const imp of moduleImports) {
        if (imp.kind === "memory") {
          const mem = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
          if (!imports[imp.module]) imports[imp.module] = {};
          imports[imp.module][imp.name] = mem;
        }
      }
    }

    // If the module imports from the `yurt` namespace, inject Python host
    // imports using a memory proxy (memory comes from instance exports, which
    // aren't available until after instantiation).
    const moduleImportDescs = WebAssembly.Module.imports(module);
    const needsYurt = moduleImportDescs.some((imp) => imp.module === "yurt");

    let setMemoryRef: ((mem: WebAssembly.Memory) => void) | null = null;
    const setjmpBridge = needsSetjmpBridge(module)
      ? new AsyncifyAsyncBridge()
      : null;

    let setMainInstanceRef: ((inst: WebAssembly.Instance) => void) | null =
      null;
    let mainInstanceRef: WebAssembly.Instance | null = null;

    if (needsYurt) {
      let memRef: WebAssembly.Memory | null = null;
      setMemoryRef = (mem: WebAssembly.Memory) => {
        memRef = mem;
      };
      setMainInstanceRef = (inst: WebAssembly.Instance) => {
        mainInstanceRef = inst;
      };

      const memoryProxy = new Proxy({} as WebAssembly.Memory, {
        get(_target, prop) {
          if (!memRef) throw new Error("memory not initialized");
          const val =
            (memRef as unknown as Record<string | symbol, unknown>)[prop];
          return typeof val === "function"
            ? (val as Function).bind(memRef)
            : val;
        },
      });

      imports.yurt = createKernelImports({
        memory: memoryProxy,
        vfs: this.vfs,
        wasiHost: host,
        networkBridge: this.networkBridge ?? undefined,
        extensionHandler: this.extensionHandler ?? undefined,
        nativeModules: this.nativeModules,
        mainInstance: () => mainInstanceRef,
      });
      if (setjmpBridge) {
        imports.yurt.host_setjmp = setjmpBridge
          .hostSetjmp as unknown as WebAssembly.ImportValue;
        imports.yurt.host_longjmp = setjmpBridge
          .hostLongjmp as unknown as WebAssembly.ImportValue;
      }
    }

    const instance = await this.adapter.instantiate(module, imports);

    // Wire up the real memory reference for the yurt import proxy
    if (setMemoryRef) {
      setMemoryRef(instance.exports.memory as WebAssembly.Memory);
    }
    // Wire the main-instance ref for the Phase 1 dlopen loader.
    if (setMainInstanceRef) {
      setMainInstanceRef(instance);
    }
    const startFn = setjmpBridge && initAsyncifyBridge(setjmpBridge, instance)
      ? setjmpBridge.wrapExportSync(instance.exports._start as () => number)
      : undefined;

    // Check exported memory against limit
    if (opts.memoryBytes !== undefined) {
      const mem = instance.exports.memory as WebAssembly.Memory | undefined;
      if (mem) {
        // Check if the module defined its own unbounded memory (no import).
        // If we injected a bounded memory via imports, that's fine. But if
        // the module defines memory internally, it bypasses our limit.
        const moduleImports = WebAssembly.Module.imports(module);
        const hasMemoryImport = moduleImports.some((imp) =>
          imp.kind === "memory"
        );
        if (!hasMemoryImport) {
          // Module defined its own memory — check if it has a maximum.
          // We can't inspect the max directly, but we can reject if the
          // module exported memory without importing our bounded one.
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              `module defines its own memory, bypassing sandbox memory limit\n`,
            executionTimeMs: 0,
          };
        }
        if (mem.buffer.byteLength > opts.memoryBytes) {
          return {
            exitCode: 1,
            stdout: "",
            stderr:
              `memory limit exceeded: ${mem.buffer.byteLength} > ${opts.memoryBytes}\n`,
            executionTimeMs: 0,
          };
        }
      }
    }

    this.currentHost = host;
    const startTime = performance.now();
    const exitCode = host.start(instance, startFn);
    const executionTimeMs = performance.now() - startTime;
    this.currentHost = null;

    const stdoutTruncated = host.isStdoutTruncated();
    const stderrTruncated = host.isStderrTruncated();

    return {
      exitCode,
      stdout: host.getStdout(),
      stderr: host.getStderr(),
      executionTimeMs,
      truncated: (stdoutTruncated || stderrTruncated)
        ? { stdout: stdoutTruncated, stderr: stderrTruncated }
        : undefined,
    };
  }

  /**
   * Load a .wasm module, returning a cached copy when available.
   * The first load for a given path compiles via the platform adapter;
   * subsequent loads reuse the compiled Module.
   */
  private async loadModule(source: ToolSource): Promise<WebAssembly.Module> {
    const key = this.cacheKey(source);
    const cached = this.moduleCache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const bytes = source.kind === "vfs"
      ? this.vfs.readFile(source.path)
      : await this.adapter.readBytes(source.path);
    const module = await this.compileBytes(bytes);
    this.moduleCache.set(key, module);
    return module;
  }

  private cacheKey(source: ToolSource): string {
    return source.kind === "host" ? source.path : `vfs:${source.path}`;
  }

  private async compileBytes(bytes: Uint8Array): Promise<WebAssembly.Module> {
    const digest = await sha256Hex(bytes);
    return await this.wasmModuleCache.getOrCompile(digest, bytes);
  }

  /**
   * Pre-load all registered tool modules into the cache so they can be
   * used synchronously by spawnSync().
   */
  async preloadModules(): Promise<void> {
    const sources = new Map<string, ToolSource>();
    for (const source of this.registry.values()) {
      sources.set(this.cacheKey(source), source);
    }
    await Promise.all(
      Array.from(sources.values()).map((source) => this.loadModule(source)),
    );
  }

  /**
   * Synchronous spawn for the rust-wasm backend (host_spawn callback).
   * Requires that the module has been pre-loaded via preloadModules().
   * Falls back to returning an error if the module is not cached.
   */
  spawnSync(
    command: string,
    args: string[],
    env: Record<string, string>,
    stdin: Uint8Array,
    cwd: string,
    opts?: {
      deadlineMs?: number;
      stdoutLimit?: number;
      stderrLimit?: number;
      memoryBytes?: number;
    },
  ): { exit_code: number; stdout: string; stderr: string } {
    if (this.toolAllowlist && !this.toolAllowlist.has(command)) {
      return {
        exit_code: 126,
        stdout: "",
        stderr: `${command}: tool not allowed by security policy\n`,
      };
    }

    let source: ToolSource;
    try {
      source = this.resolveToolSource(command);
    } catch {
      return { exit_code: 127, stdout: "", stderr: `${command}: not found\n` };
    }

    const module = this.moduleCache.get(this.cacheKey(source));
    if (!module) {
      return {
        exit_code: 127,
        stdout: "",
        stderr: `${command}: module not loaded\n`,
      };
    }

    const host = new WasiHost({
      vfs: this.vfs,
      args: [command, ...args],
      env,
      preopens: { "/": "/" },
      cwd,
      stdin,
      stdoutLimit: opts?.stdoutLimit,
      stderrLimit: opts?.stderrLimit,
      deadlineMs: opts?.deadlineMs,
    });

    const imports = host.getImports() as
      & WebAssembly.Imports
      & Record<string, WebAssembly.ModuleImports>;

    // If memoryBytes is set, inject a bounded memory into the import object
    if (opts?.memoryBytes !== undefined) {
      const maxPages = Math.ceil(opts.memoryBytes / 65536);
      const moduleImportDescs2 = WebAssembly.Module.imports(module);
      for (const imp of moduleImportDescs2) {
        if (imp.kind === "memory") {
          const mem = new WebAssembly.Memory({ initial: 1, maximum: maxPages });
          if (!imports[imp.module]) imports[imp.module] = {};
          imports[imp.module][imp.name] = mem;
        }
      }
    }

    // If the module imports from the `yurt` namespace, inject Python host
    // imports using a memory proxy.
    const moduleImportDescs = WebAssembly.Module.imports(module);
    const needsYurt = moduleImportDescs.some((imp) => imp.module === "yurt");

    let setMemoryRef: ((mem: WebAssembly.Memory) => void) | null = null;
    let setMainInstanceRef: ((inst: WebAssembly.Instance) => void) | null =
      null;
    let mainInstanceRef: WebAssembly.Instance | null = null;
    const setjmpBridge = needsSetjmpBridge(module)
      ? new AsyncifyAsyncBridge()
      : null;

    if (needsYurt) {
      let memRef: WebAssembly.Memory | null = null;
      setMemoryRef = (mem: WebAssembly.Memory) => {
        memRef = mem;
      };
      setMainInstanceRef = (inst: WebAssembly.Instance) => {
        mainInstanceRef = inst;
      };

      const memoryProxy = new Proxy({} as WebAssembly.Memory, {
        get(_target, prop) {
          if (!memRef) throw new Error("memory not initialized");
          const val =
            (memRef as unknown as Record<string | symbol, unknown>)[prop];
          return typeof val === "function"
            ? (val as Function).bind(memRef)
            : val;
        },
      });

      imports.yurt = createKernelImports({
        memory: memoryProxy,
        networkBridge: this.networkBridge ?? undefined,
        extensionHandler: this.extensionHandler ?? undefined,
        nativeModules: this.nativeModules,
        mainInstance: () => mainInstanceRef,
      });
      if (setjmpBridge) {
        imports.yurt.host_setjmp = setjmpBridge
          .hostSetjmp as unknown as WebAssembly.ImportValue;
        imports.yurt.host_longjmp = setjmpBridge
          .hostLongjmp as unknown as WebAssembly.ImportValue;
      }
    }

    // Synchronous instantiation (works because Module is already compiled)
    let instance: WebAssembly.Instance;
    try {
      instance = new WebAssembly.Instance(module, imports);
    } catch (e: unknown) {
      if (
        opts?.memoryBytes !== undefined && e instanceof Error &&
        /memory/i.test(e.message)
      ) {
        return { exit_code: 1, stdout: "", stderr: `memory limit exceeded\n` };
      }
      // Catch >8MB sync instantiation errors (V8 main-thread limitation) and
      // other instantiation failures — return an error result instead of crashing.
      if (e instanceof Error) {
        return {
          exit_code: 1,
          stdout: "",
          stderr: `${command}: ${e.message}\n`,
        };
      }
      throw e;
    }

    // Check exported memory against limit
    if (opts?.memoryBytes !== undefined) {
      const mem = instance.exports.memory as WebAssembly.Memory | undefined;
      if (mem) {
        const moduleImports3 = WebAssembly.Module.imports(module);
        const hasMemoryImport = moduleImports3.some((imp) =>
          imp.kind === "memory"
        );
        if (!hasMemoryImport) {
          return {
            exit_code: 1,
            stdout: "",
            stderr: `memory limit exceeded\n`,
          };
        }
        if (mem.buffer.byteLength > opts.memoryBytes) {
          return {
            exit_code: 1,
            stdout: "",
            stderr: `memory limit exceeded\n`,
          };
        }
      }
    }

    if (setMemoryRef) {
      setMemoryRef(instance.exports.memory as WebAssembly.Memory);
    }
    if (setMainInstanceRef) {
      setMainInstanceRef(instance);
    }
    const startFn = setjmpBridge && initAsyncifyBridge(setjmpBridge, instance)
      ? setjmpBridge.wrapExportSync(instance.exports._start as () => number)
      : undefined;

    this.currentHost = host;
    const exitCode = host.start(instance, startFn);
    this.currentHost = null;

    const stdoutTruncated = host.isStdoutTruncated();
    const stderrTruncated = host.isStderrTruncated();

    return {
      exit_code: exitCode,
      stdout: host.getStdout(),
      stderr: host.getStderr(),
      ...(stdoutTruncated || stderrTruncated
        ? {
          truncated: { stdout: stdoutTruncated, stderr: stderrTruncated },
        }
        : {}),
    };
  }
}

function needsSetjmpBridge(module: WebAssembly.Module): boolean {
  const imports = WebAssembly.Module.imports(module);
  const exports = WebAssembly.Module.exports(module);
  const importsSetjmp = imports.some((imp) =>
    imp.module === "yurt" &&
    (imp.name === "host_setjmp" || imp.name === "host_longjmp")
  );
  if (!importsSetjmp) return false;
  return [
    "asyncify_start_unwind",
    "asyncify_stop_unwind",
    "asyncify_start_rewind",
    "asyncify_stop_rewind",
    "asyncify_get_state",
  ].every((name) =>
    exports.some((exp) => exp.kind === "function" && exp.name === name)
  );
}

function initAsyncifyBridge(
  bridge: AsyncifyAsyncBridge,
  instance: WebAssembly.Instance,
): boolean {
  const exports = instance.exports;
  const hasAsyncifyState =
    typeof exports.asyncify_start_unwind === "function" &&
    typeof exports.asyncify_stop_unwind === "function" &&
    typeof exports.asyncify_start_rewind === "function" &&
    typeof exports.asyncify_stop_rewind === "function" &&
    typeof exports.asyncify_get_state === "function";
  if (!hasAsyncifyState) return false;

  const memory = exports.memory as WebAssembly.Memory;
  const addrExport = exports.yurt_asyncify_buf_addr as
    | (() => number)
    | undefined;
  const sizeExport = exports.yurt_asyncify_buf_size as
    | (() => number)
    | undefined;
  const alloc = exports.__alloc as ((size: number) => number) | undefined;

  let dataAddr: number;
  let dataSize: number;
  if (typeof addrExport === "function" && typeof sizeExport === "function") {
    dataAddr = addrExport();
    dataSize = sizeExport();
  } else if (typeof alloc === "function") {
    dataSize = 65536;
    dataAddr = alloc(dataSize);
  } else {
    throw new Error(
      "asyncify requires yurt_asyncify_buf_addr/size or __alloc exports",
    );
  }

  if (dataSize < 16) {
    throw new Error(`asyncify buffer is too small: ${dataSize}`);
  }
  const view = new DataView(memory.buffer);
  view.setUint32(dataAddr, dataAddr + 8, true);
  view.setUint32(dataAddr + 4, dataAddr + dataSize, true);
  bridge.initFromInstance(instance, dataAddr, dataSize);
  return true;
}

/** Drain all available bytes from a pipe read end into a single Uint8Array. */
function drainReadEnd(readEnd: { read(buf: Uint8Array): number }): Uint8Array {
  const chunks: Uint8Array[] = [];
  const tmp = new Uint8Array(4096);

  for (;;) {
    const n = readEnd.read(tmp);
    if (n === 0) {
      break;
    }
    chunks.push(tmp.slice(0, n));
  }

  if (chunks.length === 0) {
    return new Uint8Array(0);
  }
  if (chunks.length === 1) {
    return chunks[0];
  }

  let totalLen = 0;
  for (const chunk of chunks) {
    totalLen += chunk.byteLength;
  }
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
