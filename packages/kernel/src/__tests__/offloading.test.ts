/**
 * Integration tests for sandbox offloading and rehydration.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('Sandbox offloading', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;
  const blobs = new Map<string, Uint8Array>();

  const storage = {
    save: async (id: string, state: Uint8Array) => { blobs.set(id, state); },
    load: async (id: string) => {
      const blob = blobs.get(id);
      if (!blob) throw new Error('not found');
      return blob;
    },
  };

  afterEach(() => {
    sandbox?.destroy();
    blobs.clear();
  });

  it('offload and rehydrate preserves files', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await sandbox.offload();
    expect(blobs.size).toBe(1);

    await sandbox.rehydrate();
    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('hello');
  });

  it('offload and rehydrate preserves env vars', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.setEnv('FOO', 'bar');

    await sandbox.offload();
    await sandbox.rehydrate();

    const result = await sandbox.run('echo $FOO');
    expect(result.stdout.trim()).toBe('bar');
  });

  it('run while offloaded throws', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    await sandbox.offload();

    await expect(sandbox.run('echo hello')).rejects.toThrow('offloaded');
  });

  it('readFile while offloaded throws', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    await sandbox.offload();

    expect(() => sandbox.readFile('/tmp/test.txt')).toThrow('offloaded');
  });

  it('offload without storage throws', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    await expect(sandbox.offload()).rejects.toThrow('No storage callbacks configured');
  });

  it('double offload is idempotent', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await sandbox.offload();
    const blobCount = blobs.size;
    await sandbox.offload(); // should be a no-op
    expect(blobs.size).toBe(blobCount);
  });

  it('double rehydrate is idempotent', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await sandbox.offload();
    await sandbox.rehydrate();
    await sandbox.rehydrate(); // should be a no-op

    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('hello');
  });

  it('save failure keeps sandbox active', async () => {
    const failStorage = {
      save: async () => { throw new Error('storage down'); },
      load: async () => new Uint8Array(0),
    };
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage: failStorage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('hello'));

    await expect(sandbox.offload()).rejects.toThrow('storage down');
    // Sandbox should still be active
    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('hello');
  });

  it('multiple offload/rehydrate cycles work', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter(), storage });
    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('v1'));

    await sandbox.offload();
    await sandbox.rehydrate();

    sandbox.writeFile('/tmp/test.txt', new TextEncoder().encode('v2'));
    await sandbox.offload();
    await sandbox.rehydrate();

    const content = new TextDecoder().decode(sandbox.readFile('/tmp/test.txt'));
    expect(content).toBe('v2');
  });
});
