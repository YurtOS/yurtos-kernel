import type { RunResult } from './run-result.js';
import type { Process } from './process/handle.js';

export interface RunnerStreamCallbacks {
  onStdout?: (data: Uint8Array) => void;
  onStderr?: (data: Uint8Array) => void;
}

export interface CommandRunner {
  run(command: string, options?: { stdinData?: Uint8Array }): Promise<RunResult>;

  setOutputCallbacks?(callbacks: RunnerStreamCallbacks | null): void;

  getEnv(name: string): string | undefined;
  setEnv(name: string, value: string): void;
  getEnvMap(): Map<string, string>;
  setEnvMap(env: Map<string, string>): void;

  cancel(reason: string): void;
  setDeadlineNow(): void;
  resetCancel(deadlineMs: number): void;

  destroy?(): void;
}

export interface ResidentCommandRunner extends CommandRunner {
  readonly process: Process;
  setOutputLimits(stdoutBytes?: number, stderrBytes?: number): void;
}
