/**
 * Execution Worker entrypoint.
 *
 * Runs inside a Worker thread. Receives init + run messages from the main
 * thread, executes commands via a resident boot process, and posts results back.
 * VFS access goes through VfsProxy (SAB + Atomics).
 */

import { parentPort } from 'node:worker_threads';
import { VfsProxy } from './vfs-proxy.js';
import {
  STATUS_REQUEST,
  STATUS_RESPONSE,
  STATUS_ERROR,
  encodeRequest,
  decodeResponse,
} from './proxy-protocol.js';
import { ProcessManager } from '../process/manager.js';
import type { RunResult } from '../run-result.js';
import { CancelledError } from '../security.js';
import { INIT_PID, ProcessKernel, type SpawnRequest } from '../process/kernel.js';
import { loadProcess, type LoaderContext } from '../process/loader.js';
import { Process } from '../process/handle.js';
import { createKernelImports } from '../host-imports/kernel-imports.js';
import { WasiHost } from '../wasi/wasi-host.js';
import { bufferToString, createBufferTarget, type FdTarget } from '../wasi/fd-target.js';
import type { NetworkBridgeLike } from '../network/bridge.js';

if (!parentPort) throw new Error('Must run as Worker thread');

interface InitMessage {
  type: 'init';
  sab: SharedArrayBuffer;
  wasmDir: string;
  shellExecWasmPath: string;
  toolRegistry: [string, string][];
  networkEnabled: boolean;
  stdoutBytes?: number;
  stderrBytes?: number;
  toolAllowlist?: string[];
  memoryBytes?: number;
  bridgeSab?: SharedArrayBuffer;
  networkPolicy?: { allowedHosts?: string[]; blockedHosts?: string[] };
  hasExtensions?: boolean;
}

interface RunMessage {
  type: 'run';
  command: string;
  env: [string, string][];
  timeoutMs?: number;
  stdoutLimit?: number;
  stderrLimit?: number;
}

class WorkerResidentRunner {
  private kernel = new ProcessKernel();
  private processes = new Map<number, Process>();
  private env = new Map<string, string>();
  private bootProcess: Process | null = null;
  private stdoutLimit: number | undefined;
  private stderrLimit: number | undefined;

  constructor(
    private readonly vfs: VfsProxy,
    private readonly adapter: import('../platform/adapter.js').PlatformAdapter,
    private readonly mgr: ProcessManager,
    private readonly networkBridge: NetworkBridgeLike | undefined,
    private readonly extensionHandler: ((cmd: Record<string, unknown>) => Record<string, unknown>) | undefined,
  ) {}

  async boot(argv: string[], stdoutLimit?: number, stderrLimit?: number): Promise<void> {
    this.stdoutLimit = stdoutLimit;
    this.stderrLimit = stderrLimit;
    const ctx = this.createLoaderContext();
    this.bootProcess = await loadProcess(ctx, {
      argv,
      mode: 'resident',
      env: Object.fromEntries(this.env),
      cwd: '/',
      stdoutLimit,
      stderrLimit,
    });
    this.processes.set(this.bootProcess.pid, this.bootProcess);
    this.applyOutputLimits(this.bootProcess.pid);
  }

  setEnv(name: string, value: string): void {
    this.env.set(name, value);
  }

  getEnvMap(): Map<string, string> {
    return new Map(this.env);
  }

  setOutputLimits(stdoutLimit?: number, stderrLimit?: number): void {
    this.stdoutLimit = stdoutLimit;
    this.stderrLimit = stderrLimit;
    if (this.bootProcess) this.applyOutputLimits(this.bootProcess.pid);
  }

  resetCancel(_deadlineMs: number): void {
    // Hard-kill is enforced by terminating the Worker. Cooperative cancellation
    // is intentionally a no-op on this path.
  }

  async run(command: string): Promise<RunResult> {
    if (!this.bootProcess) {
      return { exitCode: 1, stdout: '', stderr: 'Worker not initialized\n', executionTimeMs: 0 };
    }
    return await this.callBootCommand(this.bootProcess, command);
  }

  private async runInFreshBootProcess(command: string, stdin?: Uint8Array): Promise<RunResult> {
    if (!this.bootProcess) {
      return { exitCode: 1, stdout: '', stderr: 'Worker not initialized\n', executionTimeMs: 0 };
    }
    const child = await loadProcess(this.createLoaderContext(), {
      argv: ['/bin/bash'],
      mode: 'resident',
      env: Object.fromEntries(this.env),
      cwd: '/',
      stdoutLimit: this.stdoutLimit,
      stderrLimit: this.stderrLimit,
    });
    this.processes.set(child.pid, child);
    this.applyOutputLimits(child.pid);
    try {
      return await this.callBootCommand(child, command, stdin);
    } finally {
      await child.terminate();
      this.processes.delete(child.pid);
    }
  }

