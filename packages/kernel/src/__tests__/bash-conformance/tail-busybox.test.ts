/**
 * tail tests ported from busybox/testsuite/tail.tests (GPLv2).
 * Source: https://github.com/mirror/busybox/blob/master/testsuite/tail.tests
 *
 * Covers:
 *   - Default: last 10 lines
 *   - -n N: last N lines
 *   - -N shorthand: same as -n N
 *   - -n +N: output starting from line N (1-based)
 *   - -c N: last N bytes
 *   - Fewer lines than requested: outputs all
 *   - -n 0: produces no output
 *   - Empty input
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

// Helper: 10 lines of test data
const TEN_LINES = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

describe('tail busybox', () => {
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
  // -n N: last N lines
  // ---------------------------------------------------------------------------
  describe('-n N lines', () => {
    it('-n 3 outputs last 3 of 5 lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | tail -n 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('c\nd\ne\n');
    });

    it('-n 1 outputs only the last line', async () => {
      const r = await runner.run("printf 'first\\nsecond\\nlast\\n' | tail -n 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('last\n');
    });

    it('-n 0 produces no output', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | tail -n 0");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-n larger than line count: outputs all lines', async () => {
      const r = await runner.run("printf 'a\\nb\\n' | tail -n 100");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\n');
    });

    it('default (no -n): outputs last 10 lines', async () => {
      // 11-line input; default tail keeps last 10
      vfs.writeFile('/home/user/eleven.txt', new TextEncoder().encode('line0\n' + TEN_LINES));
      const r = await runner.run('tail /home/user/eleven.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(TEN_LINES);
      expect(r.stdout).not.toContain('line0');
    });

    it('empty input: no output', async () => {
      const r = await runner.run("printf '' | tail -n 5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('single line: -n 1 returns that line', async () => {
      const r = await runner.run("printf 'only\\n' | tail -n 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('only\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -N shorthand
  // ---------------------------------------------------------------------------
  describe('-N shorthand', () => {
    it('-3 is equivalent to -n 3', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | tail -3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('c\nd\ne\n');
    });

    it('-1 outputs only the last line', async () => {
      const r = await runner.run("printf 'x\\ny\\nz\\n' | tail -1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('z\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -n +N: output from line N onwards (1-based)
  // ---------------------------------------------------------------------------
  describe('-n +N from-start', () => {
    it('-n +1 outputs all lines (from line 1)', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | tail -n +1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('-n +2 skips first line, outputs from line 2', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\n' | tail -n +2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\nc\nd\n');
    });

    it('-n +3 skips first two lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | tail -n +3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('c\nd\ne\n');
    });

    it('-n +N when N exceeds line count: no output', async () => {
      const r = await runner.run("printf 'a\\nb\\n' | tail -n +10");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-n +N when N equals line count: outputs last line', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | tail -n +3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('c\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -c N: last N bytes
  // ---------------------------------------------------------------------------
  describe('-c N bytes', () => {
    it('-c 3 outputs last 3 bytes', async () => {
      const r = await runner.run("printf 'abcde' | tail -c 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('cde');
    });

    it('-c 1 outputs single last byte', async () => {
      const r = await runner.run("printf 'hello' | tail -c 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('o');
    });

    it('-c larger than content: outputs all', async () => {
      const r = await runner.run("printf 'hi' | tail -c 100");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hi');
    });

    it('-c 0 produces no output', async () => {
      const r = await runner.run("printf 'hello' | tail -c 0");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-c includes newline bytes', async () => {
      // "ab\ncd\n" = 6 bytes; last 3 = "d\n" - wait:
      // a(0),b(1),\n(2),c(3),d(4),\n(5) — last 3 bytes = positions 3,4,5 = "cd\n"
      const r = await runner.run("printf 'ab\\ncd\\n' | tail -c 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('cd\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('one\ntwo\nthree\nfour\nfive\n'));
      const r = await runner.run('tail -n 2 /home/user/data.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('four\nfive\n');
    });

    it('-n +2 on a file skips first line', async () => {
      vfs.writeFile('/home/user/skip.txt', new TextEncoder().encode('header\nrow1\nrow2\nrow3\n'));
      const r = await runner.run('tail -n +2 /home/user/skip.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('row1\nrow2\nrow3\n');
    });
  });
});
