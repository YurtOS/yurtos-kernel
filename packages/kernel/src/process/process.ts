/**
 * Types and helpers for spawning Wasm "processes" in the sandbox.
 *
 * A process is a single execution of a compiled .wasm module with its
 * own WasiHost, file descriptor table, args, and environment. The
 * ProcessManager (manager.ts) orchestrates creation and teardown.
 */

export interface SpawnOptions {
  args: string[];
  env: Record<string, string>;
  stdin?: { read(buf: Uint8Array): number };
  stdinData?: Uint8Array;
  cwd?: string;
  stdoutLimit?: number;
  stderrLimit?: number;
  deadlineMs?: number;
  memoryBytes?: number;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
}
