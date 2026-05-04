/**
 * Conformance tests for md5sum, sha256sum, sha1sum, cksum, base64, base32 —
 * hashing and encoding commands.
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
  'cat', 'echo', 'printf', 'md5sum', 'sha256sum', 'sha1sum',
  'cksum', 'base64', 'base32', 'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('hash/encoding conformance', () => {
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
  // md5sum
  // ---------------------------------------------------------------------------
  describe('md5sum', () => {
    it('hashes known string from stdin', async () => {
      const r = await runner.run("printf 'hello' | md5sum");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('5d41402abc4b2a76b9719d911017c592');
    });

    it('hashes a file', async () => {
      writeFile('/tmp/f.txt', 'hello');
      const r = await runner.run('md5sum /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('5d41402abc4b2a76b9719d911017c592');
      expect(r.stdout).toContain('/tmp/f.txt');
    });

    it('output format has hash and filename', async () => {
      writeFile('/tmp/x.txt', 'test');
      const r = await runner.run('md5sum /tmp/x.txt');
      expect(r.stdout).toMatch(/^[0-9a-f]{32}\s/);
    });
  });

  // ---------------------------------------------------------------------------
  // sha256sum
  // ---------------------------------------------------------------------------
  describe('sha256sum', () => {
    it('hashes known string from stdin', async () => {
      const r = await runner.run("printf 'hello' | sha256sum");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('hashes a file', async () => {
      writeFile('/tmp/f.txt', 'hello');
      const r = await runner.run('sha256sum /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('2cf24dba5fb0a30e');
    });
  });

  // ---------------------------------------------------------------------------
  // sha1sum
  // ---------------------------------------------------------------------------
  describe('sha1sum', () => {
    it('hashes known string from stdin', async () => {
      const r = await runner.run("printf 'hello' | sha1sum");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('aaf4c61ddcc5e8a2dabede0f3b482cd9aea9434d');
    });
  });

  // ---------------------------------------------------------------------------
  // cksum
  // ---------------------------------------------------------------------------
  describe('cksum', () => {
    it('checksums from stdin', async () => {
      const r = await runner.run("printf 'hello' | cksum");
      expect(r.exitCode).toBe(0);
      // cksum output: <checksum> <size> [<filename>]
      expect(r.stdout).toMatch(/^\d+\s+\d+/);
    });

    it('checksums a file', async () => {
      writeFile('/tmp/f.txt', 'hello');
      const r = await runner.run('cksum /tmp/f.txt');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('5');  // size=5
      expect(r.stdout).toContain('/tmp/f.txt');
    });
  });

  // ---------------------------------------------------------------------------
  // base64
  // ---------------------------------------------------------------------------
  describe('base64', () => {
    it('encodes a string', async () => {
      const r = await runner.run("printf 'hello' | base64");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('aGVsbG8=');
    });

    it('decodes a string', async () => {
      const r = await runner.run("printf 'aGVsbG8=' | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });

    it('roundtrip preserves content', async () => {
      const r = await runner.run("printf 'test data 123' | base64 | base64 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('test data 123');
    });
  });

  // ---------------------------------------------------------------------------
  // base32
  // ---------------------------------------------------------------------------
  describe('base32', () => {
    it('encodes a string', async () => {
      const r = await runner.run("printf 'hello' | base32");
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('NBSWY3DP');
    });

    it('decodes a string', async () => {
      const r = await runner.run("printf 'NBSWY3DP' | base32 -d");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello');
    });
  });
});
