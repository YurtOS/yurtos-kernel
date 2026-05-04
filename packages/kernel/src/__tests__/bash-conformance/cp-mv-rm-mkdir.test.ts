/**
 * Conformance tests for cp, mv, rm, mkdir, rmdir, touch, ln — file manipulation.
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
  'cat', 'echo', 'printf', 'cp', 'mv', 'rm', 'mkdir', 'rmdir',
  'touch', 'ln', 'readlink', 'ls', 'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('cp/mv/rm/mkdir conformance', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    const adapter = new NodeAdapter();
    vfs = new VFS();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
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
  // cp
  // ---------------------------------------------------------------------------
  describe('cp', () => {
    it('copies a file', async () => {
      writeFile('/tmp/src.txt', 'data\n');
      const r = await runner.run('cp /tmp/src.txt /tmp/dst.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/dst.txt');
      expect(r2.stdout).toBe('data\n');
    });

    it('preserves content exactly', async () => {
      writeFile('/tmp/orig.txt', 'line1\nline2\nline3\n');
      await runner.run('cp /tmp/orig.txt /tmp/copy.txt');
      const r = await runner.run('cat /tmp/copy.txt');
      expect(r.stdout).toBe('line1\nline2\nline3\n');
    });

    it('-r copies a directory recursively', async () => {
      await runner.run('mkdir -p /tmp/d1');
      writeFile('/tmp/d1/f.txt', 'inside\n');
      const r = await runner.run('cp -r /tmp/d1 /tmp/d2');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/d2/f.txt');
      expect(r2.stdout).toBe('inside\n');
    });
  });

  // ---------------------------------------------------------------------------
  // mv
  // ---------------------------------------------------------------------------
  describe('mv', () => {
    it('renames a file', async () => {
      writeFile('/tmp/old.txt', 'content\n');
      const r = await runner.run('mv /tmp/old.txt /tmp/new.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/new.txt');
      expect(r2.stdout).toBe('content\n');
    });

    it('source does not exist after mv', async () => {
      writeFile('/tmp/a.txt', 'x\n');
      await runner.run('mv /tmp/a.txt /tmp/b.txt');
      const r = await runner.run('cat /tmp/a.txt');
      expect(r.exitCode).not.toBe(0);
    });

    it('moves file into directory', async () => {
      await runner.run('mkdir /tmp/dir');
      writeFile('/tmp/f.txt', 'hello\n');
      const r = await runner.run('mv /tmp/f.txt /tmp/dir/');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/dir/f.txt');
      expect(r2.stdout).toBe('hello\n');
    });
  });

  // ---------------------------------------------------------------------------
  // rm
  // ---------------------------------------------------------------------------
  describe('rm', () => {
    it('removes a file', async () => {
      writeFile('/tmp/f.txt', 'bye\n');
      const r = await runner.run('rm /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/f.txt');
      expect(r2.exitCode).not.toBe(0);
    });

    it('-r removes a directory', async () => {
      await runner.run('mkdir -p /tmp/d/sub');
      writeFile('/tmp/d/sub/f.txt', 'x');
      const r = await runner.run('rm -r /tmp/d');
      expect(r.exitCode).toBe(0);
    });

    it('-f no error on nonexistent file', async () => {
      const r = await runner.run('rm -f /tmp/nonexistent');
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // mkdir
  // ---------------------------------------------------------------------------
  describe('mkdir', () => {
    it('creates a directory', async () => {
      const r = await runner.run('mkdir /tmp/newdir');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('ls /tmp/newdir');
      expect(r2.exitCode).toBe(0);
    });

    it('-p creates nested directories', async () => {
      const r = await runner.run('mkdir -p /tmp/a/b/c');
      expect(r.exitCode).toBe(0);
      writeFile('/tmp/a/b/c/f.txt', 'deep\n');
      const r2 = await runner.run('cat /tmp/a/b/c/f.txt');
      expect(r2.stdout).toBe('deep\n');
    });
  });

  // ---------------------------------------------------------------------------
  // rmdir
  // ---------------------------------------------------------------------------
  describe('rmdir', () => {
    it('removes an empty directory', async () => {
      await runner.run('mkdir /tmp/empty');
      const r = await runner.run('rmdir /tmp/empty');
      expect(r.exitCode).toBe(0);
    });

    it('fails on non-empty directory', async () => {
      await runner.run('mkdir /tmp/notempty');
      writeFile('/tmp/notempty/f.txt', 'x');
      const r = await runner.run('rmdir /tmp/notempty');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // touch
  // ---------------------------------------------------------------------------
  describe('touch', () => {
    it('creates a new empty file', async () => {
      const r = await runner.run('touch /tmp/new.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/new.txt');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toBe('');
    });

    it('does not change content of existing file', async () => {
      writeFile('/tmp/existing.txt', 'keep\n');
      await runner.run('touch /tmp/existing.txt');
      const r = await runner.run('cat /tmp/existing.txt');
      expect(r.stdout).toBe('keep\n');
    });
  });

  // ---------------------------------------------------------------------------
  // ln / readlink
  // ---------------------------------------------------------------------------
  describe('ln', () => {
    it('creates a symbolic link', async () => {
      writeFile('/tmp/target.txt', 'linked\n');
      const r = await runner.run('ln -s /tmp/target.txt /tmp/link.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/link.txt');
      expect(r2.stdout).toBe('linked\n');
    });

    it('symlink content matches target', async () => {
      writeFile('/tmp/t.txt', 'linked data\n');
      await runner.run('ln -s /tmp/t.txt /tmp/l.txt');
      const r = await runner.run('cat /tmp/l.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('linked data\n');
    });
  });
});
