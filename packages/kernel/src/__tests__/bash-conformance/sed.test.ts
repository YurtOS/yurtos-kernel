/**
 * Conformance tests for sed — exercises features beyond basic integration tests.
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
  'diff',
  'du', 'df',
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

describe('sed conformance', () => {
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
  // Substitution basics
  // ---------------------------------------------------------------------------
  describe('substitution basics', () => {
    it('basic s/old/new/ replaces first occurrence on each line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('foo bar foo\nfoo baz foo\n'));
      const result = await runner.run('sed \'s/foo/qux/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('qux bar foo\nqux baz foo\n');
    });

    it('global /g flag replaces all occurrences', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('aaa bbb aaa\naaa ccc aaa\n'));
      const result = await runner.run('sed \'s/aaa/xxx/g\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('xxx bbb xxx\nxxx ccc xxx\n');
    });

    it('case-insensitive /I flag', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('Hello HELLO hello\n'));
      const result = await runner.run('sed \'s/hello/bye/gI\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('bye bye bye\n');
    });

    it('nth occurrence replacement with /2', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('aXaXaXa\n'));
      const result = await runner.run('sed \'s/a/B/2\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('aXBXaXa\n');
    });

    it('alternate delimiter s|old|new|', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('/usr/local/bin\n'));
      const result = await runner.run('sed \'s|/usr/local|/opt|g\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('/opt/bin\n');
    });

    it('empty replacement deletes matched text', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('hello world\n'));
      const result = await runner.run('sed \'s/world//\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello \n');
    });

    it('& in replacement inserts matched text', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('hello\n'));
      const result = await runner.run('sed \'s/hello/[&]/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('[hello]\n');
    });

    it('backreference \\1 captures group', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('foobar\n'));
      const result = await runner.run('sed \'s/\\(foo\\)\\(bar\\)/\\2\\1/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('barfoo\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Address types
  // ---------------------------------------------------------------------------
  describe('address types', () => {
    it('line number address applies command to specific line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'2s/two/TWO/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\nTWO\nthree\n');
    });

    it('$ addresses the last line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('first\nmiddle\nlast\n'));
      const result = await runner.run('sed \'$s/last/LAST/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('first\nmiddle\nLAST\n');
    });

    it('/regex/ address matches lines by pattern', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('apple\nbanana\napricot\n'));
      const result = await runner.run('sed \'/^a/s/a/A/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      // First 'a' on matching lines is replaced
      expect(result.stdout).toBe('Apple\nbanana\nApricot\n');
    });

    it('line range 2,4 applies to lines 2 through 4', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('L1\nL2\nL3\nL4\nL5\n'));
      const result = await runner.run('sed \'2,4s/L/X/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('L1\nX2\nX3\nX4\nL5\n');
    });

    it('regex range /start/,/stop/ applies between matching lines', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('a\nSTART\nb\nc\nSTOP\nd\n'));
      const result = await runner.run('sed \'/START/,/STOP/s/^/>> /\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('a\n>> START\n>> b\n>> c\n>> STOP\nd\n');
    });

    it('negation with ! inverts address match', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('keep\ndelete\nkeep\n'));
      const result = await runner.run('sed \'/keep/!d\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('keep\nkeep\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Commands
  // ---------------------------------------------------------------------------
  describe('commands', () => {
    it('d deletes matching lines', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'2d\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\nthree\n');
    });

    it('p prints matching lines (duplicates with default output)', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'2p\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\ntwo\ntwo\nthree\n');
    });

    it('-n suppresses default output, p prints explicitly', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed -n \'2p\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('two\n');
    });

    it('-n with /regex/p prints matching lines only (grep-like)', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('foo\nbar\nfoo baz\nqux\n'));
      const result = await runner.run('sed -n \'/foo/p\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('foo\nfoo baz\n');
    });

    it('i\\ inserts text before a line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'2i\\INSERTED\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\nINSERTED\ntwo\nthree\n');
    });

    it('a\\ appends text after a line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'2a\\APPENDED\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\ntwo\nAPPENDED\nthree\n');
    });

    it('c\\ replaces an entire line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'2c\\REPLACED\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\nREPLACED\nthree\n');
    });

    it('y/abc/ABC/ transliterates characters', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('abcdef\n'));
      const result = await runner.run('sed \'y/abc/ABC/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('ABCdef\n');
    });

    it('q quits after first line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\nthree\n'));
      const result = await runner.run('sed \'1q\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('one\n');
    });

    it('w writes matching lines to a file', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('alpha\nbeta\ngamma\n'));
      const result = await runner.run('sed -n \'/beta/w /home/user/out.txt\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      const written = new TextDecoder().decode(vfs.readFile('/home/user/out.txt'));
      expect(written).toBe('beta\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple expressions
  // ---------------------------------------------------------------------------
  describe('multiple expressions', () => {
    it('multiple -e flags apply in order', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('hello world\n'));
      const result = await runner.run('sed -e \'s/hello/hi/\' -e \'s/world/earth/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi earth\n');
    });

    it('semicolon-separated commands in single expression', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('hello world\n'));
      const result = await runner.run('sed \'s/hello/hi/;s/world/earth/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi earth\n');
    });

    it('address with multiple commands using semicolons', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('aaa\nbbb\nccc\n'));
      const result = await runner.run('sed \'2{s/bbb/BBB/;s/BBB/XXX/}\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('aaa\nXXX\nccc\n');
    });

    it('delete and substitute combined across expressions', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('keep\nremove\nstay\n'));
      const result = await runner.run('sed -e \'/remove/d\' -e \'s/keep/KEEP/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('KEEP\nstay\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Hold/pattern space
  // ---------------------------------------------------------------------------
  describe('hold/pattern space', () => {
    it('h and g copy pattern to hold and back', async () => {
      // Copy line 1 to hold space, then on line 3 replace pattern with hold
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('first\nsecond\nthird\n'));
      const result = await runner.run('sed -n \'1h;3{g;p}\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('first\n');
    });

    it('x exchanges hold and pattern spaces', async () => {
      // Exchange on line 2: pattern becomes empty (initial hold), hold gets "second"
      // Then on line 3, exchange again to recover "second"
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('first\nsecond\nthird\n'));
      const result = await runner.run('sed -n \'2x;3{x;p}\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('second\n');
    });

    it('H appends to hold space with newline separator', async () => {
      // Accumulate lines 1 and 2 in hold, print on line 3
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('first\nsecond\nthird\n'));
      const result = await runner.run('sed -n \'1h;2H;3{g;p}\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('first\nsecond\n');
    });

    it('G appends hold space to pattern space', async () => {
      // After each line, append the (initially empty) hold space
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('one\ntwo\n'));
      const result = await runner.run('sed \'G\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      // Each line gets a newline appended (empty hold space = empty string after \\n)
      expect(result.stdout).toBe('one\n\ntwo\n\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Regex features
  // ---------------------------------------------------------------------------
  describe('regex features', () => {
    it('character class [a-z] matches lowercase letters', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('a1b2c3\n'));
      const result = await runner.run('sed \'s/[a-z]//g\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('123\n');
    });

    it('POSIX class [[:digit:]] matches digits', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('abc123def\n'));
      const result = await runner.run('sed \'s/[[:digit:]]//g\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('abcdef\n');
    });

    it('anchors ^ and $ match start and end of line', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('hello\nworld\n'));
      const result = await runner.run('sed \'s/^/> /;s/$/ </\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('> hello <\n> world <\n');
    });

    it('BRE quantifiers * and \\+ and \\? work', async () => {
      // \\+ matches one or more 'b' characters
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('abbc\nabc\nac\n'));
      const result = await runner.run('sed \'s/ab\\+c/MATCH/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      // 'abbc' -> MATCH (bb matches b\+), 'abc' -> MATCH (b matches b\+), 'ac' -> ac (no b, \+ needs at least one)
      expect(result.stdout).toBe('MATCH\nMATCH\nac\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty input', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode(''));
      const result = await runner.run('sed \'s/a/b/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');
    });

    it('handles single-line input without trailing newline', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('hello'));
      const result = await runner.run('sed \'s/hello/goodbye/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('goodbye\n');
    });

    it('preserves trailing newline on multi-line input', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('line1\nline2\n'));
      const result = await runner.run('sed \'s/line/LINE/\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('LINE1\nLINE2\n');
    });

    it('handles lines with special characters (tabs and spaces)', async () => {
      vfs.writeFile('/home/user/input.txt', new TextEncoder().encode('\thello  world\t\n'));
      const result = await runner.run('sed \'s/\\t/TAB/g\' /home/user/input.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('TABhello  worldTAB\n');
    });
  });
});
