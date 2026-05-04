/**
 * Conformance tests for awk — exercises features beyond basic integration tests.
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

describe('awk conformance', () => {
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
  // Field splitting
  // ---------------------------------------------------------------------------
  describe('field splitting', () => {
    it('splits on default whitespace (spaces)', async () => {
      const result = await runner.run("echo 'alice bob charlie' | awk '{print $2}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('bob\n');
    });

    it('splits on default whitespace (tabs)', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('alice\tbob\tcharlie\n'));
      const result = await runner.run("awk '{print $3}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('charlie\n');
    });

    it('splits with -F single character separator', async () => {
      vfs.writeFile('/home/user/data.csv', new TextEncoder().encode('one:two:three\n'));
      const result = await runner.run("awk -F : '{print $2}' /home/user/data.csv");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('two\n');
    });

    it('splits with -F attached separator (no space)', async () => {
      vfs.writeFile('/home/user/data.csv', new TextEncoder().encode('a,b,c\nd,e,f\n'));
      const result = await runner.run("awk -F, '{print $1, $3}' /home/user/data.csv");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('a c\nd f\n');
    });

    it('splits with -F multi-character string separator', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a::b::c\n'));
      const result = await runner.run("awk -F '::' '{print $2}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('b\n');
    });

    it('splits with -F regex separator', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a1b2c3d\n'));
      const result = await runner.run("awk -F '[0-9]' '{print $2}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('b\n');
    });

    it('handles leading separators producing empty first field', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode(',a,b\n'));
      const result = await runner.run("awk -F , '{print NF; print $1 \"|\" $2 \"|\" $3}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      // $1 is empty, $2 is "a", $3 is "b", NF is 3
      expect(result.stdout).toBe('3\n|a|b\n');
    });

    it('handles trailing separators producing empty last field', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a,b,\n'));
      const result = await runner.run("awk -F , '{print NF; print $3}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      // trailing separator: NF is 3, $3 is empty string
      expect(result.stdout).toBe('3\n\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------------
  describe('output', () => {
    it('prints entire line with print $0', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello world\n'));
      const result = await runner.run("awk '{print $0}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello world\n');
    });

    it('prints last field with $NF', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('one two three\n'));
      const result = await runner.run("awk '{print $NF}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('three\n');
    });

    it('prints multiple fields with custom OFS', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a b c\n'));
      const result = await runner.run("awk 'BEGIN{OFS=\"-\"} {print $1, $2, $3}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('a-b-c\n');
    });

    it('uses custom ORS', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('line1\nline2\n'));
      const result = await runner.run("awk 'BEGIN{ORS=\"|\"} {print $0}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('line1|line2|');
    });

    it('formats output with printf %d and %s', async () => {
      const result = await runner.run("echo 'alice 42' | awk '{printf \"name=%s age=%d\\n\", $1, $2}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('name=alice age=42\n');
    });

    it('formats output with printf %05d and %-10s', async () => {
      const result = await runner.run("echo '7 hi' | awk '{printf \"%05d %-10s!\\n\", $1, $2}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('00007 hi        !\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Patterns and conditions
  // ---------------------------------------------------------------------------
  describe('patterns and conditions', () => {
    it('matches lines with regex /pattern/', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('apple\nbanana\napricot\ncherry\n'));
      const result = await runner.run("awk '/^a/' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('apple\napricot\n');
    });

    it('negates regex with !/pattern/', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('apple\nbanana\napricot\ncherry\n'));
      const result = await runner.run("awk '!/^a/' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('banana\ncherry\n');
    });

    it('uses comparison operators (>=)', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('10\n20\n30\n5\n'));
      const result = await runner.run("awk '$1 >= 20' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('20\n30\n');
    });

    it('uses string comparison (==)', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('alice 30\nbob 25\nalice 40\n'));
      const result = await runner.run("awk '$1 == \"alice\"' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('alice 30\nalice 40\n');
    });

    it('uses range pattern /start/,/stop/', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('before\nSTART\nmiddle1\nmiddle2\nSTOP\nafter\n'));
      const result = await runner.run("awk '/START/,/STOP/' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('START\nmiddle1\nmiddle2\nSTOP\n');
    });

    it('runs BEGIN block before processing', async () => {
      const result = await runner.run("echo 'ignored' | awk 'BEGIN{print \"header\"}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('header\n');
    });

    it('runs END block after processing', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\nc\n'));
      const result = await runner.run("awk '{count++} END{print count}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('3\n');
    });

    it('supports ternary operator', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('10\n25\n30\n15\n'));
      const result = await runner.run("awk '{print ($1 > 20 ? \"big\" : \"small\")}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('small\nbig\nbig\nsmall\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Built-in variables
  // ---------------------------------------------------------------------------
  describe('built-in variables', () => {
    it('NR gives the current line number across all files', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\nc\n'));
      const result = await runner.run("awk '{print NR, $0}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1 a\n2 b\n3 c\n');
    });

    it('NF gives the number of fields', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('one\none two\none two three\n'));
      const result = await runner.run("awk '{print NF}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1\n2\n3\n');
    });

    it('FS can be set in BEGIN block', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a:b:c\n'));
      const result = await runner.run("awk 'BEGIN{FS=\":\"} {print $2}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('b\n');
    });

    it('FILENAME contains current filename', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello\n'));
      const result = await runner.run("awk '{print FILENAME}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('/home/user/data.txt\n');
    });

    it('FNR resets per file', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('x\ny\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('p\nq\nr\n'));
      const result = await runner.run("awk '{print FILENAME, FNR}' /home/user/a.txt /home/user/b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/a.txt 1\n/home/user/a.txt 2\n/home/user/b.txt 1\n/home/user/b.txt 2\n/home/user/b.txt 3\n'
      );
    });

    it('NR continues across multiple files', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('x\ny\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('p\nq\n'));
      const result = await runner.run("awk '{print NR}' /home/user/a.txt /home/user/b.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1\n2\n3\n4\n');
    });
  });

  // ---------------------------------------------------------------------------
  // String functions
  // ---------------------------------------------------------------------------
  describe('string functions', () => {
    it('length() returns string length', async () => {
      const result = await runner.run("echo 'hello' | awk '{print length($0)}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('5\n');
    });

    it('substr() extracts substring', async () => {
      const result = await runner.run("echo 'abcdef' | awk '{print substr($0, 2, 3)}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('bcd\n');
    });

    it('index() finds position of substring', async () => {
      const result = await runner.run("echo 'hello world' | awk '{print index($0, \"world\")}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('7\n');
    });

    it('split() splits string into array', async () => {
      const result = await runner.run("echo 'a:b:c' | awk '{n = split($0, arr, \":\"); print n, arr[1], arr[2], arr[3]}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('3 a b c\n');
    });

    it('sub() replaces first occurrence', async () => {
      const result = await runner.run("echo 'foo foo foo' | awk '{sub(/foo/, \"bar\"); print}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('bar foo foo\n');
    });

    it('gsub() replaces all occurrences', async () => {
      const result = await runner.run("echo 'foo foo foo' | awk '{gsub(/foo/, \"bar\"); print}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('bar bar bar\n');
    });

    it('sprintf() formats a string without printing', async () => {
      const result = await runner.run("echo '3 7' | awk '{s = sprintf(\"%02d:%02d\", $1, $2); print s}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('03:07\n');
    });

    it('tolower() and toupper() convert case', async () => {
      const result = await runner.run("echo 'Hello World' | awk '{print tolower($0)}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello world\n');
    });

    it('toupper() converts to uppercase', async () => {
      const result = await runner.run("echo 'Hello World' | awk '{print toupper($0)}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('HELLO WORLD\n');
    });

    it('match() finds regex position and sets RSTART/RLENGTH', async () => {
      const result = await runner.run("echo 'abc123def' | awk '{match($0, /[0-9]+/); print RSTART, RLENGTH}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('4 3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Regex features (exercises regex crate port)
  // ---------------------------------------------------------------------------
  describe('regex', () => {
    it('pattern with character class matches lines', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('abc\n123\nA1b\n'));
      const result = await runner.run("awk '/[0-9]+/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('123');
      expect(result.stdout).toContain('A1b');
      expect(result.stdout).not.toContain('abc');
    });

    it('anchored pattern with ^ and $', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('hello\nhello world\nworld hello\n'));
      const result = await runner.run("awk '/^hello$/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    });

    it('alternation with | in pattern', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('cat\ndog\nbird\nfish\n'));
      const result = await runner.run("awk '/cat|fish/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('cat');
      expect(result.stdout).toContain('fish');
      expect(result.stdout).not.toContain('dog');
    });

    it('dot metacharacter in pattern', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('bat\nbet\nbit\nbot\nbut\n'));
      const result = await runner.run("awk '/b.t/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('bat\nbet\nbit\nbot\nbut\n');
    });

    it('sub() with regex pattern', async () => {
      const result = await runner.run("echo 'abc123def' | awk '{sub(/[0-9]+/, \"NUM\"); print}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('abcNUMdef\n');
    });

    it('gsub() with character class', async () => {
      const result = await runner.run("echo 'a1b2c3' | awk '{gsub(/[0-9]/, \"X\"); print}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('aXbXcX\n');
    });

    it('gsub() with alternation', async () => {
      const result = await runner.run("echo 'cat and dog' | awk '{gsub(/cat|dog/, \"pet\"); print}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('pet and pet\n');
    });

    it('match() with character class pattern', async () => {
      const result = await runner.run("echo 'abc123def' | awk '{match($0, /[a-z]+$/); print RSTART, RLENGTH}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('7 3\n');
    });

    it('field separator as regex (-F)', async () => {
      const result = await runner.run("echo 'a::b:::c' | awk -F ':+' '{print $1, $2, $3}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('a b c\n');
    });

    it('negated pattern with !', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('foo\nbar\nbaz\n'));
      const result = await runner.run("awk '!/bar/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('foo');
      expect(result.stdout).toContain('baz');
      expect(result.stdout).not.toContain('bar');
    });

    it('~ operator tests field against regex', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('alice 30\nbob 25\ncharlie 35\n'));
      const result = await runner.run("awk '$1 ~ /^[ab]/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('alice');
      expect(result.stdout).toContain('bob');
      expect(result.stdout).not.toContain('charlie');
    });

    it('!~ operator negates field regex test', async () => {
      vfs.writeFile('/home/user/re.txt', new TextEncoder().encode('alice 30\nbob 25\ncharlie 35\n'));
      const result = await runner.run("awk '$1 !~ /^[ab]/' /home/user/re.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('charlie 35');
    });

    it('gsub returns replacement count', async () => {
      const result = await runner.run("echo 'aaa' | awk '{n = gsub(/a/, \"b\"); print n, $0}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('3 bbb\n');
    });

    it('sub with & in replacement inserts matched text', async () => {
      const result = await runner.run("echo 'hello' | awk '{sub(/ell/, \"[&]\"); print}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('h[ell]o\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arithmetic
  // ---------------------------------------------------------------------------
  describe('arithmetic', () => {
    it('performs basic integer arithmetic', async () => {
      const result = await runner.run("echo '10 3' | awk '{print $1 + $2, $1 - $2, $1 * $2, int($1 / $2)}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('13 7 30 3\n');
    });

    it('computes modulo', async () => {
      const result = await runner.run("echo '17 5' | awk '{print $1 % $2}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('2\n');
    });

    it('computes exponentiation', async () => {
      const result = await runner.run("echo '2 10' | awk '{print $1 ^ $2}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1024\n');
    });

    it('supports pre-increment and post-increment', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a\nb\nc\n'));
      const result = await runner.run("awk 'BEGIN{x=0} {x++} END{print x}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arrays
  // ---------------------------------------------------------------------------
  describe('arrays', () => {
    it('uses associative arrays to count occurrences', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('apple\nbanana\napple\ncherry\nbanana\napple\n'));
      const result = await runner.run("awk '{count[$1]++} END{print count[\"apple\"]}' /home/user/data.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('3\n');
    });

    it('iterates arrays with for-in', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('a 1\nb 2\nc 3\n'));
      // Use for-in then pipe through sort to get deterministic output
      const result = await runner.run(
        "awk '{arr[$1]=$2} END{for(k in arr) print k, arr[k]}' /home/user/data.txt | sort"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('a 1\nb 2\nc 3\n');
    });

    it('deletes array elements', async () => {
      const result = await runner.run(
        "echo 'x' | awk 'BEGIN{a[1]=\"x\"; a[2]=\"y\"; a[3]=\"z\"; delete a[2]} {for(i=1;i<=3;i++) if(i in a) print i, a[i]}'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1 x\n3 z\n');
    });

    it('tests membership with (key in array)', async () => {
      const result = await runner.run(
        "echo 'x' | awk 'BEGIN{a[\"foo\"]=\"bar\"} {print (\"foo\" in a), (\"baz\" in a)}'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('1 0\n');
    });

    it('computes sum from associative array values', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('fruit 10\nveg 20\nfruit 5\nveg 15\n'));
      const result = await runner.run(
        "awk '{totals[$1] += $2} END{for(k in totals) print k, totals[k]}' /home/user/data.txt | sort"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('fruit 15\nveg 35\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple rules
  // ---------------------------------------------------------------------------
  describe('multiple rules', () => {
    it('applies multiple pattern-action pairs', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('5\n15\n25\n'));
      const result = await runner.run(
        "awk '$1 < 10 {print \"small:\", $1} $1 >= 20 {print \"big:\", $1}' /home/user/data.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('small: 5\nbig: 25\n');
    });

    it('allows fall-through: line matches multiple rules', async () => {
      const result = await runner.run(
        "echo '50' | awk '$1 > 10 {print \"gt10\"} $1 > 20 {print \"gt20\"} $1 > 40 {print \"gt40\"}'"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('gt10\ngt20\ngt40\n');
    });

    it('combines BEGIN, main rule, and END', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('10\n20\n30\n'));
      const result = await runner.run(
        "awk 'BEGIN{print \"start\"} {sum+=$1} END{print \"sum=\" sum}' /home/user/data.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('start\nsum=60\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Pipes and I/O
  // ---------------------------------------------------------------------------
  describe('pipes and I/O', () => {
    it('receives piped input from another command', async () => {
      const result = await runner.run("seq 1 5 | awk '{sum += $1} END{print sum}'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('15\n');
    });

    it('processes multiple files in sequence', async () => {
      vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('10\n'));
      vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('20\n'));
      vfs.writeFile('/home/user/c.txt', new TextEncoder().encode('30\n'));
      const result = await runner.run(
        "awk '{sum += $1} END{print sum}' /home/user/a.txt /home/user/b.txt /home/user/c.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('60\n');
    });

    it('uses getline to read next line', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('header\nvalue1\nvalue2\n'));
      const result = await runner.run(
        "awk 'NR==1 {hdr=$0; getline; print hdr, $0}' /home/user/data.txt"
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('header value1\n');
    });

    it('uses print with output redirection to file', async () => {
      vfs.writeFile('/home/user/data.txt', new TextEncoder().encode('hello\nworld\n'));
      const result = await runner.run(
        "awk '{print $0 > \"/home/user/out.txt\"}' /home/user/data.txt"
      );
      expect(result.exitCode).toBe(0);
      const content = new TextDecoder().decode(vfs.readFile('/home/user/out.txt'));
      expect(content).toBe('hello\nworld\n');
    });
  });
});
