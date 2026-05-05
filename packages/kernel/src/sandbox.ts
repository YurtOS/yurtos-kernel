/**
 * Sandbox: high-level facade wrapping VFS + the generic process kernel.
 *
 * The boot program is just a resident WASM process loaded from the VFS. The
 * default embedding boots /bin/bash, but the kernel path is not bash-specific.
 */

import { VFS } from "./vfs/vfs.js";
import { OverlayVFS } from "./vfs/overlay-vfs.js";
import { NodeDirectoryRootProvider } from "./vfs/node-directory-root-provider.js";
import { YURT_VERSION } from "./version.js";
import { ProcessManager } from "./process/manager.js";
/** Streaming callbacks for `Sandbox.run()`. Chunks are decoded UTF-8 strings. */
export interface StreamCallbacks {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

/** Callbacks for offloading sandbox state to external storage. */
export interface StorageCallbacks {
  save: (sandboxId: string, state: Uint8Array) => Promise<void>;
  load: (sandboxId: string) => Promise<Uint8Array>;
}
import type { RunResult } from "./run-result.js";
import type { PlatformAdapter } from "./platform/adapter.js";
import type { Process } from "./process/handle.js";
import type { ProcessMode } from "./process/handle.js";
import {
  INIT_PID,
  type ProcessCredentials,
  ProcessKernel,
  ROOT_UID,
  type SpawnRequest,
} from "./process/kernel.js";
import { type LoaderContext, loadProcess } from "./process/loader.js";
import type { DirEntry, StatResult } from "./vfs/inode.js";
import type { VfsLike } from "./vfs/vfs-like.js";
import { NetworkGateway } from "./network/gateway.js";
import type { NetworkPolicy } from "./network/gateway.js";
import { NetworkBridge, type NetworkBridgeLike } from "./network/bridge.js";
import type {
  SocketBackend,
  SocketListenPolicy,
} from "./network/socket-backend.js";
import {
  buildSiteCustomizeSource,
  getRequestsShimSource,
  getSocketShimSource,
  getSslShimSource,
} from "./network/socket-shim.js";
import type { AuditEventHandler, SecurityOptions } from "./security.js";
import { CancelledError } from "./security.js";
import type { WorkerExecutor } from "./execution/worker-executor.js";
import {
  exportState as serializerExportState,
  importState as serializerImportState,
} from "./persistence/serializer.js";
import type { PersistenceOptions } from "./persistence/types.js";
import { PersistenceManager } from "./persistence/manager.js";
import { HostMount } from "./vfs/host-mount.js";
import type { VirtualProvider } from "./vfs/provider.js";
import { ExtensionRegistry } from "./extension/registry.js";
import type { ExtensionConfig } from "./extension/types.js";
import {
  generateCommandShim,
  YURT_EXT_SOURCE,
} from "./extension/yurt-ext-shim.js";
import { SUBPROCESS_PY_SOURCE } from "./process/subprocess-shim.js";
import { applyManifest, loadManifest } from "./boot/manifest.js";
import { ToolRegistry } from "./fixtures/tool-registry.js";
import { type KernelApi, MemoryProxy } from "./kernel-api.js";
import { createKernelImports } from "./host-imports/kernel-imports.js";
import { WasiHost } from "./wasi/wasi-host.js";
import {
  bufferToString,
  createBufferTarget,
  type FdTarget,
  TtyHandle,
} from "./wasi/fd-target.js";
import type { RunCommandHandler } from "./run-command.js";
import {
  normalizeNice,
  type RuntimeEngineBackend,
  unsupportedRuntimeEngineBackend,
} from "./engine/backend.js";
import {
  defaultWasmModuleCache,
  type WasmModuleCache,
} from "./process/module-cache.js";

/** Describes a set of host-provided files to mount into the VFS. */
export interface MountConfig {
  /** Absolute mount path (e.g. '/mnt/tools'). */
  path: string;
  /** Flat map of relative subpaths to file contents. */
  files: Record<string, Uint8Array>;
  /** Allow writes to this mount. Default false. */
  writable?: boolean;
}

export interface SandboxOptions {
  /** Directory (Node) or URL base (browser) containing .wasm files. */
  wasmDir: string;
  /** Platform adapter. Auto-detected if not provided (Node vs browser). */
  adapter?: PlatformAdapter;
  /** Optional wasm module cache. Defaults to the process-wide cache. */
  moduleCache?: WasmModuleCache;
  /** Per-command wall-clock timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Max VFS size in bytes. Default 256MB. */
  fsLimitBytes?: number;
  /** Host directory mounted as the read-only base root layer. Node only. */
  baseRoot?: string;
  /** Path/URL to the default boot WASM. Defaults to `${wasmDir}/bash.wasm`. */
  bootWasmPath?: string;
  /** Deprecated alias for bootWasmPath. */
  shellExecWasmPath?: string;
  /** Resident process boot argv. Defaults to ['/bin/bash']; argv[0] is the VFS executable path. */
  bootArgv?: string[];
  /** Userland-specific imports merged into PID 1's yurt import namespace. */
  bootImports?: (api: KernelApi) => Record<string, WebAssembly.ImportValue>;
  /** Host callback for guest subprocess shims such as Python _yurt.spawn(). */
  runCommandHandler?: RunCommandHandler;
  /** Network policy for guest programs. If omitted, network access is disabled. */
  network?: NetworkPolicy;
  /** Optional network bridge override. Primarily used by tests and alternate embeddings. */
  networkBridge?: NetworkBridgeLike;
  /** Optional socket backend override. Primarily used by tests and alternate embeddings. */
  socketBackend?: SocketBackend;
  /** Prepared policy surface for future bind/listen/accept support. */
  serverSockets?: SocketListenPolicy;
  /** Engine-specific runtime capabilities. Selected once and reused by process imports. */
  runtimeBackend?: RuntimeEngineBackend;
  /** Security policy and limits. */
  security?: SecurityOptions;
  /** Persistence configuration. Default mode is 'ephemeral' (no persistence). */
  persistence?: PersistenceOptions;
  /** Host-provided file mounts. Processed before shell initialization. */
  mounts?: MountConfig[];
  /** Directories to include in PYTHONPATH (in addition to /usr/lib/python). */
  pythonPath?: string[];
  /** Host-provided extensions (custom commands and/or Python packages). */
  extensions?: ExtensionConfig[];
  /** Optional WASM tool bundles to install from ToolRegistry (e.g. ['pdftotext']). */
  tools?: string[];
  /** Callbacks for offloading sandbox state to external storage. */
  storage?: StorageCallbacks;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_FS_LIMIT = 256 * 1024 * 1024; // 256 MB

/** Internal config for the Sandbox constructor. Not part of the public API. */
interface SandboxParts {
  vfs: VfsLike;
  kernel: ProcessKernel;
  processes: Map<number, Process>;
  bootProcess: Process;
  env: Map<string, string>;
  timeoutMs: number;
  adapter: PlatformAdapter;
  wasmDir: string;
  bootWasmPath: string;
  moduleCache: WasmModuleCache;
  mgr: ProcessManager;
  bridge?: NetworkBridgeLike;
  socketBackend?: SocketBackend;
  serverSockets?: SocketListenPolicy;
  runtimeBackend: RuntimeEngineBackend;
  networkPolicy?: NetworkPolicy;
  security?: SecurityOptions;
  workerExecutor?: WorkerExecutor;
  extensionRegistry?: ExtensionRegistry;
  storage?: StorageCallbacks;
  bootArgv: string[];
  bootImports?: (api: KernelApi) => Record<string, WebAssembly.ImportValue>;
  runCommandHandler?: RunCommandHandler;
}

export class Sandbox {
  private vfs: VfsLike;
  private kernel: ProcessKernel;
  private processes: Map<number, Process>;
  private bootProcess: Process;
  private env: Map<string, string>;
  private timeoutMs: number;
  private destroyed = false;
  private offloaded = false;
  private storage: StorageCallbacks | null = null;
  private running = false;
  private adapter: PlatformAdapter;
  private wasmDir: string;
  private bootWasmPath: string;
  private moduleCache: WasmModuleCache;
  private mgr: ProcessManager;
  private envSnapshots: Map<string, Map<string, string>> = new Map();
  private bridge: NetworkBridgeLike | null = null;
  private socketBackend: SocketBackend | undefined;
  private serverSockets: SocketListenPolicy | undefined;
  private runtimeBackend: RuntimeEngineBackend;
  private networkPolicy: NetworkPolicy | undefined;
  private security: SecurityOptions | undefined;
  readonly sessionId: string;
  private auditHandler: AuditEventHandler | undefined;
  private workerExecutor: WorkerExecutor | null = null;
  private persistenceManager: PersistenceManager | null = null;
  private extensionRegistry: ExtensionRegistry | null = null;
  private bootArgv: string[];
  private bootImports:
    | ((api: KernelApi) => Record<string, WebAssembly.ImportValue>)
    | undefined;
  private runCommandHandler: RunCommandHandler | undefined;
  private activeDeadlineMs: number | undefined;
  private envNeedsSync = false;

