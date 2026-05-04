/**
 * Conformance tests for grep — exercises regex features after port to regex crate.
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

describe('grep conformance', () => {
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

    // Create test files
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode(
      'hello world\nHello World\nfoo bar\n123 numbers\ntest_line\nHELLO LOUD\n'
    ));
    vfs.writeFile('/home/user/code.rs', new TextEncoder().encode(
      'fn main() {\n    println!("hello");\n    let x = 42;\n}\n'
    ));
    vfs.writeFile('/home/user/data.csv', new TextEncoder().encode(
      'name,age,city\nalice,30,new york\nbob,25,london\ncharlie,35,paris\n'
    ));
  });

  // ---- Anchors ----
  describe('anchors', () => {
    it('^ matches start of line', async () => {
      const r = await runner.run('grep "^hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).not.toContain('Hello World');
    });

    it('$ matches end of line', async () => {
      const r = await runner.run('grep "bar$" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('foo bar');
    });

    it('^...$ matches entire line', async () => {
      const r = await runner.run('grep "^foo bar$" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('foo bar');
    });
  });

  // ---- Character classes ----
  describe('character classes', () => {
    it('[0-9] matches digits', async () => {
      const r = await runner.run('grep "[0-9]" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('123 numbers');
    });

    it('[a-z] matches lowercase letters', async () => {
      const r = await runner.run('grep "^[a-z]" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).toContain('foo bar');
      expect(r.stdout).not.toContain('HELLO LOUD');
    });

    it('[^0-9] matches non-digits (negation)', async () => {
      const r = await runner.run('grep "^[^0-9]" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('123 numbers');
      expect(r.stdout).toContain('hello world');
    });

    it('[A-Z] matches uppercase', async () => {
      const r = await runner.run('grep "^[A-Z]" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('Hello World');
      expect(r.stdout).toContain('HELLO LOUD');
      expect(r.stdout).not.toContain('hello world');
    });
  });

  // ---- Dot metacharacter ----
  describe('dot metacharacter', () => {
    it('. matches any character', async () => {
      const r = await runner.run('grep "h.llo" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
    });

    it('multiple dots match', async () => {
      const r = await runner.run('grep "f..\\sb" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('foo bar');
    });
  });

  // ---- Quantifiers (BRE mode) ----
  describe('quantifiers (BRE)', () => {
    it('* matches zero or more', async () => {
      const r = await runner.run('grep "fo*" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('foo bar');
    });

    it('.* matches anything', async () => {
      const r = await runner.run('grep "hello.*world" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
    });
  });

  // ---- Extended regex (-E flag) ----
  describe('extended regex (-E)', () => {
    it('+ matches one or more', async () => {
      const r = await runner.run('grep -E "[0-9]+" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('123 numbers');
    });

    it('? matches zero or one', async () => {
      const r = await runner.run('grep -E "colou?r" /home/user/test.txt');
      expect(r.exitCode).toBe(1); // no match expected
    });

    it('| alternation', async () => {
      const r = await runner.run('grep -E "hello|foo" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).toContain('foo bar');
    });

    it('() grouping with alternation', async () => {
      const r = await runner.run('grep -E "(hello|foo) " /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).toContain('foo bar');
    });
  });

  // ---- Case insensitive ----
  describe('case insensitive (-i)', () => {
    it('-i matches case-insensitively', async () => {
      const r = await runner.run('grep -i "hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).toContain('Hello World');
      expect(r.stdout).toContain('HELLO LOUD');
    });

    it('-i works with character classes', async () => {
      const r = await runner.run('grep -i "^hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
      expect(r.stdout).toContain('Hello World');
      expect(r.stdout).toContain('HELLO LOUD');
    });
  });

  // ---- Flags ----
  describe('flags', () => {
    it('-v inverts match', async () => {
      const r = await runner.run('grep -v "hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('hello world');
      expect(r.stdout).toContain('foo bar');
    });

    it('-c counts matches', async () => {
      const r = await runner.run('grep -c "hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('1');
    });

    it('-n shows line numbers', async () => {
      const r = await runner.run('grep -n "foo" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^3:foo bar/m);
    });

    it('-l lists matching files', async () => {
      const r = await runner.run('grep -l "hello" /home/user/test.txt /home/user/code.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('test.txt');
      expect(r.stdout).toContain('code.rs');
    });
  });

  // ---- Escape sequences ----
  describe('escape sequences', () => {
    it('\\d matches digits (BRE extension)', async () => {
      const r = await runner.run('grep "\\d" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('123 numbers');
    });

    it('\\w matches word chars', async () => {
      const r = await runner.run('grep "\\w\\w\\w_" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('test_line');
    });
  });

  // ---- Edge cases ----
  describe('edge cases', () => {
    it('empty file returns no match', async () => {
      vfs.writeFile('/home/user/empty.txt', new TextEncoder().encode(''));
      const r = await runner.run('grep "hello" /home/user/empty.txt');
      expect(r.exitCode).toBe(1);
    });

    it('stdin input works', async () => {
      const r = await runner.run('echo "hello world" | grep hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
    });

    it('multiple files show filenames', async () => {
      const r = await runner.run('grep "hello" /home/user/test.txt /home/user/code.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('/home/user/test.txt:');
      expect(r.stdout).toContain('/home/user/code.rs:');
    });

    it('exit code 2 on invalid regex', async () => {
      const r = await runner.run('grep "[invalid" /home/user/test.txt');
      expect(r.exitCode).toBe(2);
    });

    it('literal special chars with backslash', async () => {
      vfs.writeFile('/home/user/special.txt', new TextEncoder().encode('price: $10.00\nfoo.bar\n'));
      const r = await runner.run("grep '\\$10' /home/user/special.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('$10');
    });
  });

  // ---- Only matching (-o) ----
  describe('only matching (-o)', () => {
    it('-oE prints only matched text', async () => {
      const r = await runner.run('echo "abc123def456" | grep -oE "[0-9]+"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('123\n456\n');
    });

    it('-o with basic regex', async () => {
      const r = await runner.run('echo "hello world" | grep -o "hello"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('-o multiple matches per line', async () => {
      const r = await runner.run("echo 'aXbXcX' | grep -oE 'X'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('X\nX\nX\n');
    });

    it('-on shows line numbers', async () => {
      vfs.writeFile('/home/user/nums.txt', new TextEncoder().encode(
        'no match\nabc123xyz\nhello\n456world\n'
      ));
      const r = await runner.run('grep -onE "[0-9]+" /home/user/nums.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2:123\n4:456\n');
    });

    it('-oc counts total matches not lines', async () => {
      const r = await runner.run("echo 'aXbXcX' | grep -ocE 'X'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('3');
    });

    it('-oi case insensitive', async () => {
      const r = await runner.run("echo 'Hello HELLO hello' | grep -oiE 'hello'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Hello\nHELLO\nhello\n');
    });

    it('-o with no match exits 1', async () => {
      const r = await runner.run('echo "abc" | grep -o "xyz"');
      expect(r.exitCode).toBe(1);
    });

    it('-o with file input (not stdin)', async () => {
      const r = await runner.run('grep -oE "[0-9]+" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('123\n');
    });

    it('-o with multiple files shows filenames', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('cat dog\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('dog fish\n'));
      const r = await runner.run('grep -o "dog" /home/user/a.txt /home/user/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('/home/user/a.txt:dog');
      expect(r.stdout).toContain('/home/user/b.txt:dog');
    });

    it('-o with anchored pattern', async () => {
      const r = await runner.run('grep -o "^hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('hello');
    });

    it('-o with dot-star matches full span', async () => {
      const r = await runner.run('echo "abc" | grep -o "a.*c"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('abc');
    });

    it('-o with -v falls back to line mode', async () => {
      // -o combined with -v is undefined in GNU grep; we just output lines
      const r = await runner.run('grep -ov "hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('hello world');
      expect(r.stdout).toContain('foo bar');
    });

    it('-o with character class from file', async () => {
      const r = await runner.run('grep -oE "[a-z]+" /home/user/data.csv');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('name');
      expect(r.stdout).toContain('alice');
      expect(r.stdout).toContain('new');
      expect(r.stdout).toContain('york');
    });
  });

  // ---- Recursive ----
  describe('recursive (-r)', () => {
    it('-r searches directories', async () => {
      vfs.mkdir('/home/user/proj');
      vfs.mkdir('/home/user/proj/src');
      vfs.writeFile('/home/user/proj/src/main.rs', new TextEncoder().encode('fn main() {}\n'));
      vfs.writeFile('/home/user/proj/readme.txt', new TextEncoder().encode('main project\n'));
      const r = await runner.run('grep -r "main" /home/user/proj');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('src/main.rs');
      expect(r.stdout).toContain('readme.txt');
    });
  });

  // ---- Word match (-w) ----
  describe('word match (-w)', () => {
    it('-w matches whole words only', async () => {
      vfs.writeFile('/home/user/words.txt', new TextEncoder().encode(
        'test\ntesting\ncontest\ntest case\n'
      ));
      const r = await runner.run('grep -w "test" /home/user/words.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('test');
      expect(r.stdout).toContain('test case');
      expect(r.stdout).not.toContain('testing');
      expect(r.stdout).not.toContain('contest');
    });

    it('-wi case insensitive word match', async () => {
      const r = await runner.run('echo "Test testing TEST" | grep -ow -i "test"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Test\nTEST\n');
    });

    it('-w with no word boundary match exits 1', async () => {
      const r = await runner.run('echo "testing" | grep -w "test"');
      expect(r.exitCode).toBe(1);
    });
  });

  // ---- Quiet mode (-q) ----
  describe('quiet mode (-q)', () => {
    it('-q produces no output on match', async () => {
      const r = await runner.run('grep -q "hello" /home/user/test.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('-q exits 1 on no match', async () => {
      const r = await runner.run('grep -q "nonexistent" /home/user/test.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
    });

    it('-q in conditional', async () => {
      const r = await runner.run('if grep -q "hello" /home/user/test.txt; then echo found; else echo missing; fi');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('found');
    });
  });

  // ---- Fixed string (-F) ----
  describe('fixed string (-F)', () => {
    it('-F matches literal string', async () => {
      vfs.writeFile('/home/user/special.txt', new TextEncoder().encode(
        'price: $10.00\nfoo.bar\nfoo+bar\n'
      ));
      const r = await runner.run('grep -F "foo.bar" /home/user/special.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('foo.bar');
    });

    it('-F does not interpret regex metacharacters', async () => {
      vfs.writeFile('/home/user/meta.txt', new TextEncoder().encode(
        'a+b\na.b\na*b\n'
      ));
      const r = await runner.run('grep -F "a+b" /home/user/meta.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('a+b');
    });

    it('-Fi case insensitive fixed string', async () => {
      const r = await runner.run('echo "Hello.World" | grep -Fi "hello.world"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('Hello.World');
    });
  });

  // ---- Suppress errors (-s) ----
  describe('suppress errors (-s)', () => {
    it('-s suppresses file not found errors', async () => {
      const r = await runner.run('grep -s "hello" /home/user/nonexistent.txt');
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toBe('');
    });
  });

  // ---- Context lines (-A, -B, -C) ----
  describe('context lines', () => {
    beforeEach(() => {
      vfs.writeFile('/home/user/ctx.txt', new TextEncoder().encode(
        'line1\nline2\nMATCH\nline4\nline5\nline6\nMATCH2\nline8\n'
      ));
    });

    it('-A N prints N lines after match', async () => {
      const r = await runner.run('grep -A 1 "MATCH" /home/user/ctx.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('MATCH');
      expect(r.stdout).toContain('line4');
    });

    it('-B N prints N lines before match', async () => {
      const r = await runner.run('grep -B 1 "MATCH2" /home/user/ctx.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('line6');
      expect(r.stdout).toContain('MATCH2');
    });

    it('-C N prints N lines before and after', async () => {
      vfs.writeFile('/home/user/ctx2.txt', new TextEncoder().encode(
        'a\nb\nc\nTARGET\nd\ne\nf\n'
      ));
      const r = await runner.run('grep -C 1 "TARGET" /home/user/ctx2.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('c');
      expect(r.stdout).toContain('TARGET');
      expect(r.stdout).toContain('d');
    });

    it('-A with line numbers uses - separator for context', async () => {
      const r = await runner.run('grep -nA 1 "MATCH2" /home/user/ctx.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('7:MATCH2');
      expect(r.stdout).toContain('8-line8');
    });

    it('-B with line numbers uses - separator for context', async () => {
      const r = await runner.run('grep -nB 1 "MATCH2" /home/user/ctx.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('6-line6');
      expect(r.stdout).toContain('7:MATCH2');
    });

    it('context with no match exits 1', async () => {
      const r = await runner.run('grep -A 2 "NOPE" /home/user/ctx.txt');
      expect(r.exitCode).toBe(1);
    });
  });
});
