/**
 * Pipeline execution for wiring multiple commands together.
 *
 * A pipeline connects the stdout of each stage to the stdin of the next,
 * like a shell pipeline: `echo hello | cat | wc -c`. Stages run
 * sequentially (v1); concurrent execution can be added later.
 */

import type { ProcessManager } from './manager.js';
import type { SpawnResult } from './process.js';

export interface PipelineStage {
  cmd: string;
  args: string[];
}

export interface PipelineResult extends SpawnResult {
  /** Total wall-clock time across all stages. */
  executionTimeMs: number;
}

const EMPTY_RESULT: PipelineResult = {
  exitCode: 0,
  stdout: '',
  stderr: '',
  executionTimeMs: 0,
};

export class Pipeline {
  private mgr: ProcessManager;

  constructor(mgr: ProcessManager) {
    this.mgr = mgr;
  }

  /**
   * Run a sequence of stages, piping each stage's stdout as the next
   * stage's stdin. Returns the final stage's result with total elapsed time.
   */
  async run(stages: PipelineStage[]): Promise<PipelineResult> {
    if (stages.length === 0) {
      return EMPTY_RESULT;
    }

    const startTime = performance.now();
    let stdinData: Uint8Array | undefined;
    let lastResult: SpawnResult | undefined;
    const encoder = new TextEncoder();

    for (const stage of stages) {
      lastResult = await this.mgr.spawn(stage.cmd, {
        args: stage.args,
        env: {},
        stdinData,
      });

      // Encode this stage's stdout as bytes for the next stage's stdin
      stdinData = encoder.encode(lastResult.stdout);
    }

    return {
      ...lastResult!,
      executionTimeMs: performance.now() - startTime,
    };
  }
}
