/**
 * Conformance tests for gzip, gunzip, tar, zip, unzip — compression/archiving.
 */
import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';

import { ResidentBashRunner } from '../../resident-bash-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures');
const SHELL_EXEC_WASM = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures/yurt-shell-exec.wasm');

const TOOLS = [
  'cat', 'echo', 'printf', 'gzip', 'tar', 'zip', 'unzip',
  'ls', 'mkdir', 'rm', 'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

describe('gzip/tar/zip conformance', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    const adapter = new NodeAdapter();
    vfs = new VFS();
    const mgr = new ProcessManager(vfs, adapter);
    // Also register gunzip alias
    for (const tool of [...TOOLS, 'gunzip']) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }
    await mgr.preloadModules();
    runner = await ResidentBashRunner.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
    });
  });

  function writeFile(path: string, content: string) {
    vfs.writeFile(path, new TextEncoder().encode(content));
  }

  // ---------------------------------------------------------------------------
  // gzip / gunzip
  // ---------------------------------------------------------------------------
  describe('gzip', () => {
    it('compresses a file and creates .gz', async () => {
      writeFile('/tmp/f.txt', 'hello world\n');
      const r = await runner.run('gzip /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('ls /tmp/f.txt.gz');
      expect(r2.exitCode).toBe(0);
    });

    it('gzip -k keeps original file', async () => {
      writeFile('/tmp/f.txt', 'data\n');
      const r = await runner.run('gzip -k /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      // Original should still exist
      const r2 = await runner.run('cat /tmp/f.txt');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toBe('data\n');
    });

    it('roundtrip preserves content', async () => {
      writeFile('/tmp/f.txt', 'preserve me\n');
      await runner.run('gzip /tmp/f.txt');
      await runner.run('gunzip /tmp/f.txt.gz');
      const r = await runner.run('cat /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('preserve me\n');
    });
  });

  // ---------------------------------------------------------------------------
  // tar
  // ---------------------------------------------------------------------------
  describe('tar', () => {
    it('creates and lists archive', async () => {
      writeFile('/tmp/a.txt', 'aaa\n');
      writeFile('/tmp/b.txt', 'bbb\n');
      const r = await runner.run('tar -cf /tmp/out.tar /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('tar -tf /tmp/out.tar');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toContain('a.txt');
      expect(r2.stdout).toContain('b.txt');
    });

    it('extracts archive and preserves content', async () => {
      writeFile('/tmp/f.txt', 'content\n');
      await runner.run('tar -cf /tmp/out.tar /tmp/f.txt');
      await runner.run('rm /tmp/f.txt');
      const r = await runner.run('tar -xf /tmp/out.tar');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/f.txt');
      expect(r2.stdout).toBe('content\n');
    });
  });

  // ---------------------------------------------------------------------------
  // zip / unzip
  // ---------------------------------------------------------------------------
  describe('zip/unzip', () => {
    it('creates and lists archive', async () => {
      writeFile('/tmp/a.txt', 'aaa\n');
      const r = await runner.run('zip /tmp/out.zip /tmp/a.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('unzip -l /tmp/out.zip');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toContain('a.txt');
    });

    it('roundtrip preserves content', async () => {
      writeFile('/tmp/f.txt', 'zip me\n');
      await runner.run('zip /tmp/out.zip /tmp/f.txt');
      await runner.run('rm /tmp/f.txt');
      await runner.run('mkdir -p /tmp/ext');
      const r = await runner.run('unzip -o /tmp/out.zip -d /tmp/ext');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/ext/tmp/f.txt');
      expect(r2.stdout).toBe('zip me\n');
    });
  });
});
