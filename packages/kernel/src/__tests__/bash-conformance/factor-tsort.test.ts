/**
 * factor and tsort conformance tests.
 *
 * factor: prime factorization
 *   - Output: "N: p1 p2 p3 ..." one line per number
 *   - 0 and 1 produce no factors: "0: " and "1: "
 *   - Multiple command-line args: one line per arg
 *   - Stdin: one number (or multiple whitespace-separated) per line
 *
 * tsort: topological sort
 *   - Input: whitespace-separated pairs; each pair means "first precedes second"
 *   - Self-pairs (a a) register a node but add no edge
 *   - Odd token at end: lone node
 *   - Cycle: exit code 1, cycle members still printed to stdout
 *   - Deterministic: uses insertion order for tie-breaking
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
  'rg', 'factor', 'tsort',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

describe('factor tsort', () => {
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
  // factor
  // ---------------------------------------------------------------------------
  describe('factor: prime factorization', () => {
    it('factor 0: no factors', async () => {
      const r = await runner.run('factor 0');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('0: \n');
    });

    it('factor 1: no factors', async () => {
      const r = await runner.run('factor 1');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('1: \n');
    });

    it('factor 2: prime', async () => {
      const r = await runner.run('factor 2');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2: 2\n');
    });

    it('factor 4 = 2 * 2', async () => {
      const r = await runner.run('factor 4');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('4: 2 2\n');
    });

    it('factor 6 = 2 * 3', async () => {
      const r = await runner.run('factor 6');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('6: 2 3\n');
    });

    it('factor 12 = 2 * 2 * 3', async () => {
      const r = await runner.run('factor 12');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('12: 2 2 3\n');
    });

    it('factor 13: prime', async () => {
      const r = await runner.run('factor 13');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('13: 13\n');
    });

    it('factor 36 = 2^2 * 3^2', async () => {
      const r = await runner.run('factor 36');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('36: 2 2 3 3\n');
    });

    it('factor 100 = 2^2 * 5^2', async () => {
      const r = await runner.run('factor 100');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('100: 2 2 5 5\n');
    });

    it('factor 97: large prime', async () => {
      const r = await runner.run('factor 97');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('97: 97\n');
    });

    it('multiple args: one output line per arg', async () => {
      const r = await runner.run('factor 2 3 4');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('2: 2\n3: 3\n4: 2 2\n');
    });

    it('stdin: one number per line', async () => {
      const r = await runner.run("printf '12\\n' | factor");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('12: 2 2 3\n');
    });

    it('stdin: multiple numbers on one line (whitespace-split)', async () => {
      const r = await runner.run("printf '4 9\\n' | factor");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('4: 2 2\n9: 3 3\n');
    });
  });

  // ---------------------------------------------------------------------------
  // tsort
  // ---------------------------------------------------------------------------
  describe('tsort: topological sort', () => {
    it('simple linear chain: a→b→c', async () => {
      const r = await runner.run("printf 'a b\\nb c\\n' | tsort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\nc\n');
    });

    it('diamond dependency: a→b, a→c, b→d, c→d', async () => {
      const r = await runner.run("printf 'a b\\na c\\nb d\\nc d\\n' | tsort");
      expect(r.exitCode).toBe(0);
      // Insertion order: a(0), b(1), c(2), d(3) → a, then b before c, then d
      expect(r.stdout).toBe('a\nb\nc\nd\n');
    });

    it('self-pair registers node but adds no edge', async () => {
      const r = await runner.run("printf 'a a\\n' | tsort");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\n');
    });

    it('odd token count: input error (POSIX/GNU/BusyBox)', async () => {
      // tsort takes pairs; an odd token count means the last token has no
      // partner. POSIX leaves it implementation-defined; GNU and BusyBox
      // both report the input as malformed and exit non-zero. The BusyBox
      // tsort.tests "odd"/"odd2" cases pin this expectation.
      const r = await runner.run("printf 'alone\\n' | tsort");
      expect(r.exitCode).not.toBe(0);
      expect(r.stderr).toMatch(/odd number of tokens/);
    });

    it('file input: reads from named file', async () => {
      vfs.writeFile('/home/user/deps.txt', new TextEncoder().encode('x y\ny z\n'));
      const r = await runner.run('tsort /home/user/deps.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('x\ny\nz\n');
    });

    it('cycle: exit code 1, cycle members printed to stdout', async () => {
      const r = await runner.run("printf 'a b\\nb a\\n' | tsort");
      expect(r.exitCode).toBe(1);
      // Both nodes in cycle are output in insertion order
      expect(r.stdout).toBe('a\nb\n');
    });
  });
});