  private async callBootCommand(
    proc: Process,
    command: string,
    stdinData?: Uint8Array,
  ): Promise<RunResult> {
    const alloc = proc.exports.__alloc as ((size: number) => number) | undefined;
    const dealloc = proc.exports.__dealloc as ((ptr: number, size: number) => void) | undefined;
    if (!alloc || !dealloc) {
      throw new Error('boot process does not export __alloc/__dealloc');
    }

    const envPrefix = this.buildEnvPrefix();
    const commandText = envPrefix ? `${envPrefix}; ${command}` : command;
    const commandBytes = new TextEncoder().encode(commandText);

    proc.setStdin(stdinData);
    const commandPtr = alloc(commandBytes.length);
    const outCap = 1024 * 1024;
    const outPtr = alloc(outCap);
    let decoded = '';
    try {
      new Uint8Array(proc.memory.buffer, commandPtr, commandBytes.length).set(commandBytes);
      const written = await proc.callExport('__run_command', commandPtr, commandBytes.length, outPtr, outCap);
      if (written > outCap) throw new Error(`__run_command metadata exceeded ${outCap} bytes`);
      decoded = new TextDecoder().decode(new Uint8Array(proc.memory.buffer, outPtr, written));
    } finally {
      proc.setStdin(undefined);
      dealloc(commandPtr, commandBytes.length);
      dealloc(outPtr, outCap);
    }

    let parsed: { exit_code?: number; execution_time_ms?: number; env?: Record<string, string> };
    try {
      parsed = JSON.parse(decoded);
    } catch {
      parsed = {};
    }
    if (parsed.env) this.env = new Map(Object.entries(parsed.env));

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

  private buildEnvPrefix(): string {
    if (this.env.size === 0) return '';
    const exports: string[] = [];
    for (const [name, value] of this.env) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      exports.push(`export ${name}='${value.replace(/'/g, "'\\''")}'`);
    }
    return exports.join('; ');
  }

  private applyOutputLimits(pid: number): void {
    this.kernel.setFdTarget(pid, 1, createBufferTarget(this.stdoutLimit ?? Infinity));
    this.kernel.setFdTarget(pid, 2, createBufferTarget(this.stderrLimit ?? Infinity));
  }

  private createLoaderContext(): LoaderContext {
    const kernel = this.kernel;
    const vfs = this.vfs;
    const adapter = this.adapter;
    const mgr = this.mgr;
    const processes = this.processes;

    const makeFdReadAndClear = (pid: number) => (fd: 1 | 2) => {
      const target = kernel.getFdTarget(pid, fd);
      if (!target || target.type !== 'buffer') return { data: '', truncated: false };
      const data = bufferToString(target);
      const truncated = !!target.truncated;
      target.buf.length = 0;
      target.total = 0;
      target.truncated = false;
      return { data, truncated };
    };

    const argvForSpawn = (req: SpawnRequest): string[] => {
      const prog = req.prog.includes('/') ? req.prog : resolveExecutablePathForVfs(vfs, req.prog);
      return [prog, ...req.args];
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
      buildWasiHost: (pid, argv, env, cwd) =>
        new WasiHost({
          vfs,
          args: argv,
          env,
          preopens: { '/': '/' },
          cwd,
          ioFds: kernel.getFdTable(pid),
          kernel,
          pid,
        }),
      buildKernelImports: (pid, memory, _wasiHost, threadsBackend) =>
        createKernelImports({
          memory,
          callerPid: pid,
          kernel,
          vfs,
          networkBridge: this.networkBridge,
          extensionHandler: this.extensionHandler,
          nativeModules: mgr.nativeModules,
          threadsBackend,
          runCommand: async (cmd, stdin) => {
            const result = await this.runInFreshBootProcess(
              cmd,
              stdin ? new TextEncoder().encode(stdin) : undefined,
            );
            return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
          },
          spawnProcess: (req, fdTable) => {
            const childPid = kernel.allocPid(pid, req.prog);
            const childCwd = req.cwd || kernel.getCwd(pid);
            kernel.setCwd(childPid, childCwd);
            kernel.registerPending(childPid, req.prog);
            kernel.adoptFdTable(childPid, fdTable);
            const argv = argvForSpawn(req);
            const childCtx = makeContextWithAllocator(() => childPid);
            loadProcess(childCtx, {
              argv,
              mode: 'cli',
              env: Object.fromEntries(req.env),
              cwd: childCwd,
              stdoutLimit: this.stdoutLimit,
              stderrLimit: this.stderrLimit,
            }).then(async (proc) => {
              processes.set(childPid, proc);
              await proc.terminate();
            }).catch((e) => {
              const msg = e instanceof Error ? e.message : String(e);
              const stderr = kernel.getFdTarget(childPid, 2);
              const data = new TextEncoder().encode(`${req.prog}: ${msg}\n`);
              if (stderr?.type === 'buffer') {
                stderr.buf.push(data);
                stderr.total += data.byteLength;
              } else if (stderr?.type === 'pipe_write') {
                stderr.pipe.write(data);
              }
              kernel.releaseProcess(childPid, 127);
            });
            return childPid;
          },
        }),
      makeFdReadAndClear,
    });

