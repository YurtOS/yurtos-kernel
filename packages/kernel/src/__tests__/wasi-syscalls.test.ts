/**
 * Integration tests for WASI syscall implementations:
 * poll_oneoff, fd_renumber, clock_res_get, path_link.
 *
 * poll_oneoff is tested via the shell's `sleep` builtin, which now uses
 * std::thread::sleep() → wasi-libc → poll_oneoff (not the old host_sleep).
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('WASI syscalls', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  // ---- poll_oneoff (via sleep → std::thread::sleep → poll_oneoff) ----

  describe('poll_oneoff', () => {
    it('sleep completes without error', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run('sleep 0.01');
      expect(result.exitCode).toBe(0);
    });

    it('sleep 0 completes immediately', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run('sleep 0');
      expect(result.exitCode).toBe(0);
    });

    it('sleep respects approximate duration', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const start = Date.now();
      const result = await sandbox.run('sleep 0.05');
      const elapsed = Date.now() - start;
      expect(result.exitCode).toBe(0);
      // Should have waited at least ~20ms (allowing for timer imprecision and overhead)
      expect(elapsed).toBeGreaterThanOrEqual(20);
    });

    it('sleep works in a pipeline', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      // Note: 'done' is a shell keyword; use 'finished' instead
      const result = await sandbox.run('sleep 0.01 && echo finished');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('finished');
    });
  });

  // ---- fd_renumber (via shell redirection which uses dup2) ----

  describe('fd_renumber', () => {
    it('output redirection works', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run('echo hello > /tmp/out.txt && cat /tmp/out.txt');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    });

    it('append redirection works', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run(
        'echo first > /tmp/out.txt && echo second >> /tmp/out.txt && cat /tmp/out.txt'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('first\nsecond');
    });
  });

  // ---- path_link ----
  // The shell's `ln` builtin operates via the VFS layer and does not invoke
  // the WASI path_link syscall directly. The path_link implementation in
  // wasi-host returns ENOTSUP, but since the shell binary does not import
  // path_link, we test the observable behaviour at the shell level instead.

  describe('path_link', () => {
    it('hard link (ln without -s) creates a link via VFS', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/source.txt', new TextEncoder().encode('hello'));
      const result = await sandbox.run('ln /tmp/source.txt /tmp/link.txt && cat /tmp/link.txt');
      // The VFS supports hard links; expect success
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    });

    it('symlink (ln -s) still works', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      sandbox.writeFile('/tmp/source.txt', new TextEncoder().encode('hello'));
      const result = await sandbox.run(
        'ln -s /tmp/source.txt /tmp/link.txt && cat /tmp/link.txt'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
    });
  });

  describe('/proc/self', () => {
    it('cat /proc/self/comm returns the applet name', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run('cat /proc/self/comm');
      expect(result.exitCode).toBe(0);
      // BusyBox `cat` runs as the multicall binary — comm is the
      // executable basename, truncated at 15 chars (Linux convention).
      expect(result.stdout.trim()).toBe('cat');
    });

    it('readlink /proc/self returns a numeric pid', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run('readlink /proc/self');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toMatch(/^\d+$/);
    });

    it('/proc/self/status reports a Pid line', async () => {
      sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
      const result = await sandbox.run('cat /proc/self/status');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/^Pid:\s+\d+$/m);
    });
  });
});
