#!/usr/bin/env node
/**
 * yurt CLI — interactive shell running entirely in the WASM sandbox.
 */

import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NodeAdapter } from './platform/node-adapter.js';
import { Sandbox } from './sandbox.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const FIXTURES = resolve(__dirname, 'platform/__tests__/fixtures');

async function main() {
  const adapter = new NodeAdapter();
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

main();
