/**
 * Conformance tests for tr — character translation, deletion, squeeze, complement.
 * Based on POSIX tr specification and GNU coreutils / busybox test patterns.
 *
 * Covers:
 *   - Basic character translation with ranges and explicit sets
 *   - POSIX character classes ([:lower:], [:upper:], [:digit:], [:alpha:], [:space:])
 *   - Delete mode (-d): remove characters in set1
 *   - Squeeze mode (-s): collapse consecutive identical chars from set
 *   - Complement mode (-c): operate on chars NOT in set1
 *   - Combined -ds (delete set1, squeeze set2)
 *   - Escape sequences (\n, \t)
 *   - Edge cases (empty input, no-op, set2 longer than set1)
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

describe('tr conformance', () => {
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    const vfs = new VFS();
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
  // Basic translation
  // ---------------------------------------------------------------------------
  describe('basic translation', () => {
    it('a-z → A-Z range translates all lowercase', async () => {
      const r = await runner.run("printf 'hello' | tr 'a-z' 'A-Z'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('HELLO');
    });

    it('A-Z → a-z range translates all uppercase', async () => {
      const r = await runner.run("printf 'WORLD' | tr 'A-Z' 'a-z'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('world');
    });

    it('explicit char set maps one-to-one', async () => {
      const r = await runner.run("printf 'aeiou' | tr 'aeiou' 'AEIOU'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('AEIOU');
    });

    it('set2 shorter than set1: last char of set2 used for overflow', async () => {
      // a→x, b→y, c→y, d→y, e→y
      const r = await runner.run("printf 'abcde' | tr 'abcde' 'xy'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('xyyyy');
    });

    it('chars not in set1 pass through unchanged', async () => {
      const r = await runner.run("printf 'hello world' | tr 'aeiou' '*'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('h*ll* w*rld');
    });

    it('newline in input is preserved when not in set1', async () => {
      const r = await runner.run("printf 'hello\n' | tr 'a-z' 'A-Z'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('HELLO\n');
    });

    it('sub-range x-z maps correctly', async () => {
      const r = await runner.run("printf 'xyz' | tr 'x-z' 'a-c'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc');
    });

    it('single char to single char', async () => {
      const r = await runner.run("printf 'aaaa' | tr 'a' 'b'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('bbbb');
    });

    it('set2 longer than set1: extra set2 chars are ignored', async () => {
      const r = await runner.run("printf 'ab' | tr 'ab' 'ABCDE'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('AB');
    });
  });

  // ---------------------------------------------------------------------------
  // POSIX character classes
  // ---------------------------------------------------------------------------
  describe('POSIX character classes', () => {
    it('[:lower:] → [:upper:] converts mixed-case string', async () => {
      const r = await runner.run("printf 'Hello World' | tr '[:lower:]' '[:upper:]'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('HELLO WORLD');
    });

    it('[:upper:] → [:lower:] converts all-caps', async () => {
      const r = await runner.run("printf 'HELLO WORLD' | tr '[:upper:]' '[:lower:]'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world');
    });

    it('[:digit:] → single char replaces all digits', async () => {
      const r = await runner.run("printf 'abc123def' | tr '[:digit:]' 'X'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcXXXdef');
    });

    it('[:alpha:] → single char replaces all letters', async () => {
      const r = await runner.run("printf '123abc456' | tr '[:alpha:]' 'X'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('123XXX456');
    });
  });

  // ---------------------------------------------------------------------------
  // Delete mode (-d)
  // ---------------------------------------------------------------------------
  describe('-d delete', () => {
    it('removes vowels', async () => {
      const r = await runner.run("printf 'hello world' | tr -d 'aeiou'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hll wrld');
    });

    it('removes digit range 0-9', async () => {
      const r = await runner.run("printf 'abc123def456' | tr -d '0-9'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcdef');
    });

    it('removes newlines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc' | tr -d '\\n'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc');
    });

    it('removes digits via [:digit:] class', async () => {
      const r = await runner.run("printf 'abc123' | tr -d '[:digit:]'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc');
    });

    it('removes spaces via [:space:] class', async () => {
      const r = await runner.run("printf 'hello world' | tr -d '[:space:]'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('helloworld');
    });

    it('no matching chars: passes through unchanged', async () => {
      const r = await runner.run("printf 'hello' | tr -d '0-9'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });
  });

  // ---------------------------------------------------------------------------
  // Squeeze mode (-s)
  // ---------------------------------------------------------------------------
  describe('-s squeeze', () => {
    it('squeezes consecutive identical chars from set (all three runs)', async () => {
      const r = await runner.run("printf 'aaabbbccc' | tr -s 'abc'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc');
    });

    it('squeezes only chars in set1 (b and c runs untouched)', async () => {
      const r = await runner.run("printf 'aaabbbccc' | tr -s 'a'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abbbccc');
    });

    it('squeezes multiple spaces to one', async () => {
      const r = await runner.run("printf 'a   b   c' | tr -s ' '");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a b c');
    });

    it('-s with two sets: translate then squeeze set2 chars', async () => {
      // digits→x, consecutive x runs squeezed
      const r = await runner.run("printf 'a111b222c' | tr -s '0-9' 'x'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('axbxc');
    });

    it('-s [:space:] with translation normalises whitespace to single space', async () => {
      const r = await runner.run("printf 'foo  bar   baz' | tr -s '[:space:]' ' '");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo bar baz');
    });
  });

  // ---------------------------------------------------------------------------
  // Complement mode (-c)
  // ---------------------------------------------------------------------------
  describe('-c complement', () => {
    it('translates chars NOT in set1 to replacement char', async () => {
      // digits not in a-z → underscore
      const r = await runner.run("printf 'hello123world' | tr -c 'a-z' '_'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello___world');
    });

    it('-c with space + digits in input: all non-alpha become underscore', async () => {
      // space and digits are not in a-z
      const r = await runner.run("printf 'hello 123 world' | tr -c 'a-z' '_'");
      expect(r.exitCode).toBe(0);
      // space, 1, 2, 3, space → 5 underscores
      expect(r.stdout).toBe('hello_____world');
    });

    it('-cd: deletes chars NOT in set1 (keeps only set1 chars)', async () => {
      const r = await runner.run("printf 'abc123def' | tr -cd 'a-z'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abcdef');
    });

    it('-cd with \\n in set: keeps letters and newlines', async () => {
      const r = await runner.run("printf 'abc123\\ndef456\\n' | tr -cd 'a-z\\n'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('abc\ndef\n');
    });

    it('-c [:alpha:] replaces non-alpha chars with underscore', async () => {
      // space (1) + digits (3) + space (1) = 5 non-alpha
      const r = await runner.run("printf 'Hello 123 World' | tr -c '[:alpha:]' '_'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Hello_____World');
    });
  });

  // ---------------------------------------------------------------------------
  // Combined -ds (delete set1, then squeeze set2)
  // ---------------------------------------------------------------------------
  describe('-ds (delete then squeeze)', () => {
    it('deletes set1 chars and squeezes remaining set2 chars', async () => {
      // delete 'a' and 'c', then squeeze 'b': aabbccdd → bbdd → bdd
      const r = await runner.run("printf 'aabbccdd' | tr -ds 'ac' 'b'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('bdd');
    });

    it('deletes digits then squeezes spaces', async () => {
      // no digits to delete; two spaces squeezed to one
      const r = await runner.run("printf 'hello  world' | tr -ds '0-9' ' '");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world');
    });
  });

  // ---------------------------------------------------------------------------
  // Escape sequences
  // ---------------------------------------------------------------------------
  describe('escape sequences', () => {
    it('\\n in set matches actual newlines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc' | tr '\\n' ','");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a,b,c');
    });

    it('\\t in set matches actual tabs', async () => {
      const r = await runner.run("printf 'a\\tb\\tc' | tr '\\t' ':'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a:b:c');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('empty input produces empty output', async () => {
      const r = await runner.run("printf '' | tr 'a-z' 'A-Z'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('no chars in set1 found: entire input passes through', async () => {
      const r = await runner.run("printf 'hello' | tr '0-9' 'X'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('all same chars: translate all', async () => {
      const r = await runner.run("printf 'zzzzz' | tr 'z' 'a'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('aaaaa');
    });
  });
});
