/**
 * grep tests ported from busybox/testsuite/grep.tests (GPLv2).
 * Source: https://github.com/mirror/busybox/blob/master/testsuite/grep.tests
 *
 * Covers:
 *   - Exit codes (0=match, 1=no match, 2=error)
 *   - Data sources: stdin, file, -, multiple files
 *   - Flags: -s, -e, -f, -x, -L, -E, -o, -r, -w, -F, -v, -q, -i
 *   - Multiple patterns and newline-delimited patterns
 *   - Word-boundary matching edge cases
 *   - -o does not loop on zero-length match
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

describe('grep busybox', () => {
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
  // Exit codes
  // ---------------------------------------------------------------------------
  describe('exit codes', () => {
    it('exits 1 when no match', async () => {
      const r = await runner.run("printf 'one\\ntwo\\n' | grep nonexistent; echo $?");
      expect(r.stdout).toBe('1\n');
    });

    it('exits 0 when match found', async () => {
      const r = await runner.run("printf 'hello\\n' | grep hello; echo $?");
      expect(r.stdout).toBe('hello\n0\n');
    });

    it('exits 2 on file error (nonexistent file)', async () => {
      const r = await runner.run('grep nomatch /tmp/does-not-exist-ever 2>/dev/null; echo $?');
      expect(r.stdout).toBe('2\n');
    });

    it('exits 2 on file error even with -s (error suppressed but exit code 2)', async () => {
      const r = await runner.run('grep -s nomatch /tmp/does-not-exist-ever; echo $?');
      expect(r.stdout).toBe('2\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Data sources: stdin, file, -, multiple files
  // ---------------------------------------------------------------------------
  describe('data sources', () => {
    it('defaults to stdin when no file given', async () => {
      const r = await runner.run("printf 'one\\ntwo\\nthree\\n' | grep two");
      expect(r.stdout).toBe('two\n');
    });

    it('- reads from stdin explicitly', async () => {
      const r = await runner.run("printf 'one\\ntwo\\nthree\\n' | grep two -");
      expect(r.stdout).toBe('two\n');
    });

    it('reads from file', async () => {
      await runner.run("printf 'one\\ntwo\\nthree\\n' > /tmp/input");
      const r = await runner.run('grep two /tmp/input');
      expect(r.stdout).toBe('two\n');
    });

    it('no newline at end of file still matches', async () => {
      await runner.run("printf 'bug' > /tmp/input");
      const r = await runner.run('grep bug /tmp/input');
      expect(r.stdout).toBe('bug\n');
    });

    it('two files: prefixes with filename', async () => {
      await runner.run("printf 'one\\ntwo\\nthree\\n' > /tmp/input; touch /tmp/empty");
      const r = await runner.run('grep two /tmp/input /tmp/empty 2>/dev/null');
      expect(r.stdout).toBe('/tmp/input:two\n');
    });

    it('- and file: prefixes both with source names', async () => {
      await runner.run("printf 'one\\ntwo\\nthree\\n' > /tmp/input");
      const r = await runner.run("printf 'one\\ntwo\\ntoo\\nthree\\n' | grep two - /tmp/input");
      expect(r.stdout).toBe('(standard input):two\n/tmp/input:two\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -s (suppress errors)
  // ---------------------------------------------------------------------------
  describe('-s suppress errors', () => {
    it('-s suppresses error message but exits 2 on file error', async () => {
      const r = await runner.run("grep -s nomatch /tmp/does-not-exist-ever; echo $?");
      expect(r.stderr).toBe('');  // no error message
      expect(r.stdout).toBe('2\n');
    });

    it('-s with stdin (-) and nonexisting file: prints match but exits 2', async () => {
      const r = await runner.run("printf 'nomatch\\ndomatch\\nend\\n' | grep -s domatch /tmp/does-not-exist-ever -; echo $?");
      expect(r.stdout).toBe('(standard input):domatch\n2\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -e (multiple patterns)
  // ---------------------------------------------------------------------------
  describe('-e multiple patterns', () => {
    it('matches either pattern', async () => {
      await runner.run("printf 'one\\ntwo\\n' > /tmp/input");
      const r = await runner.run('grep -e one -e two /tmp/input; echo $?');
      expect(r.stdout).toBe('one\ntwo\n0\n');
    });

    it('-F -e matches fixed strings', async () => {
      await runner.run("printf 'one\\ntwo\\n' > /tmp/input");
      const r = await runner.run('grep -F -e one -e two /tmp/input; echo $?');
      expect(r.stdout).toBe('one\ntwo\n0\n');
    });

    it('-F -i matches case-insensitively', async () => {
      await runner.run("printf 'FOO\\n' > /tmp/input");
      const r = await runner.run('grep -F -i foo /tmp/input; echo $?');
      expect(r.stdout).toBe('FOO\n0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -f (read patterns from file)
  // ---------------------------------------------------------------------------
  describe('-f read patterns from file', () => {
    it('reads regex patterns from file via stdin (-f -)', async () => {
      // File: "tw", "two", "three". Patterns: "tw." (3-char regex), "thr"
      // "tw" has 2 chars so "tw." doesn't match it; "two" and "three" match.
      await runner.run("printf 'tw\\ntwo\\nthree\\n' > /tmp/input");
      const r = await runner.run("printf 'tw.\\nthr\\n' | grep -f - /tmp/input; echo $?");
      expect(r.stdout).toBe('two\nthree\n0\n');
    });

    it('-f with empty pattern file matches nothing', async () => {
      await runner.run("touch /tmp/empty");
      const r = await runner.run("printf 'test\\n' | grep -f /tmp/empty");
      expect(r.stdout).toBe('');
    });

    it('-v -f with empty pattern file passes everything', async () => {
      await runner.run("touch /tmp/empty");
      const r = await runner.run("printf 'test\\n' | grep -v -f /tmp/empty");
      expect(r.stdout).toBe('test\n');
    });

    it('-vxf with empty pattern file passes everything', async () => {
      await runner.run("touch /tmp/empty");
      const r = await runner.run("printf 'test\\n' | grep -vxf /tmp/empty");
      expect(r.stdout).toBe('test\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -x (whole line match)
  // ---------------------------------------------------------------------------
  describe('-x whole line match', () => {
    it('-x matches full line', async () => {
      await runner.run("printf 'foo\\n' > /tmp/input");
      const r = await runner.run('grep -x foo /tmp/input; echo $?');
      expect(r.stdout).toBe('foo\n0\n');
    });

    it('-x rejects partial match at start', async () => {
      await runner.run("printf 'foo bar\\n' > /tmp/input");
      const r = await runner.run('grep -x foo /tmp/input; echo $?');
      expect(r.stdout).toBe('1\n');
    });

    it('-x rejects partial match at end', async () => {
      await runner.run("printf 'bar foo\\n' > /tmp/input");
      const r = await runner.run('grep -x foo /tmp/input; echo $?');
      expect(r.stdout).toBe('1\n');
    });

    it('-x -F full line fixed-string match', async () => {
      await runner.run("printf 'foo\\n' > /tmp/input");
      const r = await runner.run('grep -x -F foo /tmp/input; echo $?');
      expect(r.stdout).toBe('foo\n0\n');
    });

    it('-x -F rejects partial match at start', async () => {
      await runner.run("printf 'foo bar\\n' > /tmp/input");
      const r = await runner.run('grep -x -F foo /tmp/input; echo $?');
      expect(r.stdout).toBe('1\n');
    });

    it('-x -F rejects partial match at end', async () => {
      await runner.run("printf 'bar foo\\n' > /tmp/input");
      const r = await runner.run('grep -x -F foo /tmp/input; echo $?');
      expect(r.stdout).toBe('1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -L (list files with NO matches)
  // ---------------------------------------------------------------------------
  describe('-L list non-matching files', () => {
    it('-L exits 0 when file has no match', async () => {
      await runner.run("printf 'asd\\n' > /tmp/input");
      const r = await runner.run('grep -L qwe /tmp/input; echo $?');
      expect(r.stdout).toBe('/tmp/input\n0\n');
    });

    it('-L exits 1 when file has match', async () => {
      await runner.run("printf 'qwe\\n' > /tmp/input");
      const r = await runner.run('grep -L qwe /tmp/input; echo $?');
      expect(r.stdout).toBe('1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -E (extended regex)
  // ---------------------------------------------------------------------------
  describe('-E extended regex', () => {
    it('-E supports + quantifier', async () => {
      const r = await runner.run("printf 'b\\nar\\nfoo\\nbaz' | grep -E 'fo+'");
      expect(r.stdout).toBe('foo\n');
    });

    it('-E -o prints MAC addresses', async () => {
      const r = await runner.run(
        "printf '00:19:3E:00:AA:5E 00:1D:60:3D:3A:FB 00:22:43:49:FB:AA\\n' | grep -E -o '([[:xdigit:]]{2}[:-]){5}[[:xdigit:]]{2}'"
      );
      expect(r.stdout).toBe('00:19:3E:00:AA:5E\n00:1D:60:3D:3A:FB\n00:22:43:49:FB:AA\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -o (print only matching part)
  // ---------------------------------------------------------------------------
  describe('-o only matching', () => {
    it('-o prints only the match', async () => {
      const r = await runner.run("printf '/var/test\\n' | grep -o '[^/]*$'");
      expect(r.stdout).toBe('test\n');
    });

    it('-o with empty match produces no output (not infinite loop)', async () => {
      const r = await runner.run("printf 'test\\n' | grep -o '' | head -n1");
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // -w (word boundary)
  // ---------------------------------------------------------------------------
  describe('-w word match', () => {
    it('-F -w does not match prefix of word', async () => {
      await runner.run("printf 'foop\\n' > /tmp/input");
      const r = await runner.run('grep -Fw foo /tmp/input');
      expect(r.stdout).toBe('');
    });

    it('-F -w matches word among other words', async () => {
      await runner.run("printf 'foop foo\\n' > /tmp/input");
      const r = await runner.run('grep -Fw foo /tmp/input');
      expect(r.stdout).toBe('foop foo\n');
    });

    it('-w matches word among other words', async () => {
      await runner.run("printf 'foop foo\\n' > /tmp/input");
      const r = await runner.run('grep -w foo /tmp/input');
      expect(r.stdout).toBe('foop foo\n');
    });

    it('-w ^str does not match str not at the beginning', async () => {
      await runner.run("printf 'strstr\\n' > /tmp/input");
      const r = await runner.run('grep -w ^str /tmp/input');
      expect(r.stdout).toBe('');
    });

    it('-w word does not match wordword', async () => {
      await runner.run("printf 'wordword\\n' > /tmp/input");
      const r = await runner.run('grep -w word /tmp/input');
      expect(r.stdout).toBe('');
    });

    it('-F -w w does not match ww', async () => {
      await runner.run("printf 'ww\\n' > /tmp/input");
      const r = await runner.run('grep -F -w w /tmp/input');
      expect(r.stdout).toBe('');
    });

    it('-w matches second word in comma-separated patterns', async () => {
      await runner.run("printf 'bword,word\\nwordb,word\\nbwordb,word\\n' > /tmp/input");
      const r = await runner.run('grep -w word /tmp/input');
      expect(r.stdout).toBe('bword,word\nwordb,word\nbwordb,word\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -x -v combined
  // ---------------------------------------------------------------------------
  describe('-x -v combined', () => {
    it('-x -v with two patterns finds nothing when either matches', async () => {
      const r = await runner.run("printf '  aa bb cc\\n' | grep -x -v -e '.*aa.*' -e 'bb.*'; echo $?");
      expect(r.stdout).toBe('1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Newline-delimited patterns
  // ---------------------------------------------------------------------------
  describe('newline-delimited patterns', () => {
    it('-Fv via -e with newline-embedded pattern (GNU behavior: newline = pattern separator)', async () => {
      // Use printf to write patterns to a file and read with -f (more portable than $() expansion)
      const r = await runner.run(
        "printf 'foo\\nbar\\n' > /tmp/patterns; printf 'foo\\nbar\\nbaz\\n' | grep -Fv -f /tmp/patterns"
      );
      expect(r.stdout).toBe('baz\n');
    });

    it('-Fv with multiple -e patterns', async () => {
      const r = await runner.run("printf 'foo\\nbar\\nbaz\\n' | grep -Fv -e foo -e bar");
      expect(r.stdout).toBe('baz\n');
    });
  });
});
