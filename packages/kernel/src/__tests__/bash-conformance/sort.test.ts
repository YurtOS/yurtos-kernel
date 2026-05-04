/**
 * Conformance tests for sort — lexicographic, numeric, reverse, unique, case-fold,
 * key-field, and version sorting.
 * Based on POSIX sort specification and GNU coreutils / busybox test patterns.
 *
 * Covers:
 *   - Default lexicographic sort (ASCII order)
 *   - Reverse order (-r)
 *   - Numeric sort (-n): integer and float, negative numbers
 *   - Unique deduplication (-u)
 *   - Case-insensitive sort (-f)
 *   - Key-field sort (-k) with optional separator (-t)
 *   - File input and stdin
 *   - Edge cases: empty input, single line, already sorted, all-duplicates
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

describe('sort conformance', () => {
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
  // Lexicographic sort (default)
  // ---------------------------------------------------------------------------
  describe('lexicographic sort', () => {
    it('sorts three words alphabetically', async () => {
      const r = await runner.run("printf 'banana\napple\ncherry\n' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\nbanana\ncherry\n');
    });

    it('single-line input is unchanged', async () => {
      const r = await runner.run("printf 'foo\n' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo\n');
    });

    it('empty input produces empty output', async () => {
      const r = await runner.run("printf '' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('already-sorted input is unchanged', async () => {
      const r = await runner.run("printf 'a\nb\nc\n' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('numbers sort lexicographically by default (10 before 2)', async () => {
      const r = await runner.run("printf '10\n2\n1\n20\n' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n10\n2\n20\n');
    });

    it('uppercase sorts before lowercase (ASCII order: A-Z before a-z)', async () => {
      const r = await runner.run("printf 'b\nA\na\nB\n' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('A\nB\na\nb\n');
    });

    it('all-identical lines: order preserved', async () => {
      const r = await runner.run("printf 'x\nx\nx\n' | sort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x\nx\nx\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Reverse sort (-r)
  // ---------------------------------------------------------------------------
  describe('-r reverse sort', () => {
    it('reverses lexicographic order', async () => {
      const r = await runner.run("printf 'banana\napple\ncherry\n' | sort -r");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('cherry\nbanana\napple\n');
    });

    it('-rn reverses numeric order', async () => {
      const r = await runner.run("printf '1\n10\n2\n20\n' | sort -rn");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('20\n10\n2\n1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Numeric sort (-n)
  // ---------------------------------------------------------------------------
  describe('-n numeric sort', () => {
    it('sorts integers numerically (2 before 10)', async () => {
      const r = await runner.run("printf '10\n2\n1\n20\n' | sort -n");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n2\n10\n20\n');
    });

    it('handles negative integers', async () => {
      const r = await runner.run("printf '5\n-3\n0\n-10\n' | sort -n");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('-10\n-3\n0\n5\n');
    });

    it('handles decimal fractions', async () => {
      const r = await runner.run("printf '1.5\n0.5\n2.0\n' | sort -n");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0.5\n1.5\n2.0\n');
    });

    it('non-numeric lines treated as 0, numeric line sorts last', async () => {
      const r = await runner.run("printf 'foo\n5\nbar\n' | sort -n");
      expect(r.exitCode).toBe(0);
      // foo and bar parse as 0, appear before 5
      const lines = r.stdout.trim().split('\n');
      expect(lines[lines.length - 1]).toBe('5');
      expect(lines).toContain('foo');
      expect(lines).toContain('bar');
    });

    it('larger set of integers', async () => {
      const r = await runner.run("printf '100\n9\n50\n3\n' | sort -n");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n9\n50\n100\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Unique deduplication (-u)
  // ---------------------------------------------------------------------------
  describe('-u unique sort', () => {
    it('removes exact duplicate lines', async () => {
      const r = await runner.run("printf 'b\na\na\nb\nc\n' | sort -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('removes non-consecutive duplicates (sorts first, then deduplicates)', async () => {
      const r = await runner.run("printf 'c\na\nb\na\nc\n' | sort -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('all-identical lines collapse to one', async () => {
      const r = await runner.run("printf 'z\nz\nz\n' | sort -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('z\n');
    });

    it('no duplicates: output equals sorted input', async () => {
      const r = await runner.run("printf 'c\na\nb\n' | sort -u");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Case-insensitive sort (-f)
  // ---------------------------------------------------------------------------
  describe('-f case-insensitive sort', () => {
    it('sorts case-insensitively (mixed case treated the same)', async () => {
      const r = await runner.run("printf 'Banana\napple\nCherry\n' | sort -f");
      expect(r.exitCode).toBe(0);
      // After case fold: apple < banana < cherry
      expect(r.stdout.toLowerCase()).toBe('apple\nbanana\ncherry\n');
    });

    it('case-fold with already-uppercase input', async () => {
      const r = await runner.run("printf 'CHERRY\nAPPLE\nBANANA\n' | sort -f");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.toLowerCase()).toBe('apple\nbanana\ncherry\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Key-field sort (-k, -t)
  // ---------------------------------------------------------------------------
  describe('-k key-field sort', () => {
    it('-k2 sorts by second whitespace-separated field (lex)', async () => {
      const r = await runner.run("printf 'c 3\na 1\nb 2\n' | sort -k2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a 1\nb 2\nc 3\n');
    });

    it('-k2 -n sorts by second field numerically', async () => {
      const r = await runner.run("printf 'c 30\na 1\nb 20\n' | sort -k2 -n");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a 1\nb 20\nc 30\n');
    });

    it('-t: -k2 sorts by second colon-delimited field', async () => {
      const r = await runner.run("printf 'c:30\na:1\nb:20\n' | sort -t: -k2 -n");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a:1\nb:20\nc:30\n');
    });

    it('-k1 (default key) is the same as no -k', async () => {
      const r = await runner.run("printf 'cherry\napple\nbanana\n' | sort -k1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\nbanana\ncherry\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('sorts lines from a named file', async () => {
      vfs.writeFile('/home/user/words.txt', new TextEncoder().encode('zebra\napple\nmango\n'));
      const r = await runner.run('sort /home/user/words.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('apple\nmango\nzebra\n');
    });

    it('sorts and deduplicates a file with -u', async () => {
      vfs.writeFile('/home/user/dup.txt', new TextEncoder().encode('b\na\nb\na\nc\n'));
      const r = await runner.run('sort -u /home/user/dup.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('numeric sort on file with -n', async () => {
      vfs.writeFile('/home/user/nums.txt', new TextEncoder().encode('100\n9\n50\n3\n'));
      const r = await runner.run('sort -n /home/user/nums.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n9\n50\n100\n');
    });

    it('error exit code for missing file', async () => {
      const r = await runner.run('sort /nonexistent/file.txt 2>/dev/null; echo $?');
      expect(r.stdout.trim()).not.toBe('0');
    });
  });

  // ---------------------------------------------------------------------------
  // Version sort (-V)
  // ---------------------------------------------------------------------------
  describe('-V version sort', () => {
    it('sorts version numbers in version order', async () => {
      const r = await runner.run("printf 'v1.10\nv1.2\nv1.1\n' | sort -V");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('v1.1\nv1.2\nv1.10\n');
    });

    it('sorts plain integers in numeric order', async () => {
      const r = await runner.run("printf '10\n2\n1\n' | sort -V");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n2\n10\n');
    });
  });
});
