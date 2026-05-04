/**
 * expand and unexpand conformance tests.
 * Based on POSIX specification and busybox/GNU coreutils test patterns.
 *
 * expand — convert tabs to spaces:
 *   - Default tab stop: 8
 *   - -t N: custom tab stop
 *   - Tab at column 0 → fills to next tab stop
 *   - Tab mid-line → fills to next tab stop boundary
 *   - Non-tab characters pass through unchanged
 *   - Multiple tabs compound (each expands from current column)
 *   - File input
 *
 * unexpand — convert spaces to tabs (reverse of expand):
 *   - Default tab stop: 8
 *   - -t N: custom tab stop
 *   - Only leading spaces are converted by default (-a converts all)
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

describe('expand unexpand', () => {
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
  // expand default tab stop = 8
  // ---------------------------------------------------------------------------
  describe('expand default (tab stop 8)', () => {
    it('leading tab at column 0 expands to 8 spaces', async () => {
      const r = await runner.run("printf '\\thello\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('        hello\n');
    });

    it('tab after 2 chars (col 2) expands to 6 spaces to reach col 8', async () => {
      const r = await runner.run("printf 'ab\\thello\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ab      hello\n');
    });

    it('two consecutive tabs from col 0: 8 + 8 = 16 spaces total', async () => {
      const r = await runner.run("printf '\\t\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('        \n');
    });

    it('two consecutive tabs from col 0 followed by text', async () => {
      // col 0 → 8 spaces → col 8, then tab at col 8 → 8 more spaces → col 16
      const r = await runner.run("printf '\\t\\tx\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('                x\n');
    });

    it('tab after 7 chars expands to 1 space (just reaches next tab stop)', async () => {
      // "abcdefg" is 7 chars, col=7; tab at col 7 → 8-(7%8)=1 space → col 8
      const r = await runner.run("printf 'abcdefg\\tx\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcdefg x\n');
    });

    it('tab after 8 chars expands to 8 spaces (col 8 → col 16)', async () => {
      // "abcdefgh" is 8 chars, col=8; tab at col 8 → 8-(8%8)=8 spaces → col 16
      const r = await runner.run("printf 'abcdefgh\\tx\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcdefgh        x\n');
    });

    it('line with no tabs passes through unchanged', async () => {
      const r = await runner.run("printf 'hello world\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('empty line passes through', async () => {
      const r = await runner.run("printf '\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('multiple lines each expanded independently', async () => {
      const r = await runner.run("printf '\\ta\\n\\tb\\n' | expand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('        a\n        b\n');
    });
  });

  // ---------------------------------------------------------------------------
  // expand -t N custom tab stop
  // ---------------------------------------------------------------------------
  describe('expand -t N custom tab stop', () => {
    it('-t 4: leading tab expands to 4 spaces', async () => {
      const r = await runner.run("printf '\\thello\\n' | expand -t 4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('    hello\n');
    });

    it('-t 4: tab after 2 chars expands to 2 spaces', async () => {
      // col=2; 4 - (2%4) = 2
      const r = await runner.run("printf 'ab\\tc\\n' | expand -t 4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ab  c\n');
    });

    it('-t 2: tab at col 0 expands to 2 spaces', async () => {
      const r = await runner.run("printf '\\tx\\n' | expand -t 2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('  x\n');
    });

    it('-t4 attached form (no space)', async () => {
      const r = await runner.run("printf '\\tx\\n' | expand -t4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('    x\n');
    });
  });

  // ---------------------------------------------------------------------------
  // expand file input
  // ---------------------------------------------------------------------------
  describe('expand file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/tabs.txt', new TextEncoder().encode('\thello\n\tworld\n'));
      const r = await runner.run('expand /home/user/tabs.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('        hello\n        world\n');
    });
  });

  // ---------------------------------------------------------------------------
  // unexpand (spaces back to tabs)
  // ---------------------------------------------------------------------------
  describe('unexpand default (tab stop 8)', () => {
    it('8 leading spaces → single tab', async () => {
      const r = await runner.run("printf '        hello\\n' | unexpand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\thello\n');
    });

    it('16 leading spaces → two tabs', async () => {
      const r = await runner.run("printf '                hello\\n' | unexpand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\t\thello\n');
    });

    it('no leading spaces: line unchanged', async () => {
      const r = await runner.run("printf 'hello\\n' | unexpand");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });
  });
});
