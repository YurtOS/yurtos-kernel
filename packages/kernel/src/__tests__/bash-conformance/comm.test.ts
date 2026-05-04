/**
 * comm conformance tests — compare two sorted files line by line.
 * Based on POSIX specification and busybox/GNU coreutils test patterns.
 *
 * Column layout (no suppression flags):
 *   Column 1 (no prefix):  lines unique to FILE1
 *   Column 2 (\t prefix):  lines unique to FILE2
 *   Column 3 (\t\t prefix): lines common to both
 *
 * Column prefixes adjust when columns are suppressed:
 *   -1: col2_prefix="" col3_prefix="\t"
 *   -2: col2_prefix="\t" col3_prefix="\t"
 *   -12: col3_prefix="" (both unique columns gone)
 *
 * Covers:
 *   - Default three-column output
 *   - -1 suppress lines unique to file1
 *   - -2 suppress lines unique to file2
 *   - -3 suppress common lines
 *   - -12 show only common lines
 *   - -13 show only lines unique to file2
 *   - -23 show only lines unique to file1
 *   - Completely disjoint files
 *   - Files with all lines in common
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

describe('comm conformance', () => {
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
  // Default three-column output
  // ---------------------------------------------------------------------------
  describe('default three-column output', () => {
    it('col1=no-prefix, col2=\\t, col3=\\t\\t', async () => {
      // file1: apple banana cherry
      // file2: banana cherry date
      // apple → col1 (no prefix)
      // banana → col3 (\t\t prefix)
      // cherry → col3 (\t\t prefix)
      // date → col2 (\t prefix)
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\n\t\tbanana\n\t\tcherry\n\tdate\n');
    });

    it('entirely disjoint files: all in col1 or col2', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('aaa\nbbb\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('ccc\nddd\n'));
      const r = await runner.run('comm /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('aaa\nbbb\n\tccc\n\tddd\n');
    });

    it('identical files: all in col3', async () => {
      vfs.writeFile('/home/user/same1.txt', new TextEncoder().encode('x\ny\nz\n'));
      vfs.writeFile('/home/user/same2.txt', new TextEncoder().encode('x\ny\nz\n'));
      const r = await runner.run('comm /home/user/same1.txt /home/user/same2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\t\tx\n\t\ty\n\t\tz\n');
    });

    it('file1 empty: all lines in col2', async () => {
      vfs.writeFile('/home/user/empty.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\n'));
      const r = await runner.run('comm /home/user/empty.txt /home/user/data.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\ta\n\tb\n');
    });

    it('file2 empty: all lines in col1', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\n'));
      vfs.writeFile('/home/user/empty.txt', new TextEncoder().encode(''));
      const r = await runner.run('comm /home/user/data.txt /home/user/empty.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -1: suppress lines unique to file1
  // ---------------------------------------------------------------------------
  describe('-1 suppress col1', () => {
    it('col2 prefix="" col3 prefix="\\t"', async () => {
      // apple suppressed; banana+cherry in col3 (\t); date in col2 ("")
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm -1 /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\tbanana\n\tcherry\ndate\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -2: suppress lines unique to file2
  // ---------------------------------------------------------------------------
  describe('-2 suppress col2', () => {
    it('col1 no prefix, col3 prefix="\\t"', async () => {
      // apple in col1 (""); banana+cherry in col3 (\t); date suppressed
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm -2 /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\n\tbanana\n\tcherry\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -3: suppress common lines
  // ---------------------------------------------------------------------------
  describe('-3 suppress col3 (common)', () => {
    it('shows only lines unique to each file', async () => {
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm -3 /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\n\tdate\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -12: show only common lines (suppress both unique columns)
  // ---------------------------------------------------------------------------
  describe('-12 show only common lines', () => {
    it('common lines with no prefix', async () => {
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm -12 /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('banana\ncherry\n');
    });

    it('completely disjoint files: no output', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('a\nb\n'));
      vfs.writeFile('/home/user/c.txt', new TextEncoder().encode('c\nd\n'));
      const r = await runner.run('comm -12 /home/user/a.txt /home/user/c.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // -13: show only lines unique to file2
  // ---------------------------------------------------------------------------
  describe('-13 show only lines unique to file2', () => {
    it('col2 no prefix after suppressing col1 and col3', async () => {
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm -13 /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('date\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -23: show only lines unique to file1
  // ---------------------------------------------------------------------------
  describe('-23 show only lines unique to file1', () => {
    it('col1 no prefix after suppressing col2 and col3', async () => {
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('apple\nbanana\ncherry\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('banana\ncherry\ndate\n'));
      const r = await runner.run('comm -23 /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\n');
    });
  });
});
