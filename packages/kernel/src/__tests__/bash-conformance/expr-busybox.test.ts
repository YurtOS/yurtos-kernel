/**
 * expr tests ported from busybox/testsuite/expr.tests (GPLv2).
 *
 * Covers:
 *   - Single argument: print value, exit 1 if "0" or empty
 *   - Arithmetic: +, -, *, /, %
 *   - Comparison: =, !=, <, <=, >, >= (integer and string)
 *   - : match operator (BRE anchored, returns length or group)
 *   - length STRING
 *   - substr STRING POS LEN (1-based)
 *   - index STRING CHARS
 *   - Exit codes: 0=non-null/non-zero, 1=null/zero, 2=error
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

describe('expr busybox', () => {
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
  // Single argument
  // ---------------------------------------------------------------------------
  describe('single argument', () => {
    it('non-zero integer: prints value, exits 0', async () => {
      const r = await runner.run('expr 5');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n');
    });

    it('"0": prints 0, exits 1', async () => {
      const r = await runner.run('expr 0');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('non-empty string: prints value, exits 0', async () => {
      const r = await runner.run('expr hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arithmetic
  // ---------------------------------------------------------------------------
  describe('arithmetic', () => {
    it('addition: 2 + 3 = 5', async () => {
      const r = await runner.run('expr 2 + 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n');
    });

    it('subtraction: 10 - 3 = 7', async () => {
      const r = await runner.run('expr 10 - 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('7\n');
    });

    it('multiplication: 3 * 4 = 12', async () => {
      const r = await runner.run("expr 3 '*' 4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('12\n');
    });

    it('integer division truncates: 10 / 3 = 3', async () => {
      const r = await runner.run('expr 10 / 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n');
    });

    it('modulo: 10 % 3 = 1', async () => {
      const r = await runner.run('expr 10 % 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('result of 0 exits 1: 5 - 5 = 0', async () => {
      const r = await runner.run('expr 5 - 5');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('negative result: 3 - 10 = -7', async () => {
      const r = await runner.run('expr 3 - 10');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('-7\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Integer comparison
  // ---------------------------------------------------------------------------
  describe('integer comparison', () => {
    it('3 > 2 is true: result 1, exit 0', async () => {
      const r = await runner.run("expr 3 '>' 2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('2 > 3 is false: result 0, exit 1', async () => {
      const r = await runner.run("expr 2 '>' 3");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('3 < 5 is true', async () => {
      const r = await runner.run("expr 3 '<' 5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('5 < 3 is false', async () => {
      const r = await runner.run("expr 5 '<' 3");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('3 = 3 is true', async () => {
      const r = await runner.run('expr 3 = 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('3 = 4 is false', async () => {
      const r = await runner.run('expr 3 = 4');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('3 != 4 is true', async () => {
      const r = await runner.run('expr 3 != 4');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('3 != 3 is false', async () => {
      const r = await runner.run('expr 3 != 3');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('3 <= 3 is true', async () => {
      const r = await runner.run("expr 3 '<=' 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('3 >= 3 is true', async () => {
      const r = await runner.run("expr 3 '>=' 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('2 >= 3 is false', async () => {
      const r = await runner.run("expr 2 '>=' 3");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // length keyword
  // ---------------------------------------------------------------------------
  describe('length keyword', () => {
    it('length of "hello" is 5', async () => {
      const r = await runner.run('expr length hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n');
    });

    it('length of "abc" is 3', async () => {
      const r = await runner.run('expr length abc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n');
    });

    it('length of a single char is 1', async () => {
      const r = await runner.run('expr length x');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // substr keyword (1-based position)
  // ---------------------------------------------------------------------------
  describe('substr keyword', () => {
    it('substr hello 2 3 → ell', async () => {
      const r = await runner.run('expr substr hello 2 3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ell\n');
    });

    it('substr hello 1 5 → hello (full string)', async () => {
      const r = await runner.run('expr substr hello 1 5');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('substr hello 4 2 → lo', async () => {
      const r = await runner.run('expr substr hello 4 2');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('lo\n');
    });

    it('pos beyond length: empty output, exit 1', async () => {
      const r = await runner.run('expr substr hello 10 3');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('\n');
    });
  });

  // ---------------------------------------------------------------------------
  // index keyword
  // ---------------------------------------------------------------------------
  describe('index keyword', () => {
    it('index hello lo → 3 (first char from set "lo" found at pos 3)', async () => {
      // "hello": h(1) e(2) l(3) — 'l' is in "lo" at 1-based pos 3
      const r = await runner.run('expr index hello lo');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n');
    });

    it('index hello xyz → 0 (not found), exit 1', async () => {
      const r = await runner.run('expr index hello xyz');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('index hello h → 1 (first char matches)', async () => {
      const r = await runner.run('expr index hello h');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // : match operator (BRE anchored at start)
  // ---------------------------------------------------------------------------
  describe(': match operator', () => {
    it('full string match with .* returns character count', async () => {
      const r = await runner.run("expr hello : 'he.*'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n');
    });

    it('partial match returns matched prefix length', async () => {
      const r = await runner.run("expr hello : 'he'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2\n');
    });

    it('no match returns 0, exits 1', async () => {
      const r = await runner.run("expr hello : 'world'");
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('0\n');
    });

    it('group capture \\( \\) extracts matched text', async () => {
      // BRE: hello \(.*\) → ERE: hello (.*) → anchored ^hello (.*)
      // Input: "hello world" → group = "world"
      const r = await runner.run("expr 'hello world' : 'hello \\(.*\\)'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('world\n');
    });

    it('digit pattern match on number: returns length', async () => {
      // "42" matches "^[0-9]*" → full match = "42" (2 chars)
      const r = await runner.run("expr 42 : '[0-9]*'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2\n');
    });
  });
});
