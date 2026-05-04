/**
 * head tests ported from busybox/testsuite/head.tests (GPLv2).
 * Source: https://github.com/mirror/busybox/blob/master/testsuite/head.tests
 *
 * Covers:
 *   - Default: first 10 lines
 *   - -n N: first N lines
 *   - -N shorthand: same as -n N
 *   - -n -N: all lines except the last N (head -n -1 = all but last line)
 *   - -c N: first N bytes
 *   - Fewer lines than requested: outputs all
 *   - -n 0: produces no output
 *   - Multi-line and single-line inputs
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

describe('head busybox', () => {
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
  // -n N: first N lines
  // ---------------------------------------------------------------------------
  describe('-n N lines', () => {
    it('-n 3 outputs first 3 of 5 lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | head -n 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('-n 1 outputs only the first line', async () => {
      const r = await runner.run("printf 'first\\nsecond\\nthird\\n' | head -n 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('first\n');
    });

    it('-n 0 produces no output', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | head -n 0");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-n larger than line count: outputs all lines', async () => {
      const r = await runner.run("printf 'a\\nb\\n' | head -n 100");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\n');
    });

    it('default (no -n): outputs first 10 lines', async () => {
      vfs.writeFile('/home/user/tenlines.txt', new TextEncoder().encode(TEN_LINES));
      // Add an 11th line that should NOT appear
      vfs.writeFile('/home/user/eleven.txt', new TextEncoder().encode(TEN_LINES + 'line11\n'));
      const r = await runner.run('head /home/user/eleven.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(TEN_LINES);
      expect(r.stdout).not.toContain('line11');
    });

    it('empty input: no output', async () => {
      const r = await runner.run("printf '' | head -n 5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // -N shorthand (e.g., head -3)
  // ---------------------------------------------------------------------------
  describe('-N shorthand', () => {
    it('-3 is equivalent to -n 3', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | head -3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('-1 outputs only first line', async () => {
      const r = await runner.run("printf 'only\\nthis\\n' | head -1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('only\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -n -N: all lines except the last N
  // ---------------------------------------------------------------------------
  describe('-n -N (all but last N)', () => {
    it('-n -1 outputs all but the last line', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | head -n -1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\nd\n');
    });

    it('-n -2 outputs all but the last 2 lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | head -n -2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('-n -N when N equals line count: no output', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | head -n -3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-n -N when N exceeds line count: no output', async () => {
      const r = await runner.run("printf 'a\\nb\\n' | head -n -10");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // -c N: first N bytes
  // ---------------------------------------------------------------------------
  describe('-c N bytes', () => {
    it('-c 5 outputs first 5 bytes', async () => {
      // "hello world\n" → first 5 bytes = "hello"
      const r = await runner.run("printf 'hello world' | head -c 5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('-c 1 outputs single byte', async () => {
      const r = await runner.run("printf 'abc' | head -c 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a');
    });

    it('-c larger than content: outputs all bytes', async () => {
      const r = await runner.run("printf 'hi' | head -c 100");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hi');
    });

    it('-c 0 produces no output', async () => {
      const r = await runner.run("printf 'hello' | head -c 0");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-c includes newline bytes', async () => {
      // "ab\n" = 3 bytes; -c 3 = "ab\n"
      const r = await runner.run("printf 'ab\\ncd\\n' | head -c 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ab\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('one\ntwo\nthree\nfour\nfive\n'));
      const r = await runner.run('head -n 2 /home/user/data.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('one\ntwo\n');
    });
  });
});
