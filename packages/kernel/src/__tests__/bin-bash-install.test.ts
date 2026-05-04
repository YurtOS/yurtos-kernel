/**
 * PR1 (Tasks 1.1 + 1.2): /bin/bash must exist as a real VFS file marked
 * executable after Sandbox.create. Future PRs will pass
 * `bootArgv: ["/bin/bash"]` to spawn the shell by VFS path; today we just
 * assert the file is present and looks like a wasm module.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('Sandbox installs shell wasm at /bin/bash', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('Sandbox.create installs shell wasm at /bin/bash', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const stat = sandbox.stat('/bin/bash');
    expect(stat).toBeDefined();
    expect(stat.type).toBe('file');
    // Lower 9 bits should include executable for owner (0o100).
    expect(stat.permissions & 0o100).not.toBe(0);

    // Should look like wasm: starts with \0asm magic.
    const bytes = sandbox.readFile('/bin/bash');
    expect(bytes.length).toBeGreaterThan(8);
    expect(bytes[0]).toBe(0x00);
    expect(bytes[1]).toBe(0x61); // 'a'
    expect(bytes[2]).toBe(0x73); // 's'
    expect(bytes[3]).toBe(0x6d); // 'm'
  });

  it('Sandbox.fork inherits /bin/bash in child', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const child = await sandbox.fork();
    try {
      const stat = child.stat('/bin/bash');
      expect(stat).toBeDefined();
      expect(stat.type).toBe('file');
      expect(stat.permissions & 0o100).not.toBe(0);

      const bytes = child.readFile('/bin/bash');
      expect(bytes[0]).toBe(0x00);
      expect(bytes[1]).toBe(0x61);
      expect(bytes[2]).toBe(0x73);
      expect(bytes[3]).toBe(0x6d);
    } finally {
      child.destroy();
    }
  });
});
