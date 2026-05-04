/**
 * Conformance tests for nl, rev, and tac.
 *
 * nl — number lines of files:
 *   - Default (-b a): numbers all lines, 1-based, format "{:>6}\t{line}"
 *   - -b t: numbers only non-empty lines; empty lines get "      \t"
 *   - Multiple files share the same counter
 *   - File input
 *
 * rev — reverse each line:
 *   - Reverses character order per line
 *   - Passes empty lines through
 *   - File input
 *
 * tac — reverse line order (opposite of cat):
 *   - Prints lines of input in reverse order
 *   - Final newline preserved
 *   - Single line unchanged
 *   - Empty input produces empty output
 *   - File input
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

describe('nl rev tac', () => {
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
  // nl — number lines
  // ---------------------------------------------------------------------------
  describe('nl default (-b a: number all lines)', () => {
    it('three lines numbered 1-3, tab-separated', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | nl");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\ta\n     2\tb\n     3\tc\n');
    });

    it('single line numbered 1', async () => {
      const r = await runner.run("printf 'hello\\n' | nl");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\thello\n');
    });

    it('numbers all lines including empty lines', async () => {
      // "a", "", "b" — default -b a numbers all three
      const r = await runner.run("printf 'a\\n\\nb\\n' | nl");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\ta\n     2\t\n     3\tb\n');
    });

    it('line number right-justified in 6-char field', async () => {
      // Number 1 should be right-justified: "     1"
      const r = await runner.run("printf 'x\\n' | nl");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\tx\n');
    });

    it('line numbers are 1-based and sequential', async () => {
      const r = await runner.run("printf 'p\\nq\\nr\\ns\\n' | nl");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\tp\n     2\tq\n     3\tr\n     4\ts\n');
    });
  });

  describe('nl -b t (number only non-empty lines)', () => {
    it('empty lines get 6 spaces + tab but no number', async () => {
      // "a", "", "b" — with -b t: 'a' gets 1, '' gets spaces+tab, 'b' gets 2
      const r = await runner.run("printf 'a\\n\\nb\\n' | nl -b t");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\ta\n      \t\n     2\tb\n');
    });

    it('consecutive empty lines each get spaces+tab', async () => {
      const r = await runner.run("printf 'x\\n\\n\\ny\\n' | nl -b t");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\tx\n      \t\n      \t\n     2\ty\n');
    });

    it('no empty lines: identical to default', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | nl -b t");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\ta\n     2\tb\n     3\tc\n');
    });
  });

  describe('nl file input', () => {
    it('reads and numbers lines from a named file', async () => {
      vfs.writeFile('/home/user/lines.txt', new TextEncoder().encode('foo\nbar\nbaz\n'));
      const r = await runner.run('nl /home/user/lines.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('     1\tfoo\n     2\tbar\n     3\tbaz\n');
    });
  });

  // ---------------------------------------------------------------------------
  // rev — reverse each line
  // ---------------------------------------------------------------------------
  describe('rev reverse each line', () => {
    it('reverses characters in a single line', async () => {
      const r = await runner.run("printf 'hello\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('olleh\n');
    });

    it('reverses each line independently', async () => {
      const r = await runner.run("printf 'hello\\nworld\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('olleh\ndlrow\n');
    });

    it('single character reversal is identity', async () => {
      const r = await runner.run("printf 'x\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x\n');
    });

    it('palindrome is unchanged', async () => {
      const r = await runner.run("printf 'racecar\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('racecar\n');
    });

    it('empty line reversal stays empty', async () => {
      const r = await runner.run("printf '\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('reverses digits', async () => {
      const r = await runner.run("printf '12345\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('54321\n');
    });

    it('multi-line reversal with different lengths', async () => {
      const r = await runner.run("printf 'abc\\nde\\nf\\n' | rev");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('cba\ned\nf\n');
    });
  });

  describe('rev file input', () => {
    it('reads from a named file and reverses each line', async () => {
      vfs.writeFile('/home/user/words.txt', new TextEncoder().encode('hello\nworld\n'));
      const r = await runner.run('rev /home/user/words.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('olleh\ndlrow\n');
    });
  });

  // ---------------------------------------------------------------------------
  // tac — print lines in reverse order
  // ---------------------------------------------------------------------------
  describe('tac reverse line order', () => {
    it('reverses three lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | tac");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('c\nb\na\n');
    });

    it('single line is unchanged', async () => {
      const r = await runner.run("printf 'only\\n' | tac");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('only\n');
    });

    it('two lines swap order', async () => {
      const r = await runner.run("printf 'first\\nsecond\\n' | tac");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('second\nfirst\n');
    });

    it('five lines fully reversed', async () => {
      const r = await runner.run("printf '1\\n2\\n3\\n4\\n5\\n' | tac");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n4\n3\n2\n1\n');
    });

    it('output has trailing newline after last line', async () => {
      const r = await runner.run("printf 'a\\nb\\n' | tac");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\na\n');
      expect(r.stdout.endsWith('\n')).toBe(true);
    });
  });

  describe('tac file input', () => {
    it('reads from a named file and reverses line order', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const r = await runner.run('tac /home/user/data.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('three\ntwo\none\n');
    });
  });
});
