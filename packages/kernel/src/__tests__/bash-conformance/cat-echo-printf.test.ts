/**
 * Conformance tests for cat, echo, printf — core text output commands.
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

const TOOLS = ['cat', 'echo', 'printf', 'true', 'false'];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('cat/echo/printf conformance', () => {
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
  // cat
  // ---------------------------------------------------------------------------
  describe('cat', () => {
    it('reads a file', async () => {
      writeFile('/tmp/f.txt', 'hello world\n');
      const r = await runner.run('cat /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('concatenates multiple files', async () => {
      writeFile('/tmp/a.txt', 'aaa\n');
      writeFile('/tmp/b.txt', 'bbb\n');
      const r = await runner.run('cat /tmp/a.txt /tmp/b.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('aaa\nbbb\n');
    });

    it('reads from stdin via pipe', async () => {
      const r = await runner.run("echo hello | cat");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('-n adds line numbers', async () => {
      writeFile('/tmp/f.txt', 'a\nb\nc\n');
      const r = await runner.run('cat -n /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('1');
      expect(r.stdout).toContain('a');
      expect(r.stdout).toContain('2');
      expect(r.stdout).toContain('b');
    });

    it('empty file produces empty output', async () => {
      writeFile('/tmp/empty.txt', '');
      const r = await runner.run('cat /tmp/empty.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('nonexistent file returns non-zero', async () => {
      const r = await runner.run('cat /tmp/no-such-file.txt');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // echo
  // ---------------------------------------------------------------------------
  describe('echo', () => {
    it('basic string', async () => {
      const r = await runner.run('echo hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\n');
    });

    it('multiple arguments separated by spaces', async () => {
      const r = await runner.run('echo hello world');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello world\n');
    });

    it('-n suppresses trailing newline', async () => {
      const r = await runner.run('echo -n hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('no arguments outputs just a newline', async () => {
      const r = await runner.run('echo');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('\n');
    });
  });

  // ---------------------------------------------------------------------------
  // printf
  // ---------------------------------------------------------------------------
  describe('printf', () => {
    it('basic string', async () => {
      const r = await runner.run("printf 'hello'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('%s format specifier', async () => {
      const r = await runner.run("printf 'hi %s' world");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hi world');
    });

    it('%d format specifier', async () => {
      const r = await runner.run("printf '%d' 42");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('42');
    });

    it('\\n escape sequence', async () => {
      const r = await runner.run("printf 'a\\nb\\n'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\nb\n');
    });

    it('\\t escape sequence', async () => {
      const r = await runner.run("printf 'a\\tb'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('a\tb');
    });

    it('no automatic trailing newline', async () => {
      const r = await runner.run("printf 'hello'");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });
  });
});
