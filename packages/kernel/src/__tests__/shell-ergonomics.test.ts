/**
 * Tests for shell ergonomics features: command history builtin,
 * cross-feature integration (persistence + packages, /proc/uptime timing).
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { resolve } from 'node:path';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');


describe('history builtin', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('history list returns executed commands', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    await sandbox.run('echo hello');
    await sandbox.run('echo world');
    const result = await sandbox.run('history list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo hello');
    expect(result.stdout).toContain('echo world');
    // The history list command itself should also appear
    expect(result.stdout).toContain('history list');
  });

  it('history with no args defaults to list', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    await sandbox.run('echo test');
    const result = await sandbox.run('history');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('echo test');
  });

  it('history clear empties history', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    await sandbox.run('echo hello');
    await sandbox.run('history clear');
    const result = await sandbox.run('history list');
    expect(result.exitCode).toBe(0);
    // After clear, "echo hello" should not appear (only "history list" itself will be there)
    expect(result.stdout).not.toContain('echo hello');
  });

  it('history entries have sequential indices', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    await sandbox.run('echo first');
    await sandbox.run('echo second');
    const result = await sandbox.run('history list');
    expect(result.exitCode).toBe(0);
    // Check that numbering is sequential
    expect(result.stdout).toContain('  1  echo first');
    expect(result.stdout).toContain('  2  echo second');
    expect(result.stdout).toContain('  3  history list');
  });

  it('history unknown subcommand returns error', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const result = await sandbox.run('history bogus');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('unknown subcommand');
  });

});

describe('cross-feature integration', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('file data survives export/import', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    // Write a file to a writable location to simulate package metadata
    const fakeWasm = new TextEncoder().encode('fake-wasm-binary');
    sandbox.mkdir('/tmp/pkg');
    sandbox.writeFile('/tmp/pkg/mytool.wasm', fakeWasm);

    // Export state
    const blob = sandbox.exportState();

    // Create a new sandbox and import
    const sandbox2 = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    try {
      sandbox2.importState(blob);

      // Verify the file exists after import
      const restored = sandbox2.readFile('/tmp/pkg/mytool.wasm');
      expect(new TextDecoder().decode(restored)).toBe('fake-wasm-binary');
    } finally {
      sandbox2.destroy();
    }
  });

  it('/proc/uptime increases between reads', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const result1 = await sandbox.run('cat /proc/uptime');
    expect(result1.exitCode).toBe(0);
    const uptime1 = parseFloat(result1.stdout.trim().split(' ')[0]);

    // Wait a bit so uptime increases
    await new Promise(r => setTimeout(r, 60));

    const result2 = await sandbox.run('cat /proc/uptime');
    expect(result2.exitCode).toBe(0);
    const uptime2 = parseFloat(result2.stdout.trim().split(' ')[0]);

    expect(uptime2).toBeGreaterThan(uptime1);
  });

  it('history builtin tracks commands across different features', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    // Run a mix of builtins and WASM commands
    await sandbox.run('echo hello');
    await sandbox.run('cat /proc/version');
    await sandbox.run('pwd');

    const result = await sandbox.run('history list');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('  1  echo hello');
    expect(result.stdout).toContain('  2  cat /proc/version');
    expect(result.stdout).toContain('  3  pwd');
  });
});