  private constructor(parts: SandboxParts) {
    this.vfs = parts.vfs;
    this.kernel = parts.kernel;
    this.processes = parts.processes;
    this.bootProcess = parts.bootProcess;
    this.env = parts.env;
    this.timeoutMs = parts.timeoutMs;
    this.adapter = parts.adapter;
    this.wasmDir = parts.wasmDir;
    this.bootWasmPath = parts.bootWasmPath;
    this.moduleCache = parts.moduleCache;
    this.mgr = parts.mgr;
    this.bridge = parts.bridge ?? null;
    this.socketBackend = parts.socketBackend;
    this.serverSockets = parts.serverSockets;
    this.runtimeBackend = parts.runtimeBackend;
    this.networkPolicy = parts.networkPolicy;
    this.security = parts.security;
    this.sessionId = (typeof crypto !== "undefined" && crypto.randomUUID)
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    this.auditHandler = parts.security?.onAuditEvent;
    this.workerExecutor = parts.workerExecutor ?? null;
    this.extensionRegistry = parts.extensionRegistry ?? null;
    this.storage = parts.storage ?? null;
    this.bootArgv = parts.bootArgv;
    this.bootImports = parts.bootImports;
    this.runCommandHandler = parts.runCommandHandler;
    this.envNeedsSync = parts.env.size > 0;
  }

  private audit(type: string, data?: Record<string, unknown>): void {
    if (!this.auditHandler) return;
    this.auditHandler({
      type,
      sessionId: this.sessionId,
      timestamp: Date.now(),
      ...data,
    });
  }

