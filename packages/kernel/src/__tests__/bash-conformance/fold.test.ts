/**
 * fold conformance tests — wrap input lines to fit in specified width.
 * Based on POSIX specification and busybox/GNU coreutils test patterns.
 *
 * Covers:
 *   - Default width 80: short lines pass through unchanged
 *   - -w N: hard break at column N (cuts mid-word)
 *   - -s: soft break at word boundary (last space within width)
 *   - -s with no space in window: falls back to hard break
 *   - -w N without space: combined flag form (-wN)
 *   - Empty lines pass through
 *   - Multiple lines processed independently
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

describe('fold conformance', () => {
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
  // Default width (80): short lines unchanged
  // ---------------------------------------------------------------------------
  describe('default width 80', () => {
    it('short line passes through unchanged', async () => {
      const r = await runner.run("printf 'hello\\n' | fold");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('empty line passes through', async () => {
      const r = await runner.run("printf '\\n' | fold");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -w N: hard break (cuts at exact column N)
  // ---------------------------------------------------------------------------
  describe('-w N hard break', () => {
    it('line shorter than width passes through', async () => {
      const r = await runner.run("printf 'hello\\n' | fold -w 10");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('line exactly at width passes through', async () => {
      const r = await runner.run("printf 'abcdefghij\\n' | fold -w 10");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcdefghij\n');
    });

    it('line one char over width is split', async () => {
      const r = await runner.run("printf 'abcdefghijk\\n' | fold -w 10");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcdefghij\nk\n');
    });

    it('-w 5: splits at 5 chars', async () => {
      const r = await runner.run("printf 'abcdefg\\n' | fold -w 5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcde\nfg\n');
    });

    it('-w 3: three-char chunks', async () => {
      const r = await runner.run("printf 'abcdefgh\\n' | fold -w 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc\ndef\ngh\n');
    });

    it('-w 1: one char per line', async () => {
      const r = await runner.run("printf 'abc\\n' | fold -w 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('-wN attached form works', async () => {
      const r = await runner.run("printf 'abcdef\\n' | fold -w5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcde\nf\n');
    });

    it('multiple lines each folded independently', async () => {
      const r = await runner.run("printf 'abcde\\nfghij\\n' | fold -w 3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc\nde\nfgh\nij\n');
    });

    it('empty line within input passes through', async () => {
      const r = await runner.run("printf 'abc\\n\\ndef\\n' | fold -w 2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ab\nc\n\nde\nf\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -s: soft break at word boundary
  // ---------------------------------------------------------------------------
  describe('-s soft break at space', () => {
    it('breaks at last space within width', async () => {
      const r = await runner.run("printf 'hello world\\n' | fold -s -w 10");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\nworld\n');
    });

    it('no space in window falls back to hard break', async () => {
      const r = await runner.run("printf 'helloworld\\n' | fold -s -w 5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\nworld\n');
    });

    it('three-word line wrapped correctly', async () => {
      const r = await runner.run("printf 'hello world foo bar\\n' | fold -s -w 10");
      expect(r.exitCode).toBe(0);
      // pos=0: "hello worl" → last space at 5 → "hello"
      // pos=6: "world foo " → last space at 15 → "world foo"
      // pos=16: "bar" → remainder
      expect(r.stdout).toBe('hello\nworld foo\nbar\n');
    });

    it('line shorter than width: no fold', async () => {
      const r = await runner.run("printf 'hi there\\n' | fold -s -w 20");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hi there\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from named file', async () => {
      vfs.writeFile('/home/user/long.txt', new TextEncoder().encode('abcdefghijk\n'));
      const r = await runner.run('fold -w 5 /home/user/long.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcde\nfghij\nk\n');
    });
  });
});
