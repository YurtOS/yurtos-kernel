/**
 * Integration tests for streaming stdout/stderr callbacks on Sandbox.run().
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('Streaming output', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('onStdout fires with output chunks', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const chunks: string[] = [];
    const result = await sandbox.run('echo hello', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe('hello\n');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('onStderr fires separately from onStdout', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    // echo produces stdout; cat of nonexistent file produces stderr
    await sandbox.run('echo out; cat /nonexistent/file', {
      onStdout: (chunk) => stdoutChunks.push(chunk),
      onStderr: (chunk) => stderrChunks.push(chunk),
    });
    expect(stdoutChunks.join('')).toContain('out');
    expect(stderrChunks.join('')).toContain('No such file');
  });

  it('streamed chunks concatenated equal result.stdout', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const chunks: string[] = [];
    const result = await sandbox.run('for i in $(seq 1 5); do echo $i; done', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe(result.stdout);
  });

  it('no callbacks does not change behavior', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('pipeline output streams from final stage', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const chunks: string[] = [];
    const result = await sandbox.run('echo hello | cat', {
      onStdout: (chunk) => chunks.push(chunk),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join('')).toBe(result.stdout);
  });

  it('multiple runs reset callbacks properly', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const chunks1: string[] = [];
    await sandbox.run('echo first', {
      onStdout: (chunk) => chunks1.push(chunk),
    });

    const chunks2: string[] = [];
    await sandbox.run('echo second', {
      onStdout: (chunk) => chunks2.push(chunk),
    });

    // First run's callback should not fire during second run
    expect(chunks1.join('')).toBe('first\n');
    expect(chunks2.join('')).toBe('second\n');
  });
});
