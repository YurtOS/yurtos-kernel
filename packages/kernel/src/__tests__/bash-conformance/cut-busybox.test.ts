/**
 * cut tests ported from busybox/testsuite/cut.tests (GPLv2).
 * Source: https://github.com/mirror/busybox/blob/master/testsuite/cut.tests
 *
 * Covers edge cases not in coreutils.test.ts:
 *   - field mode with single field, list, ranges, open-ended, from-start ranges
 *   - character mode: single pos, range, from-start, open-ended, list
 *   - default tab delimiter (no -d flag)
 *   - -s / --only-delimited: suppress lines without the delimiter
 *   - --output-delimiter: custom separator for field output
 *   - out-of-range field requests (produce empty output for missing fields)
 *   - multi-line stdin and file input
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

describe('cut busybox', () => {
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
  // Field mode with explicit delimiter (-d : -f N)
  // ---------------------------------------------------------------------------
  describe('field mode with delimiter', () => {
    it('extracts field 1', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: -f1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\n');
    });

    it('extracts field 2', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: -f2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\n');
    });

    it('extracts last field', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: -f3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('c\n');
    });

    it('field list 1,3 joins with delimiter', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: -f1,3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a:c\n');
    });

    it('field range 2-4', async () => {
      const r = await runner.run("printf 'a:b:c:d:e\\n' | cut -d: -f2-4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b:c:d\n');
    });

    it('open-ended range 2- (fields 2 to end)', async () => {
      const r = await runner.run("printf 'a:b:c:d\\n' | cut -d: -f2-");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b:c:d\n');
    });

    it('from-start range -2 (fields 1 to 2)', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: -f-2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a:b\n');
    });

    it('non-contiguous field list 1,3,5', async () => {
      const r = await runner.run("printf 'a:b:c:d:e\\n' | cut -d: -f1,3,5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a:c:e\n');
    });

    it('out-of-range field produces empty output line', async () => {
      // "a:b" has only 2 fields; asking for field 5 yields empty line
      const r = await runner.run("printf 'a:b\\n' | cut -d: -f5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('mixed range 2-4 when line has fewer fields returns what exists', async () => {
      // "a:b" has 2 fields; range 2-4 extracts only field 2
      const r = await runner.run("printf 'a:b\\n' | cut -d: -f2-4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\n');
    });

    it('multi-line stdin: each line processed independently', async () => {
      const r = await runner.run("printf 'a:b\\nc:d\\ne:f\\n' | cut -d: -f1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nc\ne\n');
    });

    it('attached -dX form (no space between -d and delimiter)', async () => {
      const r = await runner.run("printf 'a,b,c\\n' | cut -d, -f2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\n');
    });

    it('attached -fN form (no space between -f and number)', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: -f2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Default tab delimiter
  // ---------------------------------------------------------------------------
  describe('default tab delimiter', () => {
    it('extracts second tab-separated field', async () => {
      const r = await runner.run("printf 'a\\tb\\tc\\n' | cut -f2");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b\n');
    });

    it('line without tab: -f1 outputs entire line', async () => {
      // No tab in "hello" → split gives one field → field 1 = "hello"
      const r = await runner.run("printf 'hello\\n' | cut -f1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });
  });

  // ---------------------------------------------------------------------------
  // -s / --only-delimited: suppress lines without delimiter
  // ---------------------------------------------------------------------------
  describe('-s suppress no-delimiter lines', () => {
    it('passes lines with delimiter, suppresses lines without', async () => {
      const r = await runner.run("printf 'nodeli\\na:b\\ncnodeli\\nd:e\\n' | cut -d: -f1 -s");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nd\n');
    });

    it('suppresses all lines when none contain the delimiter', async () => {
      const r = await runner.run("printf 'foo\\nbar\\n' | cut -d: -f1 -s");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('without -s, lines without delimiter pass through on field 1', async () => {
      const r = await runner.run("printf 'foo\\na:b\\n' | cut -d: -f1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo\na\n');
    });
  });

  // ---------------------------------------------------------------------------
  // --output-delimiter: custom separator for multi-field output
  // ---------------------------------------------------------------------------
  describe('--output-delimiter', () => {
    it('replaces field delimiter in output with custom string', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: --output-delimiter=, -f1,3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a,c\n');
    });

    it('can use multi-char output delimiter', async () => {
      const r = await runner.run("printf 'a:b:c\\n' | cut -d: --output-delimiter='|' -f1,3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a|c\n');
    });

    it('output-delimiter applies to ranges too', async () => {
      const r = await runner.run("printf 'a:b:c:d\\n' | cut -d: --output-delimiter=- -f2-4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('b-c-d\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Character mode (-c)
  // ---------------------------------------------------------------------------
  describe('character mode (-c)', () => {
    it('extracts single character position', async () => {
      const r = await runner.run("printf 'hello\\n' | cut -c1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('h\n');
    });

    it('extracts character range 2-4', async () => {
      const r = await runner.run("printf 'hello\\n' | cut -c2-4");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ell\n');
    });

    it('open-ended range 2- (from char 2 to end)', async () => {
      const r = await runner.run("printf 'hello\\n' | cut -c2-");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ello\n');
    });

    it('from-start range -3 (chars 1 to 3)', async () => {
      const r = await runner.run("printf 'hello\\n' | cut -c-3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hel\n');
    });

    it('character list 1,3,5', async () => {
      const r = await runner.run("printf 'hello\\n' | cut -c1,3,5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hlo\n');
    });

    it('position beyond line length: no extra output', async () => {
      // "hi" has only 2 chars; cut -c5 gives empty line
      const r = await runner.run("printf 'hi\\n' | cut -c5");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('multi-line: each line cut independently', async () => {
      const r = await runner.run("printf 'abc\\ndefg\\n' | cut -c2-3");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('bc\nef\n');
    });
  });

  // ---------------------------------------------------------------------------
  // File input
  // ---------------------------------------------------------------------------
  describe('file input', () => {
    it('reads from a named file', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('foo:bar:baz\nalpha:beta:gamma\n'));
      const r = await runner.run('cut -d: -f2 /home/user/data.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('bar\nbeta\n');
    });
  });
});
