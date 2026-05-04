#!/usr/bin/env node
/**
 * yurt CLI — interactive shell running entirely in the WASM sandbox.
 */

import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeAdapter } from './platform/node-adapter.js';
import { Sandbox } from './sandbox.js';
import type { RunResult } from './run-result.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = resolve(__dirname, 'platform/__tests__/fixtures');
const SHELL_EXEC_WASM = resolve(__dirname, 'platform/__tests__/fixtures/yurt-shell-exec.wasm');
const RUN_COMMAND_METADATA_CAP = 1024 * 1024;

async function runPid1Bash(sandbox: Sandbox, cmd: string): Promise<RunResult> {
  const proc = sandbox.process(1);
  if (!proc) throw new Error('PID 1 is not running');

  const envPrefix = buildEnvPrefix(sandbox.getEnvMap());
  const command = envPrefix ? `${envPrefix}; ${cmd}` : cmd;
  const alloc = proc.exports.__alloc as ((size: number) => number) | undefined;
  const dealloc = proc.exports.__dealloc as ((ptr: number, size: number) => void) | undefined;
  if (!alloc || !dealloc) throw new Error('PID 1 does not export __alloc/__dealloc');

  const encoder = new TextEncoder();
  const cmdBytes = encoder.encode(command);
  const cmdPtr = alloc(cmdBytes.length);
  new Uint8Array(proc.memory.buffer, cmdPtr, cmdBytes.length).set(cmdBytes);

  const outPtr = alloc(RUN_COMMAND_METADATA_CAP);
  let decoded = '';
  try {
    const written = await proc.callExport('__run_command', cmdPtr, cmdBytes.length, outPtr, RUN_COMMAND_METADATA_CAP);
    if (written > RUN_COMMAND_METADATA_CAP) {
      throw new Error(`__run_command metadata exceeded ${RUN_COMMAND_METADATA_CAP} bytes`);
    }
    decoded = new TextDecoder().decode(new Uint8Array(proc.memory.buffer, outPtr, written));
  } finally {
    dealloc(cmdPtr, cmdBytes.length);
    dealloc(outPtr, RUN_COMMAND_METADATA_CAP);
  }

  let parsed: { exit_code?: number; execution_time_ms?: number; env?: Record<string, string> };
  try {
    parsed = JSON.parse(decoded);
  } catch {
    parsed = { exit_code: 0, execution_time_ms: 0 };
  }

  if (parsed.env) {
    sandbox.setEnvMap(new Map(Object.entries(parsed.env)));
  }

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

function buildEnvPrefix(env: Map<string, string>): string {
  if (env.size === 0) return '';
  const exports: string[] = [];
  for (const [name, value] of env) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
    exports.push(`export ${name}='${value.replace(/'/g, "'\\''")}'`);
  }
  return exports.join('; ');
}

async function main() {
  const adapter = new NodeAdapter();
  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter,
    shellExecWasmPath: SHELL_EXEC_WASM,
  });
  sandbox.setEnv('HOME', '/home/user');
  sandbox.setEnv('PWD', '/home/user');
  sandbox.setEnv('USER', 'user');
  sandbox.setEnv('PATH', '/bin:/usr/bin');

  // Handle -c flag: run single command and exit
  const cIndex = process.argv.indexOf('-c');
  if (cIndex !== -1 && cIndex + 1 < process.argv.length) {
    const cmd = process.argv[cIndex + 1];
    const result = await sandbox.executeCommand(cmd, (c) => runPid1Bash(sandbox, c), undefined, {
      allowWorkerExecutor: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    sandbox.destroy();
    process.exit(result.exitCode);
  }

  // Interactive REPL — queue lines so async handlers run sequentially
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'yurt$ ',
  });

  const queue: string[] = [];
  let processing = false;
  let closing = false;

  async function drain() {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const cmd = queue.shift()!.trim();
      if (!cmd) {
        rl.prompt();
        continue;
      }
      if (cmd === 'exit' || cmd === 'quit') {
        closing = true;
        break;
      }

      try {
        const result = await sandbox.executeCommand(cmd, (c) => runPid1Bash(sandbox, c), undefined, {
          allowWorkerExecutor: true,
        });
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`error: ${msg}\n`);
      }

      if (!closing) rl.prompt();
    }

    processing = false;
    if (closing) {
      rl.close();
    }
  }

  console.log('yurt — WASM sandbox shell');
  console.log('WASM tools + python3 available. Type "exit" to quit.\n');
  rl.prompt();

  rl.on('line', (line: string) => {
    queue.push(line);
    drain();
  });

  rl.on('close', () => {
    // Wait for any remaining commands to finish
    const waitAndExit = async () => {
      while (processing) {
        await new Promise(r => setTimeout(r, 10));
      }
      console.log('\nbye');
      sandbox.destroy();
      process.exit(0);
    };
    closing = true;
    waitAndExit();
  });
}

main();
