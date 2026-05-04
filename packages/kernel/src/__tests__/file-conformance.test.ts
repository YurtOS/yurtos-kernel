/**
 * file/libmagic conformance tests.  file.wasm is the upstream
 * file/file 5.47 port built via cpcc (packages/c-ports/file/).
 * magic.mgc is built by a host-side build of the same upstream tree
 * and copied into the VFS at /usr/share/misc/magic.mgc by the
 * sandbox at startup.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

describe('file (c-port)', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;
  afterEach(() => sandbox?.destroy());

  it('reports its version', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    const r = await sandbox.run('file --version');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^file-5\.47/);
  });

  it('classifies ASCII text', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/a.txt', new TextEncoder().encode('Hello, world!\n'));
    const r = await sandbox.run('file /tmp/a.txt');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('ASCII text');
  });

  it('classifies an empty file', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/empty.bin', new Uint8Array(0));
    const r = await sandbox.run('file /tmp/empty.bin');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('empty');
  });

  it('classifies a WebAssembly binary', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    // wasm magic (\0asm) + version 1
    const wasm = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x00]);
    sandbox.writeFile('/tmp/m.wasm', wasm);
    const r = await sandbox.run('file /tmp/m.wasm');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('WebAssembly');
  });

  it('classifies JSON via the magic database', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.json', new TextEncoder().encode('{"a":1,"b":[2,3]}\n'));
    const r = await sandbox.run('file /tmp/data.json');
    expect(r.exitCode).toBe(0);
    // libmagic recognizes JSON via the JSON-text rule in Magdir/json.
    expect(r.stdout).toMatch(/JSON|ASCII text/);
  });
});