  static async create(options: SandboxOptions): Promise<Sandbox> {
    const adapter = options.adapter ?? await Sandbox.detectAdapter();
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fsLimitBytes = options.fsLimitBytes ?? DEFAULT_FS_LIMIT;
    const moduleCache = options.moduleCache ?? defaultWasmModuleCache;

    const upper = new VFS({
      fsLimitBytes,
      fileCount: options.security?.limits?.fileCount,
    });
    const baseManifest = options.baseRoot
      ? await Sandbox.readBaseRootManifest(options.baseRoot)
      : undefined;
    const vfs: VfsLike = options.baseRoot
      ? new OverlayVFS({
        base: new NodeDirectoryRootProvider(options.baseRoot, {
          id: baseManifest?.id ?? `dir:${options.baseRoot}`,
          metadata: Object.fromEntries((baseManifest?.files ?? []).map((f) => [
            f.path,
            { uid: f.uid, gid: f.gid, mode: f.mode },
          ])),
        }),
        upper,
      })
      : upper;
    const { bridge } = options.networkBridge
      ? { bridge: options.networkBridge }
      : await Sandbox.createNetworkBridge(options.network);
    const mgr = new ProcessManager(
      vfs,
      adapter,
      bridge,
      options.security?.toolAllowlist,
      moduleCache,
    );
    const tools = options.baseRoot
      ? Sandbox.registerBaseRootTools(mgr, vfs)
      : await Sandbox.registerTools(mgr, adapter, options.wasmDir, upper);
    const runtimeBackend = options.runtimeBackend ??
      unsupportedRuntimeEngineBackend;
    if (!options.baseRoot) {
      await Sandbox.installCpythonStdlib(
        upper,
        adapter,
        options.wasmDir,
        tools,
      );
    }

    // Register optional WASM tools from ToolRegistry before preloadModules()
    if (options.tools && options.tools.length > 0) {
      const toolRegistry = new ToolRegistry();
      for (const bin of toolRegistry.resolveBinaries(options.tools)) {
        mgr.registerTool(bin.name, `${options.wasmDir}/${bin.wasm}`);
      }
    }

    // Build extension registry. Extension commands execute through
    // /usr/extensions/<name> symlinks to the generic /bin/host-call tool.
    const extensionRegistry = new ExtensionRegistry();
    if (options.extensions) {
      for (const ext of options.extensions) {
        extensionRegistry.register(ext);
      }
      // Register built-in discovery command after all user extensions are loaded
      if (options.extensions.length > 0) {
        extensionRegistry.registerBuiltinDiscovery();
      }
      vfs.withWriteAccess(() => {
        vfs.mkdirp("/usr/extensions");
        for (const ext of extensionRegistry.list()) {
          if (ext.command) {
            try {
              vfs.symlink("/bin/host-call", `/usr/extensions/${ext.name}`);
            } catch { /* already exists */ }
          }
        }
        try {
          vfs.symlink("/bin/host-call", "/usr/extensions/extensions");
        } catch { /* already exists */ }
      });
    }

    // Process host mounts before shell so files are available immediately
    if (options.mounts) {
      for (const mc of options.mounts) {
        const provider = new HostMount(mc.files, { writable: mc.writable });
        if (!vfs.mount) {
          throw new Error("Configured VFS does not support mounts");
        }
        vfs.mount(mc.path, provider);
      }
    }

    const baseBootWasmPath = options.bootWasmPath ??
      options.shellExecWasmPath ??
      `${options.wasmDir}/bash.wasm`;
    // When JSPI is unavailable, prefer the asyncify-instrumented variant.
    const jspiAvailable = typeof WebAssembly.Suspending === "function";
    const asyncifyPath = baseBootWasmPath.replace(/\.wasm$/, "-asyncify.wasm");
    const bootWasmPath = !jspiAvailable
      ? await Sandbox.tryPath(adapter, asyncifyPath) ?? baseBootWasmPath
      : baseBootWasmPath;
    const bootArgv = options.bootArgv ?? ["/bin/bash"];

    if (!options.baseRoot) {
      await Sandbox.installBootProgram(
        upper,
        adapter,
        bootArgv[0],
        bootWasmPath,
      );
    }

    // Pre-load all tool modules so spawnSync can use them synchronously
    await mgr.preloadModules();

    const secLimits = options.security?.limits;
    const kernel = new ProcessKernel({ maxProcesses: secLimits?.processes });
    vfs.setProcessListProvider?.(() => kernel.listProcesses());
    const processes = new Map<number, Process>();
    const env = new Map<string, string>();
    let sandboxRef: Sandbox | undefined;

    const loaderCtx = Sandbox.createLoaderContext({
      vfs,
      adapter,
      kernel,
      mgr,
      processes,
      bridge,
      socketBackend: options.socketBackend,
      serverSockets: options.serverSockets,
      runtimeBackend,
      extensionRegistry,
      runCommandHandler: options.runCommandHandler,
      getSandbox: () => sandboxRef,
      getDeadlineMs: () => sandboxRef?.activeDeadlineMs,
      memoryBytes: secLimits?.memoryBytes,
      stdoutLimit: secLimits?.stdoutBytes,
      stderrLimit: secLimits?.stderrBytes,
      toolAllowlist: options.security?.toolAllowlist,
      moduleCache,
    });

    const bootProcess = await loadProcess(loaderCtx, {
      argv: bootArgv,
      mode: "resident",
      env: Object.fromEntries(env),
      stdoutLimit: secLimits?.stdoutBytes,
      stderrLimit: secLimits?.stderrBytes,
      extraYurtImports: Sandbox.createBootImportFactory(
        vfs,
        mgr,
        options.bootImports,
      ),
    });
    Sandbox.applyOutputLimits(
      kernel,
      bootProcess.pid,
      secLimits?.stdoutBytes,
      secLimits?.stderrBytes,
    );
    processes.set(bootProcess.pid, bootProcess);

    // Bootstrap subprocess shim and sitecustomize.py (always installed).
    // If networking is enabled, also install socket/ssl/requests shims.
    {
      const enc = new TextEncoder();
      vfs.withWriteAccess(() => {
        vfs.mkdirp("/usr/lib/python");
        vfs.writeFile(
          "/usr/lib/python/subprocess.py",
          enc.encode(SUBPROCESS_PY_SOURCE),
        );
        // sitecustomize.py pre-loads our shims into sys.modules at interpreter
        // startup, bypassing RustPython's frozen modules which would otherwise
        // take priority over PYTHONPATH files.
        vfs.writeFile(
          "/usr/lib/python/sitecustomize.py",
          enc.encode(buildSiteCustomizeSource({ networking: !!bridge })),
        );
        if (bridge) {
          const networkMode = options.network?.mode ?? "restricted";
          vfs.writeFile(
            "/usr/lib/python/socket.py",
            enc.encode(getSocketShimSource(networkMode)),
          );
          vfs.writeFile(
            "/usr/lib/python/ssl.py",
            enc.encode(getSslShimSource()),
          );
          // requests module shim — lightweight requests-compatible API that
          // routes through _yurt.fetch() / http.client via the socket shim
          vfs.writeFile(
            "/usr/lib/python/requests.py",
            enc.encode(getRequestsShimSource()),
          );
        }
      });
    }

    // Install Python shims for extensions with command and/or pythonPackage.
    // Every extension that has a command handler gets an auto-generated _shim.py
    // that wraps the command via yurt_ext.call() — no subprocess needed.
    // If the extension also provides pythonPackage.files, those are installed
    // alongside the shim and can import from ._shim.
    const extWithPython = extensionRegistry.list().filter(
      (e) => e.command != null || e.pythonPackage != null,
    );
    if (extWithPython.length > 0) {
      vfs.withWriteAccess(() => {
        const enc = new TextEncoder();
        vfs.mkdirp("/usr/lib/python");
        vfs.writeFile(
          "/usr/lib/python/yurt_ext.py",
          enc.encode(YURT_EXT_SOURCE),
        );
        for (const ext of extWithPython) {
          vfs.mkdirp(`/usr/lib/python/${ext.name}`);
          // Auto-generate _shim.py for any extension with a command handler.
          if (ext.command) {
            vfs.writeFile(
              `/usr/lib/python/${ext.name}/_shim.py`,
              enc.encode(generateCommandShim(ext.name)),
            );
          }
          if (ext.pythonPackage) {
            // Install author-provided package files (may import from ._shim).
            for (const [fp, src] of Object.entries(ext.pythonPackage.files)) {
              const parts = fp.split("/");
              if (parts.length > 1) {
                vfs.mkdirp(
                  `/usr/lib/python/${ext.name}/${parts.slice(0, -1).join("/")}`,
                );
              }
              vfs.writeFile(
                `/usr/lib/python/${ext.name}/${fp}`,
                enc.encode(src),
              );
            }
          } else if (ext.command) {
            // No explicit package: auto-generate __init__.py that re-exports run().
            vfs.writeFile(
              `/usr/lib/python/${ext.name}/__init__.py`,
              enc.encode(
                `"""Auto-generated package for the '${ext.name}' extension command."""\n` +
                  `from ${ext.name}._shim import run\n\n__all__ = ['run']\n`,
              ),
            );
          }
        }
      });
    }

    // Bootstrap VFS config data for system identity files and extension metadata.
    {
      const enc = new TextEncoder();
      vfs.withWriteAccess(() => {
        // Standard /etc files expected by many tools and scripts
        vfs.writeFile(
          "/etc/os-release",
          enc.encode(
            [
              'NAME="Yurt"',
              "ID=yurt",
              `PRETTY_NAME="Yurt Sandbox ${YURT_VERSION}"`,
              `VERSION_ID="${YURT_VERSION}"`,
              'HOME_URL="https://github.com/yurt-sandbox/yurt"',
            ].join("\n") + "\n",
          ),
        );
        vfs.writeFile("/etc/hostname", enc.encode("sandbox\n"));
        vfs.writeFile(
          "/etc/hosts",
          enc.encode(
            [
              "127.0.0.1  localhost",
              "::1        localhost",
            ].join("\n") + "\n",
          ),
        );
        vfs.writeFile(
          "/etc/passwd",
          enc.encode(
            [
              "root:x:0:0:root:/root:/bin/sh",
              "user:x:1000:1000:user:/home/user:/bin/sh",
            ].join("\n") + "\n",
          ),
        );
        vfs.writeFile(
          "/etc/group",
          enc.encode(
            [
              "root:x:0:",
              "user:x:1000:",
            ].join("\n") + "\n",
          ),
        );
        for (
          const f of [
            "/etc/os-release",
            "/etc/hostname",
            "/etc/hosts",
            "/etc/passwd",
            "/etc/group",
          ]
        ) {
          vfs.chmod(f, 0o444);
        }

        vfs.mkdirp("/etc/yurt");

        // extension metadata
        const extMeta = extensionRegistry.list().map((e) => ({
          name: e.name,
          description: e.description,
          hasCommand: !!e.command,
          pythonPackage: e.pythonPackage
            ? {
              version: e.pythonPackage.version,
              summary: e.pythonPackage.summary,
              files: e.pythonPackage.files,
            }
            : null,
        }));
        vfs.writeFile(
          "/etc/yurt/extensions.json",
          enc.encode(JSON.stringify(extMeta)),
        );

        vfs.chmod("/etc/yurt/extensions.json", 0o444);
      });
    }

    // Set PYTHONPATH: user-provided paths + /usr/lib/python (always included)
    if (
      options.pythonPath || bridge ||
      extensionRegistry.getPackageNames().length > 0
    ) {
      const paths = [...(options.pythonPath ?? []), "/usr/lib/python"];
      env.set("PYTHONPATH", paths.join(":"));
    }

    // Create WorkerExecutor for hard-kill preemption when enabled.
    const workerExecutor = await Sandbox.createWorkerExecutor(
      vfs,
      options.wasmDir,
      bootWasmPath,
      tools,
      adapter,
      options.security,
      bridge,
      options.network,
      extensionRegistry,
    );

    const sb = new Sandbox({
      vfs,
      kernel,
      processes,
      bootProcess,
      env,
      timeoutMs,
      adapter,
      wasmDir: options.wasmDir,
      bootWasmPath,
      moduleCache,
      mgr,
      bridge,
      networkPolicy: options.network,
      socketBackend: options.socketBackend,
      serverSockets: options.serverSockets,
      runtimeBackend,
      security: options.security,
      workerExecutor,
      extensionRegistry,
      storage: options.storage,
      bootArgv,
      bootImports: options.bootImports,
      runCommandHandler: options.runCommandHandler,
    });
    sandboxRef = sb;

    // Wire persistence if configured
    const pMode = options.persistence?.mode ?? "ephemeral";
    if (pMode !== "ephemeral") {
      const backend = options.persistence?.backend ??
        await Sandbox.detectBackend();
      const pm = new PersistenceManager(
        backend,
        vfs,
        options.persistence,
        () => new Map(env),
        (restoredEnv) => {
          env.clear();
          for (const [k, v] of restoredEnv) env.set(k, v);
        },
      );
      sb.persistenceManager = pm;

      if (pMode === "persistent") {
        await pm.load();
        sb.envNeedsSync = true;
        pm.startAutosave(vfs);
      }
      // 'session' mode: user calls save()/load() explicitly
    }

    sb.audit("sandbox.create");
    return sb;
  }

