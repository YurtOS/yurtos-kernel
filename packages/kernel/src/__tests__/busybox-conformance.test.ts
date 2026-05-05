/**
 * BusyBox applet conformance through the Yurt sandbox.
 *
 * Adapted from Codepod's bash-conformance cp/mv/rm/mkdir and
 * cat/echo/printf suites, but routed through Yurt's BusyBox multicall
 * fixture so these tests exercise the kernel syscall/VFS path.
 */
import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../platform/__tests__/fixtures');

describe('BusyBox conformance', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    expect(existsSync(resolve(FIXTURES, 'busybox.wasm'))).toBe(true);
    expect(existsSync(resolve(FIXTURES, 'busybox.manifest.json'))).toBe(true);
    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
  });

  afterEach(() => {
    sandbox?.destroy();
  });

  function writeFile(path: string, content: string): void {
    sandbox.writeFile(path, new TextEncoder().encode(content));
  }

  describe('cat/echo/printf', () => {
    it('reads and concatenates files', async () => {
      writeFile('/tmp/a.txt', 'aaa\n');
      writeFile('/tmp/b.txt', 'bbb\n');

      const result = await sandbox.run('cat /tmp/a.txt /tmp/b.txt');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('aaa\nbbb\n');
    });

    it('reads stdin through a pipe', async () => {
      const result = await sandbox.run("echo hello | cat");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\n');
    });

    it('supports printf formatting and escapes', async () => {
      const result = await sandbox.run("printf 'hi %s\\n%d\\n' world 42");

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hi world\n42\n');
    });
  });

  describe('file operations', () => {
    it('copies files and directories', async () => {
      writeFile('/tmp/src.txt', 'data\n');
      let result = await sandbox.run('cp /tmp/src.txt /tmp/dst.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/dst.txt');
      expect(result.stdout).toBe('data\n');

      result = await sandbox.run('mkdir -p /tmp/d1/sub');
      expect(result.exitCode).toBe(0);
      writeFile('/tmp/d1/sub/f.txt', 'inside\n');
      result = await sandbox.run('cp -r /tmp/d1 /tmp/d2');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/d2/sub/f.txt');
      expect(result.stdout).toBe('inside\n');
    });

    it('moves files into directories', async () => {
      writeFile('/tmp/f.txt', 'hello\n');

      let result = await sandbox.run('mkdir /tmp/dir');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('mv /tmp/f.txt /tmp/dir/');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/dir/f.txt');
      expect(result.stdout).toBe('hello\n');
      result = await sandbox.run('cat /tmp/f.txt');
      expect(result.exitCode).not.toBe(0);
    });

    it('removes files and recursive directories', async () => {
      writeFile('/tmp/f.txt', 'bye\n');

      let result = await sandbox.run('rm /tmp/f.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/f.txt');
      expect(result.exitCode).not.toBe(0);

      result = await sandbox.run('mkdir -p /tmp/d/sub');
      expect(result.exitCode).toBe(0);
      writeFile('/tmp/d/sub/f.txt', 'x');
      result = await sandbox.run('rm -r /tmp/d');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('ls /tmp/d');
      expect(result.exitCode).not.toBe(0);
    });

    it('creates nested directories and removes empty directories', async () => {
      let result = await sandbox.run('mkdir -p /tmp/a/b/c');
      expect(result.exitCode).toBe(0);
      writeFile('/tmp/a/b/c/f.txt', 'deep\n');
      result = await sandbox.run('cat /tmp/a/b/c/f.txt');
      expect(result.stdout).toBe('deep\n');

      result = await sandbox.run('mkdir /tmp/empty');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('rmdir /tmp/empty');
      expect(result.exitCode).toBe(0);
    });

    it('touch creates files without truncating existing content', async () => {
      let result = await sandbox.run('touch /tmp/new.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/new.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('');

      writeFile('/tmp/existing.txt', 'keep\n');
      result = await sandbox.run('touch /tmp/existing.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/existing.txt');
      expect(result.stdout).toBe('keep\n');
    });

    it('creates symbolic and hard links', async () => {
      writeFile('/tmp/target.txt', 'linked\n');

      let result = await sandbox.run('ln -s /tmp/target.txt /tmp/symlink.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run('cat /tmp/symlink.txt');
      expect(result.stdout).toBe('linked\n');

      result = await sandbox.run('ln /tmp/target.txt /tmp/hardlink.txt');
      expect(result.exitCode).toBe(0);
      result = await sandbox.run("printf updated > /tmp/hardlink.txt; cat /tmp/target.txt");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('updated');
    });
  });
});