    return makeContextWithAllocator((argv) => kernel.allocPid(INIT_PID, argv[0]));
  }
}

function resolveExecutablePathForVfs(vfs: VfsProxy, prog: string): string {
  for (const dir of ['/usr/extensions', '/usr/bin', '/bin']) {
    const path = `${dir}/${prog}`;
    try {
      const st = vfs.stat(path);
      if (st.type === 'file' && (st.permissions & 0o111)) return path;
    } catch {
      // Try next PATH entry.
    }
  }
  return prog;
}

let runner: WorkerResidentRunner | null = null;

parentPort.on('message', async (msg: InitMessage | RunMessage) => {
  if (msg.type === 'init') {
    const { sab, toolRegistry } = msg;

    const { NodeAdapter } = await import('../platform/node-adapter.js');
    const adapter = new NodeAdapter();

    const vfs = new VfsProxy(sab, { parentPort: parentPort! });

    // Set up network bridge client if SAB provided
    let networkBridge: import('../network/bridge.js').NetworkBridgeLike | undefined;
    let networkGateway: import('../network/gateway.js').NetworkGateway | undefined;
    if (msg.bridgeSab) {
      const { NetworkGateway } = await import('../network/gateway.js');
      const { BridgeClient } = await import('../network/bridge-client.js');
      if (msg.networkPolicy) {
        networkGateway = new NetworkGateway(msg.networkPolicy);
      }
      networkBridge = new BridgeClient(msg.bridgeSab, networkGateway);
    }

    const mgr = new ProcessManager(vfs, adapter, networkBridge, msg.toolAllowlist);

    for (const [name, path] of toolRegistry) {
      mgr.registerTool(name, path);
    }

    // Set up extension handler proxy: worker blocks on Atomics.wait while
    // main thread runs the async extension handler, then notifies.
    let extensionProxy: ((cmd: Record<string, unknown>) => Record<string, unknown>) | undefined;
    if (msg.hasExtensions) {
      const extInt32 = new Int32Array(sab);
      extensionProxy = (cmd: Record<string, unknown>): Record<string, unknown> => {
        encodeRequest(sab, { op: 'extensionInvoke', ...cmd });
        Atomics.store(extInt32, 0, STATUS_REQUEST);
        parentPort!.postMessage('proxy-request');
        Atomics.wait(extInt32, 0, STATUS_REQUEST);
        const status = Atomics.load(extInt32, 0);
        const resp = decodeResponse(sab);
        Atomics.store(extInt32, 0, 0); // STATUS_IDLE
        if (status === STATUS_ERROR) {
          return { ok: false, error: resp.metadata.message ?? 'error' };
        }
        return resp.metadata as Record<string, unknown>;
      };
      mgr.setExtensionHandler(extensionProxy);
    }

    runner = new WorkerResidentRunner(vfs, adapter, mgr, networkBridge, extensionProxy);
    await runner.boot(['/bin/bash'], msg.stdoutBytes, msg.stderrBytes);

    if (msg.bridgeSab !== undefined) {
      runner.setEnv('PYTHONPATH', '/usr/lib/python');
    }

    parentPort!.postMessage({ type: 'ready' });
    return;
  }

  if (msg.type === 'run') {
    if (!runner) {
      parentPort!.postMessage({
        type: 'result',
        result: { exitCode: 1, stdout: '', stderr: 'Worker not initialized\n', executionTimeMs: 0 },
      });
      return;
    }

    // Apply env vars from main thread
    for (const [k, v] of msg.env) {
      runner.setEnv(k, v);
    }

    // Apply output limits if provided
    if (msg.stdoutLimit !== undefined || msg.stderrLimit !== undefined) {
      runner.setOutputLimits(msg.stdoutLimit, msg.stderrLimit);
    }

    // Set deadline for cooperative cancellation
    if (msg.timeoutMs !== undefined) {
      runner.resetCancel(msg.timeoutMs);
    }

    try {
      const result = await runner.run(msg.command);
      const envMap = runner.getEnvMap();
      parentPort!.postMessage({
        type: 'result',
        result,
        env: Array.from(envMap.entries()),
      });
    } catch (err) {
      if (err instanceof CancelledError) {
        parentPort!.postMessage({
          type: 'result',
          result: {
            exitCode: 124,
            stdout: '',
            stderr: `command ${err.reason.toLowerCase()}\n`,
            executionTimeMs: 0,
            errorClass: err.reason,
          },
        });
      } else {
        parentPort!.postMessage({
          type: 'result',
          result: {
            exitCode: 1,
            stdout: '',
            stderr: `Worker execution error: ${(err as Error).message}\n`,
            executionTimeMs: 0,
          },
        });
      }
    }
  }
});
