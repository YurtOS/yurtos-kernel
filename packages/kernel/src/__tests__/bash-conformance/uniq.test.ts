/**
 * Conformance tests for uniq — filter adjacent duplicate lines.
 * Based on POSIX uniq specification and busybox/GNU coreutils test patterns.
 *
 * Covers:
 *   - Default: remove adjacent duplicates, keep one
 *   - -c count: prefix each output group with its repeat count
 *   - -d duplicates-only: print only lines that appeared more than once
 *   - -u unique-only: print only lines that appeared exactly once
 *   - -i case-insensitive comparison
 *   - -f N skip-fields: ignore first N whitespace-separated fields in comparison
 *   - -s N skip-chars: ignore first N characters in comparison
 *   - Combined flags
 *   - Edge cases: empty input, single line, non-consecutive duplicates, all identical
 *
 * Output format for -c: "{:>7} {line}" — count right-justified in 7-char field,
 *   then a space, then the line (e.g., "      2 foo").
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

describe('uniq conformance', () => {
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
  // Default: remove adjacent duplicates
  // ---------------------------------------------------------------------------
  describe('default (remove adjacent duplicates)', () => {
    it('collapses consecutive duplicates to one', async () => {
      const r = await runner.run("printf 'a\\na\\nb\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\n');
    });

    it('non-consecutive duplicates are NOT removed', async () => {
      const r = await runner.run("printf 'a\\nb\\na\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\na\n');
    });

    it('three consecutive identical lines become one', async () => {
      const r = await runner.run("printf 'x\\nx\\nx\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x\n');
    });

    it('no adjacent duplicates: input passes through unchanged', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('empty input produces empty output', async () => {
      const r = await runner.run("printf '' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('single line passes through', async () => {
      const r = await runner.run("printf 'hello\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('all identical lines collapse to one', async () => {
      const r = await runner.run("printf 'dup\\ndup\\ndup\\ndup\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('dup\n');
    });

    it('mixed groups: each group reduced to one', async () => {
      const r = await runner.run("printf 'a\\na\\nb\\nb\\nb\\nc\\n' | uniq");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -c: prefix count
  // ---------------------------------------------------------------------------
  describe('-c count', () => {
    it('prefixes each group with its repeat count (7-char right-justified)', async () => {
      const r = await runner.run("printf 'a\\na\\nb\\n' | uniq -c");
      expect(r.exitCode).toBe(0);
      // count=2 → "      2 a"; count=1 → "      1 b"
      expect(r.stdout).toBe('      2 a\n      1 b\n');
    });

    it('count of 3 for three consecutive identical lines', async () => {
      const r = await runner.run("printf 'x\\nx\\nx\\n' | uniq -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('      3 x\n');
    });

    it('count of 1 for every unique line', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | uniq -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('      1 a\n      1 b\n      1 c\n');
    });

    it('multiple groups with different counts', async () => {
      const r = await runner.run("printf 'a\\na\\na\\nb\\nb\\nc\\n' | uniq -c");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('      3 a\n      2 b\n      1 c\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -d: only print duplicated lines (groups with count > 1)
  // ---------------------------------------------------------------------------
  describe('-d duplicates only', () => {
    it('prints only duplicated groups (once per group)', async () => {
      const r = await runner.run("printf 'a\\na\\nb\\n' | uniq -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\n');
    });

    it('suppresses all unique lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | uniq -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('prints each duplicated group exactly once', async () => {
      const r = await runner.run("printf 'x\\nx\\nx\\ny\\ny\\nz\\n' | uniq -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x\ny\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -u: only print unique lines (groups with count == 1)
  // ---------------------------------------------------------------------------
  describe('-u unique only', () => {
    it('prints only lines that appeared exactly once', async () => {
      const r = await runner.run("printf 'a\\na\\nb\\n' | uniq -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\n');
    });

    it('suppresses all duplicated groups', async () => {
      const r = await runner.run("printf 'a\\na\\nb\\nb\\n' | uniq -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('passes through all lines when none are duplicates', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | uniq -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -i: case-insensitive comparison
  // ---------------------------------------------------------------------------
  describe('-i case-insensitive', () => {
    it('treats lines as equal regardless of case', async () => {
      const r = await runner.run("printf 'A\\na\\nB\\n' | uniq -i");
      expect(r.exitCode).toBe(0);
      // 'A' and 'a' are adjacent and case-fold equal → keep first ('A')
      expect(r.stdout).toBe('A\nB\n');
    });

    it('mixed case run collapses to first occurrence', async () => {
      const r = await runner.run("printf 'Hello\\nhello\\nHELLO\\nworld\\n' | uniq -i");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Hello\nworld\n');
    });

    it('case-sensitive lines that differ stay separate', async () => {
      // 'abc' and 'ABC' differ only in case; -i makes them equal
      const r = await runner.run("printf 'abc\\nABC\\ndef\\n' | uniq -i");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc\ndef\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -f N: skip first N fields in comparison
  // ---------------------------------------------------------------------------
  describe('-f skip-fields', () => {
    it('-f 1 skips the first whitespace-delimited field', async () => {
      // Comparison key for "1 same" with -f1 is " same"
      // "1 same" and "2 same" have the same key → dedup
      const r = await runner.run("printf '1 same\\n2 same\\n3 diff\\n' | uniq -f 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1 same\n3 diff\n');
    });

    it('-f 1 with three matching groups', async () => {
      const r = await runner.run("printf 'a val\\nb val\\nc other\\nd other\\n' | uniq -f 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a val\nc other\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -s N: skip first N characters in comparison
  // ---------------------------------------------------------------------------
  describe('-s skip-chars', () => {
    it('-s 1 skips first character, so lines differing only in prefix are equal', async () => {
      const r = await runner.run("printf 'xfoo\\nyfoo\\nxbar\\n' | uniq -s 1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('xfoo\nxbar\n');
    });

    it('-s 2 skips two chars: prefix of 2 is ignored', async () => {
      const r = await runner.run("printf 'axfoo\\nbxfoo\\ncxbar\\n' | uniq -s 2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('axfoo\ncxbar\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/words.txt', new TextEncoder().encode('apple\napple\nbanana\nbanana\ncherry\n'));
      const r = await runner.run('uniq /home/user/words.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\nbanana\ncherry\n');
    });

    it('-c on a file', async () => {
      vfs.writeFile('/home/user/reps.txt', new TextEncoder().encode('yes\nyes\nyes\nno\n'));
      const r = await runner.run('uniq -c /home/user/reps.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('      3 yes\n      1 no\n');
    });
  });
});
