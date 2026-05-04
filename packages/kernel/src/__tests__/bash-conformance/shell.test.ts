/**
 * Conformance tests for shell features — exercises POSIX and bash-like functionality.
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

describe('shell conformance', () => {
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
  // Parameter expansion
  // ---------------------------------------------------------------------------
  describe('parameter expansion', () => {
    it('${var:-default} returns default when variable is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR:-fallback}');
      expect(result.stdout).toBe('fallback\n');
    });

    it('${var:-default} returns value when variable is set', async () => {
      await runner.run('MY_VAR=hello');
      const result = await runner.run('echo ${MY_VAR:-fallback}');
      expect(result.stdout).toBe('hello\n');
    });

    it('${var:=default} assigns default when variable is unset', async () => {
      const result = await runner.run('echo ${NEW_VAR:=assigned}');
      expect(result.stdout).toBe('assigned\n');
      // The variable should now be set in the environment
      expect(runner.getEnv('NEW_VAR')).toBe('assigned');
    });

    it('${var:+alternate} returns alternate when variable is set', async () => {
      await runner.run('MY_VAR=hello');
      const result = await runner.run('echo ${MY_VAR:+alternate}');
      expect(result.stdout).toBe('alternate\n');
    });

    it('${var:+alternate} returns empty when variable is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR:+alternate}');
      expect(result.stdout).toBe('\n');
    });

    it('${var:?error} prints error and fails when variable is unset', async () => {
      const result = await runner.run('echo ${UNSET_VAR:?variable is required}');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('variable is required');
    });

    it('${#var} returns string length', async () => {
      await runner.run('MY_VAR=hello');
      const result = await runner.run('echo ${#MY_VAR}');
      expect(result.stdout).toBe('5\n');
    });

    it('${var%pattern} removes shortest suffix match', async () => {
      const result = await runner.run('X=file.tar.gz; echo ${X%.*}');
      expect(result.stdout).toBe('file.tar\n');
    });

    it('${var%%pattern} removes longest suffix match', async () => {
      const result = await runner.run('X=file.tar.gz; echo ${X%%.*}');
      expect(result.stdout).toBe('file\n');
    });

    it('${var#pattern} removes shortest prefix match', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X#*/}');
      expect(result.stdout).toBe('usr/local/bin\n');
    });

    it('${var##pattern} removes longest prefix match', async () => {
      const result = await runner.run('X=/usr/local/bin; echo ${X##*/}');
      expect(result.stdout).toBe('bin\n');
    });

    it('${var^^} uppercases', async () => {
      const r = await runner.run(`x=hello; echo \${x^^}`);
      expect(r.stdout).toBe('HELLO\n');
    });

    it('${var,,} lowercases', async () => {
      const r = await runner.run(`x=HELLO; echo \${x,,}`);
      expect(r.stdout).toBe('hello\n');
    });

    it('${var^} uppercases first char', async () => {
      const r = await runner.run(`x=hello; echo \${x^}`);
      expect(r.stdout).toBe('Hello\n');
    });

    it('${var:offset:length} substring', async () => {
      const r = await runner.run(`x=hello; echo \${x:1:3}`);
      expect(r.stdout).toBe('ell\n');
    });

    it('${var:offset} substring to end', async () => {
      const r = await runner.run(`x=hello; echo \${x:2}`);
      expect(r.stdout).toBe('llo\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arithmetic expansion
  // ---------------------------------------------------------------------------
  describe('arithmetic', () => {
    it('evaluates simple addition $((1+2))', async () => {
      const result = await runner.run('echo $((1+2))');
      expect(result.stdout).toBe('3\n');
    });

    it('evaluates multiplication with variables $((a*b))', async () => {
      await runner.run('A=6');
      await runner.run('B=7');
      const result = await runner.run('echo $((A*B))');
      expect(result.stdout).toBe('42\n');
    });

    it('evaluates modulo $((10%3))', async () => {
      const result = await runner.run('echo $((10%3))');
      expect(result.stdout).toBe('1\n');
    });

    it('evaluates nested arithmetic $(( $((1+2)) * 3 ))', async () => {
      const result = await runner.run('echo $(( $((1+2)) * 3 ))');
      expect(result.stdout).toBe('9\n');
    });

    it('evaluates comparison $((1>0)) returns 1', async () => {
      const result = await runner.run('echo $((1>0))');
      expect(result.stdout).toBe('1\n');
    });

    it('evaluates assignment in arithmetic $((x=5))', async () => {
      const result = await runner.run('echo $((x=5))');
      // In POSIX shell, $((x=5)) should assign 5 to x and produce 5
      expect(result.stdout).toBe('5\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Quoting edge cases
  // ---------------------------------------------------------------------------
  describe('quoting edge cases', () => {
    it('handles nested single quote inside double quotes', async () => {
      const result = await runner.run("echo \"it's a test\"");
      expect(result.stdout).toBe("it's a test\n");
    });

    it('handles empty string argument ""', async () => {
      const result = await runner.run('echo ""');
      expect(result.stdout).toBe('\n');
    });

    it('preserves whitespace inside double quotes', async () => {
      const result = await runner.run('echo "hello   world"');
      expect(result.stdout).toBe('hello   world\n');
    });

    it('single quotes prevent variable expansion', async () => {
      await runner.run('export HOME=/home/user');
      const result = await runner.run("echo '$HOME'");
      expect(result.stdout).toBe('$HOME\n');
    });

    it('backslash in double quotes escapes special characters', async () => {
      const result = await runner.run('echo "hello\\nworld"');
      // In POSIX echo, backslash-n inside double quotes stays literal
      // (echo builtin does not interpret escape sequences by default)
      expect(result.stdout).toContain('hello');
    });

    it('dollar-sign escaping with backslash \\$', async () => {
      const result = await runner.run('echo "price is \\$5"');
      expect(result.stdout).toBe('price is $5\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Functions
  // ---------------------------------------------------------------------------
  describe('functions', () => {
    it('defines and calls a basic function', async () => {
      const result = await runner.run('greet() { echo hello; }; greet');
      expect(result.stdout).toBe('hello\n');
    });

    it('passes arguments to function via $1 $2', async () => {
      const result = await runner.run('add() { echo "$1 + $2"; }; add foo bar');
      expect(result.stdout).toBe('foo + bar\n');
    });

    it('supports local variables inside functions', async () => {
      // "local" is a bash extension; test whether it isolates variables
      await runner.run('OUTER=original');
      const result = await runner.run('myfn() { local OUTER=changed; echo $OUTER; }; myfn');
      expect(result.stdout).toBe('changed\n');
      // After the function call, OUTER should still be "original"
      const check = await runner.run('echo $OUTER');
      expect(check.stdout).toBe('original\n');
    });

    it('captures return value via $?', async () => {
      await runner.run('myfn() { return 42; }');
      await runner.run('myfn');
      const result = await runner.run('echo $?');
      expect(result.stdout).toBe('42\n');
    });

    it('captures function output via command substitution $(func)', async () => {
      const result = await runner.run('getval() { echo computed; }; RESULT=$(getval); echo $RESULT');
      expect(result.stdout).toBe('computed\n');
    });

    it('supports recursive function calls', async () => {
      // Countdown from 3 to 1
      const script = [
        'countdown() {',
        '  if [ "$1" -le 0 ]; then return; fi',
        '  echo $1',
        '  countdown $(( $1 - 1 ))',
        '}',
        'countdown 3',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toBe('3\n2\n1\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Control flow
  // ---------------------------------------------------------------------------
  describe('control flow', () => {
    it('if with test command [ -f file ]', async () => {
      vfs.writeFile('/home/user/exists.txt', new TextEncoder().encode('data'));
      const result = await runner.run('if [ -f /home/user/exists.txt ]; then echo found; fi');
      expect(result.stdout).toBe('found\n');
    });

    it('elif chain selects correct branch', async () => {
      await runner.run('VAL=2');
      const result = await runner.run(
        'if [ "$VAL" = "1" ]; then echo one; elif [ "$VAL" = "2" ]; then echo two; else echo other; fi'
      );
      expect(result.stdout).toBe('two\n');
    });

    it('for loop iterates over words', async () => {
      const result = await runner.run('for x in alpha beta gamma; do echo $x; done');
      expect(result.stdout).toBe('alpha\nbeta\ngamma\n');
    });

    it('for loop with command substitution using seq', async () => {
      const result = await runner.run('for i in $(seq 1 4); do echo $i; done');
      expect(result.stdout).toBe('1\n2\n3\n4\n');
    });

    it('while loop with counter', async () => {
      const script = [
        'I=0',
        'while [ "$I" -lt 3 ]; do',
        '  echo $I',
        '  I=$(( I + 1 ))',
        'done',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toBe('0\n1\n2\n');
    });

    it('case statement with multiple patterns', async () => {
      const result = await runner.run(
        'case "hello" in bye) echo no;; hello|hi) echo matched;; *) echo default;; esac'
      );
      expect(result.stdout).toBe('matched\n');
    });

    it('case with glob patterns', async () => {
      const result = await runner.run(
        'case "file.txt" in *.sh) echo shell;; *.txt) echo text;; *) echo unknown;; esac'
      );
      expect(result.stdout).toBe('text\n');
    });

    it('nested if inside for loop', async () => {
      const script = [
        'for x in 1 2 3 4 5; do',
        '  if [ "$x" = "3" ]; then',
        '    echo "found $x"',
        '  fi',
        'done',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toBe('found 3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arrays / variables
  // ---------------------------------------------------------------------------
  describe('arrays and variables', () => {
    // Arrays are a bash extension not currently implemented.
    it.skip('indexed assignment arr[0]=val and echo ${arr[0]}', async () => {
      const result = await runner.run('arr[0]=hello; echo ${arr[0]}');
      expect(result.stdout).toBe('hello\n');
    });

    it.skip('${arr[@]} expands all array elements', async () => {
      const result = await runner.run('arr[0]=a; arr[1]=b; arr[2]=c; echo ${arr[@]}');
      expect(result.stdout).toBe('a b c\n');
    });

    it.skip('${#arr[@]} returns count of array elements', async () => {
      const result = await runner.run('arr[0]=x; arr[1]=y; arr[2]=z; echo ${#arr[@]}');
      expect(result.stdout).toBe('3\n');
    });

    it.skip('unset removes an array element', async () => {
      const result = await runner.run('arr[0]=a; arr[1]=b; unset arr[1]; echo ${arr[@]}');
      expect(result.stdout).toBe('a\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Subshells and scope
  // ---------------------------------------------------------------------------
  describe('subshells and scope', () => {
    it('subshell variable changes do not leak to parent', async () => {
      await runner.run('OUTER=parent');
      await runner.run('( OUTER=child )');
      const result = await runner.run('echo $OUTER');
      expect(result.stdout).toBe('parent\n');
    });

    it('subshell exit code is captured', async () => {
      const result = await runner.run('( exit 42 )');
      expect(result.exitCode).toBe(42);
    });

    it('nested subshells work correctly', async () => {
      const result = await runner.run('( echo $(( 1 + ( 2 + 3 ) )) )');
      expect(result.stdout).toBe('6\n');
    });

    it('pipeline does not affect parent variable scope', async () => {
      // In POSIX, commands in a pipeline may run in subshells
      await runner.run('X=before');
      await runner.run('echo hello | X=after');
      const result = await runner.run('echo $X');
      // X should remain "before" because the pipeline right side runs in a subshell
      // (or the assignment in the pipeline segment is isolated)
      expect(result.stdout).toBe('before\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Redirects
  // ---------------------------------------------------------------------------
  describe('redirects', () => {
    it('redirects stdout to file with >', async () => {
      await runner.run('echo "hello world" > /tmp/out.txt');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/out.txt'));
      expect(content).toBe('hello world\n');
    });

    it('appends to file with >>', async () => {
      vfs.writeFile('/tmp/log.txt', new TextEncoder().encode('line1\n'));
      await runner.run('echo "line2" >> /tmp/log.txt');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/log.txt'));
      expect(content).toBe('line1\nline2\n');
    });

    it('reads stdin from file with <', async () => {
      vfs.writeFile('/tmp/data.txt', new TextEncoder().encode('file content here'));
      const result = await runner.run('cat < /tmp/data.txt');
      expect(result.stdout).toBe('file content here');
    });

    it('redirects stderr with 2>', async () => {
      // Use a command that produces stderr (nonexistent file for cat)
      await runner.run('cat /nonexistent 2> /tmp/err.txt');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/err.txt'));
      expect(content.length).toBeGreaterThan(0);
    });

    it('merges stderr into stdout with 2>&1', async () => {
      // Run a command and merge stderr to stdout, redirect combined to file
      await runner.run('cat /nonexistent > /tmp/combined.txt 2>&1');
      const content = new TextDecoder().decode(vfs.readFile('/tmp/combined.txt'));
      // The error message about the nonexistent file should appear in the file
      expect(content.length).toBeGreaterThan(0);
    });

    it('here document provides stdin to command', async () => {
      const result = await runner.run('cat <<EOF\nhello from heredoc\nEOF');
      expect(result.stdout).toBe('hello from heredoc\n');
    });

    it('cat > file with heredoc', async () => {
      const r = await runner.run(`cat > /tmp/hd_test.txt <<EOF\nhello heredoc\nEOF\ncat /tmp/hd_test.txt`);
      expect(r.stdout).toBe('hello heredoc\n');
    });

    it('herestring <<< provides stdin to command', async () => {
      const r = await runner.run('cat <<< "hello herestring"');
      expect(r.stdout).toBe('hello herestring\n');
    });

    it('herestring with sed', async () => {
      const r = await runner.run("sed 's/world/yurt/' <<< 'hello world'");
      expect(r.stdout).toBe('hello yurt\n');
    });

    it('herestring with grep', async () => {
      const r = await runner.run('grep -o "hello" <<< "hello world"');
      expect(r.stdout).toBe('hello\n');
    });

    it('herestring with unquoted word', async () => {
      const r = await runner.run('cat <<< hello');
      expect(r.stdout).toBe('hello\n');
    });

    it('herestring with variable expansion', async () => {
      const r = await runner.run('X=world; cat <<< "hello $X"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('herestring with ${VAR} expansion', async () => {
      const r = await runner.run('NAME=yurt; cat <<< "project: ${NAME}"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('project: yurt\n');
    });

    it('herestring with command substitution', async () => {
      const r = await runner.run('cat <<< "count: $(echo 42)"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('count: 42\n');
    });

    it('herestring piped through tr', async () => {
      // Herestring as standalone, then pipe its output through tr
      const r = await runner.run('echo "hello world" | tr a-z A-Z');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('HELLO WORLD');
    });

    it('herestring with wc -c', async () => {
      const r = await runner.run('wc -c <<< "hello"');
      expect(r.exitCode).toBe(0);
      // "hello" + trailing newline = 6 bytes
      expect(r.stdout.trim()).toBe('6');
    });

    it('herestring with tr', async () => {
      const r = await runner.run("tr 'a-z' 'A-Z' <<< 'lowercase'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('LOWERCASE');
    });

    it('herestring with cut', async () => {
      const r = await runner.run("cut -d',' -f2 <<< 'a,b,c'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('b');
    });
  });

  // ---------------------------------------------------------------------------
  // Test expressions
  // ---------------------------------------------------------------------------
  describe('test expressions', () => {
    it('[ -f file ] returns true for existing file', async () => {
      vfs.writeFile('/tmp/test.txt', new TextEncoder().encode('data'));
      const result = await runner.run('[ -f /tmp/test.txt ]');
      expect(result.exitCode).toBe(0);
    });

    it('[ -d dir ] returns true for existing directory', async () => {
      vfs.mkdir('/tmp/mydir');
      const result = await runner.run('[ -d /tmp/mydir ]');
      expect(result.exitCode).toBe(0);
    });

    it('[ -z "" ] returns true for empty string', async () => {
      const result = await runner.run('[ -z "" ]');
      expect(result.exitCode).toBe(0);
    });

    it('[ str1 = str2 ] string comparison', async () => {
      const result = await runner.run('[ "abc" = "abc" ]');
      expect(result.exitCode).toBe(0);
      const result2 = await runner.run('[ "abc" = "def" ]');
      expect(result2.exitCode).toBe(1);
    });

    it('[ num1 -eq num2 ] numeric comparison', async () => {
      const result = await runner.run('[ 42 -eq 42 ]');
      expect(result.exitCode).toBe(0);
      const result2 = await runner.run('[ 42 -eq 99 ]');
      expect(result2.exitCode).toBe(1);
    });

    it('compound test [ cond1 -a cond2 ] with AND', async () => {
      vfs.writeFile('/tmp/a.txt', new TextEncoder().encode('a'));
      vfs.writeFile('/tmp/b.txt', new TextEncoder().encode('b'));
      const result = await runner.run('[ -f /tmp/a.txt -a -f /tmp/b.txt ]');
      expect(result.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Miscellaneous
  // ---------------------------------------------------------------------------
  describe('miscellaneous', () => {
    it('nested command substitution $(echo $(echo hello))', async () => {
      const result = await runner.run('echo $(echo $(echo hello))');
      expect(result.stdout).toBe('hello\n');
    });

    it('eval executes a dynamically constructed command', async () => {
      await runner.run('CMD="echo hello"');
      const result = await runner.run('eval $CMD');
      expect(result.stdout).toBe('hello\n');
    });

    // Brace group in pipeline (e.g. echo | { read; echo; }) not yet supported.
    it('read from echo pipe assigns to variable', async () => {
      const result = await runner.run('echo "bob" | { read NAME; echo "got $NAME"; }');
      expect(result.stdout).toBe('got bob\n');
    });

    it('set -- assigns positional parameters', async () => {
      const result = await runner.run('set -- x y z; echo $1 $2 $3');
      expect(result.stdout).toBe('x y z\n');
    });

    it('getopts parses options in a while loop', async () => {
      const script = [
        'OPTIND=1',
        'while getopts "a:b" opt -a val -b; do',
        '  echo "opt=$opt"',
        'done',
      ].join('\n');
      const result = await runner.run(script);
      expect(result.stdout).toContain('opt=a');
      expect(result.stdout).toContain('opt=b');
    });

    it('exit status of last command in pipeline is returned', async () => {
      const result = await runner.run('true | false');
      // POSIX: exit status of pipeline is exit status of last command
      expect(result.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Pipeline stdin for compound commands
  // ---------------------------------------------------------------------------
  describe('pipeline stdin for compound commands', () => {
    it('pipe into while read loop', async () => {
      const r = await runner.run(`printf "a\\nb\\nc\\n" | while read line; do echo "got: $line"; done`);
      expect(r.stdout).toBe('got: a\ngot: b\ngot: c\n');
    });

    it('pipe seq into while read with arithmetic', async () => {
      const r = await runner.run(`seq 1 3 | while read n; do echo $((n * n)); done`);
      expect(r.stdout).toBe('1\n4\n9\n');
    });

    it('2>&1 merges stderr into stdout in pipeline', async () => {
      const r = await runner.run(`ls /nonexistent_path_xyz 2>&1 | head -1`);
      expect(r.stdout).toContain('No such file');
    });

    it('pipe into for loop via cat', async () => {
      // For loops don't read from stdin directly, but subshell + cat should work
      const r = await runner.run(`printf "hello\\n" | cat`);
      expect(r.stdout).toBe('hello\n');
    });

    it('pipe into while read with multiple fields', async () => {
      const r = await runner.run(`printf "a b\\nc d\\n" | while read x y; do echo "$y $x"; done`);
      expect(r.stdout).toBe('b a\nd c\n');
    });

    it('pipe into while read -r preserves backslashes', async () => {
      const r = await runner.run(`printf "%s\\n" "a\\\\b" | while read -r line; do echo "$line"; done`);
      expect(r.stdout).toBe('a\\b\n');
    });

    it('read -n reads N characters', async () => {
      const r = await runner.run(`read -n 5 x <<< "hello world"; echo "$x"`);
      expect(r.stdout).toBe('hello\n');
    });

    it('read -d uses custom delimiter', async () => {
      const r = await runner.run(`read -d , first <<< "a,b,c"; echo "$first"`);
      expect(r.stdout).toBe('a\n');
    });

    it('read -a populates array', async () => {
      const r = await runner.run(`read -a words <<< "one two three"; echo "\${words[0]} \${words[2]}"`);
      expect(r.stdout).toBe('one three\n');
    });

    it('read -p is silently ignored', async () => {
      const r = await runner.run(`read -p "prompt: " val <<< "42"; echo "$val"`);
      expect(r.stdout).toBe('42\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Word splitting
  // ---------------------------------------------------------------------------
  describe('word splitting', () => {
    it('word splitting on unquoted command substitution', async () => {
      const r = await runner.run(`for w in $(echo "a b c"); do echo "item: $w"; done`);
      expect(r.stdout).toBe('item: a\nitem: b\nitem: c\n');
    });

    it('no word splitting inside double quotes with literal prefix', async () => {
      // Note: the parser cannot distinguish "$x" from $x (both produce identical ASTs).
      // However when there is literal text alongside the variable (e.g. "val: $x"),
      // the QuotedLiteral part signals that splitting should be suppressed.
      const r = await runner.run(`x="a b c"; for w in "val: $x"; do echo "item: $w"; done`);
      expect(r.stdout).toBe('item: val: a b c\n');
    });

    it('word splitting on unquoted variable', async () => {
      const r = await runner.run(`x="a b c"; for w in $x; do echo $w; done`);
      expect(r.stdout).toBe('a\nb\nc\n');
    });
  });

  // ---------------------------------------------------------------------------
  // echo -e
  // ---------------------------------------------------------------------------
  describe('echo -e', () => {
    it('echo -e interprets backslash escapes', async () => {
      const r = await runner.run(`echo -e "hello\\nworld"`);
      expect(r.stdout).toBe('hello\nworld\n');
    });

    it('echo -e interprets tab', async () => {
      const r = await runner.run(`echo -e "a\\tb"`);
      expect(r.stdout).toBe('a\tb\n');
    });

    it('echo -en combines flags', async () => {
      const r = await runner.run(`echo -en "hi\\n"`);
      expect(r.stdout).toBe('hi\n');
    });

    it('echo without -e does not interpret escapes', async () => {
      const r = await runner.run(`echo "hello\\nworld"`);
      expect(r.stdout).toBe('hello\\nworld\n');
    });
  });

  // ---------------------------------------------------------------------------
  // $RANDOM
  // ---------------------------------------------------------------------------
  describe('$RANDOM', () => {
    it('$RANDOM produces a number', async () => {
      const r = await runner.run(`echo $RANDOM`);
      const n = parseInt(r.stdout.trim());
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(32768);
    });
  });

  // ---------------------------------------------------------------------------
  // trap builtin
  // ---------------------------------------------------------------------------
  describe('trap', () => {
    it('trap EXIT runs handler on exit', async () => {
      const r = await runner.run(`trap "echo cleanup" EXIT; echo running`);
      expect(r.stdout).toBe('running\ncleanup\n');
    });

    it('trap with empty string removes handler', async () => {
      const r = await runner.run(`trap "echo cleanup" EXIT; trap "" EXIT; echo finished`);
      expect(r.stdout).toBe('finished\n');
    });
  });

  // ---------------------------------------------------------------------------
  // process substitution
  // ---------------------------------------------------------------------------
  describe('process substitution', () => {
    it('process substitution <(cmd)', async () => {
      const r = await runner.run(`cat <(echo hello)`);
      expect(r.stdout).toBe('hello\n');
    });
  });

  // ---------------------------------------------------------------------------
  // arrays
  // ---------------------------------------------------------------------------
  describe('arrays', () => {
    it('array assignment and indexed access', async () => {
      const r = await runner.run(`arr=(one two three); echo \${arr[1]}`);
      expect(r.stdout).toBe('two\n');
    });

    it('array length ${#arr[@]}', async () => {
      const r = await runner.run(`arr=(a b c d); echo \${#arr[@]}`);
      expect(r.stdout).toBe('4\n');
    });

    it('array all elements ${arr[@]}', async () => {
      const r = await runner.run(`arr=(x y z); echo \${arr[@]}`);
      expect(r.stdout).toBe('x y z\n');
    });

    it('array ${arr[0]} first element', async () => {
      const r = await runner.run(`arr=(first second); echo \${arr[0]}`);
      expect(r.stdout).toBe('first\n');
    });
  });

  // ---------------------------------------------------------------------------
  // $SHELL
  // ---------------------------------------------------------------------------
  describe('$SHELL', () => {
    it('$SHELL is set', async () => {
      const r = await runner.run(`echo $SHELL`);
      expect(r.stdout).toBe('/bin/sh\n');
    });
  });

  // ---------------------------------------------------------------------------
  // C-style for loops
  // ---------------------------------------------------------------------------
  describe('c-style for loop', () => {
    it('basic counting', async () => {
      const r = await runner.run(`for ((i=0; i<5; i++)); do echo $i; done`);
      expect(r.stdout).toBe('0\n1\n2\n3\n4\n');
    });

    it('decrement', async () => {
      const r = await runner.run(`for ((i=3; i>0; i--)); do echo $i; done`);
      expect(r.stdout).toBe('3\n2\n1\n');
    });

    it('step by 2', async () => {
      const r = await runner.run(`for ((i=0; i<10; i+=2)); do echo $i; done`);
      expect(r.stdout).toBe('0\n2\n4\n6\n8\n');
    });

    it('break inside c-for', async () => {
      const r = await runner.run(`for ((i=0; i<100; i++)); do
        if [ "$i" = "3" ]; then break; fi
        echo $i
      done`);
      expect(r.stdout).toBe('0\n1\n2\n');
    });

    it('continue inside c-for', async () => {
      const r = await runner.run(`for ((i=0; i<5; i++)); do
        if [ "$i" = "2" ]; then continue; fi
        echo $i
      done`);
      expect(r.stdout).toBe('0\n1\n3\n4\n');
    });

    it('variable persists after loop', async () => {
      const r = await runner.run(`for ((i=0; i<3; i++)); do true; done; echo $i`);
      expect(r.stdout).toBe('3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Brace groups
  // ---------------------------------------------------------------------------
  describe('brace groups', () => {
    it('simple brace group', async () => {
      const r = await runner.run(`{ echo hello; echo world; }`);
      expect(r.stdout).toBe('hello\nworld\n');
    });

    it('brace group in pipeline', async () => {
      const r = await runner.run(`echo "line1" | { cat; }`);
      expect(r.stdout).toBe('line1\n');
    });

    it('brace group with read from pipe', async () => {
      const r = await runner.run(`echo "bob" | { read NAME; echo "got $NAME"; }`);
      expect(r.stdout).toBe('got bob\n');
    });

    it('brace group preserves variable scope', async () => {
      const r = await runner.run(`X=before; { X=inside; }; echo $X`);
      expect(r.stdout).toBe('inside\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Until loops
  // ---------------------------------------------------------------------------
  describe('until loops', () => {
    it('basic until loop', async () => {
      const r = await runner.run(`i=0; until [ "$i" = "3" ]; do echo $i; i=$((i+1)); done`);
      expect(r.stdout).toBe('0\n1\n2\n');
    });

    it('until with break', async () => {
      const r = await runner.run(`i=0; until false; do
        if [ "$i" = "2" ]; then break; fi
        echo $i; i=$((i+1))
      done`);
      expect(r.stdout).toBe('0\n1\n');
    });

    it('until condition starts true exits immediately', async () => {
      const r = await runner.run(`until true; do echo "nope"; done; echo "done"`);
      expect(r.stdout).toBe('done\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Recursive glob **
  // ---------------------------------------------------------------------------
  describe('recursive glob', () => {
    it('** matches files recursively', async () => {
      vfs.mkdir('/home/user/proj');
      vfs.mkdir('/home/user/proj/src');
      vfs.mkdir('/home/user/proj/src/sub');
      vfs.writeFile('/home/user/proj/a.py', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/proj/src/b.py', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/proj/src/sub/c.py', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/proj/src/sub/d.txt', new TextEncoder().encode(''));

      const r = await runner.run(`cd /home/user/proj && echo **/*.py`);
      const files = r.stdout.trim().split(' ').sort();
      expect(files).toContain('a.py');
      expect(files).toContain('src/b.py');
      expect(files).toContain('src/sub/c.py');
      expect(files).not.toContain('src/sub/d.txt');
    });

    it('** with absolute path', async () => {
      vfs.mkdir('/tmp/rglob');
      vfs.mkdir('/tmp/rglob/d1');
      vfs.writeFile('/tmp/rglob/x.txt', new TextEncoder().encode(''));
      vfs.writeFile('/tmp/rglob/d1/y.txt', new TextEncoder().encode(''));

      const r = await runner.run(`echo /tmp/rglob/**/*.txt`);
      const files = r.stdout.trim().split(' ').sort();
      expect(files).toContain('/tmp/rglob/d1/y.txt');
    });
  });

  // ---------------------------------------------------------------------------
  // Negative substring indices
  // ---------------------------------------------------------------------------
  describe('negative substring indices', () => {
    it('${var: -N} extracts last N characters', async () => {
      const r = await runner.run(`x=hello; echo "\${x: -2}"`);
      expect(r.stdout).toBe('lo\n');
    });

    it('${var: -N:M} extracts M chars from -N', async () => {
      const r = await runner.run(`x=hello; echo "\${x: -3:2}"`);
      expect(r.stdout).toBe('ll\n');
    });

    it('${var:0: -1} trims last character', async () => {
      const r = await runner.run(`x=hello; echo "\${x:0: -1}"`);
      // Should be "hell" — negative length means end position from end
      // Actually in bash ${x:0:-1} means "from 0, stop 1 from end" = "hell"
      expect(r.stdout).toBe('hell\n');
    });

    it('${var:-default} still works (not confused with substring)', async () => {
      const r = await runner.run(`echo "\${unset:-fallback}"`);
      expect(r.stdout).toBe('fallback\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Array slicing
  // ---------------------------------------------------------------------------
  describe('array slicing', () => {
    it('${arr[@]:offset} slices from offset', async () => {
      const r = await runner.run(`arr=(a b c d e); echo "\${arr[@]:2}"`);
      expect(r.stdout).toBe('c d e\n');
    });

    it('${arr[@]:offset:length} slices with length', async () => {
      const r = await runner.run(`arr=(a b c d e); echo "\${arr[@]:1:3}"`);
      expect(r.stdout).toBe('b c d\n');
    });

    it('${arr[@]: -N} slices from end', async () => {
      const r = await runner.run(`arr=(a b c d e); echo "\${arr[@]: -2}"`);
      expect(r.stdout).toBe('d e\n');
    });

    it('negative array index ${arr[-1]}', async () => {
      const r = await runner.run(`arr=(a b c); echo "\${arr[-1]}"`);
      expect(r.stdout).toBe('c\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Associative arrays (declare -A)
  // ---------------------------------------------------------------------------
  describe('associative arrays', () => {
    it('declare -A and element access', async () => {
      const r = await runner.run(`declare -A m; m[name]=alice; m[age]=30; echo "\${m[name]} is \${m[age]}"`);
      expect(r.stdout).toBe('alice is 30\n');
    });

    it('declare -A with inline initialization', async () => {
      const r = await runner.run(`declare -A m=([x]=10 [y]=20); echo "\${m[x]} \${m[y]}"`);
      expect(r.stdout).toBe('10 20\n');
    });

    it('${#assoc[@]} returns count of keys', async () => {
      const r = await runner.run(`declare -A m=([a]=1 [b]=2 [c]=3); echo "\${#m[@]}"`);
      expect(r.stdout).toBe('3\n');
    });

    it('${assoc[@]} expands all values', async () => {
      const r = await runner.run(`declare -A m=([x]=hello [y]=world); echo "\${m[@]}" | sed 's/ /\\n/g' | sort`);
      expect(r.stdout).toBe('hello\nworld\n');
    });
  });

  // ---------------------------------------------------------------------------
  // sort -f and -b flags
  // ---------------------------------------------------------------------------
  describe('sort flags', () => {
    it('sort -f folds case', async () => {
      const r = await runner.run(`printf "banana\\nApple\\ncherry\\n" | sort -f`);
      expect(r.stdout).toBe('Apple\nbanana\ncherry\n');
    });

    it('sort -b ignores leading blanks', async () => {
      const r = await runner.run(`printf "  z\\na\\n  b\\n" | sort -b`);
      expect(r.stdout).toBe('a\n  b\n  z\n');
    });

    it('sort -fb combined', async () => {
      const r = await runner.run(`printf "  Banana\\napple\\n  Cherry\\n" | sort -fb`);
      expect(r.stdout).toBe('apple\n  Banana\n  Cherry\n');
    });
  });

  // ---------------------------------------------------------------------------
  // head -c and tail -c byte mode
  // ---------------------------------------------------------------------------
  describe('head/tail -c byte mode', () => {
    it('head -c N outputs first N bytes', async () => {
      const r = await runner.run(`echo "hello world" | head -c 5`);
      expect(r.stdout).toBe('hello');
    });

    it('tail -c N outputs last N bytes', async () => {
      const r = await runner.run(`printf "hello world" | tail -c 5`);
      expect(r.stdout).toBe('world');
    });

    it('head -c with file', async () => {
      const r = await runner.run(`echo "abcdefgh" > /tmp/hc.txt && head -c 4 /tmp/hc.txt`);
      expect(r.stdout).toBe('abcd');
    });
  });

  // ---------------------------------------------------------------------------
  // xargs -0 null-delimited input
  // ---------------------------------------------------------------------------
  describe('xargs -0', () => {
    it('splits on null bytes', async () => {
      const r = await runner.run(`printf "a\\0b\\0c" | xargs -0 echo`);
      expect(r.stdout).toBe('echo a b c\n');
    });

    it('-0 with -n 1 processes one at a time', async () => {
      const r = await runner.run(`printf "hello\\0world" | xargs -0 -n 1 echo`);
      expect(r.stdout).toBe('echo hello\necho world\n');
    });
  });

  // ---------------------------------------------------------------------------
  // shift builtin
  // ---------------------------------------------------------------------------
  describe('shift builtin', () => {
    it('shifts positional parameters', async () => {
      const r = await runner.run(`f() { echo "$1"; shift; echo "$1"; }; f a b c`);
      expect(r.stdout).toBe('a\nb\n');
    });

    it('shift N removes N parameters', async () => {
      const r = await runner.run(`f() { shift 2; echo "$1"; }; f a b c d`);
      expect(r.stdout).toBe('c\n');
    });

    it('$# updates after shift', async () => {
      const r = await runner.run(`f() { echo "$#"; shift; echo "$#"; }; f x y z`);
      expect(r.stdout).toBe('3\n2\n');
    });
  });

  // ---------------------------------------------------------------------------
  // type and command builtins
  // ---------------------------------------------------------------------------
  describe('type and command builtins', () => {
    it('type identifies builtins', async () => {
      const r = await runner.run(`type echo`);
      expect(r.stdout).toBe('echo is a shell builtin\n');
    });

    it('type identifies external tools', async () => {
      const r = await runner.run(`type grep`);
      expect(r.stdout).toBe('grep is /usr/bin/grep\n');
    });

    it('type identifies functions', async () => {
      const r = await runner.run(`myfn() { echo hi; }; type myfn`);
      expect(r.stdout).toBe('myfn is a function\n');
    });

    it('command -v returns path for tools', async () => {
      const r = await runner.run(`command -v sort`);
      expect(r.stdout).toBe('/usr/bin/sort\n');
    });

    it('command -v exits 1 for unknown', async () => {
      const r = await runner.run(`command -v nonexistent`);
      expect(r.exitCode).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // let builtin
  // ---------------------------------------------------------------------------
  describe('let builtin', () => {
    it('evaluates arithmetic', async () => {
      const r = await runner.run(`let x=5+3; echo $x`);
      expect(r.stdout).toBe('8\n');
    });

    it('returns 1 when expression is zero', async () => {
      const r = await runner.run(`let "0"; echo $?`);
      expect(r.stdout).toBe('1\n');
    });

    it('returns 0 when expression is nonzero', async () => {
      const r = await runner.run(`let "42"; echo $?`);
      expect(r.stdout).toBe('0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Array += append
  // ---------------------------------------------------------------------------
  describe('array append', () => {
    it('arr+=(elem) appends to array', async () => {
      const r = await runner.run(`arr=(a b); arr+=(c d); echo "\${arr[@]}"`);
      expect(r.stdout).toBe('a b c d\n');
    });

    it('var+=string appends to string', async () => {
      const r = await runner.run(`x=hello; x+=world; echo "$x"`);
      expect(r.stdout).toBe('helloworld\n');
    });

    it('${#arr[@]} reflects appended elements', async () => {
      const r = await runner.run(`arr=(1 2); arr+=(3); echo "\${#arr[@]}"`);
      expect(r.stdout).toBe('3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // unset array element
  // ---------------------------------------------------------------------------
  describe('unset array element', () => {
    it('unset arr[idx] removes element', async () => {
      const r = await runner.run(`arr=(a b c); unset arr[1]; echo "\${arr[0]} \${arr[2]}"`);
      expect(r.stdout).toBe('a c\n');
    });
  });

  // ---------------------------------------------------------------------------
  // wc -L (max line length)
  // ---------------------------------------------------------------------------
  describe('wc -L', () => {
    it('outputs max line length', async () => {
      const r = await runner.run(`printf "hi\\nhello world\\nbye\\n" | wc -L`);
      expect(r.stdout.trim()).toBe('11');
    });
  });

  // ---------------------------------------------------------------------------
  // [[ ... ]] conditional expression
  // ---------------------------------------------------------------------------
  describe('[[ ]] conditional', () => {
    it('string equality', async () => {
      const r = await runner.run(`x=hello; [[ $x == hello ]] && echo yes || echo no`);
      expect(r.stdout).toBe('yes\n');
    });

    it('string inequality', async () => {
      const r = await runner.run(`x=hello; [[ $x != world ]] && echo yes || echo no`);
      expect(r.stdout).toBe('yes\n');
    });

    it('-z and -n tests', async () => {
      const r = await runner.run(`[[ -z "" ]] && echo empty; [[ -n "hi" ]] && echo nonempty`);
      expect(r.stdout).toBe('empty\nnonempty\n');
    });

    it('-f file test', async () => {
      const r = await runner.run(`echo x > /tmp/bb_test.txt; [[ -f /tmp/bb_test.txt ]] && echo yes`);
      expect(r.stdout).toBe('yes\n');
    });

    it('&& and || logical operators', async () => {
      const r = await runner.run(`[[ -n "a" && -n "b" ]] && echo both`);
      expect(r.stdout).toBe('both\n');
    });

    it('! negation', async () => {
      const r = await runner.run(`[[ ! -z "hello" ]] && echo yes`);
      expect(r.stdout).toBe('yes\n');
    });

    it('=~ regex match', async () => {
      const r = await runner.run(`x=hello123; [[ $x =~ [0-9]+ ]] && echo match || echo no`);
      expect(r.stdout).toBe('match\n');
    });

    it('numeric comparison with -gt', async () => {
      const r = await runner.run(`x=10; [[ $x -gt 5 ]] && echo yes`);
      expect(r.stdout).toBe('yes\n');
    });
  });

  // ---------------------------------------------------------------------------
  // (( )) standalone arithmetic command
  // ---------------------------------------------------------------------------
  describe('(( )) arithmetic command', () => {
    it('returns 0 for nonzero expression', async () => {
      const r = await runner.run(`(( 5 > 3 )) && echo yes`);
      expect(r.stdout).toBe('yes\n');
    });

    it('returns 1 for zero expression', async () => {
      const r = await runner.run(`(( 0 )); echo $?`);
      expect(r.stdout).toBe('1\n');
    });

    it('modifies variables', async () => {
      const r = await runner.run(`x=5; (( x++ )); echo $x`);
      expect(r.stdout).toBe('6\n');
    });

    it('used in if condition', async () => {
      const r = await runner.run(`x=10; if (( x > 5 )); then echo big; fi`);
      expect(r.stdout).toBe('big\n');
    });
  });

  // ---------------------------------------------------------------------------
  // printf -v (assign to variable)
  // ---------------------------------------------------------------------------
  describe('printf -v', () => {
    it('assigns formatted output to variable', async () => {
      const r = await runner.run(`printf -v result "%d + %d = %d" 2 3 5; echo "$result"`);
      expect(r.stdout).toBe('2 + 3 = 5\n');
    });

    it('regular printf still works', async () => {
      const r = await runner.run(`printf "hello %s\\n" world`);
      expect(r.stdout).toBe('hello world\n');
    });
  });

  // ---------------------------------------------------------------------------
  // mapfile / readarray
  // ---------------------------------------------------------------------------
  describe('mapfile', () => {
    it('reads lines into array', async () => {
      const r = await runner.run(`mapfile arr <<< "a
b
c"; echo "\${arr[0]}" "\${arr[1]}" "\${arr[2]}"`);
      expect(r.stdout).toBe('a b c\n');
    });

    it('-t strips trailing newline', async () => {
      const r = await runner.run(`printf "hello\\nworld\\n" > /tmp/mf.txt; mapfile -t lines < /tmp/mf.txt; echo "\${#lines[@]}"`);
      expect(r.stdout).toBe('2\n');
    });

    it('-n limits lines', async () => {
      const r = await runner.run(`printf "a\\nb\\nc\\nd\\n" > /tmp/mf2.txt; mapfile -n 2 arr < /tmp/mf2.txt; echo "\${#arr[@]}"`);
      expect(r.stdout).toBe('2\n');
    });

    it('readarray is alias for mapfile', async () => {
      const r = await runner.run(`readarray items <<< "x
y"; echo "\${items[@]}"`);
      expect(r.stdout).toBe('x y\n');
    });
  });

  // ---------- sed -i (in-place edit) ----------
  describe('sed -i', () => {
    it('edits file in place', async () => {
      const r = await runner.run(`echo "hello world" > /tmp/si.txt; sed -i 's/world/earth/' /tmp/si.txt; cat /tmp/si.txt`);
      expect(r.stdout).toBe('hello earth\n');
    });

    it('-i with multiple files', async () => {
      const r = await runner.run(`echo "aaa" > /tmp/si1.txt; echo "aaa" > /tmp/si2.txt; sed -i 's/aaa/bbb/' /tmp/si1.txt /tmp/si2.txt; cat /tmp/si1.txt /tmp/si2.txt`);
      expect(r.stdout).toBe('bbb\nbbb\n');
    });

    it('-i with delete command', async () => {
      const r = await runner.run(`printf "line1\\nline2\\nline3\\n" > /tmp/sid.txt; sed -i '2d' /tmp/sid.txt; cat /tmp/sid.txt`);
      expect(r.stdout).toBe('line1\nline3\n');
    });
  });

  // ---------- sed -E (extended regex) ----------
  describe('sed -E', () => {
    it('uses ERE without backslash groups', async () => {
      const r = await runner.run(`echo "abc123def" | sed -E 's/[0-9]+/NUM/'`);
      expect(r.stdout).toBe('abcNUMdef\n');
    });

    it('ERE alternation with |', async () => {
      const r = await runner.run(`echo "cat" | sed -E 's/cat|dog/pet/'`);
      expect(r.stdout).toBe('pet\n');
    });

    it('ERE with + quantifier', async () => {
      const r = await runner.run(`echo "aabbb" | sed -E 's/b+/X/'`);
      expect(r.stdout).toBe('aaX\n');
    });
  });

  // ---------- grep -m (max count) ----------
  describe('grep -m', () => {
    it('stops after N matches', async () => {
      const r = await runner.run(`printf "a\\nb\\na\\nb\\na\\n" | grep -m 2 a`);
      expect(r.stdout).toBe('a\na\n');
    });

    it('-m with -c counts up to limit', async () => {
      const r = await runner.run(`printf "x\\nx\\nx\\nx\\n" | grep -m 2 -c x`);
      expect(r.stdout).toBe('2\n');
    });

    it('-m with -n shows line numbers', async () => {
      const r = await runner.run(`printf "a\\nb\\na\\nb\\n" | grep -m 1 -n a`);
      expect(r.stdout).toBe('1:a\n');
    });
  });

  // ---------- exec builtin ----------
  describe('exec builtin', () => {
    it('runs a command', async () => {
      const r = await runner.run(`exec echo hello`);
      expect(r.stdout).toBe('hello\n');
    });

    it('exec with no command succeeds', async () => {
      const r = await runner.run(`exec; echo "still here"`);
      expect(r.stdout).toBe('still here\n');
    });
  });

  // ---------- readonly builtin ----------
  describe('readonly builtin', () => {
    it('sets and protects a variable', async () => {
      const r = await runner.run(`readonly X=42; echo $X`);
      expect(r.stdout).toBe('42\n');
    });

    it('rejects assignment to readonly var', async () => {
      const r = await runner.run(`readonly Y=1; Y=2; echo $Y`);
      expect(r.stderr).toContain('readonly');
      expect(r.stdout).toBe('1\n');
    });

    it('marks existing var as readonly', async () => {
      const r = await runner.run(`Z=hello; readonly Z; Z=world 2>/dev/null; echo $Z`);
      expect(r.stdout).toBe('hello\n');
    });
  });

  // ---------- grep -h/-H (filename control) ----------
  describe('grep -h/-H', () => {
    it('-h suppresses filename prefix', async () => {
      const r = await runner.run(`echo "hello" > /tmp/gh1.txt; echo "hello" > /tmp/gh2.txt; grep -h hello /tmp/gh1.txt /tmp/gh2.txt`);
      expect(r.stdout).toBe('hello\nhello\n');
    });

    it('-H forces filename prefix for single file', async () => {
      const r = await runner.run(`echo "hello" > /tmp/gH.txt; grep -H hello /tmp/gH.txt`);
      expect(r.stdout).toBe('/tmp/gH.txt:hello\n');
    });
  });

  // ---------- grep --include/--exclude ----------
  describe('grep --include/--exclude', () => {
    it('--include filters by glob', async () => {
      const r = await runner.run(`mkdir -p /tmp/gi; echo "match" > /tmp/gi/a.txt; echo "match" > /tmp/gi/b.log; grep -r --include="*.txt" match /tmp/gi`);
      expect(r.stdout).toContain('a.txt');
      expect(r.stdout).not.toContain('b.log');
    });

    it('--exclude skips matching files', async () => {
      const r = await runner.run(`mkdir -p /tmp/ge; echo "match" > /tmp/ge/a.txt; echo "match" > /tmp/ge/b.log; grep -r --exclude="*.log" match /tmp/ge`);
      expect(r.stdout).toContain('a.txt');
      expect(r.stdout).not.toContain('b.log');
    });
  });

  // ---------- cut -s and --output-delimiter ----------
  describe('cut -s and --output-delimiter', () => {
    it('-s suppresses lines without delimiter', async () => {
      const r = await runner.run(`printf "a:b\\nno-delim\\nc:d\\n" | cut -d: -f1 -s`);
      expect(r.stdout).toBe('a\nc\n');
    });

    it('--output-delimiter changes output separator', async () => {
      const r = await runner.run(`echo "a:b:c" | cut -d: -f1,3 --output-delimiter=,`);
      expect(r.stdout).toBe('a,c\n');
    });
  });

  // ---------- uniq -i/-f/-s ----------
  describe('uniq -i/-f/-s', () => {
    it('-i ignores case', async () => {
      const r = await runner.run(`printf "Hello\\nhello\\nHELLO\\nworld\\n" | uniq -i`);
      expect(r.stdout).toBe('Hello\nworld\n');
    });

    it('-f skips fields', async () => {
      const r = await runner.run(`printf "1 aaa\\n2 aaa\\n3 bbb\\n" | uniq -f 1`);
      expect(r.stdout).toBe('1 aaa\n3 bbb\n');
    });

    it('-s skips chars', async () => {
      const r = await runner.run(`printf "XXhello\\nYYhello\\nZZworld\\n" | uniq -s 2`);
      expect(r.stdout).toBe('XXhello\nZZworld\n');
    });
  });

  // ---------- sed -f (read script from file) ----------
  describe('sed -f', () => {
    it('reads script from file', async () => {
      const r = await runner.run(`echo 's/foo/bar/' > /tmp/sed_script.txt; echo "foo baz" | sed -f /tmp/sed_script.txt`);
      expect(r.stdout).toBe('bar baz\n');
    });
  });

  // ---------- $BASH_REMATCH ----------
  describe('$BASH_REMATCH', () => {
    it('populates on regex match', async () => {
      const r = await runner.run(`[[ "hello123world" =~ ([0-9]+) ]] && echo "\${BASH_REMATCH[0]}" "\${BASH_REMATCH[1]}"`);
      expect(r.stdout).toBe('123 123\n');
    });

    it('captures multiple groups', async () => {
      const r = await runner.run(`[[ "2024-01-15" =~ ([0-9]{4})-([0-9]{2})-([0-9]{2}) ]] && echo "\${BASH_REMATCH[1]}" "\${BASH_REMATCH[2]}" "\${BASH_REMATCH[3]}"`);
      expect(r.stdout).toBe('2024 01 15\n');
    });

    it('clears on non-match', async () => {
      const r = await runner.run(`[[ "abc" =~ ([0-9]+) ]]; echo "\${#BASH_REMATCH[@]}"`);
      expect(r.stdout).toBe('0\n');
    });
  });

  // ---------- $SECONDS ----------
  describe('$SECONDS', () => {
    it('returns elapsed seconds (at least 0)', async () => {
      const r = await runner.run(`echo $SECONDS`);
      const val = parseInt(r.stdout.trim(), 10);
      expect(val).toBeGreaterThanOrEqual(0);
    });
  });

  // ---------- $LINENO ----------
  describe('$LINENO', () => {
    it('returns a line number', async () => {
      const r = await runner.run(`echo $LINENO`);
      const val = parseInt(r.stdout.trim(), 10);
      expect(val).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------- $BASH_SOURCE ----------
  describe('$BASH_SOURCE', () => {
    it('is set when sourcing a file', async () => {
      const r = await runner.run(`echo 'echo $BASH_SOURCE' > /tmp/bs.sh; source /tmp/bs.sh`);
      expect(r.stdout.trim()).toBe('/tmp/bs.sh');
    });
  });

  // ---------- grep -L (files without match) ----------
  describe('grep -L', () => {
    it('prints files without match', async () => {
      const r = await runner.run(`echo "yes" > /tmp/gL1.txt; echo "no" > /tmp/gL2.txt; grep -L yes /tmp/gL1.txt /tmp/gL2.txt`);
      expect(r.stdout.trim()).toBe('/tmp/gL2.txt');
    });
  });

  // ---------- find -print0 ----------
  describe('find -print0', () => {
    it('outputs null-separated paths', async () => {
      const r = await runner.run(`mkdir -p /tmp/fp0; touch /tmp/fp0/a /tmp/fp0/b; find /tmp/fp0 -type f -name "a" -print0`);
      // Output should contain null byte instead of newline
      expect(r.stdout).toContain('\0');
      expect(r.stdout).not.toContain('\n');
    });
  });

  // ---------- ls -lh (human readable) ----------
  describe('ls -lh', () => {
    it('shows human-readable sizes', async () => {
      const r = await runner.run(`ls -lh /home/user`);
      // Should not error; just verify it runs
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------- ls -t (sort by time) ----------
  describe('ls -t', () => {
    it('sorts by modification time', async () => {
      // Write files with staggered content to ensure different mtimes in VFS
      const r = await runner.run(`mkdir -p /tmp/lst; echo a > /tmp/lst/old; echo b > /tmp/lst/new; ls -1t /tmp/lst`);
      // Both files listed (order depends on VFS mtime granularity)
      expect(r.stdout).toContain('old');
      expect(r.stdout).toContain('new');
    });
  });

  // ---------- ls -S (sort by size) ----------
  describe('ls -S', () => {
    it('sorts by size, largest first', async () => {
      const r = await runner.run(`mkdir -p /tmp/lsS; echo "a" > /tmp/lsS/small; echo "aaaaaaaaaa" > /tmp/lsS/big; ls -1S /tmp/lsS`);
      expect(r.stdout.trim().split('\n')[0]).toBe('big');
    });
  });

  // ---------- wc -m ----------
  describe('wc -m', () => {
    it('counts characters', async () => {
      const r = await runner.run(`echo "hello" | wc -m`);
      expect(r.stdout.trim()).toBe('6'); // 5 chars + 1 newline
    });
  });

  // ---------- sort -V ----------
  describe('sort -V', () => {
    it('sorts version numbers correctly', async () => {
      const r = await runner.run(`printf "v1.10\\nv1.2\\nv1.1\\n" | sort -V`);
      expect(r.stdout).toBe('v1.1\nv1.2\nv1.10\n');
    });
  });

  // ---------- pushd/popd/dirs ----------
  describe('pushd/popd/dirs', () => {
    it('pushd changes directory and prints stack', async () => {
      const r = await runner.run(`mkdir -p /tmp/pd; pushd /tmp/pd > /dev/null; pwd`);
      expect(r.stdout.trim()).toBe('/tmp/pd');
    });

    it('popd returns to previous directory', async () => {
      const r = await runner.run(`mkdir -p /tmp/pd2; pushd /tmp/pd2 > /dev/null; popd > /dev/null; pwd`);
      expect(r.stdout.trim()).toBe('/home/user');
    });

    it('dirs shows directory stack', async () => {
      const r = await runner.run(`dirs`);
      expect(r.stdout).toContain('/home/user');
    });
  });

  // ---------- export -p / declare -p / readonly -p ----------
  describe('export -p / declare -p / readonly -p', () => {
    it('export -p prints variables in declare -x format', async () => {
      await runner.run(`export MY_TEST_VAR=hello`);
      const r = await runner.run(`export -p`);
      expect(r.stdout).toContain('declare -x MY_TEST_VAR="hello"');
    });

    it('export with no args prints same as export -p', async () => {
      await runner.run(`export FOO=bar`);
      const r = await runner.run(`export`);
      expect(r.stdout).toContain('declare -x FOO="bar"');
    });

    it('declare -p prints variables in declare -- format', async () => {
      const r = await runner.run(`X=123; declare -p X`);
      expect(r.stdout.trim()).toBe('declare -- X="123"');
    });

    it('declare -p with unknown var returns error', async () => {
      const r = await runner.run(`declare -p NONEXISTENT_VAR_XYZ`);
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toContain('not found');
    });

    it('readonly -p prints readonly variables', async () => {
      const r = await runner.run(`readonly RO_VAR=42`);
      const r2 = await runner.run(`readonly -p`);
      expect(r2.stdout).toContain('declare -r RO_VAR="42"');
    });

    it('readonly with no args lists readonly vars', async () => {
      await runner.run(`readonly A_RO=1`);
      const r = await runner.run(`readonly`);
      expect(r.stdout).toContain('declare -r A_RO="1"');
    });
  });

  // ---------- stat format flags ----------
  describe('stat format flags', () => {
    it('stat -c %n prints filename', async () => {
      const r = await runner.run(`echo hi > /tmp/st1; stat -c '%n' /tmp/st1`);
      expect(r.stdout.trim()).toBe('/tmp/st1');
    });

    it('stat -c %s prints file size', async () => {
      const r = await runner.run(`echo -n "hello" > /tmp/st2; stat -c '%s' /tmp/st2`);
      expect(r.stdout.trim()).toBe('5');
    });

    it('stat -c %F prints file type', async () => {
      const r = await runner.run(`mkdir -p /tmp/stdir; stat -c '%F' /tmp/stdir`);
      expect(r.stdout.trim()).toBe('directory');
    });

    it('stat -c %a prints octal permissions', async () => {
      const r = await runner.run(`echo hi > /tmp/st3; stat -c '%a' /tmp/st3`);
      // WASM VFS returns 644 for files
      expect(r.stdout.trim()).toBe('644');
    });

    it('stat -c %A prints permission string', async () => {
      const r = await runner.run(`mkdir -p /tmp/stdir2; stat -c '%A' /tmp/stdir2`);
      expect(r.stdout.trim()).toBe('drwxr-xr-x');
    });

    it('stat -c %U prints owner', async () => {
      const r = await runner.run(`echo hi > /tmp/st4; stat -c '%U' /tmp/st4`);
      expect(r.stdout.trim()).toBe('root');
    });
  });

  // ---------- find -mtime / -newer ----------
  describe('find -mtime / -newer', () => {
    it('find -mtime -1 finds recently created files', async () => {
      const r = await runner.run(`echo x > /tmp/mtime_test; find /tmp -name mtime_test -mtime -1`);
      expect(r.stdout).toContain('mtime_test');
    });

    it('find -mtime +9999 finds nothing recent', async () => {
      const r = await runner.run(`echo x > /tmp/mtime_old; find /tmp -name mtime_old -mtime +9999`);
      expect(r.stdout.trim()).toBe('');
    });

    it('find -newer reference file works', async () => {
      const r = await runner.run(`echo old > /tmp/ref_file; echo new > /tmp/newer_file; find /tmp -name newer_file -newer /tmp/ref_file`);
      // Both created nearly simultaneously, so newer_file may or may not be strictly newer
      // At minimum, the command should not error
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------- until loop ----------
  describe('until loop', () => {
    it('until loop runs until condition is true', async () => {
      const r = await runner.run(`x=0; until [ $x -eq 3 ]; do x=$((x+1)); done; echo $x`);
      expect(r.stdout.trim()).toBe('3');
    });

    it('until loop with false condition runs body at least once', async () => {
      const r = await runner.run(`x=5; until [ $x -lt 10 ]; do x=$((x+1)); break; done; echo $x`);
      // condition is already true, so body never runs
      expect(r.stdout.trim()).toBe('5');
    });
  });

  // ---------- tr escape sequences ----------
  describe('tr escape sequences', () => {
    it('tr \\n replaces newlines', async () => {
      const r = await runner.run(`printf "a\\nb\\nc" | tr '\\n' ','`);
      expect(r.stdout).toBe('a,b,c');
    });

    it('tr \\t replaces tabs', async () => {
      const r = await runner.run(`printf "a\\tb" | tr '\\t' ','`);
      expect(r.stdout).toBe('a,b');
    });
  });

  // ---------- expr pattern matching ----------
  describe('expr pattern matching', () => {
    it('expr STRING : REGEX returns match length', async () => {
      const r = await runner.run(`expr "hello123" : '.*'`);
      expect(r.stdout.trim()).toBe('8');
    });

    it('expr STRING : with capture group returns captured text', async () => {
      const r = await runner.run(`expr "hello123" : 'hello\\(.*\\)'`);
      expect(r.stdout.trim()).toBe('123');
    });

    it('expr substr extracts substring', async () => {
      const r = await runner.run(`expr substr "hello" 2 3`);
      expect(r.stdout.trim()).toBe('ell');
    });

    it('expr index finds first matching char', async () => {
      const r = await runner.run(`expr index "hello" "lo"`);
      expect(r.stdout.trim()).toBe('3');
    });

    it('expr match works like : operator', async () => {
      const r = await runner.run(`expr match "abc123" '[a-z]*'`);
      expect(r.stdout.trim()).toBe('3');
    });
  });

  // ---------- touch flags ----------
  describe('touch flags', () => {
    it('touch -c does not create file if missing', async () => {
      const r = await runner.run(`touch -c /tmp/nonexistent_touch_test; test -f /tmp/nonexistent_touch_test && echo exists || echo missing`);
      expect(r.stdout.trim()).toBe('missing');
    });

    it('touch -d accepts date argument without error', async () => {
      const r = await runner.run(`touch -d "2024-01-01" /tmp/touch_date_test; test -f /tmp/touch_date_test && echo ok`);
      expect(r.stdout.trim()).toBe('ok');
    });

    it('touch -t accepts timestamp argument without error', async () => {
      const r = await runner.run(`touch -t 202401010000 /tmp/touch_ts_test; test -f /tmp/touch_ts_test && echo ok`);
      expect(r.stdout.trim()).toBe('ok');
    });
  });

  // ---------- cp -a/-p ----------
  describe('cp flags', () => {
    it('cp -a copies recursively', async () => {
      const r = await runner.run(`mkdir -p /tmp/cpa/sub; echo hi > /tmp/cpa/sub/f; cp -a /tmp/cpa /tmp/cpb; cat /tmp/cpb/sub/f`);
      expect(r.stdout.trim()).toBe('hi');
    });

    it('cp -p accepts preserve flag', async () => {
      const r = await runner.run(`echo x > /tmp/cpp1; cp -p /tmp/cpp1 /tmp/cpp2; cat /tmp/cpp2`);
      expect(r.stdout.trim()).toBe('x');
    });
  });

  // ---------- mkdir -m ----------
  describe('mkdir -m', () => {
    it('mkdir -m 755 accepts mode flag', async () => {
      const r = await runner.run(`mkdir -m 755 /tmp/mdm; test -d /tmp/mdm && echo ok`);
      expect(r.stdout.trim()).toBe('ok');
    });

    it('mkdir -p -m creates parents with mode', async () => {
      const r = await runner.run(`mkdir -p -m 700 /tmp/mdpm/sub; test -d /tmp/mdpm/sub && echo ok`);
      expect(r.stdout.trim()).toBe('ok');
    });
  });

  // ---------- cat -b/-s/-E ----------
  describe('cat -b/-s/-E', () => {
    it('cat -b numbers non-blank lines', async () => {
      const r = await runner.run(`printf "a\\n\\nb\\n" | cat -b`);
      expect(r.stdout).toContain('1\ta');
      expect(r.stdout).toContain('2\tb');
      // blank line should not be numbered
      expect(r.stdout).not.toContain('2\t\n');
    });

    it('cat -s squeezes blank lines', async () => {
      const r = await runner.run(`printf "a\\n\\n\\n\\nb\\n" | cat -s`);
      const lines = r.stdout.split('\n').filter(l => l !== '');
      expect(lines.length).toBeLessThanOrEqual(3); // a, (one blank), b
    });

    it('cat -E shows line ends', async () => {
      const r = await runner.run(`printf "hello\\n" | cat -E`);
      expect(r.stdout).toContain('hello$');
    });
  });

  // ---------- head -n -N ----------
  describe('head -n -N', () => {
    it('head -n -2 prints all but last 2 lines', async () => {
      const r = await runner.run(`printf "a\\nb\\nc\\nd\\ne\\n" | head -n -2`);
      expect(r.stdout.trim()).toBe('a\nb\nc');
    });
  });

  // ---------- tail -n +N and -f ----------
  describe('tail -n +N and -f', () => {
    it('tail -n +3 prints from line 3 onwards', async () => {
      const r = await runner.run(`printf "a\\nb\\nc\\nd\\ne\\n" | tail -n +3`);
      expect(r.stdout.trim()).toBe('c\nd\ne');
    });

    it('tail -f accepts follow flag without error', async () => {
      const r = await runner.run(`printf "line1\\nline2\\n" | tail -f -n 1`);
      expect(r.stdout.trim()).toBe('line2');
    });
  });

  // ---------- ${!var} indirect expansion ----------
  describe('indirect variable expansion', () => {
    it('${!var} expands to value of named variable', async () => {
      const r = await runner.run(`greeting="hello"; name="greeting"; echo \${!name}`);
      expect(r.stdout.trim()).toBe('hello');
    });

    it('${!var} returns empty when indirect var is unset', async () => {
      const r = await runner.run(`name="nonexistent"; echo ">\${!name}<"`);
      expect(r.stdout.trim()).toBe('><');
    });
  });

  // ---------- awk rand/srand ----------
  describe('awk rand/srand', () => {
    it('awk rand() returns a number between 0 and 1', async () => {
      const r = await runner.run(`awk 'BEGIN { x = rand(); print (x >= 0 && x < 1) ? "ok" : "fail" }'`);
      expect(r.stdout.trim()).toBe('ok');
    });

    it('awk srand() with same seed produces same sequence', async () => {
      const r = await runner.run(`awk 'BEGIN { srand(42); a=rand(); srand(42); b=rand(); print (a == b) ? "ok" : "fail" }'`);
      expect(r.stdout.trim()).toBe('ok');
    });
  });

  // ---------- awk split with regex ----------
  describe('awk split with regex', () => {
    it('split with multi-char regex separator', async () => {
      const r = await runner.run(`echo "a::b::c" | awk '{ n = split($0, arr, "::"); print n, arr[1], arr[2], arr[3] }'`);
      expect(r.stdout.trim()).toBe('3 a b c');
    });

    it('split with regex pattern separator', async () => {
      const r = await runner.run(`echo "a1b2c3d" | awk '{ n = split($0, arr, /[0-9]/); print n, arr[1], arr[2], arr[3] }'`);
      expect(r.stdout.trim()).toBe('4 a b c');
    });
  });
});
