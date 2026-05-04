/**
 * Conformance tests for wc — line, word, byte, char, and max-line-length counting.
 * Based on POSIX wc specification and GNU coreutils / busybox test patterns.
 *
 * Covers:
 *   - Default mode (lines + words + bytes)
 *   - -l (lines), -w (words), -c (bytes), -m (chars), -L (max line length)
 *   - Combined flags (-lw, -lc, etc.)
 *   - Named-file input and multiple-file totals
 *   - Edge cases: empty input, no trailing newline, empty lines
 *
 * Output format: each count right-justified in an 8-character field, fields concatenated,
 * followed by a space and filename when reading a named file.
 * Example: "       1       2      12 /path/file"
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

describe('wc conformance', () => {
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
  // Default mode: lines + words + bytes (no flags)
  // ---------------------------------------------------------------------------
  describe('default (lines words bytes)', () => {
    it('counts single line: 1 line, 2 words, 12 bytes', async () => {
      // "hello world\n" = 12 bytes
      const r = await runner.run("printf 'hello world\n' | wc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       1       2      12\n');
    });

    it('empty input: all zeros', async () => {
      const r = await runner.run("printf '' | wc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0       0       0\n');
    });

    it('input without trailing newline: 0 lines, counts words and bytes', async () => {
      // "hello" = 5 bytes, 1 word, 0 lines (no newline)
      const r = await runner.run("printf 'hello' | wc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0       1       5\n');
    });

    it('multiple lines: summed correctly', async () => {
      // "one two\n" = 8 bytes, 2 words; "three four five\n" = 16 bytes, 3 words
      const r = await runner.run("printf 'one two\nthree four five\n' | wc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       2       5      24\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -l: count lines only
  // ---------------------------------------------------------------------------
  describe('-l line count', () => {
    it('counts three newline-terminated lines', async () => {
      const r = await runner.run("printf 'a\nb\nc\n' | wc -l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       3\n');
    });

    it('empty lines (only newlines) count as lines', async () => {
      const r = await runner.run("printf '\\n\\n\\n' | wc -l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       3\n');
    });

    it('no trailing newline: 0 lines', async () => {
      const r = await runner.run("printf 'hello' | wc -l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0\n');
    });

    it('empty input: 0 lines', async () => {
      const r = await runner.run("printf '' | wc -l");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -w: count words only
  // ---------------------------------------------------------------------------
  describe('-w word count', () => {
    it('counts three space-separated words', async () => {
      const r = await runner.run("printf 'one two three\n' | wc -w");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       3\n');
    });

    it('multiple spaces between words still yield correct count', async () => {
      const r = await runner.run("printf 'a  b  c\n' | wc -w");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       3\n');
    });

    it('words across multiple lines', async () => {
      const r = await runner.run("printf 'a b\nc d e\n' | wc -w");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       5\n');
    });

    it('empty input: 0 words', async () => {
      const r = await runner.run("printf '' | wc -w");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -c: count bytes only
  // ---------------------------------------------------------------------------
  describe('-c byte count', () => {
    it('counts bytes including the trailing newline', async () => {
      // "hello\n" = 6 bytes
      const r = await runner.run("printf 'hello\n' | wc -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       6\n');
    });

    it('counts bytes across multiple lines', async () => {
      // "ab\n" = 3, "cd\n" = 3, total = 6
      const r = await runner.run("printf 'ab\ncd\n' | wc -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       6\n');
    });

    it('empty input: 0 bytes', async () => {
      const r = await runner.run("printf '' | wc -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0\n');
    });

    it('input without trailing newline: exact byte count', async () => {
      // "hello" = 5 bytes, no trailing newline
      const r = await runner.run("printf 'hello' | wc -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       5\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -L: maximum line length
  // ---------------------------------------------------------------------------
  describe('-L max line length', () => {
    it('length of the single line (without newline)', async () => {
      // content "hello" = 5 chars
      const r = await runner.run("printf 'hello\n' | wc -L");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       5\n');
    });

    it('max of two lines with different lengths', async () => {
      // "hello" = 5, "world!" = 6 → max = 6
      const r = await runner.run("printf 'hello\nworld!\n' | wc -L");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       6\n');
    });

    it('empty input: max line length is 0', async () => {
      const r = await runner.run("printf '' | wc -L");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0\n');
    });

    it('empty lines: max line length is 0', async () => {
      const r = await runner.run("printf '\\n\\n' | wc -L");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Combined flags
  // ---------------------------------------------------------------------------
  describe('combined flags', () => {
    it('-lw shows lines then words', async () => {
      const r = await runner.run("printf 'one two three\n' | wc -lw");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       1       3\n');
    });

    it('-lc shows lines then bytes', async () => {
      // "hello\n" = 1 line, 6 bytes
      const r = await runner.run("printf 'hello\n' | wc -lc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       1       6\n');
    });

    it('-wc shows words then bytes', async () => {
      // "hi there\n" = 2 words, 9 bytes
      const r = await runner.run("printf 'hi there\n' | wc -wc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       2       9\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('counts from a named file (with filename in output)', async () => {
      vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('hello world\n'));
      const r = await runner.run('wc /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       1       2      12 /home/user/test.txt\n');
    });

    it('-l on a named file', async () => {
      vfs.writeFile('/home/user/lines.txt', new TextEncoder().encode('a\nb\nc\nd\n'));
      const r = await runner.run('wc -l /home/user/lines.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('       4 /home/user/lines.txt\n');
    });

    it('multiple files: per-file counts plus total line', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('hello\n'));      // 1 line, 1 word, 6 bytes
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('world foo\n')); // 1 line, 2 words, 10 bytes
      const r = await runner.run('wc /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(
        '       1       1       6 /home/user/a.txt\n' +
        '       1       2      10 /home/user/b.txt\n' +
        '       2       3      16 total\n',
      );
    });
  });
});
