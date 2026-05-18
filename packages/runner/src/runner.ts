// Runner — drives the Rust/WASM kernel through the thin TypeScript h/k
// interface (kernel-host-interface-js). Replaces the old TS-kernel `Sandbox`
// for the Deno/browser side: there is no TS syscall fallback, the Rust
// kernel is the sole authority.

import {
  defaultHostState,
  type HostState,
  KernelHostInterface,
  s,
} from "@yurt/kernel-host-interface-js";
import type { RunResult } from "./run-result.ts";
import { type MountConfig, stageImage, stageMounts } from "./vfs-stage.ts";
import { pumpToCompletion } from "./process-pump.ts";
import { decode, encode } from "./stdio.ts";

export type { MountConfig } from "./vfs-stage.ts";
export type { RunResult } from "./run-result.ts";

export interface RunnerOptions {
  /** Bytes of `yurt_kernel_wasm.wasm` (the caller reads the artifact). */
  kernelWasm: Uint8Array;
  /** Host capabilities (real fs/net/kv); defaults to the portable in-memory state. */
  hostState?: HostState;
  /** Files staged into the kernel ramfs before any guest runs. */
  mounts?: MountConfig[];
  /** A .yurtimg path/bytes (or raw tar bytes) staged as the base root. */
  image?: string | Uint8Array;
  imageCacheDir?: string;
}

export interface RunArgvOptions {
  stdin?: Uint8Array | string;
}

export class Runner {
  private constructor(
    private readonly mk: KernelHostInterface,
    private readonly files: Map<string, Uint8Array>,
  ) {}

  static async create(opts: RunnerOptions): Promise<Runner> {
    const mk = await KernelHostInterface.load(
      opts.kernelWasm,
      opts.hostState ?? defaultHostState(),
    );
    const files = new Map<string, Uint8Array>();
    await stageImage(mk, opts.image, opts.imageCacheDir, files);
    stageMounts(mk, opts.mounts, files);
    return new Runner(mk, files);
  }

  /** Run `argv` (argv[0] is the program path, resolved by the kernel). */
  runArgv(argv: string[], opts: RunArgvOptions = {}): RunResult {
    if (argv.length === 0) throw new Error("runArgv: empty argv");
    const programBytes = this.files.get(argv[0]);
    if (programBytes === undefined) {
      throw new Error(
        `runArgv: program ${argv[0]} not staged — pass it via mounts, ` +
          `image, or writeFile() before runArgv()`,
      );
    }
    const stdin = opts.stdin === undefined
      ? undefined
      : typeof opts.stdin === "string"
      ? encode(opts.stdin)
      : opts.stdin;

    const start = performance.now();
    const user = stdin === undefined
      ? this.mk.spawnUserProcessWithArgs(programBytes, argv.map(s))
      : this.mk.spawnUserProcessWithArgsAndStdin(
        programBytes,
        argv.map(s),
        stdin,
        true,
      );
    const { exitCode } = pumpToCompletion(this.mk, user);
    const stdout = decode(user.capturedStdout());
    const stderr = decode(user.capturedStderr());
    return {
      exitCode,
      stdout,
      stderr,
      executionTimeMs: performance.now() - start,
    };
  }

  /** Convenience: run a single command line through the shell-exec entry. */
  run(commandLine: string, opts: RunArgvOptions = {}): RunResult {
    return this.runArgv(
      ["/bin/yurt-shell-exec", "-c", commandLine],
      opts,
    );
  }

  writeFile(path: string, bytes: Uint8Array): void {
    this.mk.registerRamfsFile(s(path), bytes);
    this.files.set(path, bytes);
  }

  readFile(path: string): Uint8Array {
    const bytes = this.files.get(path);
    if (bytes === undefined) throw new Error(`readFile: ${path} not staged`);
    return bytes;
  }

  destroy(): void {
    // KernelHostInterface holds no OS handles in the portable path; the
    // instance is reclaimed by GC. Method kept for API symmetry with the
    // old Sandbox and for future real-IO host states.
  }
}
