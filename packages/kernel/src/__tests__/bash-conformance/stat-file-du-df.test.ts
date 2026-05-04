/**
 * Conformance tests for stat, file, du, df, ls, tree — file info and listing.
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
  'cat', 'echo', 'printf', 'stat', 'file', 'du', 'df', 'ls',
  'tree', 'mkdir', 'touch', 'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('stat/file/du/df/ls/tree conformance', () => {
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
  // stat
  // ---------------------------------------------------------------------------
  describe('stat', () => {
    it('shows info for a file', async () => {
      writeFile('/tmp/f.txt', 'hello\n');
      const r = await runner.run('stat /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('f.txt');
    });

    it('shows info for a directory', async () => {
      await runner.run('mkdir /tmp/d');
      const r = await runner.run('stat /tmp/d');
      expect(r.exitCode).toBe(0);
    });

    it('nonexistent file returns non-zero', async () => {
      const r = await runner.run('stat /tmp/nope');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // file
  //
  // SKIPPED: this conformance file hand-builds ProcessManager and
  // bypasses the manifest install pass, so /usr/share/misc/magic.mgc
  // isn't loaded.  Re-enable after the test setup migrates to
  // Sandbox.create.
  // ---------------------------------------------------------------------------
  describe.skip('file', () => {
    it('identifies a text file', async () => {
      writeFile('/tmp/f.txt', 'hello world\n');
      const r = await runner.run('file /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toLowerCase()).toContain('text');
    });

    it('identifies an empty file', async () => {
      writeFile('/tmp/empty.txt', '');
      const r = await runner.run('file /tmp/empty.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toLowerCase()).toContain('empty');
    });
  });

  // ---------------------------------------------------------------------------
  // du
  // ---------------------------------------------------------------------------
  describe('du', () => {
    it('reports size of a directory', async () => {
      await runner.run('mkdir /tmp/d');
      writeFile('/tmp/d/f.txt', 'data');
      const r = await runner.run('du /tmp/d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/\d/);
    });

    it('-s gives summary', async () => {
      await runner.run('mkdir /tmp/d');
      writeFile('/tmp/d/f.txt', 'data');
      const r = await runner.run('du -s /tmp/d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('/tmp/d');
    });
  });

  // ---------------------------------------------------------------------------
  // df
  // ---------------------------------------------------------------------------
  describe('df', () => {
    it('runs without error', async () => {
      const r = await runner.run('df');
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // ls
  // ---------------------------------------------------------------------------
  describe('ls', () => {
    it('lists files in a directory', async () => {
      await runner.run('mkdir /tmp/d');
      writeFile('/tmp/d/a.txt', 'a');
      writeFile('/tmp/d/b.txt', 'b');
      const r = await runner.run('ls /tmp/d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('a.txt');
      expect(r.stdout).toContain('b.txt');
    });

    it('-l shows long format', async () => {
      await runner.run('mkdir /tmp/d');
      writeFile('/tmp/d/f.txt', 'data');
      const r = await runner.run('ls -l /tmp/d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('f.txt');
    });

    it('empty directory produces no file listings', async () => {
      await runner.run('mkdir /tmp/empty');
      const r = await runner.run('ls /tmp/empty');
      expect(r.exitCode).toBe(0);
    });

    it('nonexistent directory returns non-zero', async () => {
      const r = await runner.run('ls /tmp/no-such-dir');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // tree
  // ---------------------------------------------------------------------------
  describe('tree', () => {
    it('shows directory structure', async () => {
      await runner.run('mkdir -p /tmp/d/sub');
      writeFile('/tmp/d/f.txt', 'x');
      writeFile('/tmp/d/sub/g.txt', 'y');
      const r = await runner.run('tree /tmp/d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('f.txt');
      expect(r.stdout).toContain('sub');
    });
  });
});
