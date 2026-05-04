/**
 * Integration tests for the VFS mount system and PYTHONPATH configuration.
 */
import { describe, it, afterEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { HostMount } from '../vfs/host-mount.js';

const WASM_DIR = resolve(import.meta.dirname, '../platform/__tests__/fixtures');

const enc = (s: string) => new TextEncoder().encode(s);

describe('mounts', () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('Sandbox.create with mounts makes files readable via shell', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      mounts: [{
        path: '/mnt/tools',
        files: {
          'hello.sh': enc('#!/bin/sh\necho hello'),
          'data.txt': enc('some data'),
        },
      }],
    });

    const result = await sandbox.run('cat /mnt/tools/data.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('some data');
  });

  it('ls on mount point shows files', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      mounts: [{
        path: '/mnt/tools',
        files: {
          'a.txt': enc('a'),
          'b.txt': enc('b'),
        },
      }],
    });

    const result = await sandbox.run('ls /mnt/tools');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('a.txt');
    expect(result.stdout).toContain('b.txt');
  });

  it('dynamic sandbox.mount() at runtime', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    sandbox.mount('/mnt/uploads', {
      'file1.txt': enc('uploaded content'),
    });

    const result = await sandbox.run('cat /mnt/uploads/file1.txt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('uploaded content');
  });

  it('dynamic mount with VirtualProvider instance', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    const provider = new HostMount({ 'readme.md': enc('# Hi') });
    sandbox.mount('/mnt/docs', provider);

    const result = await sandbox.run('cat /mnt/docs/readme.md');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('# Hi');
  });

  it('mount dirs visible in parent listing', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      mounts: [{
        path: '/mnt/tools',
        files: { 'x.txt': enc('x') },
      }],
    });

    const result = await sandbox.run('ls /mnt');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('tools');
  });

  it('mounted files excluded from exportState()', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      mounts: [{
        path: '/mnt/tools',
        files: { 'tool.sh': enc('#!/bin/sh\necho hi') },
      }],
    });

    // Write a regular file that should be included
    sandbox.writeFile('/tmp/normal.txt', enc('normal'));

    const blob = sandbox.exportState();
    const json = new TextDecoder().decode(blob.subarray(12));
    const state = JSON.parse(json);

    // /mnt/tools subtree should be excluded
    const paths: string[] = state.files.map((f: { path: string }) => f.path);
    expect(paths.some((p: string) => p.startsWith('/mnt/tools'))).toBe(false);
    // /tmp/normal.txt should be included
    expect(paths.some((p: string) => p === '/tmp/normal.txt')).toBe(true);
  });

  it('mounts with nested subdirectories', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      mounts: [{
        path: '/mnt/pkg',
        files: {
          'mylib/__init__.py': enc(''),
          'mylib/utils.py': enc('def greet(): return "hello"'),
        },
      }],
    });

    const lsResult = await sandbox.run('ls /mnt/pkg/mylib');
    expect(lsResult.exitCode).toBe(0);
    expect(lsResult.stdout).toContain('__init__.py');
    expect(lsResult.stdout).toContain('utils.py');
  });

  it('fork() preserves user mounts', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      mounts: [{
        path: '/mnt/tools',
        files: { 'script.sh': enc('echo forked') },
      }],
    });

    const child = await sandbox.fork();
    try {
      const result = await child.run('cat /mnt/tools/script.sh');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('echo forked');
    } finally {
      child.destroy();
    }
  });
});

describe('pythonPath', { sanitizeOps: false, sanitizeResources: false }, () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('pythonPath option sets PYTHONPATH correctly', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      pythonPath: ['/mnt/libs', '/mnt/extra'],
    });

    const pythonPath = sandbox.getEnv('PYTHONPATH');
    expect(pythonPath).toBe('/mnt/libs:/mnt/extra:/usr/lib/python');
  });

  it('pythonPath combined with network includes all paths', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      pythonPath: ['/mnt/libs'],
      network: { allowedHosts: ['example.com'] },
    });

    const pythonPath = sandbox.getEnv('PYTHONPATH');
    expect(pythonPath).toBe('/mnt/libs:/usr/lib/python');
  });

  it('pythonPath without network still sets PYTHONPATH', async () => {
    sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      pythonPath: ['/mnt/mylib'],
    });

    expect(sandbox.getEnv('PYTHONPATH')).toBe('/mnt/mylib:/usr/lib/python');
  });
});
