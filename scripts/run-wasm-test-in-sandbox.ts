#!/usr/bin/env -S deno run -A
import { basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Sandbox } from '../packages/orchestrator/src/sandbox.ts';
import { NodeAdapter } from '../packages/orchestrator/src/platform/node-adapter.ts';

const [wasmPathArg, ...testArgs] = Deno.args;
if (!wasmPathArg) {
  console.error('Usage: run-wasm-test-in-sandbox.ts <test.wasm> [test-args...]');
  Deno.exit(2);
}

const repoRoot = resolve(import.meta.dirname!, '..');
const wasmDir = resolve(repoRoot, 'packages/orchestrator/src/platform/__tests__/fixtures');
const adapter = new NodeAdapter();
const sandbox = await Sandbox.create({
  wasmDir,
  adapter,
  timeoutMs: 30_000,
  fsLimitBytes: 768 * 1024 * 1024,
});

try {
  const wasmPath = resolve(wasmPathArg);
  const guestPath = `/tmp/${basename(wasmPath)}`;
  sandbox.writeFile(guestPath, new Uint8Array(readFileSync(wasmPath)));

  const proc = await sandbox.spawn([guestPath, ...testArgs], {
    mode: 'cli',
    env: {
      RUST_TEST_THREADS: '1',
      RAYON_NUM_THREADS: Deno.env.get('RAYON_NUM_THREADS') ?? '1',
    },
  });

  const stdout = proc.fdReadAndClear(1);
  const stderr = proc.fdReadAndClear(2);
  if (stdout.data) await Deno.stdout.write(new TextEncoder().encode(stdout.data));
  if (stderr.data) await Deno.stderr.write(new TextEncoder().encode(stderr.data));
  Deno.exit(proc.exitCode ?? 1);
} finally {
  sandbox.destroy();
}
