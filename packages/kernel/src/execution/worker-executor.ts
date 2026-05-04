/**
 * WorkerExecutor — main-thread Worker lifecycle manager.
 *
 * Creates Worker threads for command execution, serves VFS proxy
 * requests over SharedArrayBuffer, and handles timeout/kill.
 */

import type { Worker } from 'node:worker_threads';
import type { VFS } from '../vfs/vfs.js';
import type { RunResult } from '../run-result.js';
import {
  SAB_SIZE,
  STATUS_RESPONSE,
  STATUS_ERROR,
  decodeRequest,
  encodeResponse,
} from './proxy-protocol.js';
import { VfsError } from '../vfs/inode.js';
import type { ExtensionRegistry } from '../extension/registry.js';

export interface WorkerConfig {
  vfs: VFS;
  wasmDir: string;
  shellExecWasmPath: string;
  toolRegistry: [string, string][];
  networkEnabled?: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  toolAllowlist?: string[];
  memoryBytes?: number;
  processes?: number;
  bridgeSab?: SharedArrayBuffer;
  networkPolicy?: { allowedHosts?: string[]; blockedHosts?: string[] };
  extensionRegistry?: ExtensionRegistry;
}

export interface WorkerRunResult extends RunResult {
  /** Environment updates from the worker, for syncing back to the main runner. */
  env?: [string, string][];
}