  private static async detectAdapter(): Promise<PlatformAdapter> {
    if (
      typeof globalThis.process !== "undefined" &&
      globalThis.process.versions?.node
    ) {
      const { NodeAdapter } = await import("./platform/node-adapter.js");
      return new NodeAdapter();
    }
    const { BrowserAdapter } = await import("./platform/browser-adapter.js");
    return new BrowserAdapter();
  }

  private static async detectBackend(): Promise<
    import("./persistence/backend.js").PersistenceBackend
  > {
    if (
      typeof globalThis.process !== "undefined" &&
      globalThis.process.versions?.node
    ) {
      const { FsBackend } = await import("./persistence/fs-backend.js");
      return new FsBackend();
    }
    const { IdbBackend } = await import("./persistence/idb-backend.js");
    return new IdbBackend();
  }

  private static async createNetworkBridge(
    policy: NetworkPolicy | undefined,
  ): Promise<{ gateway?: NetworkGateway; bridge?: NetworkBridge }> {
    if (!policy) return {};
    const gateway = new NetworkGateway(policy);
    const bridge = new NetworkBridge(gateway);
    await bridge.start();
    return { gateway, bridge };
  }

  private static getBridgeSab(
    bridge: NetworkBridgeLike | undefined,
  ): SharedArrayBuffer | undefined {
    const bridgeWithSab = bridge as
      | (NetworkBridgeLike & { getSab?: () => SharedArrayBuffer })
      | undefined;
    return typeof bridgeWithSab?.getSab === "function"
      ? bridgeWithSab.getSab()
      : undefined;
  }

