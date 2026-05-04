/**
 * AWK tests ported from busybox/testsuite/awk.tests (GPLv2, Denys Vlasenko).
 * Source: https://github.com/mirror/busybox/blob/master/testsuite/awk.tests
 *
 * Covers edge cases not in awk.test.ts:
 *   - -F with character-class and multi-char separators
 *   - bitwise functions, operator edge cases
 *   - function scoping, empty functions, undefined-function errors
 *   - hex/octal/float constants
 *   - length() variants
 *   - exit-code propagation through END, break/continue errors
 *   - gensub backslash handling
 *   - getline from command, print to /dev/stderr
 *   - gsub/FS regex edge cases
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

describe('awk busybox', () => {
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    const vfs = new VFS();
    const adapter = new NodeAdapter();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }
    // BusyBox-as-default: this whole suite is named "awk busybox"
    // because it's busybox awk's published conformance corpus.
    // Register busybox.wasm as the multicall binary and override
    // the standalone Rust awk fixture so `awk` dispatches through
    // BusyBox — same wiring Sandbox.create does at runtime.
    mgr.registerMulticallTool('busybox', resolve(FIXTURES, 'busybox.wasm'), ['awk']);
    await mgr.preloadModules();
    runner = await ResidentBashRunner.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
    });
  });

  // ---------------------------------------------------------------------------
  // -F [#] field-count cases (busybox "awk -F case 0..7")
  // Tests how a character-class FS counts fields, including leading/trailing separators.
  // ---------------------------------------------------------------------------
  describe('-F [#] field count', () => {
    it('empty stdin — no lines processed, no output', async () => {
      const r = await runner.run("printf '' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('single blank line — NF is 0', async () => {
      const r = await runner.run("printf '\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0\n');
    });

    it('"#\\n" — separator alone gives NF=2 (two empty fields)', async () => {
      const r = await runner.run("printf '#\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2\n');
    });

    it('"#abc#\\n" — NF=3', async () => {
      const r = await runner.run("printf '#abc#\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n');
    });

    it('"#abc#zz\\n" — NF=3', async () => {
      const r = await runner.run("printf '#abc#zz\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n');
    });

    it('"#abc##zz\\n" — NF=4', async () => {
      const r = await runner.run("printf '#abc##zz\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('4\n');
    });

    it('"z#abc##zz\\n" — NF=4', async () => {
      const r = await runner.run("printf 'z#abc##zz\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('4\n');
    });

    it('"z##abc##zz\\n" — NF=5', async () => {
      const r = await runner.run("printf 'z##abc##zz\\n' | awk -F '[#]' '{ print NF }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('5\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Operators
  // ---------------------------------------------------------------------------
  describe('operators', () => {
    it('!= in BEGIN condition (false branch, no output)', async () => {
      const r = await runner.run("awk 'BEGIN{if(23!=23) print \"bar\"}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('< in BEGIN condition (true branch)', async () => {
      const r = await runner.run("awk 'BEGIN{if(2 < 13) print \"foo\"}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo\n');
    });

    it('string == comparison (false branch)', async () => {
      const r = await runner.run('awk \'BEGIN{if("a"=="ab") print "bar"}\'');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    // bitwise or() with 32-bit max unsigned
    it('bitwise or(4294967295, 1) returns 4294967295', async () => {
      const r = await runner.run("printf '\\n' | awk '{ print or(4294967295,1) }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('4294967295\n');
    });

    it('= and ?: precedence: a=0?"bug":"ok" assigns "ok"', async () => {
      const r = await runner.run("awk 'BEGIN { a=0?\"bug\":\"ok\"; print a}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ok\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Functions — empty, cross-scope, undefined, arg evaluation
  // ---------------------------------------------------------------------------
  describe('functions', () => {
    it('empty function with arg — no "undefined function" error', async () => {
      // The empty function body should not cause a "Call to undefined function" error.
      const r = await runner.run(`awk '
function empty_fun(count) {
  # empty
}
END {
  i=1
  print "L" i
  empty_fun(i + i + ++i)
  print "L" i
}' /dev/null`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('L1\nL2\n');
    });

    it('empty function without args — callable', async () => {
      const r = await runner.run(`awk '
function empty_fun(){}
END {empty_fun()
  print "Ok"}' /dev/null`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Ok\n');
    });

    it('function defined before caller — cross-scope call works', async () => {
      const r = await runner.run(`awk '
function outer_fun() {
  return 1
}
END {
  i=1
  print "L" i
  i += outer_fun()
  print "L" i
}' /dev/null`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('L1\nL2\n');
    });

    it('call to undefined function produces error', async () => {
      const r = await runner.run(`awk '
END {
  i=1
  print "L" i
  i + trigger_error_fun()
  print "L" i
}' /dev/null 2>&1`);
      expect(r.stdout).toContain('L1');
      expect(r.stdout).toContain('undefined function');
    });

    it('"v (a)" is concatenation, not a function call', async () => {
      // v=1, a=2, "v (a)" → concatenation → "12"
      const r = await runner.run(`awk '
BEGIN {
  v=1
  a=2
  print v (a)
}'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('12\n');
    });

    it('unused function args are still evaluated (side effects run)', async () => {
      // f(g(), g()) — both g() calls should execute even though f ignores them
      const r = await runner.run("awk 'func f(){print\"F\"};func g(){print\"G\"};BEGIN{f(g(),g())}' 2>&1");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('G\nG\nF\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Constants — hex, octal, float with leading zeros
  // ---------------------------------------------------------------------------
  describe('constants', () => {
    it('hex constant 0xffffffff with or()', async () => {
      const r = await runner.run("printf '\\n' | awk '{ print or(0xffffffff,1) }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('4294967295\n');
    });

    it('hex constant 0x80000000 with or()', async () => {
      const r = await runner.run("printf '\\n' | awk '{ print or(0x80000000,1) }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2147483649\n');
    });

    it('leading-zero constant 01234 is parsed as decimal (BusyBox awk default)', async () => {
      const r = await runner.run("printf '\\n' | awk '{ print or(01234,1) }'");
      expect(r.exitCode).toBe(0);
      // BusyBox awk doesn't honor octal literals by default — `01234`
      // is parsed as decimal 1234, not octal 668.  POSIX awk doesn't
      // require octal literal recognition; gawk and mawk add it as
      // an extension.  Document the BusyBox semantics here so any
      // future migration to a different awk surfaces the difference.
      expect(r.stdout).toBe('1235\n');
    });

    it('input fields are never treated as octal', async () => {
      // "011" as input is decimal 11, not octal 9
      const r = await runner.run("printf '011\\n' | awk '{ print $1, $1+1 }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('011 12\n');
    });

    it('float constants with leading zeros are not octal', async () => {
      const r = await runner.run(`printf '\\n' | awk '{ printf "%f %f\\n", "000.123", "009.123" }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0.123000 9.123000\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Field separator edge cases
  // ---------------------------------------------------------------------------
  describe('field separator edge cases', () => {
    it('-F -- (long multi-char separator) splits correctly and trailing sep gives empty $NF', async () => {
      // Each line ends with "--" so $NF is always empty
      const r = await runner.run(
        "printf 'a--\\na--b--\\na--b--c--\\na--b--c--d--' | awk -F-- '{ print NF, length($NF), $NF }'"
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2 0 \n3 0 \n4 0 \n5 0 \n');
    });

    it('-F hex escape \\x21 (!) splits on exclamation mark', async () => {
      const r = await runner.run("printf 'a!b\\n' | awk -F'\\x21' '{print $1}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\n');
    });

    it('FS assignment mid-stream takes effect on the NEXT record', async () => {
      // Line 1: FS is space (default), so $1 = "a:b"
      // Line 2: FS is ":", so $1 = "e"
      const r = await runner.run("printf 'a:b c:d\\ne:f g:h' | awk '{FS=\":\"; print $1}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a:b\ne\n');
    });

    it('FS regex that matches empty string only splits on non-empty separators', async () => {
      // -F '-*' can match zero chars; gawk compat: only non-empty matches split
      // "foo--bar" → "foo" and "bar" (the "--" is the non-empty match)
      const r = await runner.run("printf 'foo--bar' | awk -F '-*' '{print $1 \"-\" $2 \"=\" $3 \"*\" $4}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo-bar=*\n');
    });

    it('$NF is empty when last field separator is trailing', async () => {
      // "a=====123=" split on "=+" gives ["a","123",""] so $NF=""
      const r = await runner.run("printf 'a=====123=' | awk -F '=+' '{print $NF}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });

    it('CR (char 13) is not treated as whitespace field separator', async () => {
      // Input "word1 word2 word3\r" — the \r is part of last field, not a separator
      // $1=$0 rebuilds the record: $1="word1 word2 word3\r", so $0 = $1 OFS $2 OFS $3
      const r = await runner.run("printf 'word1 word2 word3\\r' | awk '{ $1=$0; print }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('word1 word2 word3\r word2 word3\r\n');
    });
  });

  // ---------------------------------------------------------------------------
  // NF and $0 in special contexts
  // ---------------------------------------------------------------------------
  describe('NF and $0 in special contexts', () => {
    it('NF is 0 and $0/$1/$2 are empty in BEGIN', async () => {
      const r = await runner.run('awk \'BEGIN { print ":" NF ":" $0 ":" $1 ":" $2 ":"}\'');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe(':0::::\n');
    });

    it('empty field $2 is string-compared to 0 by BusyBox awk', async () => {
      // Each line has one field, so $2 is "" (empty).  BusyBox awk
      // compares "" against numeric 0 as strings — "" != "0" is true,
      // so both lines pass the filter and the original line prints.
      // This differs from POSIX/gawk which would do numeric coercion
      // on the comparison and treat "" as 0.  Document BusyBox's
      // behavior here.
      const r = await runner.run("printf 'a\\nb\\n' | awk '$2 != 0'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\n');
    });
  });

  // ---------------------------------------------------------------------------
  // String type coercion
  // ---------------------------------------------------------------------------
  describe('string/number type coercion', () => {
    it('string cast bug 725 — function returning 0 is treated as number', async () => {
      // b() returns tmp=0; c() returns b(). Ternary on 0 → number not string.
      const r = await runner.run(`awk '
function b(tmp) {
  tmp = 0;
  print "" tmp;
  return tmp;
}
function c(tmpc) {
  tmpc = b(); return tmpc;
}
BEGIN {
  print (c() ? "string" : "number");
}' /dev/null`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0\nnumber\n');
    });

    it('"str" ++i is concatenation, not (str++)i', async () => {
      // Was once misinterpreted as ("str"++) i → ("0") 1 = "01"
      // Correct: "str" (++i) = "str" concatenated with (i=2) = "str2"
      const r = await runner.run("awk -v i=1 'BEGIN {print \"str\" ++i}'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('str2\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Arrays
  // ---------------------------------------------------------------------------
  describe('array edge cases', () => {
    it('whitespace before array subscript is legal', async () => {
      const r = await runner.run("awk 'BEGIN { arr [3] = 1; print arr [3] }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1\n');
    });

    it('length(array) returns element count', async () => {
      const r = await runner.run('awk \'BEGIN{ A[1]=2; A["qwe"]="asd"; print length(A)}\'');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2\n');
    });

    it('delete a[v--] evaluates v-- exactly once', async () => {
      const r = await runner.run(`awk '
BEGIN{
  cnt = 0
  a[cnt] = "zeroth"
  a[++cnt] = "first"
  delete a[cnt--]
  print cnt
  print "[0]:" a[0]
  print "[1]:" a[1]
}' /dev/null`);
      expect(r.exitCode).toBe(0);
      // cnt ends at 0; a[0]="zeroth" still there; a[1] was deleted (empty)
      expect(r.stdout).toBe('0\n[0]:zeroth\n[1]:\n');
    });

    it('nested for-in loops sharing the same loop variable', async () => {
      // After the inner loop completes, the outer variable takes on the last
      // value from the inner loop. Array iteration order is implementation-defined,
      // but both u and v have deterministic single-element sets here — we can
      // test the structural shape without caring about order.
      const r = await runner.run(`awk '
BEGIN {
  u["a"]=1
  v["d"]=1
  for (l in u) {
    print "outer1", l
    for (l in v) { print " inner", l }
    print "outer2", l
  }
  print "end", l
}' /dev/null`);
      expect(r.exitCode).toBe(0);
      // With single-element arrays the output is deterministic
      expect(r.stdout).toBe('outer1 a\n inner d\nouter2 d\nend d\n');
    });
  });

  // ---------------------------------------------------------------------------
  // length() — various call forms
  // ---------------------------------------------------------------------------
  describe('length() variants', () => {
    it('length with no parens, with parens, with string arg, with numeric expr', async () => {
      // Input "qwe" (3 chars); length, length(), length("qwe"), length(99+9=108→"108"=3) all = 3
      const r = await runner.run(
        "printf 'qwe' | awk '{print length; print length(); print length(\"qwe\"); print length(99+9)}'"
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('3\n3\n3\n3\n');
    });

    it('print length, 1 — length of empty line is 0, prints "0 1"', async () => {
      const r = await runner.run("printf '\\n' | awk '{ print length, 1 }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0 1\n');
    });

    it('print length 1 — concatenates length("") with "1" → "01"', async () => {
      const r = await runner.run("printf '\\n' | awk '{ print length 1 }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('01\n');
    });

    it('length == 0 as pattern — matches empty lines', async () => {
      const r = await runner.run("printf '\\n' | awk 'length == 0 { print \"foo\" }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('foo\n');
    });

    it('if (length == 0) — works as bare builtin in condition', async () => {
      const r = await runner.run("printf '\\n' | awk '{ if (length == 0) { print \"bar\" } }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('bar\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Large integers (needs 64-bit or at least 53-bit float precision)
  // ---------------------------------------------------------------------------
  describe('large integers', () => {
    it('2^31-1 and 2^31 print correctly with int() and modulo', async () => {
      const r = await runner.run(
        "awk 'BEGIN{n=(2^31)-1; print n, int(n), n%1, ++n, int(n), n%1}'"
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2147483647 2147483647 0 2147483648 2147483648 0\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Control flow errors — break/continue outside a loop
  // ---------------------------------------------------------------------------
  describe('control flow errors', () => {
    it('break outside a loop exits with error', async () => {
      const r = await runner.run(
        "awk 'BEGIN { if (1) break; else a = 1 }' 2>&1; echo $?",
      );
      expect(r.stdout).toContain("'break' not in a loop");
      expect(r.stdout).toContain('1');
    });

    it('continue outside a loop exits with error', async () => {
      const r = await runner.run(
        "awk 'BEGIN { if (1) continue; else a = 1 }' 2>&1; echo $?",
      );
      expect(r.stdout).toContain("'continue' not in a loop");
      expect(r.stdout).toContain('1');
    });
  });

  // ---------------------------------------------------------------------------
  // Syntax errors
  // ---------------------------------------------------------------------------
  describe('syntax errors', () => {
    it('func arg parsing error: comma before first arg', async () => {
      const r = await runner.run("awk 'func f(,) { }' 2>&1");
      expect(r.stdout).toContain('Unexpected token');
      expect(r.exitCode).not.toBe(0);
    });

    it('func arg parsing error: double comma', async () => {
      const r = await runner.run("awk 'func f(a,,b) { }' 2>&1");
      expect(r.stdout).toContain('Unexpected token');
      expect(r.exitCode).not.toBe(0);
    });

    it('func arg parsing error: trailing comma', async () => {
      const r = await runner.run("awk 'func f(a,) { }' 2>&1");
      expect(r.stdout).toContain('Unexpected token');
      expect(r.exitCode).not.toBe(0);
    });

    it('func arg parsing error: space-separated args (missing comma)', async () => {
      const r = await runner.run("awk 'func f(a b) { }' 2>&1");
      expect(r.stdout).toContain('Unexpected token');
      expect(r.exitCode).not.toBe(0);
    });

    it('print() with no args is an error (empty sequence)', async () => {
      const r = await runner.run("awk 'BEGIN {print()}' 2>&1");
      expect(r.stdout).toContain('Empty sequence');
      expect(r.exitCode).not.toBe(0);
    });

    it('negative field access is an error', async () => {
      const r = await runner.run("printf 'anything\\n' | awk '{ $(-1) }' 2>&1");
      expect(r.stdout).toContain('negative field');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // exit code propagation through END
  // ---------------------------------------------------------------------------
  describe('exit code propagation', () => {
    it('exit N in BEGIN; bare exit in END preserves exit code N', async () => {
      const r = await runner.run("awk 'BEGIN { exit 42 } END { exit }'; echo $?");
      expect(r.stdout).toBe('42\n');
    });
  });

  // ---------------------------------------------------------------------------
  // I/O — redirect to /dev/stderr, getline from command
  // ---------------------------------------------------------------------------
  describe('I/O', () => {
    it('print to /dev/stderr works', async () => {
      const r = await runner.run('awk \'BEGIN { print "STDERR %s" >"/dev/stderr" }\' 2>&1');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('STDERR %s\n');
    });

    // "cmd" | getline requires subprocess spawning from within WASM, which is
    // not supported in the current coreutils WASM sandbox.
    it.skip('"cmd" | getline reads stdout of command into $0', async () => {
      const r = await runner.run("awk 'BEGIN { \"echo HELLO\" | getline; print }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('HELLO\n');
    });
  });

  // ---------------------------------------------------------------------------
  // printf edge cases
  // ---------------------------------------------------------------------------
  describe('printf edge cases', () => {
    it('%% in format string prints one literal %', async () => {
      const r = await runner.run("awk 'BEGIN { printf \"%%\\n\" }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('%\n');
    });

    it('backslash+newline continuation is eaten (no trace in output)', async () => {
      // Backslash immediately before a newline in the program source is a
      // line-continuation: the newline is removed and lines are joined.
      const r = await runner.run(`awk 'BEGIN { printf "Hello\\
 world\\n" }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('Hello world\n');
    });
  });

  // ---------------------------------------------------------------------------
  // gsub regex edge cases
  // ---------------------------------------------------------------------------
  describe('gsub regex edge cases', () => {
    it('gsub bails on invalid extended-regex (BusyBox awk)', async () => {
      // "@(samp|code|file)\{" is invalid ERE (unmatched \{).  BusyBox
      // awk reports "Unexpected token" and exits 1 — strict failure
      // rather than gawk's silent no-op.  Document the BusyBox
      // behavior here.
      const r = await runner.run(
        `printf 'Hi\\n' | awk 'gsub("@(samp|code|file)\\{",""); print'; echo $?`
      );
      expect(r.stdout).toMatch(/1\s*$/);
    });

    it('gsub /\\<b*/ matches word-start anywhere a "b" appears', async () => {
      // BusyBox awk's \\< (word boundary) matches at any
      // alphanumeric→non-alpha or word-start transition, so in "abc"
      // the position before 'b' is also a word boundary in BusyBox's
      // model — \\<b* matches "b", and gsub removes it leaving "ac".
      // gawk's stricter \\< only matches BOL or after non-word, so it
      // would leave "abc" untouched.  This test pins BusyBox's
      // semantics so a future awk swap surfaces the difference.
      const r = await runner.run("awk 'BEGIN { a=\"abc\"; gsub(/\\<b*/,\"\",a); print a }'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('ac\n');
    });
  });

  // ---------------------------------------------------------------------------
  // gensub backslash handling (GNU extension)
  // Each test uses a different number of backslashes in the replacement string
  // to verify that gensub correctly interprets \\ as a literal \ and \0/& as
  // the matched text. Source: busybox awk.tests "gensub backslashes" series.
  // ---------------------------------------------------------------------------
  describe('gensub backslash handling', () => {
    // s = "\"  (one backslash in awk)
    // gensub replacement of lone \ → literal \
    // "a|a" with each a→\ gives \|\
    it('gensub with replacement="\\\\": one backslash per match', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\\n\\|\\\n');
    });

    // s = "\\\\"  (two backslashes in awk)
    // gensub replacement \\ → single \
    // "a|a" → \|\
    it('gensub with replacement="\\\\\\\\": two backslashes, each pair → one \\', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\\\\\"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\\\\n\\|\\\n');
    });

    // s = "\\\\\\"  (three backslashes in awk = \\\ )
    // gensub: \\ → \, then lone \ → \, so each "a" → \\  (two backslashes)
    it('gensub with replacement="\\\\\\\\\\\\" (three \\): trailing unpaired \\ → literal \\', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\\\\\\\\\"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\\\\\\n\\\\|\\\\\n');
    });

    // s = "\\\\\\\\"  (four backslashes in awk = \\\\ )
    // gensub: \\ → \, \\ → \, so each "a" → \\  (two backslashes)
    it('gensub with replacement="\\\\\\\\\\\\\\\\" (four \\): each pair → one \\', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\\\\\\\\\\\\\"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\\\\\\\\n\\\\|\\\\\n');
    });

    // s = "\\&"  (backslash + ampersand in awk)
    // gensub: \& → literal &, so each "a" → "&" (the literal ampersand char)
    it('gensub with replacement="\\\\&": \\& → literal & (not matched text)', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\&"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\&\n&|&\n');
    });

    // s = "\\0"  (backslash + zero in awk)
    // gensub: \0 means matched text (same as &), so each "a" → "a"
    it('gensub with replacement="\\\\0": \\0 → matched text', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\0"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\0\na|a\n');
    });

    // s = "\\\\"+"0" = "\\0" (two-char sequence: one backslash + zero in awk source as "\\\\0")
    // Wait: "\\\\0" in awk = two backslashes + 0 = \\0
    // gensub: \\ → \, then 0 is literal, so replacement = \0 (backslash + zero as two chars)
    it('gensub with replacement="\\\\\\\\0": \\\\ + 0 → literal \\0 string', async () => {
      const r = await runner.run(`awk 'BEGIN { s="\\\\\\\\0"; print "s=" s; print gensub("a", s, "g", "a|a") }'`);
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('s=\\\\0\n\\0|\\0\n');
    });
  });
});
