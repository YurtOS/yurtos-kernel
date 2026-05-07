import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { mkdir, mkdtemp, readlink, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeDirectoryRootProvider } from '../node-directory-root-provider.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('NodeDirectoryRootProvider', () => {
  it('reads files and lists directories from a host directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yurt-root-'));
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/bash'), enc.encode('wasm'));

    const provider = new NodeDirectoryRootProvider(root, { id: 'test-root' });

    expect(dec.decode(provider.readFile('/bin/bash'))).toBe('wasm');
    expect(provider.readdir('/')).toEqual([{ name: 'bin', type: 'dir' }]);
    expect(provider.stat('/bin/bash').type).toBe('file');
    expect(typeof provider.stat('/bin/bash').uid).toBe('number');
    expect(typeof provider.stat('/bin/bash').gid).toBe('number');
    expect(provider.id).toBe('test-root');
  });

  it('blocks path traversal and symlink escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yurt-root-'));
    await symlink('/etc/passwd', join(root, 'escape'));
    const provider = new NodeDirectoryRootProvider(root, { id: 'test-root' });

    expect(() => provider.readFile('/../etc/passwd')).toThrow(/traversal/);
    expect(() => provider.readFile('/escape')).toThrow(/symlink/);
  });

  it('returns symlink targets without exposing resolved host paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yurt-root-'));
    await mkdir(join(root, 'bin'));
    await symlink('../bin/tool', join(root, 'tool-link'));
    const provider = new NodeDirectoryRootProvider(root, { id: 'test-root' });

    expect(provider.readlink('/tool-link')).toBe('../bin/tool');
    expect(await readlink(join(root, 'tool-link'))).toBe('../bin/tool');
  });

  it('normalizes lookup paths before applying manifest metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'yurt-root-'));
    await mkdir(join(root, 'bin'));
    await writeFile(join(root, 'bin/bash'), enc.encode('wasm'));
    const provider = new NodeDirectoryRootProvider(root, {
      id: 'test-root',
      metadata: { '/bin/bash': { uid: 0, gid: 0, mode: 0o755 } },
    });

    expect(provider.stat('/bin/../bin/bash').uid).toBe(0);
    expect(provider.stat('/bin/../bin/bash').permissions).toBe(0o755);
  });
});
