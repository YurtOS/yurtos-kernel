/**
 * Conformance tests for diff — Myers diff algorithm with unified/normal output.
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
  'cat', 'echo', 'diff', 'printf', 'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('diff conformance', () => {
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

  // Helper to create test files
  function writeFile(path: string, content: string) {
    vfs.writeFile(path, new TextEncoder().encode(content));
  }

  // ---------------------------------------------------------------------------
  // Identical files
  // ---------------------------------------------------------------------------
  describe('identical files', () => {
    it('exit 0 and no output for identical files', async () => {
      writeFile('/tmp/a.txt', 'hello\nworld\n');
      writeFile('/tmp/b.txt', 'hello\nworld\n');
      const r = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('exit 0 for empty files', async () => {
      writeFile('/tmp/a.txt', '');
      writeFile('/tmp/b.txt', '');
      const r = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Normal diff output
  // ---------------------------------------------------------------------------
  describe('normal output', () => {
    it('change: single line changed', async () => {
      writeFile('/tmp/a.txt', 'hello\nworld\nfoo\n');
      writeFile('/tmp/b.txt', 'hello\nplanet\nfoo\n');
      const r = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('2c2');
      expect(r.stdout).toContain('< world');
      expect(r.stdout).toContain('> planet');
    });

    it('add: lines appended', async () => {
      writeFile('/tmp/a.txt', 'a\nb\n');
      writeFile('/tmp/b.txt', 'a\nb\nc\nd\n');
      const r = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('a');
      expect(r.stdout).toContain('> c');
      expect(r.stdout).toContain('> d');
    });

    it('delete: lines removed', async () => {
      writeFile('/tmp/a.txt', 'a\nb\nc\nd\n');
      writeFile('/tmp/b.txt', 'a\nd\n');
      const r = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('< b');
      expect(r.stdout).toContain('< c');
    });
  });

  // ---------------------------------------------------------------------------
  // Unified diff output (-u)
  // ---------------------------------------------------------------------------
  describe('unified output (-u)', () => {
    it('basic unified diff', async () => {
      writeFile('/tmp/a.txt', 'hello\nworld\nfoo\n');
      writeFile('/tmp/b.txt', 'hello\nplanet\nfoo\n');
      const r = await runner.run('diff -u /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('--- /tmp/a.txt');
      expect(r.stdout).toContain('+++ /tmp/b.txt');
      expect(r.stdout).toContain('@@ ');
      expect(r.stdout).toContain('-world');
      expect(r.stdout).toContain('+planet');
      expect(r.stdout).toContain(' hello');
      expect(r.stdout).toContain(' foo');
    });

    it('unified diff with context lines count', async () => {
      writeFile('/tmp/a.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
      writeFile('/tmp/b.txt', '1\n2\n3\n4\nFIVE\n6\n7\n8\n9\n10\n');
      const r = await runner.run('diff -U1 /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      // With -U1, only 1 context line on each side
      expect(r.stdout).toContain(' 4');
      expect(r.stdout).toContain('-5');
      expect(r.stdout).toContain('+FIVE');
      expect(r.stdout).toContain(' 6');
    });

    it('multiple hunks in unified diff', async () => {
      writeFile('/tmp/a.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n');
      writeFile('/tmp/b.txt', '1\nTWO\n3\n4\n5\n6\n7\n8\nNINE\n10\n');
      const r = await runner.run('diff -U0 /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      // Two separate hunks with 0 context
      const hunkCount = (r.stdout.match(/@@ /g) || []).length;
      expect(hunkCount).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Brief mode (-q)
  // ---------------------------------------------------------------------------
  describe('brief mode (-q)', () => {
    it('reports files differ', async () => {
      writeFile('/tmp/a.txt', 'hello\n');
      writeFile('/tmp/b.txt', 'world\n');
      const r = await runner.run('diff -q /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('differ');
    });

    it('no output for identical files', async () => {
      writeFile('/tmp/a.txt', 'same\n');
      writeFile('/tmp/b.txt', 'same\n');
      const r = await runner.run('diff -q /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Whitespace options
  // ---------------------------------------------------------------------------
  describe('whitespace options', () => {
    it('-w ignores all whitespace', async () => {
      writeFile('/tmp/a.txt', 'hello world\n');
      writeFile('/tmp/b.txt', 'helloworld\n');
      const r = await runner.run('diff -w /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
    });

    it('-b ignores whitespace amount changes', async () => {
      writeFile('/tmp/a.txt', 'hello  world\n');
      writeFile('/tmp/b.txt', 'hello world\n');
      const r = await runner.run('diff -b /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
    });

    it('-i ignores case', async () => {
      writeFile('/tmp/a.txt', 'Hello World\n');
      writeFile('/tmp/b.txt', 'hello world\n');
      const r = await runner.run('diff -i /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
    });

    it('-B ignores blank lines', async () => {
      writeFile('/tmp/a.txt', 'hello\n\nworld\n');
      writeFile('/tmp/b.txt', 'hello\nworld\n');
      const r = await runner.run('diff -B /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Combined flags
  // ---------------------------------------------------------------------------
  describe('combined flags', () => {
    it('-ub combines unified and whitespace-change', async () => {
      writeFile('/tmp/a.txt', 'hello  world\nfoo\n');
      writeFile('/tmp/b.txt', 'hello world\nbar\n');
      const r = await runner.run('diff -ub /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      // First line should be equal (whitespace change ignored)
      // Second line should differ
      expect(r.stdout).toContain('-foo');
      expect(r.stdout).toContain('+bar');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('one file empty, other has content', async () => {
      writeFile('/tmp/a.txt', '');
      writeFile('/tmp/b.txt', 'hello\nworld\n');
      const r = await runner.run('diff /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('> hello');
      expect(r.stdout).toContain('> world');
    });

    it('file not found returns exit 2', async () => {
      writeFile('/tmp/a.txt', 'hello\n');
      const r = await runner.run('diff /tmp/a.txt /tmp/nonexistent.txt');
      expect(r.exitCode).toBe(2);
    });

    it('large diff with many changes', async () => {
      const lines1 = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n') + '\n';
      const lines2 = Array.from({ length: 50 }, (_, i) => i === 25 ? 'CHANGED' : `line${i}`).join('\n') + '\n';
      writeFile('/tmp/a.txt', lines1);
      writeFile('/tmp/b.txt', lines2);
      const r = await runner.run('diff -u /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toContain('-line25');
      expect(r.stdout).toContain('+CHANGED');
    });
  });
});
