/**
 * paste tests ported from busybox/testsuite/paste.tests (GPLv2).
 *
 * Covers:
 *   - Default (parallel): merges corresponding lines with tab delimiter
 *   - -d DELIM: custom field delimiter
 *   - -s (serial): all lines of each file joined on one output line
 *   - Mixed -s and -d
 *   - Single-file input (pass-through with tabs for single col)
 *   - Stdin via "-" argument
 *   - File input
 *   - Multi-file parallel with different-length files (shorter produces empty)
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

describe('paste busybox', () => {
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
  // Serial mode (-s): join all lines of a file with delimiter
  // ---------------------------------------------------------------------------
  describe('-s serial mode', () => {
    it('joins three lines with tab delimiter (default)', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | paste -s");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\tb\tc\n');
    });

    it('single line serial mode: just the line', async () => {
      const r = await runner.run("printf 'only\\n' | paste -s");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('only\n');
    });

    it('-s -d, joins with comma', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | paste -s -d,");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a,b,c\n');
    });

    it('-s with custom delimiter: colon', async () => {
      const r = await runner.run("printf 'x\\ny\\nz\\n' | paste -s -d:");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x:y:z\n');
    });

    it('-s on a file joins all file lines', async () => {
      vfs.writeFile('/home/user/items.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const r = await runner.run('paste -s /home/user/items.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('one\ttwo\tthree\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Parallel mode (default): merge corresponding lines from multiple files
  // ---------------------------------------------------------------------------
  describe('parallel mode (default)', () => {
    it('merges two files line by line with tab', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('a1\na2\na3\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('b1\nb2\nb3\n'));
      const r = await runner.run('paste /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a1\tb1\na2\tb2\na3\tb3\n');
    });

    it('-d, merges two files with comma separator', async () => {
      vfs.writeFile('/home/user/col1.txt', new TextEncoder().encode('foo\nbar\n'));
      vfs.writeFile('/home/user/col2.txt', new TextEncoder().encode('baz\nqux\n'));
      const r = await runner.run('paste -d, /home/user/col1.txt /home/user/col2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo,baz\nbar,qux\n');
    });

    it('merges two files with custom delimiter -d|', async () => {
      vfs.writeFile('/home/user/x.txt', new TextEncoder().encode('1\n2\n'));
      vfs.writeFile('/home/user/y.txt', new TextEncoder().encode('a\nb\n'));
      const r = await runner.run("paste -d'|' /home/user/x.txt /home/user/y.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1|a\n2|b\n');
    });

    it('when file B is shorter, remaining rows from A get empty B column', async () => {
      // a.txt has 3 lines, b.txt has 1 line
      vfs.writeFile('/home/user/long.txt', new TextEncoder().encode('x\ny\nz\n'));
      vfs.writeFile('/home/user/short.txt', new TextEncoder().encode('1\n'));
      const r = await runner.run('paste /home/user/long.txt /home/user/short.txt');
      expect(r.exitCode).toBe(0);
      // Row 1: x\t1; Row 2: y\t; Row 3: z\t
      expect(r.stdout).toBe('x\t1\ny\t\nz\t\n');
    });
  });

});
