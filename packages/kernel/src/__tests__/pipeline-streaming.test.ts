/**
 * Integration tests for streaming pipelines.
 *
 * These tests verify end-to-end pipeline execution through the Sandbox API.
 * The streaming pipeline path uses pipe/spawn_async/waitpid to connect
 * pipeline stages with real pipes and concurrent WASM execution via JSPI.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

describe('Streaming Pipelines', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('simple pipeline: echo | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('multi-stage pipeline: echo | grep | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo "hello world" | grep hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('builtin-only pipeline: echo | echo', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello | echo world');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('world');
  });

  it('pipeline produces correct output on repeated runs', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const r1 = await sandbox.run('echo first | grep first');
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout.trim()).toBe('first');

    const r2 = await sandbox.run('echo second | grep second');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout.trim()).toBe('second');
  });

  it('external-only pipeline: seq | head captures output', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('seq 1 5 | head -n 3');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('1\n2\n3');
  });

  it('builtin to external: echo | wc -w', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello world | wc -w');
    expect(result.exitCode).toBe(0);
    // Must return wc output ("2"), not echo output ("hello world")
    expect(result.stdout.trim()).toBe('2');
  });

  it('file content piped to external: cat | wc -l', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/lines.txt', new TextEncoder().encode('aaa\nbbb\nccc\n'));
    const result = await sandbox.run('cat /tmp/lines.txt | wc -l');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('3');
  });

  it('4-stage pipeline: echo | cat | grep | cat', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo "hello world" | cat | grep hello | cat');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello world');
  });

  it('5-stage pipeline: seq | head | cat | grep | wc', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('seq 1 10 | head -n 5 | cat | grep -E "^[0-9]" | wc -l');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('5');
  });

  it('3+ stage with while read loop', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo -e "a\\nb\\nc" | cat | while read line; do echo "got:$line"; done');
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toEqual(['got:a', 'got:b', 'got:c']);
  });

  it('non-pipeline commands still work (regression)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const echo = await sandbox.run('echo hello');
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout.trim()).toBe('hello');

    const env = await sandbox.run('export FOO=bar && echo $FOO');
    expect(env.stdout.trim()).toBe('bar');
  });

  it('non-pipeline external command works (regression)', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('file content'));
    const result = await sandbox.run('cat /tmp/data.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('file content');
  });
});
