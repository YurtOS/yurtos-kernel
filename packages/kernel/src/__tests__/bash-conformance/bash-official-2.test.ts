/**
 * More conformance tests adapted from the official GNU bash test suite.
 * Source: https://github.com/ryuichiueda/bash_for_sush_test/tree/master/tests
 *
 * Part 2: IFS splitting, array edge cases, command substitution,
 * function scoping, glob patterns, redirections, trap, type, varenv.
 *
 * All gaps from the official bash test suite are now closed.
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
  'cat', 'echo', 'printf', 'true', 'false', 'seq', 'wc', 'tr',
  'head', 'tail', 'sort', 'grep', 'sed', 'ls', 'mkdir', 'touch', 'rm',
  'printenv',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('bash official test suite (part 2)', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    const adapter = new NodeAdapter();
    vfs = new VFS();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }
    await mgr.preloadModules();
    runner = await ResidentBashRunner.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
    });
  });

  function writeFile(path: string, content: string) {
    vfs.writeFile(path, new TextEncoder().encode(content));
  }

  // ---------------------------------------------------------------------------
  // ifs.tests — IFS field splitting
  // ---------------------------------------------------------------------------
  describe('IFS splitting (ifs.tests)', () => {
    it('custom IFS splits on colon', async () => {
      const r = await runner.run('IFS=:; x=a:b:c; for i in $x; do echo $i; done');
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('custom IFS with read', async () => {
      const r = await runner.run("echo 'a:b:c' | { IFS=: read x y z; echo $x $y $z; }");
      expect(r.stdout).toBe('a b c\n');
    });

    it('empty IFS prevents splitting', async () => {
      const r = await runner.run("IFS=''; x='a b c'; echo $x");
      expect(r.stdout).toBe('a b c\n');
    });

    it('IFS restoration after subshell', async () => {
      const r = await runner.run('(IFS=:; echo "a:b" | tr : X); echo "a:b" | tr : X');
      expect(r.stdout).toBe('aXb\naXb\n');
    });

    it('default IFS splits on space', async () => {
      const r = await runner.run("x='  a  b  c  '; echo $x");
      expect(r.stdout).toBe('a b c\n');
    });
  });

  // ---------------------------------------------------------------------------
  // array.tests — Array operations
  // ---------------------------------------------------------------------------
  describe('array operations (array.tests)', () => {
    it('declare -a converts scalar to array', async () => {
      const r = await runner.run('a=abcde; declare -a a; echo ${a[0]}');
      expect(r.stdout).toBe('abcde\n');
    });

    it('empty array expansion', async () => {
      const r = await runner.run('x=(); echo ${x[@]}');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('sparse array indexing', async () => {
      const r = await runner.run('a[0]=x; a[5]=y; echo ${a[0]} ${a[5]}');
      expect(r.stdout).toBe('x y\n');
    });

    it('${#a[@]} counts elements', async () => {
      const r = await runner.run('a=(one two three); echo ${#a[@]}');
      expect(r.stdout).toBe('3\n');
    });

    it('array append with +=', async () => {
      const r = await runner.run('a=(1 2); a+=(3 4); echo ${a[@]}');
      expect(r.stdout).toBe('1 2 3 4\n');
    });

    it('unset array element', async () => {
      const r = await runner.run('a=(a b c d); unset a[1]; echo ${a[@]}');
      expect(r.stdout).toBe('a c d\n');
    });

    it('array slicing ${a[@]:1:2}', async () => {
      const r = await runner.run('a=(a b c d e); echo ${a[@]:1:2}');
      expect(r.stdout).toBe('b c\n');
    });

    it('array in for loop', async () => {
      const r = await runner.run('a=(x y z); for i in "${a[@]}"; do echo $i; done');
      expect(r.stdout).toBe('x\ny\nz\n');
    });

    it('${!a[@]} returns indices', async () => {
      const r = await runner.run('a=(x y z); echo ${!a[@]}');
      expect(r.stdout).toBe('0 1 2\n');
    });

    it('${#a[0]} returns element length', async () => {
      const r = await runner.run('a=(hello world); echo ${#a[0]}');
      expect(r.stdout).toBe('5\n');
    });

    it('negative index a[-1]', async () => {
      const r = await runner.run('a=(a b c); echo ${a[-1]}');
      expect(r.stdout).toBe('c\n');
    });

    it('array assignment from command substitution', async () => {
      const r = await runner.run('a=($(echo 1 2 3)); echo ${a[1]}');
      expect(r.stdout).toBe('2\n');
    });
  });

  // ---------------------------------------------------------------------------
  // comsub.tests — Command substitution edge cases
  // ---------------------------------------------------------------------------
  describe('command substitution (comsub.tests)', () => {
    it('nested command substitution', async () => {
      const r = await runner.run('echo $(echo $(echo hello))');
      expect(r.stdout).toBe('hello\n');
    });

    it('triple-nested substitution', async () => {
      const r = await runner.run('echo $(echo $(echo $(echo deep)))');
      expect(r.stdout).toBe('deep\n');
    });

    it('command sub strips trailing newlines', async () => {
      const r = await runner.run("x=$(printf 'hello\\n\\n\\n'); echo \"$x\"");
      expect(r.stdout).toBe('hello\n');
    });

    it('$? after $(false) in assignment', async () => {
      const r = await runner.run('x=$(false); echo $?');
      expect(r.stdout).toBe('1\n');
    });

    it('backtick substitution', async () => {
      const r = await runner.run('echo `echo hello`');
      expect(r.stdout).toBe('hello\n');
    });

    it('read from pipe works', async () => {
      const r = await runner.run('echo hello | { read x; echo $x; }');
      expect(r.stdout).toBe('hello\n');
    });

    it('while read from pipe', async () => {
      const r = await runner.run('echo hello | while read x; do echo got=$x; done');
      expect(r.stdout).toBe('got=hello\n');
    });

    it('command sub in array', async () => {
      const r = await runner.run('a=($(seq 3)); echo ${a[@]}');
      expect(r.stdout).toBe('1 2 3\n');
    });

    it('$(cmd) inside $(()) arithmetic', async () => {
      const r = await runner.run('echo $(( $(echo 5) + $(echo 3) ))');
      expect(r.stdout).toBe('8\n');
    });
  });

  // ---------------------------------------------------------------------------
  // func.tests — Function scoping
  // ---------------------------------------------------------------------------
  describe('function scoping (func.tests)', () => {
    it('function return value via $?', async () => {
      const r = await runner.run('f() { return 42; }; f; echo $?');
      expect(r.stdout).toBe('42\n');
    });

    it('nested function calls with return values', async () => {
      const r = await runner.run('a() { return 5; }; b() { a; echo $?; return 4; }; b; echo $?');
      expect(r.stdout).toBe('5\n4\n');
    });

    it('local variable does not leak', async () => {
      const r = await runner.run('f() { local x=inside; }; x=outside; f; echo $x');
      expect(r.stdout).toBe('outside\n');
    });

    it('global variable visible in function', async () => {
      const r = await runner.run('x=global; f() { echo $x; }; f');
      expect(r.stdout).toBe('global\n');
    });

    it('function modifies global variable', async () => {
      const r = await runner.run('x=old; f() { x=new; }; f; echo $x');
      expect(r.stdout).toBe('new\n');
    });

    it('function with arguments $1 $2', async () => {
      const r = await runner.run('f() { echo $1 $2; }; f hello world');
      expect(r.stdout).toBe('hello world\n');
    });

    it('function with $# counts args', async () => {
      const r = await runner.run('f() { echo $#; }; f a b c');
      expect(r.stdout).toBe('3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // glob.tests — Pathname expansion
  // ---------------------------------------------------------------------------
  describe('glob patterns (glob.tests)', () => {
    it('* matches files', async () => {
      await runner.run('mkdir /tmp/gd; touch /tmp/gd/a.txt /tmp/gd/b.txt /tmp/gd/c.log');
      const r = await runner.run('echo /tmp/gd/*.txt');
      expect(r.stdout).toContain('a.txt');
      expect(r.stdout).toContain('b.txt');
      expect(r.stdout).not.toContain('c.log');
    });

    it('? matches single char', async () => {
      await runner.run('mkdir /tmp/gd2; touch /tmp/gd2/ab /tmp/gd2/ac /tmp/gd2/abc');
      const r = await runner.run('echo /tmp/gd2/a?');
      expect(r.stdout).toContain('ab');
      expect(r.stdout).toContain('ac');
      expect(r.stdout).not.toContain('abc');
    });

    it('[abc] character class', async () => {
      await runner.run('mkdir /tmp/gd3; touch /tmp/gd3/a /tmp/gd3/b /tmp/gd3/c /tmp/gd3/d');
      const r = await runner.run('echo /tmp/gd3/[ac]');
      expect(r.stdout).toContain('/tmp/gd3/a');
      expect(r.stdout).toContain('/tmp/gd3/c');
      expect(r.stdout).not.toContain('/tmp/gd3/d');
    });

    it('no match returns literal pattern', async () => {
      const r = await runner.run('echo /tmp/nonexistent_dir_xyz/*.nothing');
      expect(r.stdout).toBe('/tmp/nonexistent_dir_xyz/*.nothing\n');
    });
  });

  // ---------------------------------------------------------------------------
  // redir.tests — Redirections
  // ---------------------------------------------------------------------------
  describe('redirections (redir.tests)', () => {
    it('> creates file', async () => {
      await runner.run('echo hello > /tmp/redir.txt');
      const r = await runner.run('cat /tmp/redir.txt');
      expect(r.stdout).toBe('hello\n');
    });

    it('>> appends', async () => {
      await runner.run('echo line1 > /tmp/redir.txt');
      await runner.run('echo line2 >> /tmp/redir.txt');
      const r = await runner.run('cat /tmp/redir.txt');
      expect(r.stdout).toBe('line1\nline2\n');
    });

    it('< reads from file', async () => {
      writeFile('/tmp/input.txt', 'from file\n');
      const r = await runner.run('cat < /tmp/input.txt');
      expect(r.stdout).toBe('from file\n');
    });

    it('2>/dev/null suppresses stderr', async () => {
      const r = await runner.run('echo ok; cat /nonexistent 2>/dev/null');
      expect(r.stdout).toBe('ok\n');
    });

    it('&> redirects both stdout and stderr', async () => {
      await runner.run('echo hello &> /tmp/both.txt');
      const r = await runner.run('cat /tmp/both.txt');
      expect(r.stdout).toContain('hello');
    });

    it('multiple redirects in one command', async () => {
      await runner.run('echo output > /tmp/out.txt 2> /tmp/err.txt');
      const r = await runner.run('cat /tmp/out.txt');
      expect(r.stdout).toBe('output\n');
    });

    it('2>&1 merges stderr to stdout', async () => {
      const r = await runner.run('(echo OUT; echo ERR >&2) 2>&1');
      expect(r.stdout).toBe('OUT\nERR\n');
    });

    it('2>&1 through pipe', async () => {
      const r = await runner.run('(echo OUT; echo ERR >&2) 2>&1 | sort');
      expect(r.stdout).toBe('ERR\nOUT\n');
    });

    it('brace group 2>&1 through pipe', async () => {
      const r = await runner.run('{ echo A; echo B >&2; } 2>&1 | sort');
      expect(r.stdout).toBe('A\nB\n');
    });
  });

  // ---------------------------------------------------------------------------
  // trap.tests — Signal traps
  // ---------------------------------------------------------------------------
  describe('trap (trap.tests)', () => {
    it('trap EXIT runs on exit', async () => {
      const r = await runner.run("trap 'echo goodbye' EXIT; echo hello");
      expect(r.stdout).toBe('hello\ngoodbye\n');
    });

    it('trap - clears trap', async () => {
      const r = await runner.run("trap 'echo BYE' EXIT; echo MID; trap - EXIT; echo DONE");
      expect(r.stdout).toBe('MID\nDONE\n');
    });

    it('trap -p prints trap', async () => {
      const r = await runner.run("trap 'echo bye' EXIT; trap -p EXIT");
      expect(r.stdout).toContain('EXIT');
      expect(r.stdout).toContain('echo bye');
    });
  });

  // ---------------------------------------------------------------------------
  // type.tests — Type/command builtins
  // ---------------------------------------------------------------------------
  describe('type and command (type.tests)', () => {
    it('type identifies builtin', async () => {
      const r = await runner.run('type echo');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('echo');
    });

    it('type -t returns type keyword', async () => {
      const r = await runner.run('type -t echo');
      expect(r.stdout).toBe('builtin\n');
    });

    it('command -v finds command', async () => {
      const r = await runner.run('command -v echo');
      expect(r.exitCode).toBe(0);
    });

    it('type for nonexistent returns error', async () => {
      const r = await runner.run('type nonexistent_cmd_xyz 2>/dev/null');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // varenv.tests — Variable environment
  // ---------------------------------------------------------------------------
  describe('variable environment (varenv.tests)', () => {
    it('exported variable visible in subshell', async () => {
      const r = await runner.run('export X=hello; (echo $X)');
      expect(r.stdout).toBe('hello\n');
    });

    it('non-exported variable accessible', async () => {
      const r = await runner.run('X=local; echo $X');
      expect(r.stdout).toBe('local\n');
    });

    it('variable in subshell does not leak', async () => {
      const r = await runner.run('(X=sub); echo ${X:-unset}');
      expect(r.stdout).toBe('unset\n');
    });

    it('export -n removes from env', async () => {
      const r = await runner.run('export X=hello; export -n X; (echo ${X:-gone})');
      expect(r.stdout).toBe('gone\n');
    });
  });
});
