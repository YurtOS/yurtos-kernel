import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';

import { Pipeline } from '../pipeline.js';
import { ProcessManager } from '../manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname, '../../platform/__tests__/fixtures');

describe('Pipeline', () => {
  let vfs: VFS;
  let mgr: ProcessManager;
  let pipeline: Pipeline;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    mgr = new ProcessManager(vfs, adapter);
    mgr.registerTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'));
    mgr.registerTool('cat-stdin', resolve(FIXTURES, 'cat-stdin.wasm'));
    mgr.registerTool('wc-bytes', resolve(FIXTURES, 'wc-bytes.wasm'));
    pipeline = new Pipeline(mgr);
  });

  it('runs a single command', async () => {
    const result = await pipeline.run([
      { cmd: 'echo-args', args: ['hello'] },
    ]);
    expect(result.stdout).toBe('hello\n');
    expect(result.exitCode).toBe(0);
  });

  it('pipes stdout of one command to stdin of next', async () => {
    // echo-args "hello world" | wc-bytes
    // "hello world\n" = 12 bytes
    const result = await pipeline.run([
      { cmd: 'echo-args', args: ['hello world'] },
      { cmd: 'wc-bytes', args: [] },
    ]);
    expect(result.stdout.trim()).toBe('12');
  });

  it('chains three commands', async () => {
    // echo-args "data" | cat-stdin | cat-stdin
    const result = await pipeline.run([
      { cmd: 'echo-args', args: ['data'] },
      { cmd: 'cat-stdin', args: [] },
      { cmd: 'cat-stdin', args: [] },
    ]);
    expect(result.stdout).toBe('data\n');
  });

  it('returns exit code of last command', async () => {
    const result = await pipeline.run([
      { cmd: 'echo-args', args: ['test'] },
    ]);
    expect(result.exitCode).toBe(0);
  });

  it('provides execution time', async () => {
    const result = await pipeline.run([
      { cmd: 'echo-args', args: ['hello'] },
    ]);
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns empty result for zero stages', async () => {
    const result = await pipeline.run([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.executionTimeMs).toBe(0);
  });

  it('passes stdin data through cat-stdin', async () => {
    // cat-stdin alone with stdinData provided via spawn
    const stdinData = new TextEncoder().encode('piped input');
    const result = await mgr.spawn('cat-stdin', {
      args: [],
      env: {},
      stdinData,
    });
    expect(result.stdout).toBe('piped input');
    expect(result.exitCode).toBe(0);
  });
});