  private static async readBaseRootManifest(baseRoot: string): Promise<
    {
      id?: string;
      files?: Array<
        {
          path: string;
          type?: "file" | "dir" | "symlink";
          uid: number;
          gid: number;
          mode: number;
        }
      >;
      tools?: Array<{ name: string; path: string }>;
    } | undefined
  > {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(
        `${baseRoot}/etc/yurt/base-image.json`,
        "utf8",
      );
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  private static registerBaseRootTools(
    mgr: ProcessManager,
    vfs: VfsLike,
  ): Map<string, string> {
    const tools = new Map<string, string>();
    try {
      const manifest = JSON.parse(
        new TextDecoder().decode(vfs.readFile("/etc/yurt/base-image.json")),
      ) as {
        tools?: Array<{ name: string; path: string }>;
      };
      for (const tool of manifest.tools ?? []) {
        mgr.registerTool(tool.name, { kind: "vfs", path: tool.path });
        tools.set(tool.name, tool.path);
      }
    } catch {
      // Base roots may choose to provide only the boot program.
    }
    return tools;
  }

  private static async registerTools(
    mgr: ProcessManager,
    adapter: PlatformAdapter,
    wasmDir: string,
    vfs: VFS,
  ): Promise<Map<string, string>> {
    const tools = await adapter.scanTools(wasmDir);
    for (const [name, path] of tools) {
      mgr.registerTool(name, path);
      await Sandbox.installToolExecutable(
        vfs,
        adapter,
        `/usr/bin/${name}`,
        path,
      );
    }
    for (const [name, path] of tools) {
      const manifest = await loadManifest(adapter, wasmDir, name);
      if (manifest) {
        await applyManifest(manifest, { mgr, vfs, adapter, wasmDir }, path);
      }
    }
    return tools;
  }

  private static async installToolExecutable(
    vfs: VFS,
    adapter: PlatformAdapter,
    vfsPath: string,
    wasmPath: string,
  ): Promise<void> {
    const bytes = await adapter.readBytes(wasmPath);
    vfs.withWriteAccess(() => {
      const dir = vfsPath.slice(0, vfsPath.lastIndexOf("/")) || "/";
      vfs.mkdirp(dir);
      try {
        vfs.unlink(vfsPath);
      } catch { /* not present */ }
      vfs.writeFile(vfsPath, bytes);
      vfs.chmod(vfsPath, 0o555);
    });
  }

  private static async installCpythonStdlib(
    vfs: VFS,
    adapter: PlatformAdapter,
    wasmDir: string,
    tools: Map<string, string>,
  ): Promise<void> {
    // Temporary CPython bring-up shim. This belongs in pkg once package install
    // owns language runtimes and their VFS layouts.
    if (!tools.has("cpython3") || !adapter.readDataFile) return;

    const manifestBytes = await adapter.readDataFile(
      wasmDir,
      "cpython3-lib-manifest.json",
    );
    if (!manifestBytes) return;

    const manifest = JSON.parse(
      new TextDecoder().decode(manifestBytes),
    ) as string[];
    for (const relPath of manifest) {
      if (relPath.startsWith("/") || relPath.includes("..")) {
        throw new Error(`Invalid CPython stdlib path in manifest: ${relPath}`);
      }
      const data = await adapter.readDataFile(
        wasmDir,
        `cpython3-lib/${relPath}`,
      );
      if (!data) {
        throw new Error(`Missing CPython stdlib sidecar: ${relPath}`);
      }
      vfs.withWriteAccess(() => {
        const fullPath = `/usr/local/lib/python3.14/${relPath}`;
        const dir = fullPath.slice(0, fullPath.lastIndexOf("/")) || "/";
        vfs.mkdirp(dir);
        vfs.writeFile(fullPath, data);
        vfs.chmod(fullPath, 0o444);
      });
    }
  }

  private static async tryPath(
    adapter: PlatformAdapter,
    path: string,
  ): Promise<string | null> {
    try {
      await adapter.readBytes(path);
      return path;
    } catch {
      return null;
    }
  }

  private static async installBootProgram(
    vfs: VFS,
    adapter: PlatformAdapter,
    vfsPath: string,
    wasmPath: string,
  ): Promise<void> {
    if (!vfsPath) throw new Error("bootArgv[0] is required");
    const bytes = await adapter.readBytes(wasmPath);
    vfs.withWriteAccess(() => {
      const dir = vfsPath.slice(0, vfsPath.lastIndexOf("/")) || "/";
      vfs.mkdirp(dir);
      try {
        vfs.unlink(vfsPath);
      } catch { /* not present */ }
      vfs.writeFile(vfsPath, bytes);
      vfs.chmod(vfsPath, 0o555);
    });
  }

  private static applyOutputLimits(
    kernel: ProcessKernel,
    pid: number,
    stdoutLimit?: number,
    stderrLimit?: number,
  ): void {
    kernel.setFdTarget(pid, 1, createBufferTarget(stdoutLimit ?? Infinity));
    kernel.setFdTarget(pid, 2, createBufferTarget(stderrLimit ?? Infinity));
  }

  private static writeToFdTarget(
    target: FdTarget | undefined | null,
    text: string,
  ): void {
    const data = new TextEncoder().encode(text);
    if (target?.type === "buffer") {
      target.buf.push(data);
      target.total += data.byteLength;
    } else if (target?.type === "pipe_write") {
      target.pipe.write(data);
    }
  }

  private static createBootImportFactory(
    vfs: VfsLike,
    mgr: ProcessManager,
    bootImports:
      | ((api: KernelApi) => Record<string, WebAssembly.ImportValue>)
      | undefined,
  ):
    | ((memory: WebAssembly.Memory) => Record<string, WebAssembly.ImportValue>)
    | undefined {
    if (!bootImports) return undefined;
    return (memory) => {
      const apiMemory = new MemoryProxy();
      apiMemory.current = memory;
      return bootImports({
        vfs,
        processManager: {
          registerTool: (name, impl) => mgr.registerTool(name, String(impl)),
          registerAndLoadTool: (name, path) =>
            mgr.registerAndLoadTool(name, path),
          registerNativeModule: (name, wasmBytes) =>
            mgr.registerNativeModule(name, wasmBytes),
          hasTool: (name) => mgr.hasTool(name),
        },
        time: {
          now: () => Date.now() / 1000,
          monotonic: () => BigInt(Math.floor(performance.now() * 1_000_000)),
        },
        memory: apiMemory,
      });
    };
  }

  private static createLoaderContext(opts: {
    vfs: VfsLike;
    adapter: PlatformAdapter;
    kernel: ProcessKernel;
    mgr: ProcessManager;
    processes: Map<number, Process>;
    bridge?: NetworkBridgeLike;
    socketBackend?: SocketBackend;
    serverSockets?: SocketListenPolicy;
    runtimeBackend: RuntimeEngineBackend;
    extensionRegistry: ExtensionRegistry;
    runCommandHandler?: RunCommandHandler;
    getSandbox: () => Sandbox | undefined;
    getDeadlineMs?: () => number | undefined;
    memoryBytes?: number;
    stdoutLimit?: number;
    stderrLimit?: number;
    toolAllowlist?: string[];
    moduleCache?: WasmModuleCache;
  }): LoaderContext {
    const {
      vfs,
      adapter,
      kernel,
      mgr,
      processes,
      bridge,
      socketBackend,
      serverSockets,
      runtimeBackend,
      extensionRegistry,
      runCommandHandler,
      getSandbox,
      getDeadlineMs,
      memoryBytes,
      stdoutLimit,
      stderrLimit,
      toolAllowlist,
      moduleCache,
    } = opts;
    const allowedTools = toolAllowlist ? new Set(toolAllowlist) : null;

    const makeFdReadAndClear = (pid: number) => (fd: 1 | 2) => {
      const target = kernel.getFdTarget(pid, fd);
      if (!target || target.type !== "buffer") {
        return { data: "", truncated: false };
      }
      const data = bufferToString(target);
      const truncated = !!target.truncated;
      target.buf.length = 0;
      target.total = 0;
      target.truncated = false;
      return { data, truncated };
    };

    const makeContextWithAllocator = (
      allocatePid: (argv: string[]) => number,
    ): LoaderContext => ({
      vfs,
      adapter,
      kernel,
      allocatePid,
      releasePid: (pid, exitCode) => {
        kernel.releaseProcess(pid, exitCode);
        processes.delete(pid);
      },
      buildWasiHost: (pid, argv, env, cwd) => {
        return new WasiHost({
          vfs,
          args: argv,
          env,
          preopens: { "/": "/" },
          cwd,
          ioFds: kernel.getFdTable(pid),
          kernel,
          pid,
          deadlineMs: getDeadlineMs?.(),
        });
      },
      buildKernelImports: (pid, memory, wasiHost, threadsBackend) => {
        const kernelImports = createKernelImports({
          memory,
          callerPid: pid,
          kernel,
          vfs,
          wasiHost,
          networkBridge: bridge,
          socketBackend,
          serverSockets,
          runtimeBackend,
          extensionRegistry,
          mgr,
          nativeModules: mgr.nativeModules,
          threadsBackend,
          runCommand: async (cmd, stdin) => {
            const sandbox = getSandbox();
            if (!sandbox) {
              return { exitCode: 1, stdout: "", stderr: "sandbox not ready\n" };
            }
            if (runCommandHandler) {
              const result = await runCommandHandler(
                { cmd, stdin },
                { sandbox },
              );
              return {
                exitCode: result.exit_code,
                stdout: result.stdout,
                stderr: result.stderr,
              };
            }
            const result = await sandbox.runBootCommandInFreshProcess(cmd, {
              stdinData: stdin ? new TextEncoder().encode(stdin) : undefined,
            });
            return {
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
            };
          },
          spawnProcess: (req, fdTable) => {
            const childPid = kernel.allocPid(pid, req.prog);
            const childCwd = req.cwd || kernel.getCwd(pid);
            kernel.setCwd(childPid, childCwd);
            kernel.registerPending(childPid, req.prog, pid);
            kernel.adoptFdTable(childPid, fdTable);
            const childNice = normalizeNice(
              req.nice ?? kernel.getPriority(pid),
            );
            if (childNice > 0) {
              const priorityResult = runtimeBackend.scheduler?.setPriority({
                callerPid: pid,
                targetPid: childPid,
                nice: childNice,
              }) ?? { ok: false as const, error: "unsupported" as const };
              if (!priorityResult.ok) {
                kernel.discardProcess(childPid);
                return priorityResult.error === "permission" ? -2 : -38;
              }
              kernel.setPriority(childPid, childNice);
            }
            const commandName = req.prog.includes("/")
              ? req.prog.split("/").pop() ?? req.prog
              : req.prog;
            if (allowedTools && !allowedTools.has(commandName)) {
              Sandbox.writeToFdTarget(
                fdTable.get(2),
                `${commandName}: tool not allowed by security policy\n`,
              );
              kernel.releaseProcess(childPid, 126);
              return childPid;
            }
            let argv: string[];
            try {
              argv = Sandbox.argvForSpawn(vfs, req, kernel.getCredentials(pid));
            } catch (e) {
              kernel.discardProcess(childPid);
              throw e;
            }
            const childCtx = makeContextWithAllocator(() => childPid);
            const promise = loadProcess(childCtx, {
              argv,
              mode: "cli",
              env: Object.fromEntries(req.env),
              cwd: childCwd,
              memoryBytes,
              stdoutLimit,
              stderrLimit,
              rollbackOnFailure: false,
            }).then(async (proc) => {
              processes.set(childPid, proc);
              await proc.terminate();
            }).catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              Sandbox.writeToFdTarget(
                kernel.getFdTarget(childPid, 2),
                `${req.prog}: ${msg}\n`,
              );
              kernel.releaseProcess(childPid, 127);
            });
            return childPid;
          },
        });
        return {
          ...kernelImports,
          host_spawn_async: kernelImports.host_spawn,
        };
      },
      makeFdReadAndClear,
      moduleCache,
    });

    return makeContextWithAllocator((argv) =>
      kernel.allocPid(INIT_PID, argv[0])
    );
  }

  private static argvForSpawn(
    vfs: VfsLike,
    req: SpawnRequest,
    credentials: ProcessCredentials,
  ): string[] {
    const prog = req.prog.includes("/")
      ? Sandbox.resolveSpawnPath(req.prog, req.cwd || "/")
      : Sandbox.resolveExecutablePathForVfs(vfs, req.prog);
    Sandbox.assertExecutableForSpawn(vfs, prog, credentials);
    return [prog, ...req.args];
  }

  private static resolveSpawnPath(path: string, cwd: string): string {
    return Sandbox.normalizeVfsPath(
      path.startsWith("/") ? path : `${cwd}/${path}`,
    );
  }

  private static normalizeVfsPath(path: string): string {
    const parts: string[] = [];
    for (const part of path.split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") {
        parts.pop();
      } else {
        parts.push(part);
      }
    }
    return `/${parts.join("/")}`;
  }

  private static assertExecutableForSpawn(
    vfs: VfsLike,
    path: string,
    credentials: ProcessCredentials,
  ): void {
    let st: StatResult;
    try {
      st = vfs.stat(path);
    } catch {
      throw new Error(`ENOENT: no such file or directory: ${path}`);
    }
    if (st.type !== "file" || !Sandbox.canExecute(st, credentials)) {
      throw new Error(`EACCES: permission denied: ${path}`);
    }
  }