export class WorkerExecutor {
  private worker: Worker | null = null;
  private sab: SharedArrayBuffer;
  private int32: Int32Array;
  private config: WorkerConfig;
  private pendingResolve: ((r: WorkerRunResult) => void) | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private lastEnv: Map<string, string> | null = null;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
  }

  async run(command: string, env: Map<string, string>, timeoutMs: number): Promise<WorkerRunResult> {
    if (!this.worker) {
      await this.createWorker();
    }

    this.running = true;

    return new Promise<WorkerRunResult>((resolve) => {
      this.pendingResolve = resolve;

      this.timeoutTimer = setTimeout(() => {
        this.terminateWorker({
          exitCode: 124,
          stdout: '',
          stderr: 'command timeout\n',
          executionTimeMs: timeoutMs,
          errorClass: 'TIMEOUT',
        });
      }, timeoutMs);

      this.worker!.postMessage({
        type: 'run',
        command,
        env: Array.from(env.entries()),
        timeoutMs,
        stdoutLimit: this.config.stdoutBytes,
        stderrLimit: this.config.stderrBytes,
      });
    });
  }

  kill(): void {
    this.terminateWorker({
      exitCode: 125,
      stdout: '',
      stderr: 'command cancelled\n',
      executionTimeMs: 0,
      errorClass: 'CANCELLED',
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Return the env map from the last completed run, or null. */
  getLastEnv(): Map<string, string> | null {
    return this.lastEnv;
  }

  dispose(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    // Resolve any pending run() promise before terminating the worker.
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({
        exitCode: 1, stdout: '', stderr: 'disposed\n', executionTimeMs: 0,
      });
    }
    if (this.worker) {
      this.worker.removeAllListeners();
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    this.running = false;
  }

  private async createWorker(): Promise<void> {
    const { Worker } = await import('node:worker_threads');

    // Fresh SAB for each Worker to avoid data races with terminated Workers
    // whose threads may still be lingering on the old SAB.
    this.sab = new SharedArrayBuffer(SAB_SIZE);
    this.int32 = new Int32Array(this.sab);
    await this.ensureBootBinary();

    // Source runs can load TS directly; built Node packages load the emitted JS worker.
    const workerPath = new URL(
      import.meta.url.endsWith('.ts') ? './execution-worker.ts' : './execution-worker.js',
      import.meta.url,
    ).pathname;
    this.worker = new Worker(workerPath, { execArgv: [] });

    // Don't let the Worker prevent the process from exiting (e.g. in tests).
    this.worker.unref();

    // Handle messages from Worker
    this.worker.on('message', (msg: any) => {
      if (msg === 'proxy-request') {
        this.handleProxyRequest();
        return;
      }
      if (msg?.type === 'result') {
        this.running = false;
        if (this.timeoutTimer) {
          clearTimeout(this.timeoutTimer);
          this.timeoutTimer = null;
        }
        // Capture env changes from Worker
        if (msg.env) {
          this.lastEnv = new Map(msg.env as [string, string][]);
        }
        if (this.pendingResolve) {
          const resolve = this.pendingResolve;
          this.pendingResolve = null;
          const result: WorkerRunResult = msg.result as RunResult;
          if (msg.env) {
            result.env = msg.env;
          }
          resolve(result);
        }
      }
    });

    this.worker.on('error', (err) => {
      this.terminateWorker({
        exitCode: 1,
        stdout: '',
        stderr: `Worker error: ${err.message}\n`,
        executionTimeMs: 0,
      });
    });

    // Send init message and wait for ready
    const readyPromise = new Promise<void>((resolve, reject) => {
      const onMsg = (msg: any) => {
        if (msg?.type === 'ready') {
          this.worker!.off('error', onError);
          this.worker!.off('exit', onExit);
          this.worker!.off('message', onMsg);
          resolve();
        }
      };
      const onError = (err: Error) => {
        this.worker?.off('message', onMsg);
        this.worker?.off('exit', onExit);
        reject(err);
      };
      const onExit = (code: number) => {
        if (code === 0) return;
        this.worker?.off('message', onMsg);
        this.worker?.off('error', onError);
        reject(new Error(`Worker exited before ready with code ${code}`));
      };
      this.worker!.on('message', onMsg);
      this.worker!.once('error', onError);
      this.worker!.once('exit', onExit);
    });

    this.worker.postMessage({
      type: 'init',
      sab: this.sab,
      wasmDir: this.config.wasmDir,
      shellExecWasmPath: this.config.shellExecWasmPath,
      toolRegistry: this.config.toolRegistry,
      networkEnabled: this.config.networkEnabled ?? false,
      stdoutBytes: this.config.stdoutBytes,
      stderrBytes: this.config.stderrBytes,
      toolAllowlist: this.config.toolAllowlist,
      memoryBytes: this.config.memoryBytes,
      processes: this.config.processes,
      bridgeSab: this.config.bridgeSab,
      networkPolicy: this.config.networkPolicy,
      hasExtensions: this.config.extensionRegistry != null,
    });

    await readyPromise;
  }

  private async ensureBootBinary(): Promise<void> {
    try {
      this.config.vfs.stat('/bin/bash');
      return;
    } catch {
      // Missing in direct WorkerExecutor tests/usage. Sandbox.create installs
      // this already, so never overwrite an existing sandbox boot binary.
    }

    const { readFile } = await import('node:fs/promises');
    const shellWasmBytes = await readFile(this.config.shellExecWasmPath);
    this.config.vfs.withWriteAccess(() => {
      this.config.vfs.mkdirp('/bin');
      this.config.vfs.writeFile('/bin/bash', shellWasmBytes);
      this.config.vfs.chmod('/bin/bash', 0o755);
    });
  }

  private handleProxyRequest(): void {
    const { metadata, binary } = decodeRequest(this.sab);
    const op = metadata.op as string;

    // Extension invocations are async — main thread is free while worker blocks
    if (op === 'extensionInvoke') {
      this.handleExtensionProxy(metadata).then(() => {
        Atomics.notify(this.int32, 0);
      }).catch((err) => {
        encodeResponse(this.sab, { ok: false, error: (err as Error).message ?? 'extension handler error' });
        Atomics.store(this.int32, 0, STATUS_ERROR);
        Atomics.notify(this.int32, 0);
      });
      return; // Don't notify yet — async handler will notify
    }

    const path = (metadata.path as string) ?? '';
    const vfs = this.config.vfs;

    // Only use withWriteAccess for write operations targeting tool stub paths.
    // Restrict elevation to /usr/bin (tool stubs only) and /.wasi (WASI internals).
    // Never elevate writes to /usr/lib, /usr/share, or /bin to prevent
    // overwriting security-critical files (e.g. Python socket shim).
    const READ_OPS = new Set(['readFile', 'stat', 'lstat', 'readdir']);
    const ELEVATED_WRITE_PREFIXES = ['/usr/bin/', '/.wasi/'];
    const ELEVATED_WRITE_PATHS = new Set(['/.wasi-preopen-sentinel']);
    const isRead = READ_OPS.has(op);
    const isElevatedPath = ELEVATED_WRITE_PATHS.has(path) || ELEVATED_WRITE_PREFIXES.some(p => path.startsWith(p));
    const needsElevation = !isRead && isElevatedPath;

    const exec = () => {
      switch (op) {
        case 'readFile': {
          const content = vfs.readFile(metadata.path as string);
          encodeResponse(this.sab, {}, content);
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'writeFile': {
          vfs.writeFile(metadata.path as string, binary ?? new Uint8Array(0));
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'stat': {
          const st = vfs.stat(metadata.path as string);
          encodeResponse(this.sab, {
            type: st.type,
            size: st.size,
            permissions: st.permissions,
            uid: st.uid,
            gid: st.gid,
            mtime: st.mtime.toISOString(),
            ctime: st.ctime.toISOString(),
            atime: st.atime.toISOString(),
          });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'lstat': {
          const lst = vfs.lstat(metadata.path as string);
          encodeResponse(this.sab, {
            type: lst.type,
            size: lst.size,
            permissions: lst.permissions,
            uid: lst.uid,
            gid: lst.gid,
            mtime: lst.mtime.toISOString(),
            ctime: lst.ctime.toISOString(),
            atime: lst.atime.toISOString(),
          });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'readdir': {
          const entries = vfs.readdir(metadata.path as string);
          encodeResponse(this.sab, { entries });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'mkdir': {
          vfs.mkdir(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'mkdirp': {
          vfs.mkdirp(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'unlink': {
          vfs.unlink(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'rmdir': {
          vfs.rmdir(metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'rename': {
          vfs.rename(metadata.oldPath as string, metadata.newPath as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'chmod': {
          vfs.chmod(metadata.path as string, metadata.mode as number);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'chown': {
          vfs.chown(
            metadata.path as string,
            metadata.uid as number,
            metadata.gid as number,
            metadata.followSymlinks as boolean | undefined,
          );
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'symlink': {
          vfs.symlink(metadata.target as string, metadata.path as string);
          encodeResponse(this.sab, { ok: true });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        case 'readlink': {
          const target = vfs.readlink(metadata.path as string);
          encodeResponse(this.sab, { target });
          Atomics.store(this.int32, 0, STATUS_RESPONSE);
          break;
        }
        default: {
          encodeResponse(this.sab, {
            error: true,
            code: 'ENOSYS',
            message: `Unknown op: ${op}`,
          });
          Atomics.store(this.int32, 0, STATUS_ERROR);
          break;
        }
      }
    };

    try {
      if (needsElevation) {
        vfs.withWriteAccess(exec);
      } else {
        exec();
      }
    } catch (err) {
      if (err instanceof VfsError) {
        encodeResponse(this.sab, {
          error: true,
          code: err.errno,
          message: err.message,
        });
      } else {
        encodeResponse(this.sab, {
          error: true,
          code: 'EIO',
          message: (err as Error).message,
        });
      }
      Atomics.store(this.int32, 0, STATUS_ERROR);
    }

    Atomics.notify(this.int32, 0);
  }

  private async handleExtensionProxy(metadata: Record<string, unknown>): Promise<void> {
    const extName = metadata.extension as string;
    const method = metadata.method as string;
    const kwargs = metadata.kwargs as Record<string, unknown>;

    if (!this.config.extensionRegistry) {
      encodeResponse(this.sab, { ok: false, error: 'no extension registry configured' });
      Atomics.store(this.int32, 0, STATUS_RESPONSE);
      return;
    }

    try {
      const result = await this.config.extensionRegistry.invoke(extName, {
        args: [method, JSON.stringify(kwargs)],
        stdin: '',
        env: {},
        cwd: '/',
      });
      encodeResponse(this.sab, { ok: true, result: result.stdout });
      Atomics.store(this.int32, 0, STATUS_RESPONSE);
    } catch (err) {
      encodeResponse(this.sab, { ok: false, error: (err as Error).message });
      Atomics.store(this.int32, 0, STATUS_RESPONSE);
    }
  }

  private terminateWorker(result: RunResult): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.worker) {
      this.worker.terminate().catch(() => {});
      this.worker = null;
    }
    this.running = false;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(result);
    }
  }
}
