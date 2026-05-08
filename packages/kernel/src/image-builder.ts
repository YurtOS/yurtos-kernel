import { exportVfsToYurtImage } from "./image-exporter.js";
import { loadYurtImage } from "./image-loader.js";
import type { PlatformAdapter } from "./platform/adapter.js";
import { Process } from "./process/handle.js";
import { ProcessKernel } from "./process/kernel.js";
import { loadProcess } from "./process/loader.js";
import {
  defaultWasmModuleCache,
  type WasmModuleCache,
} from "./process/module-cache.js";
import { ProcessManager } from "./process/manager.js";
import { createProcessLoaderContextForVfs } from "./sandbox.js";
import { OverlayVFS } from "./vfs/overlay-vfs.js";
import { TarImageRootProvider } from "./vfs/tar-image-root-provider.js";
import { VFS } from "./vfs/vfs.js";
import type { VfsLike } from "./vfs/vfs-like.js";

const DEFAULT_ENV: Record<string, string> = {
  HOME: "/",
  PATH: "/bin:/usr/bin",
  PWD: "/",
  USER: "root",
};

export interface YurtImageBuilderOptions {
  wasmDir: string;
  adapter?: PlatformAdapter;
  moduleCache?: WasmModuleCache;
  baseImage?: string | Uint8Array;
  imageCacheDir?: string;
}

export interface CopyInOptions {
  uid?: number;
  gid?: number;
  mode?: number;
}

export interface RunImageCommandOptions {
  env?: Record<string, string>;
  cwd?: string;
  stderrToStdout?: boolean;
  stdoutLimit?: number;
  stderrLimit?: number;
}

export interface RunImageCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated?: {
    stdout: boolean;
    stderr: boolean;
  };
}

export class YurtImageBuilder {
  private readonly adapter: PlatformAdapter;
  private readonly kernel = new ProcessKernel();
  private readonly mgr: ProcessManager;
  private readonly moduleCache: WasmModuleCache;
  private readonly processes = new Map<number, Process>();
  private destroyed = false;

  private constructor(
    private readonly vfs: VfsLike,
    options: {
      adapter: PlatformAdapter;
      moduleCache: WasmModuleCache;
    },
  ) {
    this.adapter = options.adapter;
    this.moduleCache = options.moduleCache;
    this.mgr = new ProcessManager(
      vfs,
      this.adapter,
      undefined,
      undefined,
      this.moduleCache,
    );
    this.vfs.setProcessListProvider?.(() => this.kernel.listProcesses());
  }

  static async empty(
    options: Omit<YurtImageBuilderOptions, "baseImage">,
  ): Promise<YurtImageBuilder> {
    return await YurtImageBuilder.create(options);
  }

  static async create(
    options: YurtImageBuilderOptions,
  ): Promise<YurtImageBuilder> {
    const adapter = options.adapter ?? await defaultAdapter();
    const moduleCache = options.moduleCache ?? defaultWasmModuleCache;
    const upper = new VFS({ layout: "empty" });
    let vfs: VfsLike = upper;

    if (options.baseImage) {
      const loaded = await loadYurtImage(options.baseImage, {
        cacheDir: options.imageCacheDir,
      });
      vfs = new OverlayVFS({
        base: new TarImageRootProvider({
          id: loaded.baseId,
          image: loaded.tarBytes,
          index: loaded.index,
        }),
        upper,
      });
    }

    return new YurtImageBuilder(vfs, { adapter, moduleCache });
  }

  async copyIn(
    source: string | Uint8Array,
    destination: string,
    options: CopyInOptions = {},
  ): Promise<void> {
    this.assertAlive();
    const data = typeof source === "string"
      ? new Uint8Array(await readHostFile(source))
      : source;
    this.vfs.withWriteAccess(() => {
      ensureParentDirectory(this.vfs, destination);
      this.vfs.writeFile(destination, data, options.mode);
      applyOwnershipAndMode(this.vfs, destination, options);
    });
  }