  private static canExecute(
    st: StatResult,
    credentials: ProcessCredentials,
  ): boolean {
    if (credentials.euid === ROOT_UID) return true;
    const mode = st.permissions;
    if (st.uid === credentials.euid) return (mode & 0o100) !== 0;
    if (st.gid === credentials.egid) return (mode & 0o010) !== 0;
    return (mode & 0o001) !== 0;
  }

  private static resolveExecutablePathForVfs(
    vfs: VfsLike,
    prog: string,
  ): string {
    for (const dir of ["/usr/extensions", "/usr/bin", "/bin"]) {
      const path = `${dir}/${prog}`;
      try {
        const st = vfs.stat(path);
        if (st.type === "file" && (st.permissions & 0o111)) return path;
      } catch {
        // Try next PATH entry.
      }
    }
    return prog;
  }

  private static async createWorkerExecutor(
    vfs: VfsLike,
    wasmDir: string,
    shellExecWasmPath: string,
    tools: Map<string, string>,
    adapter: PlatformAdapter,
    security?: SecurityOptions,
    bridge?: NetworkBridgeLike,
    networkPolicy?: NetworkPolicy,
    extensionRegistry?: ExtensionRegistry,
  ): Promise<WorkerExecutor | undefined> {
    if (!security?.hardKill || !adapter.supportsWorkerExecution) {
      return undefined;
    }
    if (!(vfs instanceof VFS)) return undefined;
    const { WorkerExecutor: WE } = await import(
      "./execution/worker-executor.js"
    );
    const toolRegistry: [string, string][] = Array.from(tools);
    return new WE({
      vfs,
      wasmDir,
      shellExecWasmPath,
      toolRegistry,
      stdoutBytes: security.limits?.stdoutBytes,
      stderrBytes: security.limits?.stderrBytes,
      toolAllowlist: security.toolAllowlist,
      memoryBytes: security.limits?.memoryBytes,
      processes: security.limits?.processes,
      bridgeSab: Sandbox.getBridgeSab(bridge),
      networkPolicy: networkPolicy
        ? {
          allowedHosts: networkPolicy.allowedHosts,
          blockedHosts: networkPolicy.blockedHosts,
        }
        : undefined,
      extensionRegistry: extensionRegistry?.list().length
        ? extensionRegistry
        : undefined,
    });
  }

  async run(
    command: string,
    callbacks?: StreamCallbacks & { stdinData?: Uint8Array },
  ): Promise<RunResult> {
    this.assertAlive();

    // Check command size limit
    const commandLimit = this.security?.limits?.commandBytes ?? 65536;
    if (new TextEncoder().encode(command).byteLength > commandLimit) {
      this.audit("limit.exceeded", { subtype: "command", command });
      return {
        exitCode: 1,
        stdout: "",
        stderr: "command too large\n",
        executionTimeMs: 0,
        errorClass: "LIMIT_EXCEEDED",
      };
    }

    this.running = true;
    try {
      this.audit("command.start", { command });

      const effectiveTimeout = this.security?.limits?.timeoutMs ??
        this.timeoutMs;
      const startTime = performance.now();
      this.activeDeadlineMs = Number.isFinite(effectiveTimeout)
        ? Date.now() + effectiveTimeout
        : undefined;

      let result: RunResult;

      if (this.workerExecutor) {
        // Worker-based execution (Node) — hard kill on timeout via worker.terminate()
        if (callbacks?.onStdout || callbacks?.onStderr) {
          console.warn(
            "[yurt] Streaming callbacks not supported with worker executor (security.hardKill). Output will be returned in result only.",
          );
        }
        const workerResult = await this.workerExecutor.run(
          command,
          this.getEnvMap(),
          effectiveTimeout,
        );

        // Sync env changes from Worker back to main-thread runner
        if (workerResult.env) {
          this.setEnvMap(new Map(workerResult.env));
        }

        result = workerResult;
      } else {
        // In-process execution: the sandbox facade speaks the resident process
        // command protocol, but the kernel only sees a generic Process.
        try {
          result = await this.runBootCommand(command, {
            stdinData: callbacks?.stdinData,
          });
        } catch (e) {
          if (e instanceof CancelledError) {
            const executionTimeMs = performance.now() - startTime;
            result = {
              exitCode: 124,
              stdout: "",
              stderr: `command ${e.reason.toLowerCase()}\n`,
              executionTimeMs,
              errorClass: e.reason,
            };
          } else {
            throw e;
          }
        }
      }

      const executionTimeMs = performance.now() - startTime;
      result.executionTimeMs = result.executionTimeMs || executionTimeMs;
      if (
        this.activeDeadlineMs !== undefined &&
        Date.now() >= this.activeDeadlineMs
      ) {
        result.exitCode = 124;
        result.errorClass = "TIMEOUT";
      } else if (result.exitCode === 124 && !result.errorClass) {
        result.errorClass = "TIMEOUT";
      }

      if (callbacks?.onStdout && result.stdout) {
        callbacks.onStdout(result.stdout);
      }
      if (callbacks?.onStderr && result.stderr) {
        callbacks.onStderr(result.stderr);
      }
      // Post-execution audit
      if (result.errorClass === "TIMEOUT") {
        this.audit("command.timeout", { command, executionTimeMs });
      } else if (result.errorClass === "CANCELLED") {
        this.audit("command.cancelled", { command, executionTimeMs });
      } else {
        if (result.truncated?.stdout) {
          this.audit("limit.exceeded", { subtype: "stdout", command });
        }
        if (result.truncated?.stderr) {
          this.audit("limit.exceeded", { subtype: "stderr", command });
        }
        if (result.stderr?.includes("not allowed by security policy")) {
          this.audit("capability.denied", {
            command,
            reason: result.stderr.trim(),
          });
        }
        this.audit("command.complete", {
          command,
          exitCode: result.exitCode,
          executionTimeMs,
        });
      }

      return result;
    } finally {
      this.activeDeadlineMs = undefined;
      this.running = false;
    }
  }

  private async runBootCommand(
    command: string,
    options?: { stdinData?: Uint8Array },
  ): Promise<RunResult> {
    return await this.callBootCommand(this.bootProcess, command, options);
  }

  private async runBootCommandInFreshProcess(
    command: string,
    options?: { stdinData?: Uint8Array },
  ): Promise<RunResult> {
    const child = await this.spawn(this.bootArgv, {
      mode: "resident",
      env: Object.fromEntries(this.env),
      bootImports: this.bootImports,
    });
    try {
      return await this.callBootCommand(child, command, options);
    } finally {
      await child.terminate();
    }
  }

  private async callBootCommand(
    proc: Process,
    command: string,
    options?: { stdinData?: Uint8Array },
  ): Promise<RunResult> {
    const alloc = proc.exports.__alloc as
      | ((size: number) => number)
      | undefined;
    const dealloc = proc.exports.__dealloc as
      | ((ptr: number, size: number) => void)
      | undefined;
    if (!alloc || !dealloc) {
      throw new Error("boot process does not export __alloc/__dealloc");
    }

    await this.syncBootEnv(proc);
    const encoder = new TextEncoder();
    const commandBytes = encoder.encode(command);

    proc.setStdin(options?.stdinData);
    const commandPtr = alloc(commandBytes.length);
    const outCap = 1024 * 1024;
    const outPtr = alloc(outCap);
    let decoded = "";
    try {
      new Uint8Array(proc.memory.buffer, commandPtr, commandBytes.length).set(
        commandBytes,
      );
      const written = await proc.callExport(
        "__run_command",
        commandPtr,
        commandBytes.length,
        outPtr,
        outCap,
      );
      if (written > outCap) {
        throw new Error(`__run_command metadata exceeded ${outCap} bytes`);
      }
      decoded = new TextDecoder().decode(
        new Uint8Array(proc.memory.buffer, outPtr, written),
      );
    } finally {
      proc.setStdin(undefined);
      dealloc(commandPtr, commandBytes.length);
      dealloc(outPtr, outCap);
    }

    let parsed: {
      exit_code?: number;
      execution_time_ms?: number;
      env?: Record<string, string>;
    };
    try {
      parsed = JSON.parse(decoded);
    } catch {
      parsed = {};
    }

    if (parsed.env) {
      this.replaceEnvMapFromGuest(new Map(Object.entries(parsed.env)));
    }

    const stdout = proc.fdReadAndClear(1);
    const stderr = proc.fdReadAndClear(2);
    const truncated = stdout.truncated || stderr.truncated
      ? { stdout: stdout.truncated, stderr: stderr.truncated }
      : undefined;

    return {
      exitCode: parsed.exit_code ?? 0,
      stdout: stdout.data,
      stderr: stderr.data,
      executionTimeMs: parsed.execution_time_ms ?? 0,
      ...(truncated ? { truncated } : {}),
    };
  }

