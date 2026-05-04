/**
 * Process is the generic kernel-side handle for a running wasm process.
 *
 * Resident processes keep their wasm instance after _start completes and accept
 * later work through exported functions. callExport is single-flight per
 * process so exports on the same instance do not interleave.
 */

export type ProcessMode = 'cli' | 'resident';

export interface ProcessExports {
  readonly exports: Record<string, (...args: number[]) => unknown>;
}

export class Process {
  readonly pid: number;
  readonly mode: ProcessMode;
  exitCode: number | undefined;

  private inflight: Promise<unknown> = Promise.resolve();
  private exportsRef: ProcessExports | undefined;
  private memoryRef: WebAssembly.Memory | undefined;
  private fdReadAndClearImpl?: (fd: 1 | 2) => { data: string; truncated: boolean };
  private setStdinImpl?: (data: Uint8Array | undefined) => void;
  private terminateImpl?: () => Promise<void>;

  private constructor(opts: { pid: number; mode: ProcessMode }) {
    this.pid = opts.pid;
    this.mode = opts.mode;
  }

  get memory(): WebAssembly.Memory {
    if (!this.memoryRef) throw new Error(`Process ${this.pid} memory not yet bound`);
    return this.memoryRef;
  }

  get exports(): Record<string, (...args: number[]) => unknown> {
    if (!this.exportsRef) throw new Error(`Process ${this.pid} exports not yet bound`);
    return this.exportsRef.exports;
  }

  static __forLoader(opts: { pid: number; mode: ProcessMode }): Process {
    return new Process(opts);
  }

  static __forTesting(opts: { pid: number; mode: ProcessMode }): Process {
    return new Process(opts);
  }

  __setExports(refs: ProcessExports): void {
    this.exportsRef = refs;
  }

  __setMemory(mem: WebAssembly.Memory): void {
    this.memoryRef = mem;
  }

  __setFdReadAndClear(fn: (fd: 1 | 2) => { data: string; truncated: boolean }): void {
    this.fdReadAndClearImpl = fn;
  }

  __setStdin(fn: (data: Uint8Array | undefined) => void): void {
    this.setStdinImpl = fn;
  }

  setStdin(data: Uint8Array | undefined): void {
    if (!this.setStdinImpl) throw new Error(`Process ${this.pid} stdin not yet bound`);
    this.setStdinImpl(data);
  }

  fdReadAndClear(fd: 1 | 2): { data: string; truncated: boolean } {
    if (!this.fdReadAndClearImpl) throw new Error(`Process ${this.pid} fds not yet bound`);
    return this.fdReadAndClearImpl(fd);
  }

  async callExport(name: string, ...args: number[]): Promise<number> {
    const exports = this.exportsRef?.exports;
    if (!exports || !(name in exports)) {
      throw new Error(`no export named ${name}`);
    }

    const fn = exports[name];
    const next = this.inflight.then(() => fn(...args)) as Promise<number>;
    this.inflight = next.catch(() => {});
    return next;
  }

  async terminate(): Promise<void> {
    if (this.terminateImpl) await this.terminateImpl();
    this.exitCode ??= 0;
  }

  __setTerminate(fn: () => Promise<void>): void {
    this.terminateImpl = fn;
  }
}
