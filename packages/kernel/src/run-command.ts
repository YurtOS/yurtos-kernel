import type { Sandbox } from './sandbox.js';

export interface RunRequest {
  cmd: string;
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
}

export interface RunResponse {
  exit_code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandContext {
  sandbox: Sandbox;
}

export type RunCommandHandler = (
  req: RunRequest,
  ctx: RunCommandContext,
) => Promise<RunResponse>;