  private async syncBootEnv(proc: Process): Promise<void> {
    if (!this.envNeedsSync) return;
    const setEnv = proc.exports.__set_env as
      | ((ptr: number, len: number) => number)
      | undefined;
    const alloc = proc.exports.__alloc as
      | ((size: number) => number)
      | undefined;
    const dealloc = proc.exports.__dealloc as
      | ((ptr: number, size: number) => void)
      | undefined;
    if (!setEnv || !alloc || !dealloc) return;

    const bytes = new TextEncoder().encode(
      JSON.stringify(Object.fromEntries(this.env)),
    );
    const ptr = alloc(bytes.length);
    try {
      new Uint8Array(proc.memory.buffer, ptr, bytes.length).set(bytes);
      const rc = await proc.callExport("__set_env", ptr, bytes.length);
      if (rc !== 0) {
        throw new Error(`boot process rejected environment sync: ${rc}`);
      }
      this.envNeedsSync = false;
    } finally {
      dealloc(ptr, bytes.length);
    }
  }

  readFile(path: string): Uint8Array {
    this.assertAlive();
    return this.vfs.readFile(path);
  }

  writeFile(path: string, data: Uint8Array): void {
    this.assertAlive();
    this.vfs.writeFile(path, data);
  }

  readDir(path: string): DirEntry[] {
    this.assertAlive();
    return this.vfs.readdir(path);
  }

  mkdir(path: string): void {
    this.assertAlive();
    this.vfs.mkdir(path);
  }

  stat(path: string): StatResult {
    this.assertAlive();
    return this.vfs.stat(path);
  }

  process(pid: number): Process | undefined {
    this.assertAlive();
    return this.processes.get(pid);
  }

  async spawn(argv: string[], opts: {
    mode?: ProcessMode;
    env?: Record<string, string>;
    cwd?: string;
    bootImports?: (api: KernelApi) => Record<string, WebAssembly.ImportValue>;
  } = {}): Promise<Process> {
    this.assertAlive();
    const loaderCtx = Sandbox.createLoaderContext({
      vfs: this.vfs,
      adapter: this.adapter,
      kernel: this.kernel,
      mgr: this.mgr,
      processes: this.processes,
      bridge: this.bridge ?? undefined,
      socketBackend: this.socketBackend,
      serverSockets: this.serverSockets,
      runtimeBackend: this.runtimeBackend,
      extensionRegistry: this.extensionRegistry ?? new ExtensionRegistry(),
      runCommandHandler: this.runCommandHandler,
      getSandbox: () => this,
      getDeadlineMs: () => this.activeDeadlineMs,
      memoryBytes: this.security?.limits?.memoryBytes,
      stdoutLimit: this.security?.limits?.stdoutBytes,
      stderrLimit: this.security?.limits?.stderrBytes,
      toolAllowlist: this.security?.toolAllowlist,
      moduleCache: this.moduleCache,
    });
    const proc = await loadProcess(loaderCtx, {
      argv,
      mode: opts.mode ?? "cli",
      env: opts.env ?? Object.fromEntries(this.env),
      cwd: opts.cwd ?? "/",
      stdoutLimit: this.security?.limits?.stdoutBytes,
      stderrLimit: this.security?.limits?.stderrBytes,
      extraYurtImports: Sandbox.createBootImportFactory(
        this.vfs,
        this.mgr,
        opts.bootImports ?? this.bootImports,
      ),
    });
    if (proc.mode === "resident") {
      Sandbox.applyOutputLimits(
        this.kernel,
        proc.pid,
        this.security?.limits?.stdoutBytes,
        this.security?.limits?.stderrBytes,
      );
      this.processes.set(proc.pid, proc);
    } else {
      const captured = {
        1: proc.fdReadAndClear(1),
        2: proc.fdReadAndClear(2),
      };
      proc.__setFdReadAndClear((fd) => {
        const result = captured[fd];
        captured[fd] = { data: "", truncated: false };
        return result;
      });
      await proc.terminate();
      await this.kernel.waitpid(proc.pid);
    }
    return proc;
  }

  /**
   * Create a TTY pair and wire the boot process's fds 0/1/2 to the slave side.
   * Returns a `TtyHandle` the host can use to write input and read output.
   *
   * Call this once after `Sandbox.create()` when running an interactive shell
   * (ash/bash in TTY mode). The boot process must already be loaded.
   *
   * Writing input: `tty.write(new TextEncoder().encode("ls\n"))`
   * Reading output: `const chunk = await tty.read()`
   */
  openTty(rows = 24, cols = 80): TtyHandle {
    this.assertAlive();
    const state = this.kernel.openTtyForProcess(this.bootProcess.pid);
    if (
      this.kernel.setControllingTty(this.bootProcess.pid, state.ttyId) !== 0
    ) {
      throw new Error(
        `failed to set controlling terminal for pid ${this.bootProcess.pid}`,
      );
    }
    state.rows = rows;
    state.cols = cols;
    return new TtyHandle(state);
  }

  rm(path: string): void {
    this.assertAlive();
    this.vfs.unlink(path);
  }

  /**
   * Mount host-provided files (or a custom VirtualProvider) at the given path.
   *
   * Accepts either a flat file map `Record<string, Uint8Array>` (convenient)
   * or a `VirtualProvider` instance (flexible). Duck-types on `readFile` method.
   */
  mount(
    path: string,
    filesOrProvider: Record<string, Uint8Array> | VirtualProvider,
  ): void {
    this.assertAlive();
    const provider: VirtualProvider =
      typeof (filesOrProvider as VirtualProvider).readFile === "function"
        ? (filesOrProvider as VirtualProvider)
        : new HostMount(filesOrProvider as Record<string, Uint8Array>);
    if (!this.vfs.mount) {
      throw new Error("Configured VFS does not support mounts");
    }
    this.vfs.mount(path, provider);
  }

