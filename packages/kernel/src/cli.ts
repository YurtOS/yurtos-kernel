#!/usr/bin/env node
/**
 * yurt CLI — interactive shell running entirely in the WASM sandbox.
 */

import { createInterface } from 'node:readline';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { writeFile } from 'node:fs/promises';

import { NodeAdapter } from './platform/node-adapter.js';
import { Sandbox } from './sandbox.js';
import { YurtImageBuilder } from './image-builder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = resolve(__dirname, 'platform/__tests__/fixtures');

type ImageBuildOp =
  | { kind: 'copy'; hostPath: string; vfsPath: string }
  | { kind: 'chmod'; path: string; mode: number }
  | { kind: 'chown'; path: string; uid: number; gid: number }
  | { kind: 'rm'; path: string };

interface ImageBuildArgs {
  empty: boolean;
  baseImage?: string;
  outputPath: string;
  ops: ImageBuildOp[];
  runArgv?: string[];
}

async function main() {
  if (process.argv[2] === 'image' && process.argv[3] === 'build') {
    await runImageBuild(process.argv.slice(4));
    return;
  }

  const adapter = new NodeAdapter();
  const [, , imageArg, ...commandArgv] = process.argv;
  if (imageArg && imageArg.endsWith('.yurtimg')) {
    const sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter,
      image: imageArg,
      imageCacheDir: process.env.YURT_IMAGE_CACHE_DIR ??
        join(tmpdir(), 'yurt-image-cache'),
      bootArgv: ['/bin/true'],
    });
    sandbox.setEnv('HOME', '/home/user');
    sandbox.setEnv('PWD', '/home/user');
    sandbox.setEnv('USER', 'user');
    sandbox.setEnv('PATH', '/bin:/usr/bin');

    try {
      const argv = commandArgv.length > 0 ? commandArgv : ['/bin/sh'];
      if (commandArgv.length === 0) {
        try {
          sandbox.stat('/bin/sh');
        } catch {
          process.stderr.write('no command provided and /bin/sh is not present in image\n');
          process.exitCode = 127;
          return;
        }
      }
      const result = await sandbox.runArgv(argv);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
      return;
    } finally {
      sandbox.destroy();
    }
  }

  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter,
  });
  sandbox.setEnv('HOME', '/home/user');
  sandbox.setEnv('PWD', '/home/user');
  sandbox.setEnv('USER', 'user');
  sandbox.setEnv('PATH', '/bin:/usr/bin');

  // Handle -c flag: run single command and exit
  const cIndex = process.argv.indexOf('-c');
  if (cIndex !== -1 && cIndex + 1 < process.argv.length) {
    const cmd = process.argv[cIndex + 1];
    const result = await sandbox.run(cmd);
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
        const result = await sandbox.run(cmd);
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

async function runImageBuild(args: string[]): Promise<void> {
  let parsed: ImageBuildArgs;
  try {
    parsed = parseImageBuildArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 2;
    return;
  }

  const adapter = new NodeAdapter();
  const builder = parsed.empty
    ? await YurtImageBuilder.empty({ wasmDir: FIXTURES, adapter })
    : await YurtImageBuilder.create({
      wasmDir: FIXTURES,
      adapter,
      baseImage: parsed.baseImage,
      imageCacheDir: process.env.YURT_IMAGE_CACHE_DIR ??
        join(tmpdir(), 'yurt-image-cache'),
    });

  try {
    for (const op of parsed.ops) {
      if (op.kind === 'copy') {
        await builder.copyIn(op.hostPath, op.vfsPath);
      } else if (op.kind === 'chmod') {
        builder.chmod(op.path, op.mode);
      } else if (op.kind === 'chown') {
        builder.chown(op.path, op.uid, op.gid);
      } else {
        builder.remove(op.path);
      }
    }

    let runExitCode = 0;
    if (parsed.runArgv) {
      const result = await builder.run(parsed.runArgv);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      runExitCode = result.exitCode;
    }

    await writeFile(parsed.outputPath, await builder.exportImage());
    process.exitCode = runExitCode;
  } finally {
    builder.destroy();
  }
}

function parseImageBuildArgs(args: string[]): ImageBuildArgs {
  let empty = false;
  let outputPath: string | undefined;
  let baseImage: string | undefined;
  let runArgv: string[] | undefined;
  const ops: ImageBuildOp[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--empty') {
      empty = true;
    } else if (arg === '-o' || arg === '--output') {
      outputPath = requiredValue(args, ++i, arg);
    } else if (arg === '--copy') {
      const { left, right } = splitPair(requiredValue(args, ++i, arg), ':', arg);
      assertAbsolute(right, arg);
      ops.push({ kind: 'copy', hostPath: left, vfsPath: right });
    } else if (arg === '--chmod') {
      const { left, right } = splitPair(requiredValue(args, ++i, arg), ':', arg);
      assertAbsolute(right, arg);
      ops.push({ kind: 'chmod', path: right, mode: parseMode(left) });
    } else if (arg === '--chown') {
      const value = requiredValue(args, ++i, arg);
      const first = value.indexOf(':');
      const second = value.indexOf(':', first + 1);
      if (first <= 0 || second <= first + 1 || second === value.length - 1) {
        throw new Error(`invalid ${arg}; expected uid:gid:/path`);
      }
      const path = value.slice(second + 1);
      assertAbsolute(path, arg);
      ops.push({
        kind: 'chown',
        uid: parseDecimal(value.slice(0, first), 'uid'),
        gid: parseDecimal(value.slice(first + 1, second), 'gid'),
        path,
      });
    } else if (arg === '--rm') {
      const path = requiredValue(args, ++i, arg);
      assertAbsolute(path, arg);
      ops.push({ kind: 'rm', path });
    } else if (arg === '--run') {
      runArgv = args.slice(i + 1);
      if (runArgv.length === 0) throw new Error('--run requires argv');
      break;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (baseImage === undefined) {
      baseImage = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (!outputPath) throw new Error('missing -o/--output');
  if (empty && baseImage) throw new Error('--empty cannot be combined with a base image');
  if (!empty && !baseImage) throw new Error('missing base image; pass --empty for an empty disk');

  return { empty, baseImage, outputPath, ops, runArgv };
}

function requiredValue(args: string[], index: number, option: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function splitPair(value: string, separator: string, option: string): {
  left: string;
  right: string;
} {
  const index = value.lastIndexOf(separator);
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`invalid ${option} value`);
  }
  return { left: value.slice(0, index), right: value.slice(index + 1) };
}

function parseMode(value: string): number {
  if (!/^[0-7]+$/.test(value)) throw new Error(`invalid mode: ${value}`);
  return parseInt(value, 8);
}

function parseDecimal(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`invalid ${label}: ${value}`);
  return Number(value);
}

function assertAbsolute(path: string, option: string): void {
  if (!path.startsWith('/')) throw new Error(`${option} path must be absolute`);
}

main();
