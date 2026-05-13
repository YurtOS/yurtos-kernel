import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';

import { ProcessManager } from '../manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures');

describe('ProcessManager', () => {
  let vfs: VFS;
  let mgr: ProcessManager;

  beforeEach(() => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
    mgr = new ProcessManager(vfs, adapter);
    mgr.registerTool('hello', resolve(FIXTURES, 'hello.wasm'));
    mgr.registerTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'));
  });

  it('spawns a process and captures stdout', async () => {
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from wasm\n');
    expect(result.stderr).toBe('');
  });

  it('passes args to the process', async () => {
    const result = await mgr.spawn('echo-args', {
      args: ['one', 'two'],
      env: {},
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('one\ntwo\n');
  });

  it('passes env to the process', async () => {
    const result = await mgr.spawn('hello', {
      args: [],
      env: { FOO: 'bar' },
    });
    expect(result.exitCode).toBe(0);
  });

  it('caches modules after first load', async () => {
    const r1 = await mgr.spawn('hello', { args: [], env: {} });
    const r2 = await mgr.spawn('hello', { args: [], env: {} });
    expect(r1.stdout).toBe('hello from wasm\n');
    expect(r2.stdout).toBe('hello from wasm\n');
  });

  it('throws for unregistered tools', async () => {
    await expect(mgr.spawn('nonexistent', { args: [], env: {} }))
      .rejects.toThrow(/not found|not registered/i);
  });

  describe('spawnSync', () => {
    it('returns not-found for unregistered tool', async () => {
      await mgr.preloadModules();
      const result = mgr.spawnSync('no-such-tool', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(127);
      expect(result.stderr).toContain('not found');
    });

    it('returns module-not-loaded for tool without preloaded module', () => {
      mgr.registerTool('unloaded', resolve(FIXTURES, 'hello.wasm'));
      // Don't call preloadModules — module is registered but not compiled
      const result = mgr.spawnSync('unloaded', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(127);
      expect(result.stderr).toContain('module not loaded');
    });

    it('runs a preloaded module synchronously', async () => {
      await mgr.preloadModules();
      const result = mgr.spawnSync('hello', [], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe('hello from wasm\n');
    });

    it('returns graceful error on instantiation failure instead of throwing', async () => {
      await mgr.preloadModules();
      // Build a valid WASM module that requires an import the host won't provide.
      // (module (import "bad" "fn" (func)))
      const wat = `(module (import "bad" "fn" (func)))`;
      // Use a pre-built binary for this import-requiring module:
      const importWasm = new Uint8Array([
        0x00, 0x61, 0x73, 0x6d, // \0asm magic
        0x01, 0x00, 0x00, 0x00, // version 1
        0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: 1 type () -> ()
        0x02, 0x0a, 0x01,                   // import section: 1 import
        0x03, 0x62, 0x61, 0x64,             // module "bad"
        0x02, 0x66, 0x6e,                   // field "fn"
        0x00, 0x00,                         // func, type 0
      ]);
      const badModule = await WebAssembly.compile(importWasm);
      // Inject the bad module into the cache via the tool path
      const helloPath = resolve(FIXTURES, 'hello.wasm');
      (mgr as any).moduleCache.set(helloPath, badModule);

      const result = mgr.spawnSync('hello', [], {}, new Uint8Array(), '/');
      // Should return an error result, not throw
      expect(result.exit_code).toBe(1);
      expect(result.stderr).toContain('hello');
      expect(result.stderr.length).toBeGreaterThan(0);
    });
  });

  it('provides execution time', async () => {
    const result = await mgr.spawn('hello', { args: [], env: {} });
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    expect(result.executionTimeMs).toBeLessThan(5000);
  });

  describe('tool registry', () => {
    it('registered tool is resolvable', () => {
      expect(mgr.resolveTool('hello')).toBe(resolve(FIXTURES, 'hello.wasm'));
    });

    it('unregistered names throw', () => {
      expect(() => mgr.resolveTool('fake')).toThrow(/not found/i);
    });

    it('registerMulticallTool registers all applets', () => {
      mgr.registerMulticallTool('hello', resolve(FIXTURES, 'hello.wasm'), ['hi', 'howdy']);
      expect(mgr.resolveTool('hi')).toBe(resolve(FIXTURES, 'hello.wasm'));
      expect(mgr.resolveTool('howdy')).toBe(resolve(FIXTURES, 'hello.wasm'));
    });

    it('spawnSync works through a multicall applet alias', async () => {
      mgr.registerMulticallTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'), ['myecho']);
      await mgr.preloadModules();
      const result = mgr.spawnSync('myecho', ['foo'], {}, new Uint8Array(), '/');
      expect(result.exit_code).toBe(0);
      expect(result.stdout).toBe('foo\n');
    });

    it('spawn works through a multicall applet alias', async () => {
      mgr.registerMulticallTool('echo-args', resolve(FIXTURES, 'echo-args.wasm'), ['myecho']);
      const result = await mgr.spawn('myecho', { args: ['foo'], env: {} });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('foo\n');
    });

    it('hasTool returns true for registered names', () => {
      expect(mgr.hasTool('hello')).toBe(true);
      expect(mgr.hasTool('fake')).toBe(false);
    });
  });
});
