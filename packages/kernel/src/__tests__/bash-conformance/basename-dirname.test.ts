/**
 * basename and dirname conformance tests.
 * Based on POSIX specification and busybox/GNU coreutils test patterns.
 *
 * basename covers:
 *   - Strip directory components from a path
 *   - Trailing slash handling
 *   - Optional suffix stripping (only when base.len() > suffix.len())
 *   - All-slash input → "/"
 *   - No-slash input → filename itself
 *
 * dirname covers:
 *   - Extract directory portion of a path
 *   - No slash → "."
 *   - Root slash → "/"
 *   - Trailing slash stripping before extraction
 *   - All-slash input → "/"
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
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'true', 'false',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr',
  'diff', 'du', 'df',
  'gzip', 'gunzip', 'tar',
  'bc', 'dc',
  'sqlite3',
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
  'rg',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

describe('basename and dirname', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }
    await mgr.preloadModules();
    runner = await ResidentBashRunner.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
    });
  });

  // ---------------------------------------------------------------------------
  // basename: basic path stripping
  // ---------------------------------------------------------------------------
  describe('basename path stripping', () => {
    it('strips directory from a deep path', async () => {
      const r = await runner.run('basename /path/to/file');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('file\n');
    });

    it('strips single directory component', async () => {
      const r = await runner.run('basename /usr/bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('bin\n');
    });

    it('file without directory component passes through', async () => {
      const r = await runner.run('basename file.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('file.txt\n');
    });

    it('strips trailing slash before extracting name', async () => {
      const r = await runner.run('basename /path/to/');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('to\n');
    });

    it('all-slash path returns "/"', async () => {
      const r = await runner.run('basename ///');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('/\n');
    });

    it('root path /file returns "file"', async () => {
      const r = await runner.run('basename /file');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('file\n');
    });
  });

  // ---------------------------------------------------------------------------
  // basename: suffix stripping
  // ---------------------------------------------------------------------------
  describe('basename suffix stripping', () => {
    it('strips .txt suffix from file.txt', async () => {
      const r = await runner.run('basename file.txt .txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('file\n');
    });

    it('strips suffix from deep path', async () => {
      const r = await runner.run('basename /path/to/script.sh .sh');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('script\n');
    });

    it('suffix not stripped when base equals suffix (not strictly longer)', async () => {
      // "foo" (3 chars) with suffix "foo" (3 chars): 3 > 3 is false → not stripped
      const r = await runner.run('basename foo foo');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo\n');
    });

    it('suffix not stripped when name does not end with it', async () => {
      const r = await runner.run('basename file.txt .sh');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('file.txt\n');
    });

    it('empty suffix has no effect', async () => {
      const r = await runner.run("basename file.txt ''");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('file.txt\n');
    });
  });

  // ---------------------------------------------------------------------------
  // dirname: directory extraction
  // ---------------------------------------------------------------------------
  describe('dirname path extraction', () => {
    it('extracts directory from a deep path', async () => {
      const r = await runner.run('dirname /path/to/file');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('/path/to\n');
    });

    it('file directly under root: returns "/"', async () => {
      const r = await runner.run('dirname /file');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('/\n');
    });

    it('no slash in path: returns "."', async () => {
      const r = await runner.run('dirname file');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('.\n');
    });

    it('all-slash path returns "/"', async () => {
      const r = await runner.run('dirname ///');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('/\n');
    });

    it('trailing slash stripped before extracting directory', async () => {
      // /path/to/ → strip trailing / → /path/to → dir = /path
      const r = await runner.run('dirname /path/to/');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('/path\n');
    });

    it('two-component path with no trailing slash', async () => {
      const r = await runner.run('dirname a/b');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\n');
    });

    it('three-component path', async () => {
      const r = await runner.run('dirname /usr/local/bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('/usr/local\n');
    });
  });

  // ---------------------------------------------------------------------------
  // basename and dirname used together
  // ---------------------------------------------------------------------------
  describe('combined usage', () => {
    it('basename then dirname on the same path', async () => {
      const r1 = await runner.run('basename /usr/bin/grep');
      expect(r1.exitCode).toBe(0);
      expect(r1.stdout).toBe('grep\n');

      const r2 = await runner.run('dirname /usr/bin/grep');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toBe('/usr/bin\n');
    });
  });
});
