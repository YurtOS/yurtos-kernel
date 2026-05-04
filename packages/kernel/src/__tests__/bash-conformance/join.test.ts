/**
 * join conformance tests — join lines of sorted files on a common field.
 * Based on POSIX specification and busybox/GNU coreutils test patterns.
 *
 * Covers:
 *   - Default: join on field 1, space-separated output
 *   - -t CHAR: custom field separator
 *   - -1 / -2: join on different fields
 *   - Lines with no match are not output (inner join semantics)
 *   - Many-to-one and one-to-many matches
 *   - Empty files
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

// SKIPPED: hand-built ProcessManager bypasses Sandbox.registerTools.
// Re-enable after migrating to Sandbox.create — alongside the
// Python+pkg refactor.
describe.skip('join conformance', () => {
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
  // Default: join on field 1, space-delimited
  // ---------------------------------------------------------------------------
  describe('default join (field 1, space separator)', () => {
    it('joins matching lines from two files', async () => {
      vfs.writeFile('/home/user/f1.txt', new TextEncoder().encode('1 a\n2 b\n3 c\n'));
      vfs.writeFile('/home/user/f2.txt', new TextEncoder().encode('1 x\n2 y\n4 z\n'));
      const r = await runner.run('join /home/user/f1.txt /home/user/f2.txt');
      expect(r.exitCode).toBe(0);
      // key=1: "1 a x"; key=2: "2 b y"; key=3 unmatched, key=4 unmatched
      expect(r.stdout).toBe('1 a x\n2 b y\n');
    });

    it('no matches: empty output', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('1 foo\n2 bar\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('3 baz\n4 qux\n'));
      const r = await runner.run('join /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('all lines match', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('1 alpha\n2 beta\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('1 one\n2 two\n'));
      const r = await runner.run('join /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 alpha one\n2 beta two\n');
    });

    it('three fields in file1: all non-key fields included', async () => {
      // "1 a b" + "1 x" → key=1, other1=["a","b"], other2=["x"] → "1 a b x"
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('1 a b\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('1 x\n'));
      const r = await runner.run('join /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 a b x\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -t CHAR: custom field separator
  // ---------------------------------------------------------------------------
  describe('-t CHAR custom field separator', () => {
    it('colon-separated files joined on field 1', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('1:foo:bar\n2:baz:qux\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('1:alpha:beta\n3:x:y\n'));
      // -t must be separate from the delimiter character
      const r = await runner.run('join -t : /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      // key=1: other1=["foo","bar"], other2=["alpha","beta"] → "1:foo:bar:alpha:beta"
      expect(r.stdout).toBe('1:foo:bar:alpha:beta\n');
    });

    it('comma-separated files', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('a,1\nb,2\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('a,x\nb,y\n'));
      const r = await runner.run('join -t , /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a,1,x\nb,2,y\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -1 / -2: join on different fields
  // ---------------------------------------------------------------------------
  describe('-1 -2 join on specified fields', () => {
    it('-1 2 -2 1: join on field 2 of file1 and field 1 of file2', async () => {
      // file1 field 2: "1","2"; file2 field 1: "1","2"
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('a 1\nb 2\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('1 x\n2 y\n'));
      const r = await runner.run('join -1 2 -2 1 /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      // key=1: other1=["a"], other2=["x"] → "1 a x"
      // key=2: other1=["b"], other2=["y"] → "2 b y"
      expect(r.stdout).toBe('1 a x\n2 b y\n');
    });
  });

  // ---------------------------------------------------------------------------
  // One-to-many and many-to-one matches
  // ---------------------------------------------------------------------------
  describe('one-to-many matches', () => {
    it('one file1 key matches two file2 lines: both pairs output', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('1 foo\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('1 bar\n1 baz\n'));
      const r = await runner.run('join /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 foo bar\n1 foo baz\n');
    });
  });
});
