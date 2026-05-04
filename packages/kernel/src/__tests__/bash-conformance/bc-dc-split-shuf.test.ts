/**
 * Conformance tests for bc, dc, split, tee, truncate, mktemp, cmp, shuf —
 * math, splitting, and misc utilities.
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
  'cat', 'echo', 'printf', 'bc', 'dc', 'split', 'tee', 'truncate',
  'mktemp', 'cmp', 'shuf', 'ls', 'mkdir', 'wc', 'sort', 'seq',
  'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('bc/dc/split/misc conformance', () => {
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
  // bc
  // ---------------------------------------------------------------------------
  describe('bc', () => {
    it('basic addition', async () => {
      const r = await runner.run("echo '2+3' | bc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('5');
    });

    it('multiplication', async () => {
      const r = await runner.run("echo '6*7' | bc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('42');
    });

    it('integer division', async () => {
      const r = await runner.run("echo '10/3' | bc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('3');
    });

    it('scale for decimals', async () => {
      const r = await runner.run("echo 'scale=2; 10/3' | bc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('3.33');
    });
  });

  // ---------------------------------------------------------------------------
  // dc
  // ---------------------------------------------------------------------------
  describe('dc', () => {
    it('addition', async () => {
      const r = await runner.run("echo '2 3 + p' | dc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('5');
    });

    it('multiplication', async () => {
      const r = await runner.run("echo '6 7 * p' | dc");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('42');
    });
  });

  // ---------------------------------------------------------------------------
  // split
  // ---------------------------------------------------------------------------
  describe('split', () => {
    it('splits file by lines', async () => {
      writeFile('/tmp/input.txt', 'a\nb\nc\nd\ne\nf\n');
      const r = await runner.run('split -l 2 /tmp/input.txt /tmp/part_');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/part_aa');
      expect(r2.stdout).toBe('a\nb\n');
      const r3 = await runner.run('cat /tmp/part_ab');
      expect(r3.stdout).toBe('c\nd\n');
    });

    it('cat pieces back together matches original', async () => {
      writeFile('/tmp/input.txt', 'line1\nline2\nline3\nline4\n');
      await runner.run('split -l 2 /tmp/input.txt /tmp/s_');
      const r = await runner.run('cat /tmp/s_aa /tmp/s_ab');
      expect(r.stdout).toBe('line1\nline2\nline3\nline4\n');
    });
  });

  // ---------------------------------------------------------------------------
  // tee
  // ---------------------------------------------------------------------------
  describe('tee', () => {
    it('duplicates stdin to file and stdout', async () => {
      const r = await runner.run("echo 'hello' | tee /tmp/out.txt");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
      const r2 = await runner.run('cat /tmp/out.txt');
      expect(r2.stdout).toBe('hello\n');
    });

    it('-a appends to existing file', async () => {
      writeFile('/tmp/out.txt', 'first\n');
      await runner.run("echo 'second' | tee -a /tmp/out.txt");
      const r = await runner.run('cat /tmp/out.txt');
      expect(r.stdout).toBe('first\nsecond\n');
    });
  });

  // ---------------------------------------------------------------------------
  // truncate
  // ---------------------------------------------------------------------------
  describe('truncate', () => {
    it('-s 0 empties a file', async () => {
      writeFile('/tmp/f.txt', 'some content\n');
      const r = await runner.run('truncate -s 0 /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/f.txt');
      expect(r2.stdout).toBe('');
    });

    it('-s 5 sets file to 5 bytes', async () => {
      writeFile('/tmp/f.txt', 'hello world');
      const r = await runner.run('truncate -s 5 /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      const r2 = await runner.run('cat /tmp/f.txt');
      expect(r2.stdout).toBe('hello');
    });
  });

  // ---------------------------------------------------------------------------
  // mktemp
  // ---------------------------------------------------------------------------
  describe('mktemp', () => {
    it('creates a temporary file', async () => {
      const r = await runner.run('mktemp');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });

    it('-d creates a temporary directory', async () => {
      const r = await runner.run('mktemp -d');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // cmp
  // ---------------------------------------------------------------------------
  describe('cmp', () => {
    it('identical files exit 0', async () => {
      writeFile('/tmp/a.txt', 'same\n');
      writeFile('/tmp/b.txt', 'same\n');
      const r = await runner.run('cmp /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
    });

    it('different files exit non-zero', async () => {
      writeFile('/tmp/a.txt', 'aaa\n');
      writeFile('/tmp/b.txt', 'bbb\n');
      const r = await runner.run('cmp /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // shuf
  // ---------------------------------------------------------------------------
  describe('shuf', () => {
    it('-n 1 outputs exactly one line', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | shuf -n 1");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines.length).toBe(1);
      expect(['a', 'b', 'c']).toContain(lines[0]);
    });

    it('shuffles all lines', async () => {
      const r = await runner.run("printf 'a\\nb\\nc\\n' | shuf");
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split('\n').sort();
      expect(lines).toEqual(['a', 'b', 'c']);
    });
  });
});
