import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Sandbox } from '../sandbox.ts';
import { NodeAdapter } from '../platform/node-adapter.ts';

const WASM_DIR = resolve(decodeURIComponent(new URL('../platform/__tests__/fixtures', import.meta.url).pathname));
const enc = new TextEncoder();
const dec = new TextDecoder();

async function createBaseRoot(): Promise<string> {
  const baseRoot = await mkdtemp(join(tmpdir(), 'yurt-base-root-'));
  await mkdir(join(baseRoot, 'bin'), { recursive: true });
  await mkdir(join(baseRoot, 'etc/yurt'), { recursive: true });

  await copyFile(join(WASM_DIR, 'true-cmd.wasm'), join(baseRoot, 'bin/true'));
  await writeFile(join(baseRoot, 'etc/base-marker.txt'), 'base');

  await writeFile(
    join(baseRoot, 'etc/yurt/base-image.json'),
    JSON.stringify({
      version: 1,
      id: 'test-base-root',
      files: [
        { path: '/bin', type: 'dir', uid: 0, gid: 0, mode: 0o755 },
        { path: '/bin/true', type: 'file', uid: 0, gid: 0, mode: 0o755 },
        { path: '/etc', type: 'dir', uid: 0, gid: 0, mode: 0o755 },
        { path: '/etc/base-marker.txt', type: 'file', uid: 1000, gid: 1000, mode: 0o644 },
        { path: '/etc/yurt', type: 'dir', uid: 0, gid: 0, mode: 0o755 },
        { path: '/etc/yurt/base-image.json', type: 'file', uid: 0, gid: 0, mode: 0o644 },
      ],
      tools: [{ name: 'true', path: '/bin/true' }],
    }),
  );

  return baseRoot;
}

describe('Sandbox baseRoot', { sanitizeResources: false, sanitizeOps: false }, () => {
  it('boots from a read-only base root and writes changes only to the upper layer', async () => {
    const baseRoot = await createBaseRoot();
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      baseRoot,
      bootArgv: ['/bin/true'],
      bootWasmPath: join(WASM_DIR, 'true-cmd.wasm'),
    });

    try {
      expect(dec.decode(sandbox.readFile('/etc/base-marker.txt'))).toBe('base');

      sandbox.writeFile('/etc/base-marker.txt', enc.encode('upper'));

      expect(dec.decode(sandbox.readFile('/etc/base-marker.txt'))).toBe('upper');
      expect(dec.decode(await readFile(join(baseRoot, 'etc/base-marker.txt')))).toBe('base');
      expect(() => sandbox.writeFile('/bin/true', enc.encode('not wasm'))).toThrow(/EACCES/);
    } finally {
      sandbox.destroy();
    }
  });

  it('snapshots and restores upper changes without touching base files', async () => {
    const baseRoot = await createBaseRoot();
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      baseRoot,
      bootArgv: ['/bin/true'],
      bootWasmPath: join(WASM_DIR, 'true-cmd.wasm'),
    });

    try {
      const snap = sandbox.snapshot();
      sandbox.writeFile('/etc/base-marker.txt', enc.encode('upper'));
      sandbox.restore(snap);

      expect(dec.decode(sandbox.readFile('/etc/base-marker.txt'))).toBe('base');
      expect(dec.decode(await readFile(join(baseRoot, 'etc/base-marker.txt')))).toBe('base');
    } finally {
      sandbox.destroy();
    }
  });

  it('forks with the same base root and an isolated upper layer', async () => {
    const baseRoot = await createBaseRoot();
    const parent = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      baseRoot,
      bootArgv: ['/bin/true'],
      bootWasmPath: join(WASM_DIR, 'true-cmd.wasm'),
    });
    let child: Sandbox | undefined;

    try {
      parent.writeFile('/etc/base-marker.txt', enc.encode('parent'));
      child = await parent.fork();
      child.writeFile('/etc/base-marker.txt', enc.encode('child'));

      expect(dec.decode(parent.readFile('/etc/base-marker.txt'))).toBe('parent');
      expect(dec.decode(child.readFile('/etc/base-marker.txt'))).toBe('child');
      expect(dec.decode(await readFile(join(baseRoot, 'etc/base-marker.txt')))).toBe('base');
    } finally {
      child?.destroy();
      parent.destroy();
    }
  });
});
