/**
 * strings and column conformance tests.
 *
 * strings — extract printable ASCII sequences from binary data:
 *   - Printable range: 0x20-0x7e plus tab (0x09); newline (0x0a) is NOT printable
 *   - Default minimum length: 4 chars
 *   - -n N / -nN: custom minimum length
 *   - Sequences shorter than min_len are silently skipped
 *   - No filename or offset prefix — just the strings, one per line
 *
 * column — columnate lists:
 *   - Default mode: fills 80-char terminal width, items padded to (max_len+2)
 *   - -t: table mode — aligns fields using whitespace separator by default
 *   - -s DELIM: field separator for table mode
 *   - -o SEP: output separator (default "  ", two spaces)
 *   - Last field in each row is never padded
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

describe('strings column', () => {
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
  // strings: extract printable sequences
  // ---------------------------------------------------------------------------
  describe('strings: extract printable sequences', () => {
    it('two 5-char strings separated by null: both output', async () => {
      vfs.writeFile(
        '/home/user/bin.bin',
        new Uint8Array([
          0x68, 0x65, 0x6c, 0x6c, 0x6f, // "hello"
          0x00,                           // null separator
          0x77, 0x6f, 0x72, 0x6c, 0x64, // "world"
        ]),
      );
      const r = await runner.run('strings /home/user/bin.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\nworld\n');
    });

    it('sequence shorter than 4 chars is suppressed', async () => {
      vfs.writeFile(
        '/home/user/short.bin',
        new Uint8Array([
          0x61, 0x62, 0x63, // "abc" (3 chars — below default min)
          0x00,
          0x68, 0x65, 0x6c, 0x6c, 0x6f, // "hello" (5 chars)
        ]),
      );
      const r = await runner.run('strings /home/user/short.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('exact 4-char sequence is output', async () => {
      vfs.writeFile(
        '/home/user/four.bin',
        new Uint8Array([0x74, 0x65, 0x73, 0x74]), // "test"
      );
      const r = await runner.run('strings /home/user/four.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('test\n');
    });

    it('-n 3: minimum length 3 — outputs short sequence too', async () => {
      vfs.writeFile(
        '/home/user/short.bin',
        new Uint8Array([
          0x61, 0x62, 0x63, // "abc"
          0x00,
          0x68, 0x65, 0x6c, 0x6c, 0x6f, // "hello"
        ]),
      );
      const r = await runner.run('strings -n 3 /home/user/short.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc\nhello\n');
    });

    it('-n8 attached form: suppresses strings shorter than 8', async () => {
      vfs.writeFile(
        '/home/user/mixed.bin',
        new Uint8Array([
          // "hello" = 5 chars (< 8, suppressed)
          0x68, 0x65, 0x6c, 0x6c, 0x6f,
          0x00,
          // "hello world" = 11 chars (≥ 8, output)
          0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64,
        ]),
      );
      const r = await runner.run('strings -n8 /home/user/mixed.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('tab (0x09) is printable and included in sequences', async () => {
      vfs.writeFile(
        '/home/user/tab.bin',
        new Uint8Array([0x09, 0x61, 0x62, 0x63, 0x64]), // "\tabcd"
      );
      const r = await runner.run('strings /home/user/tab.bin');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\tabcd\n');
    });

    it('newline (0x0a) is NOT printable — breaks sequences', async () => {
      vfs.writeFile(
        '/home/user/nl.bin',
        new Uint8Array([
          // "hell" then newline (not printable) then "o wor" = broken
          0x68, 0x65, 0x6c, 0x6c, 0x0a, 0x6f, 0x20, 0x77, 0x6f, 0x72,
        ]),
      );
      const r = await runner.run('strings /home/user/nl.bin');
      expect(r.exitCode).toBe(0);
      // "hell" = 4 chars → output; "o wor" = 5 chars → output
      expect(r.stdout).toBe('hell\no wor\n');
    });
  });

  // ---------------------------------------------------------------------------
  // column: default mode (fill 80-char terminal)
  // ---------------------------------------------------------------------------
  describe('column: default fill mode', () => {
    it('5 single-char items → single row with 2-space padding', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\nd\\ne\\n' | column");
      expect(r.exitCode).toBe(0);
      // max_len=1, col_width=3, 26 columns; all 5 fit on one row
      // a(padded 3) b(padded 3) c(padded 3) d(padded 3) e(no padding as last)
      expect(r.stdout).toBe('a  b  c  d  e\n');
    });

    it('3 longer items → single row', async () => {
      const r = await runner.run("printf 'apple\\nbanana\\ncherry\\n' | column");
      expect(r.exitCode).toBe(0);
      // max_len=6 (cherry), col_width=8, num_cols=10; all 3 fit on one row
      expect(r.stdout).toBe('apple   banana  cherry\n');
    });
  });

  // ---------------------------------------------------------------------------
  // column -t: table mode (aligned columns)
  // ---------------------------------------------------------------------------
  describe('column -t table mode', () => {
    it('two equal-width columns', async () => {
      const r = await runner.run("printf 'a b\\nc d\\n' | column -t");
      expect(r.exitCode).toBe(0);
      // col_widths=[1,1]; format!("{:1}", "a") = "a"; output_sep = "  "
      expect(r.stdout).toBe('a  b\nc  d\n');
    });

    it('unequal column widths: shorter entries padded', async () => {
      const r = await runner.run("printf 'foo bar\\na b\\n' | column -t");
      expect(r.exitCode).toBe(0);
      // col_widths=[3,3]; "foo  bar", "a    b" (a padded to 3 + sep "  " + b)
      expect(r.stdout).toBe('foo  bar\na    b\n');
    });

    it('three columns', async () => {
      const r = await runner.run("printf 'a b c\\nd e f\\n' | column -t");
      expect(r.exitCode).toBe(0);
      // col_widths=[1,1,1]; "a  b  c", "d  e  f"
      expect(r.stdout).toBe('a  b  c\nd  e  f\n');
    });
  });

  // ---------------------------------------------------------------------------
  // column -t -s DELIM: custom field separator
  // ---------------------------------------------------------------------------
  describe('column -t -s: custom separator', () => {
    it('-s : splits on colon', async () => {
      const r = await runner.run("printf 'name:age\\nalice:30\\n' | column -t -s :");
      expect(r.exitCode).toBe(0);
      // col_widths=[5,3]; "name   age", "alice  30"
      expect(r.stdout).toBe('name   age\nalice  30\n');
    });
  });

  // ---------------------------------------------------------------------------
  // column -t -o SEP: custom output separator
  // ---------------------------------------------------------------------------
  describe('column -t -o: custom output separator', () => {
    it('-o | uses pipe as separator', async () => {
      const r = await runner.run("printf 'a b\\nc d\\n' | column -t -o '|'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a|b\nc|d\n');
    });
  });
});
