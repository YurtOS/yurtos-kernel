/**
 * Conformance tests adapted from the official GNU bash test suite.
 * Source: https://github.com/ryuichiueda/bash_for_sush_test/tree/master/tests
 *
 * Tests are extracted from .tests/.right file pairs in the bash source tree.
 * Each test is a self-contained shell command whose stdout is compared
 * against the expected output from the .right file.
 *
 * Categories: brace expansion, arithmetic, parameter stripping, case,
 * conditionals, heredoc/herestr, set-e, and quoting.
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
  'head', 'tail', 'sort', 'grep', 'sed',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('bash official test suite', () => {
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

  // ---------------------------------------------------------------------------
  // braces.tests — Brace expansion
  // Source: tests/braces.tests + tests/braces.right
  // ---------------------------------------------------------------------------
  describe('brace expansion (braces.tests)', () => {
    it('echo ff{c,b,a}', async () => {
      const r = await runner.run('echo ff{c,b,a}');
      expect(r.stdout).toBe('ffc ffb ffa\n');
    });

    it('echo f{d,e,f}g', async () => {
      const r = await runner.run('echo f{d,e,f}g');
      expect(r.stdout).toBe('fdg feg ffg\n');
    });

    it('echo {l,n,m}xyz', async () => {
      const r = await runner.run('echo {l,n,m}xyz');
      expect(r.stdout).toBe('lxyz nxyz mxyz\n');
    });

    it('echo {abc}', async () => {
      const r = await runner.run('echo {abc}');
      expect(r.stdout).toBe('{abc}\n');
    });

    it('echo {}', async () => {
      const r = await runner.run('echo {}');
      expect(r.stdout).toBe('{}\n');
    });

    it('numeric range {1..5}', async () => {
      const r = await runner.run('echo {1..5}');
      expect(r.stdout).toBe('1 2 3 4 5\n');
    });

    it('alpha range {a..e}', async () => {
      const r = await runner.run('echo {a..e}');
      expect(r.stdout).toBe('a b c d e\n');
    });

    it('reverse range {5..1}', async () => {
      const r = await runner.run('echo {5..1}');
      expect(r.stdout).toBe('5 4 3 2 1\n');
    });

    it('nested braces', async () => {
      const r = await runner.run('echo {a,b{1,2},c}');
      expect(r.stdout).toBe('a b1 b2 c\n');
    });

    it('prefix and suffix with braces', async () => {
      const r = await runner.run('echo pre-{a,b}-post');
      expect(r.stdout).toBe('pre-a-post pre-b-post\n');
    });
  });

  // ---------------------------------------------------------------------------
  // arith.tests — Arithmetic evaluation
  // Source: tests/arith.tests + tests/arith.right
  // ---------------------------------------------------------------------------
  describe('arithmetic (arith.tests)', () => {
    it('basic addition', async () => {
      const r = await runner.run('echo $((3 + 5 * 32))');
      expect(r.stdout).toBe('163\n');
    });

    it('bitwise NOT ~1', async () => {
      const r = await runner.run('echo $(( ~1 ))');
      expect(r.stdout).toBe('-2\n');
    });

    it('logical NOT !0', async () => {
      const r = await runner.run('echo $(( ! 0 ))');
      expect(r.stdout).toBe('1\n');
    });

    it('bitwise AND', async () => {
      const r = await runner.run('echo $(( 33 & 55 ))');
      expect(r.stdout).toBe('33\n');
    });

    it('bitwise OR', async () => {
      const r = await runner.run('echo $(( 33 | 17 ))');
      expect(r.stdout).toBe('49\n');
    });

    it('left shift', async () => {
      const r = await runner.run('echo $(( 1 << 4 ))');
      expect(r.stdout).toBe('16\n');
    });

    it('right shift', async () => {
      const r = await runner.run('echo $(( 16 >> 2 ))');
      expect(r.stdout).toBe('4\n');
    });

    it('ternary operator', async () => {
      const r = await runner.run('echo $(( 1 > 0 ? 42 : 0 ))');
      expect(r.stdout).toBe('42\n');
    });

    it('ternary false branch', async () => {
      const r = await runner.run('echo $(( 0 > 1 ? 42 : 99 ))');
      expect(r.stdout).toBe('99\n');
    });

    it('comma operator', async () => {
      const r = await runner.run('echo $(( 1, 2, 3 ))');
      expect(r.stdout).toBe('3\n');
    });

    it('assignment in arithmetic', async () => {
      const r = await runner.run('echo $(( x = 5, x + 1 ))');
      expect(r.stdout).toBe('6\n');
    });

    it('pre-increment', async () => {
      const r = await runner.run('x=5; echo $(( ++x )); echo $x');
      expect(r.stdout).toBe('6\n6\n');
    });

    it('post-increment', async () => {
      const r = await runner.run('x=5; echo $(( x++ )); echo $x');
      expect(r.stdout).toBe('5\n6\n');
    });

    it('compound assignment +=', async () => {
      const r = await runner.run('x=10; echo $(( x += 5 ))');
      expect(r.stdout).toBe('15\n');
    });

    it('compound assignment *=', async () => {
      const r = await runner.run('x=3; echo $(( x *= 4 ))');
      expect(r.stdout).toBe('12\n');
    });

    it('nested arithmetic', async () => {
      const r = await runner.run('echo $(( (2 + 3) * (4 + 1) ))');
      expect(r.stdout).toBe('25\n');
    });

    it('hex literals', async () => {
      const r = await runner.run('echo $(( 0xff ))');
      expect(r.stdout).toBe('255\n');
    });

    it('octal literals', async () => {
      const r = await runner.run('echo $(( 010 ))');
      expect(r.stdout).toBe('8\n');
    });

    it('negative numbers', async () => {
      const r = await runner.run('echo $(( -5 + 3 ))');
      expect(r.stdout).toBe('-2\n');
    });
  });

  // ---------------------------------------------------------------------------
  // strip.tests — Parameter expansion stripping
  // Source: tests/strip.tests + tests/strip.right
  // ---------------------------------------------------------------------------
  describe('parameter stripping (strip.tests)', () => {
    it('command substitution trims trailing newlines', async () => {
      const r = await runner.run("v=$(echo ''); echo \"'$v'\"");
      expect(r.stdout).toBe("''\n");
    });

    it('echo -n preserves trailing space in subst', async () => {
      const r = await runner.run("v=$(echo -n ' ab '); echo \"'$v'\"");
      expect(r.stdout).toBe("' ab '\n");
    });

    it('empty echo -n in subst', async () => {
      const r = await runner.run("v=$(echo -n ''); echo \"'$v'\"");
      expect(r.stdout).toBe("''\n");
    });
  });

  // ---------------------------------------------------------------------------
  // case.tests — Case statements
  // Source: tests/case.tests + tests/case.right
  // ---------------------------------------------------------------------------
  describe('case statements (case.tests)', () => {
    it('basic pattern match', async () => {
      const r = await runner.run('case foo in foo) echo matched;; esac');
      expect(r.stdout).toBe('matched\n');
    });

    it('wildcard pattern *', async () => {
      const r = await runner.run('case hello in h*) echo yes;; esac');
      expect(r.stdout).toBe('yes\n');
    });

    it('multiple patterns with |', async () => {
      const r = await runner.run('case b in a|b|c) echo matched;; esac');
      expect(r.stdout).toBe('matched\n');
    });

    it('default case *)', async () => {
      const r = await runner.run('case xyz in a) echo a;; *) echo default;; esac');
      expect(r.stdout).toBe('default\n');
    });

    it('no match produces no output', async () => {
      const r = await runner.run('case x in a) echo a;; b) echo b;; esac');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('case with variable', async () => {
      const r = await runner.run('x=hello; case $x in hello) echo yes;; esac');
      expect(r.stdout).toBe('yes\n');
    });

    it('case with character class [...]', async () => {
      const r = await runner.run('case 5 in [0-9]) echo digit;; esac');
      expect(r.stdout).toBe('digit\n');
    });

    it('case with ? glob', async () => {
      const r = await runner.run('case ab in ?b) echo yes;; esac');
      expect(r.stdout).toBe('yes\n');
    });
  });

  // ---------------------------------------------------------------------------
  // cond.tests — Conditional expressions [[ ]]
  // Source: tests/cond.tests + tests/cond.right
  // ---------------------------------------------------------------------------
  describe('conditionals [[ ]] (cond.tests)', () => {
    it('[[ -z "" ]] is true', async () => {
      const r = await runner.run('[[ -z "" ]] && echo true || echo false');
      expect(r.stdout).toBe('true\n');
    });

    it('[[ -n "x" ]] is true', async () => {
      const r = await runner.run('[[ -n "x" ]] && echo true || echo false');
      expect(r.stdout).toBe('true\n');
    });

    it('[[ string == pattern ]]', async () => {
      const r = await runner.run('[[ hello == hel* ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ string != pattern ]]', async () => {
      const r = await runner.run('[[ hello != world* ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ string =~ regex ]]', async () => {
      const r = await runner.run('[[ hello123 =~ [0-9]+ ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ -a and -o or ]]', async () => {
      const r = await runner.run('[[ 1 == 1 && 2 == 2 ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ with || ]]', async () => {
      const r = await runner.run('[[ 1 == 2 || 3 == 3 ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ ! negation ]]', async () => {
      const r = await runner.run('[[ ! 1 == 2 ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ -lt numeric comparison ]]', async () => {
      const r = await runner.run('[[ 5 -lt 10 ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ -gt numeric comparison ]]', async () => {
      const r = await runner.run('[[ 10 -gt 5 ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });

    it('[[ < string comparison ]]', async () => {
      const r = await runner.run('[[ abc < def ]] && echo yes || echo no');
      expect(r.stdout).toBe('yes\n');
    });
  });

  // ---------------------------------------------------------------------------
  // heredoc.tests — Here documents
  // Source: tests/heredoc.tests + tests/heredoc.right
  // ---------------------------------------------------------------------------
  describe('heredoc (heredoc.tests)', () => {
    it('basic heredoc', async () => {
      const r = await runner.run('cat <<EOF\nhello world\nEOF');
      expect(r.stdout).toBe('hello world\n');
    });

    it('heredoc with variable expansion', async () => {
      const r = await runner.run('x=42; cat <<EOF\nvalue is $x\nEOF');
      expect(r.stdout).toBe('value is 42\n');
    });

    it('quoted heredoc prevents expansion', async () => {
      const r = await runner.run("x=42; cat <<'EOF'\nvalue is $x\nEOF");
      expect(r.stdout).toBe('value is $x\n');
    });

    it('heredoc with command substitution', async () => {
      const r = await runner.run('cat <<EOF\nresult: $(echo hello)\nEOF');
      expect(r.stdout).toBe('result: hello\n');
    });

    it('multi-line heredoc', async () => {
      const r = await runner.run('cat <<EOF\nline1\nline2\nline3\nEOF');
      expect(r.stdout).toBe('line1\nline2\nline3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // herestr.tests — Here strings
  // Source: tests/herestr.tests + tests/herestr.right
  // ---------------------------------------------------------------------------
  describe('herestring (herestr.tests)', () => {
    it('basic herestring', async () => {
      const r = await runner.run('cat <<< "hello"');
      expect(r.stdout).toBe('hello\n');
    });

    it('herestring with variable', async () => {
      const r = await runner.run('x=world; cat <<< "hello $x"');
      expect(r.stdout).toBe('hello world\n');
    });

    it('herestring to read', async () => {
      const r = await runner.run('read x <<< "test"; echo $x');
      expect(r.stdout).toBe('test\n');
    });

    it('herestring with wc', async () => {
      const r = await runner.run('wc -c <<< "hello"');
      expect(r.stdout.trim()).toBe('6');
    });
  });

  // ---------------------------------------------------------------------------
  // set-e.tests — Error handling modes
  // Source: tests/set-e.tests + tests/set-e.right
  // ---------------------------------------------------------------------------
  describe('set -e (set-e.tests)', () => {
    it('set -e stops on error', async () => {
      const r = await runner.run('set -e; true; echo one; false; echo two');
      expect(r.stdout).toBe('one\n');
      expect(r.exitCode).not.toBe(0);
    });

    it('set -e does not trigger in if condition', async () => {
      const r = await runner.run('set -e; if false; then echo x; fi; echo ok');
      expect(r.stdout).toBe('ok\n');
    });

    it('set -e does not trigger in while condition', async () => {
      const r = await runner.run('set -e; while false; do echo x; done; echo ok');
      expect(r.stdout).toBe('ok\n');
    });

    it('set -e does not trigger with ||', async () => {
      const r = await runner.run('set -e; false || echo recovered; echo ok');
      expect(r.stdout).toBe('recovered\nok\n');
    });

    it('set -e does not trigger with &&', async () => {
      const r = await runner.run('set -e; false && echo x; echo ok');
      expect(r.stdout).toBe('ok\n');
    });

    it('set +e disables errexit', async () => {
      const r = await runner.run('set -e; set +e; false; echo still here');
      expect(r.stdout).toBe('still here\n');
    });
  });

  // ---------------------------------------------------------------------------
  // quote.tests — Quoting
  // Source: tests/quote.tests + tests/quote.right
  // ---------------------------------------------------------------------------
  describe('quoting (quote.tests)', () => {
    it('single quotes preserve literal $', async () => {
      const r = await runner.run("echo '$HOME'");
      expect(r.stdout).toBe('$HOME\n');
    });

    it('double quotes allow variable expansion', async () => {
      const r = await runner.run('x=hello; echo "$x"');
      expect(r.stdout).toBe('hello\n');
    });

    it('backslash escapes in double quotes', async () => {
      const r = await runner.run('echo "a\\$b"');
      expect(r.stdout).toBe('a$b\n');
    });

    it("dollar-single-quote $'\\n'", async () => {
      const r = await runner.run("echo $'a\\nb'");
      expect(r.stdout).toBe('a\nb\n');
    });

    it("dollar-single-quote $'\\t'", async () => {
      const r = await runner.run("echo $'a\\tb'");
      expect(r.stdout).toBe('a\tb\n');
    });
  });

  // ---------------------------------------------------------------------------
  // new-exp.tests — Advanced parameter expansion
  // Source: tests/new-exp.tests + tests/new-exp.right
  // ---------------------------------------------------------------------------
  describe('parameter expansion (new-exp.tests)', () => {
    it('${var/pattern/replacement}', async () => {
      const r = await runner.run('x=hello; echo ${x/ell/ELL}');
      expect(r.stdout).toBe('hELLo\n');
    });

    it('${var//pattern/replacement} global', async () => {
      const r = await runner.run('x=aabbaa; echo ${x//aa/XX}');
      expect(r.stdout).toBe('XXbbXX\n');
    });

    it('${var/#pattern/replacement} prefix', async () => {
      const r = await runner.run('x=hello; echo ${x/#hel/HEL}');
      expect(r.stdout).toBe('HELlo\n');
    });

    it('${var/%pattern/replacement} suffix', async () => {
      const r = await runner.run('x=hello; echo ${x/%llo/LLO}');
      expect(r.stdout).toBe('heLLO\n');
    });

    it('${#array[@]} counts elements', async () => {
      const r = await runner.run('a=(one two three); echo ${#a[@]}');
      expect(r.stdout).toBe('3\n');
    });

    it('${!var} indirect expansion', async () => {
      const r = await runner.run('x=hello; ref=x; echo ${!ref}');
      expect(r.stdout).toBe('hello\n');
    });

    it('${var:offset:length} substring', async () => {
      const r = await runner.run('x=abcdefgh; echo ${x:2:3}');
      expect(r.stdout).toBe('cde\n');
    });

    it('${var:-default} with unset', async () => {
      const r = await runner.run('unset x; echo ${x:-default}');
      expect(r.stdout).toBe('default\n');
    });

    it('${var:=default} assigns', async () => {
      const r = await runner.run('unset x; echo ${x:=assigned}; echo $x');
      expect(r.stdout).toBe('assigned\nassigned\n');
    });

    it('${var:+alternate} when set', async () => {
      const r = await runner.run('x=val; echo ${x:+alternate}');
      expect(r.stdout).toBe('alternate\n');
    });

    it('${var:+alternate} when unset', async () => {
      const r = await runner.run('unset x; echo ${x:+alternate}');
      expect(r.stdout).toBe('\n');
    });
  });

  // ---------------------------------------------------------------------------
  // test.tests — [ ] test expressions
  // Source: tests/test.tests + tests/test.right
  // ---------------------------------------------------------------------------
  describe('test expressions (test.tests)', () => {
    it('[ -z "" ]', async () => {
      const r = await runner.run('[ -z "" ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ -n "x" ]', async () => {
      const r = await runner.run('[ -n "x" ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ "a" = "a" ]', async () => {
      const r = await runner.run('[ "a" = "a" ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ "a" != "b" ]', async () => {
      const r = await runner.run('[ "a" != "b" ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ 5 -eq 5 ]', async () => {
      const r = await runner.run('[ 5 -eq 5 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ 5 -ne 3 ]', async () => {
      const r = await runner.run('[ 5 -ne 3 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ 3 -lt 5 ]', async () => {
      const r = await runner.run('[ 3 -lt 5 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ 5 -gt 3 ]', async () => {
      const r = await runner.run('[ 5 -gt 3 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ 5 -le 5 ]', async () => {
      const r = await runner.run('[ 5 -le 5 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('[ 5 -ge 5 ]', async () => {
      const r = await runner.run('[ 5 -ge 5 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('compound -a', async () => {
      const r = await runner.run('[ 1 -eq 1 -a 2 -eq 2 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('compound -o', async () => {
      const r = await runner.run('[ 1 -eq 2 -o 2 -eq 2 ] && echo true');
      expect(r.stdout).toBe('true\n');
    });

    it('negation !', async () => {
      const r = await runner.run('[ ! -z "x" ] && echo true');
      expect(r.stdout).toBe('true\n');
    });
  });
});
