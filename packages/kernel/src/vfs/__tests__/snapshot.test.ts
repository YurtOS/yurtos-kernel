import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { VFS } from '../vfs.js';

describe('VFS Snapshot', () => {
  it('creates a snapshot and restores it', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('before'));
    const snapId = vfs.snapshot();
    vfs.writeFile('/home/user/test.txt', new TextEncoder().encode('after'));
    expect(new TextDecoder().decode(vfs.readFile('/home/user/test.txt'))).toBe('after');
    vfs.restore(snapId);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/test.txt'))).toBe('before');
  });

  it('snapshot preserves files created before snapshot', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/a.txt', new TextEncoder().encode('aaa'));
    vfs.writeFile('/home/user/b.txt', new TextEncoder().encode('bbb'));
    const snapId = vfs.snapshot();
    vfs.unlink('/home/user/a.txt');
    vfs.writeFile('/home/user/c.txt', new TextEncoder().encode('ccc'));
    vfs.restore(snapId);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/a.txt'))).toBe('aaa');
    expect(new TextDecoder().decode(vfs.readFile('/home/user/b.txt'))).toBe('bbb');
    expect(() => vfs.stat('/home/user/c.txt')).toThrow(/ENOENT/);
  });

  it('COW fork: parent and child see independent copies', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/shared.txt', new TextEncoder().encode('original'));
    const child = vfs.cowClone();
    child.writeFile('/home/user/shared.txt', new TextEncoder().encode('child'));
    expect(new TextDecoder().decode(vfs.readFile('/home/user/shared.txt'))).toBe('original');
    expect(new TextDecoder().decode(child.readFile('/home/user/shared.txt'))).toBe('child');
  });

  it('COW fork: new files in child not visible in parent', () => {
    const vfs = new VFS();
    const child = vfs.cowClone();
    child.writeFile('/home/user/new.txt', new TextEncoder().encode('new'));
    expect(() => vfs.stat('/home/user/new.txt')).toThrow(/ENOENT/);
    expect(new TextDecoder().decode(child.readFile('/home/user/new.txt'))).toBe('new');
  });

  it('COW fork: new files in parent not visible in child', () => {
    const vfs = new VFS();
    const child = vfs.cowClone();
    vfs.writeFile('/home/user/parent-only.txt', new TextEncoder().encode('parent'));
    expect(() => child.stat('/home/user/parent-only.txt')).toThrow(/ENOENT/);
  });

  it('COW fork: deleting in child does not affect parent', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/keep.txt', new TextEncoder().encode('keep'));
    const child = vfs.cowClone();
    child.unlink('/home/user/keep.txt');
    expect(new TextDecoder().decode(vfs.readFile('/home/user/keep.txt'))).toBe('keep');
    expect(() => child.stat('/home/user/keep.txt')).toThrow(/ENOENT/);
  });

  it('COW fork: mkdir in child does not affect parent', () => {
    const vfs = new VFS();
    const child = vfs.cowClone();
    child.mkdir('/home/user/childdir');
    expect(() => vfs.stat('/home/user/childdir')).toThrow(/ENOENT/);
    expect(child.stat('/home/user/childdir')).toMatchObject({ type: 'dir' });
  });

  it('multiple snapshots can coexist', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/f.txt', new TextEncoder().encode('v1'));
    const snap1 = vfs.snapshot();
    vfs.writeFile('/home/user/f.txt', new TextEncoder().encode('v2'));
    const snap2 = vfs.snapshot();
    vfs.writeFile('/home/user/f.txt', new TextEncoder().encode('v3'));

    vfs.restore(snap1);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/f.txt'))).toBe('v1');

    vfs.restore(snap2);
    expect(new TextDecoder().decode(vfs.readFile('/home/user/f.txt'))).toBe('v2');
  });
});