  setEnv(name: string, value: string): void {
    this.assertAlive();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: '${name}'`);
    }
    this.env.set(name, value);
    this.envNeedsSync = true;
  }

  getEnv(name: string): string | undefined {
    this.assertAlive();
    return this.env.get(name);
  }

  getEnvMap(): Map<string, string> {
    this.assertAlive();
    return new Map(this.env);
  }

  setEnvMap(env: Map<string, string>): void {
    this.assertAlive();
    this.env = new Map(env);
    this.envNeedsSync = true;
  }

  private replaceEnvMapFromGuest(env: Map<string, string>): void {
    this.env = new Map(env);
    this.envNeedsSync = false;
  }

  snapshot(): string {
    this.assertAlive();
    if (!this.vfs.snapshot) {
      throw new Error("Configured VFS does not support snapshot");
    }
    const id = this.vfs.snapshot();
    this.envSnapshots.set(id, this.getEnvMap());
    return id;
  }

  restore(id: string): void {
    this.assertAlive();
    if (!this.vfs.restore) {
      throw new Error("Configured VFS does not support restore");
    }
    this.vfs.restore(id);
    const envSnap = this.envSnapshots.get(id);
    if (envSnap) {
      this.setEnvMap(envSnap);
    }
  }

  /** Export the entire sandbox state (VFS files + env vars) as a binary blob. */
  exportState(): Uint8Array {
    this.assertAlive();
    return serializerExportState(
      this.vfs,
      this.getEnvMap(),
      this.vfs.getProviderPaths?.(),
    );
  }

  /** Import a previously exported state blob, restoring files and env vars. */
  importState(blob: Uint8Array): void {
    this.assertAlive();
    const { env } = serializerImportState(this.vfs, blob);
    if (env) {
      this.setEnvMap(env);
    }
  }

  /** Offload sandbox state to external storage, freeing VFS file content memory. */
  async offload(): Promise<void> {
    if (this.offloaded) return; // idempotent
    if (this.destroyed) throw new Error("Sandbox has been destroyed");
    if (!this.storage) throw new Error("No storage callbacks configured");
    if (this.running) {
      throw new Error("Cannot offload while a command is running");
    }
    if (!this.vfs.clearFileContents) {
      throw new Error("Configured VFS does not support offload");
    }

    const blob = serializerExportState(
      this.vfs,
      this.getEnvMap(),
      this.vfs.getProviderPaths?.(),
    );
    await this.storage.save(this.sessionId, blob);
    this.vfs.clearFileContents();
    this.offloaded = true;
  }

  /** Restore sandbox state from external storage. */
  async rehydrate(): Promise<void> {
    if (!this.offloaded) return; // idempotent
    if (this.destroyed) throw new Error("Sandbox has been destroyed");
    if (!this.storage) throw new Error("No storage callbacks configured");

    const blob = await this.storage.load(this.sessionId);
    this.offloaded = false; // clear before importState so assertAlive passes
    const { env } = serializerImportState(this.vfs, blob);
    if (env) {
      this.setEnvMap(env);
    }
  }

  /** Persist current state to the configured backend. Requires persistence mode. */
  async saveState(): Promise<void> {
    this.assertAlive();
    if (!this.persistenceManager) {
      throw new Error(
        'Persistence not configured. Set persistence.mode to "session" or "persistent".',
      );
    }
    await this.persistenceManager.save();
  }

  /** Load persisted state from the configured backend. Returns true if state was restored. */
  async loadState(): Promise<boolean> {
    this.assertAlive();
    if (!this.persistenceManager) {
      throw new Error(
        'Persistence not configured. Set persistence.mode to "session" or "persistent".',
      );
    }
    return this.persistenceManager.load();
  }

  /** Delete persisted state from the configured backend. */
  async clearPersistedState(): Promise<void> {
    this.assertAlive();
    if (!this.persistenceManager) {
      throw new Error(
        'Persistence not configured. Set persistence.mode to "session" or "persistent".',
      );
    }
    await this.persistenceManager.clear();
  }

  async fork(): Promise<Sandbox> {
    this.assertAlive();
    if (!this.vfs.cowClone) {
      throw new Error("Configured VFS does not support fork");
    }
    const childVfs = this.vfs.cowClone();
    const { bridge } = await Sandbox.createNetworkBridge(this.networkPolicy);
    const childMgr = new ProcessManager(
      childVfs,
      this.adapter,
      bridge,
      this.security?.toolAllowlist,
      this.moduleCache,
    );
    const tools = childVfs instanceof OverlayVFS
      ? Sandbox.registerBaseRootTools(childMgr, childVfs)
      : await Sandbox.registerTools(
        childMgr,
        this.adapter,
        this.wasmDir,
        childVfs as VFS,
      );

    // Pre-load all tool modules so spawnSync can use them synchronously
    await childMgr.preloadModules();

    const childKernel = new ProcessKernel({
      maxProcesses: this.security?.limits?.processes,
    });
    const childProcesses = new Map<number, Process>();
    let childRef: Sandbox | undefined;
    const childCtx = Sandbox.createLoaderContext({
      vfs: childVfs,
      adapter: this.adapter,
      kernel: childKernel,
      mgr: childMgr,
      processes: childProcesses,
      bridge,
      socketBackend: this.socketBackend,
      serverSockets: this.serverSockets,
      runtimeBackend: this.runtimeBackend,
      extensionRegistry: this.extensionRegistry ?? new ExtensionRegistry(),
      runCommandHandler: this.runCommandHandler,
      getSandbox: () => childRef,
      getDeadlineMs: () => childRef?.activeDeadlineMs,
      memoryBytes: this.security?.limits?.memoryBytes,
      stdoutLimit: this.security?.limits?.stdoutBytes,
      stderrLimit: this.security?.limits?.stderrBytes,
      toolAllowlist: this.security?.toolAllowlist,
      moduleCache: this.moduleCache,
    });
    const childEnv = this.getEnvMap();
    const childBootProcess = await loadProcess(childCtx, {
      argv: this.bootArgv,
      mode: "resident",
      env: Object.fromEntries(childEnv),
      stdoutLimit: this.security?.limits?.stdoutBytes,
      stderrLimit: this.security?.limits?.stderrBytes,
      extraYurtImports: Sandbox.createBootImportFactory(
        childVfs,
        childMgr,
        this.bootImports,
      ),
    });
    Sandbox.applyOutputLimits(
      childKernel,
      childBootProcess.pid,
      this.security?.limits?.stdoutBytes,
      this.security?.limits?.stderrBytes,
    );
    childProcesses.set(childBootProcess.pid, childBootProcess);

    // Create WorkerExecutor for the child if parent uses hard-kill
    const childWorkerExecutor = await Sandbox.createWorkerExecutor(
      childVfs,
      this.wasmDir,
      this.bootWasmPath,
      tools,
      this.adapter,
      this.security,
      bridge,
      this.networkPolicy,
      this.extensionRegistry ?? undefined,
    );

    const child = new Sandbox({
      vfs: childVfs,
      kernel: childKernel,
      processes: childProcesses,
      bootProcess: childBootProcess,
      env: childEnv,
      timeoutMs: this.timeoutMs,
      adapter: this.adapter,
      wasmDir: this.wasmDir,
      bootWasmPath: this.bootWasmPath,
      mgr: childMgr,
      bridge,
      networkPolicy: this.networkPolicy,
      socketBackend: this.socketBackend,
      serverSockets: this.serverSockets,
      runtimeBackend: this.runtimeBackend,
      security: this.security,
      workerExecutor: childWorkerExecutor,
      extensionRegistry: this.extensionRegistry ?? undefined,
      storage: this.storage ?? undefined,
      bootArgv: this.bootArgv,
      bootImports: this.bootImports,
      runCommandHandler: this.runCommandHandler,
      moduleCache: this.moduleCache,
    });
    childRef = child;
    return child;
  }

  /** Cancel the currently running command. */
  cancel(): void {
    if (this.workerExecutor) {
      this.workerExecutor.kill();
    } else {
      this.mgr.cancelCurrent();
    }
  }

  destroy(): void {
    this.audit("sandbox.destroy");
    this.destroyed = true;
    // Fire-and-forget: dispose is async but destroy is sync
    this.persistenceManager?.dispose().catch(() => {});
    this.workerExecutor?.dispose();
    const disposableBridge = this.bridge as
      | (NetworkBridgeLike & { dispose?: () => void })
      | null;
    if (typeof disposableBridge?.dispose === "function") {
      disposableBridge.dispose();
    }
    this.kernel.dispose();
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error("Sandbox has been destroyed");
    }
    if (this.offloaded) {
      throw new Error("Sandbox is offloaded — call rehydrate() first");
    }
  }
}