  mkdir(path: string, options: CopyInOptions = {}): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() => {
      ensureParentDirectory(this.vfs, path);
      try {
        this.vfs.mkdir(path, options.mode);
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
      }
      applyOwnershipAndMode(this.vfs, path, options);
    });
  }

  symlink(target: string, path: string, options: CopyInOptions = {}): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() => {
      ensureParentDirectory(this.vfs, path);
      this.vfs.symlink(target, path);
      if (options.uid !== undefined || options.gid !== undefined) {
        this.vfs.chown(path, options.uid ?? 0, options.gid ?? 0, false);
      }
    });
  }

  chmod(path: string, mode: number): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() => this.vfs.chmod(path, mode));
  }

  chown(path: string, uid: number, gid: number, followSymlinks = true): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() =>
      this.vfs.chown(path, uid, gid, followSymlinks)
    );
  }

  unlink(path: string): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() => this.vfs.unlink(path));
  }

  rmdir(path: string): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() => this.vfs.rmdir(path));
  }

  remove(path: string): void {
    this.assertAlive();
    this.vfs.withWriteAccess(() => this.removeUnlocked(path));
  }

  async run(
    argv: string[],
    options: RunImageCommandOptions = {},
  ): Promise<RunImageCommandResult> {
    this.assertAlive();
    if (argv.length === 0 || argv[0] === "") {
      throw new Error("YurtImageBuilder.run requires argv[0]");
    }

    const loaderCtx = createProcessLoaderContextForVfs({
      vfs: this.vfs,
      adapter: this.adapter,
      kernel: this.kernel,
      mgr: this.mgr,
      processes: this.processes,
      moduleCache: this.moduleCache,
      stdoutLimit: options.stdoutLimit,
      stderrLimit: options.stderrLimit,
    });
    const proc = await loadProcess(loaderCtx, {
      argv,
      mode: "cli",
      env: { ...DEFAULT_ENV, ...(options.env ?? {}) },
      cwd: options.cwd ?? "/",
      stderrToStdout: options.stderrToStdout,
      stdoutLimit: options.stdoutLimit,
      stderrLimit: options.stderrLimit,
    });

    try {
      const stdout = proc.fdReadAndClear(1);
      const stderr = proc.fdReadAndClear(2);
      return {
        exitCode: proc.exitCode ?? 0,
        stdout: stdout.data,
        stderr: stderr.data,
        truncated: stdout.truncated || stderr.truncated
          ? { stdout: stdout.truncated, stderr: stderr.truncated }
          : undefined,
      };
    } finally {
      await proc.terminate();
      await this.kernel.waitpid(proc.pid);
    }
  }

  async exportImage(): Promise<Uint8Array> {
    this.assertAlive();
    return await exportVfsToYurtImage(this.vfs);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.vfs.setProcessListProvider?.(null);
    this.processes.clear();
    this.kernel.dispose();
  }

  private removeUnlocked(path: string): void {
    const stat = this.vfs.lstat(path);
    if (stat.type !== "dir") {
      this.vfs.unlink(path);
      return;
    }

    for (const entry of this.vfs.readdir(path)) {
      this.removeUnlocked(joinPath(path, entry.name));
    }
    this.vfs.rmdir(path);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("YurtImageBuilder has been destroyed");
  }
}

async function defaultAdapter(): Promise<PlatformAdapter> {
  const { NodeAdapter } = await import("./platform/node-adapter.js");
  return new NodeAdapter();
}

async function readHostFile(path: string): Promise<Uint8Array> {
  const { readFile } = await import("node:fs/promises");
  return new Uint8Array(await readFile(path));
}

function applyOwnershipAndMode(
  vfs: VfsLike,
  path: string,
  options: CopyInOptions,
): void {
  if (options.uid !== undefined || options.gid !== undefined) {
    vfs.chown(path, options.uid ?? 0, options.gid ?? 0);
  }
  if (options.mode !== undefined) vfs.chmod(path, options.mode);
}

function ensureParentDirectory(vfs: VfsLike, path: string): void {
  assertAbsolutePath(path);
  const parent = parentPath(path);
  if (parent !== "/") vfs.mkdirp(parent);
}

function parentPath(path: string): string {
  const slash = normalizePath(path).lastIndexOf("/");
  return slash <= 0 ? "/" : path.slice(0, slash);
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function normalizePath(path: string): string {
  assertAbsolutePath(path);
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function assertAbsolutePath(path: string): void {
  if (!path.startsWith("/")) throw new Error(`path must be absolute: ${path}`);
}

function isErrno(error: unknown, errno: string): boolean {
  return typeof error === "object" && error !== null &&
    ("errno" in error || "code" in error) &&
    ((error as { errno?: unknown }).errno === errno ||
      (error as { code?: unknown }).code === errno);
}
