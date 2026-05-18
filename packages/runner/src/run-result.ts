import type { ErrorClass } from './security.js';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  truncated?: { stdout: boolean; stderr: boolean };
  errorClass?: ErrorClass;
}

export const EMPTY_RESULT: RunResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  executionTimeMs: 0,
};
