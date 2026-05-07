import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HostMount } from '../host-mount.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('HostMount', () => {
  it('creates from flat map with nested paths', () => {
    const mount = new HostMount({
      'README.md': enc('# Hello'),
      'lib/__init__.py': enc(''),
      'lib/utils.py': enc('def foo(): pass'),
    });

    expect(dec(mount.readFile('README.md'))).toBe('# Hello');
    expect(dec(mount.readFile('lib/utils.py'))).toBe('def foo(): pass');
  });

  it('readFile throws ENOENT for missing files', () => {
    const mount = new HostMount({});
    expect(() => mount.readFile('nope.txt')).toThrow('ENOENT');
  });

  it('readFile throws EISDIR for directories', () => {
    const mount = new HostMount({ 'dir/file.txt': enc('x') });
    expect(() => mount.readFile('dir')).toThrow('EISDIR');
  });

  it('readdir lists root children', () => {
    const mount = new HostMount({
      'a.txt': enc('a'),
      'b.txt': enc('b'),
      'sub/c.txt': enc('c'),
    });

    const entries = mount.readdir('');
    const names = entries.map(e => e.name).sort();
    expect(names).toEqual(['a.txt', 'b.txt', 'sub']);
    expect(entries.find(e => e.name === 'sub')?.type).toBe('dir');
    expect(entries.find(e => e.name === 'a.txt')?.type).toBe('file');
  });

  it('readdir lists subdirectory children', () => {
    const mount = new HostMount({
      'lib/__init__.py': enc(''),
      'lib/utils.py': enc('x'),
    });

    const entries = mount.readdir('lib');
    expect(entries.map(e => e.name).sort()).toEqual(['__init__.py', 'utils.py']);
  });

  it('readdir throws ENOENT for missing dirs', () => {
    const mount = new HostMount({});
    expect(() => mount.readdir('nope')).toThrow('ENOENT');
  });

  it('readdir throws ENOTDIR for files', () => {
    const mount = new HostMount({ 'file.txt': enc('x') });
    expect(() => mount.readdir('file.txt')).toThrow('ENOTDIR');
  });

  it('stat returns file info', () => {
    const mount = new HostMount({ 'data.bin': enc('hello') });
    const s = mount.stat('data.bin');
    expect(s.type).toBe('file');
    expect(s.size).toBe(5);
  });

  it('stat returns dir info', () => {
    const mount = new HostMount({
      'dir/a.txt': enc('a'),
      'dir/b.txt': enc('b'),
    });
    const s = mount.stat('dir');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(2);
  });

  it('stat returns root info', () => {
    const mount = new HostMount({ 'a.txt': enc('a') });
    const s = mount.stat('');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(1);
  });

  it('stat throws ENOENT for missing paths', () => {
    const mount = new HostMount({});
    expect(() => mount.stat('nope')).toThrow('ENOENT');
  });

  it('exists returns true for files and dirs', () => {
    const mount = new HostMount({ 'dir/file.txt': enc('x') });
    expect(mount.exists('')).toBe(true);
    expect(mount.exists('dir')).toBe(true);
    expect(mount.exists('dir/file.txt')).toBe(true);
    expect(mount.exists('nope')).toBe(false);
  });

  it('writeFile throws EROFS when not writable', () => {
    const mount = new HostMount({});
    expect(() => mount.writeFile('test.txt', enc('x'))).toThrow('EROFS');
  });

  it('writeFile works when writable', () => {
    const mount = new HostMount({}, { writable: true });
    mount.writeFile('new.txt', enc('hello'));
    expect(dec(mount.readFile('new.txt'))).toBe('hello');
  });

  it('writeFile creates intermediate dirs when writable', () => {
    const mount = new HostMount({}, { writable: true });
    mount.writeFile('a/b/c.txt', enc('deep'));
    expect(dec(mount.readFile('a/b/c.txt'))).toBe('deep');
    expect(mount.stat('a').type).toBe('dir');
    expect(mount.stat('a/b').type).toBe('dir');
  });

  it('addFile incrementally populates the mount', () => {
    const mount = new HostMount({ 'a.txt': enc('a') });
    mount.addFile('b.txt', enc('b'));
    mount.addFile('sub/c.txt', enc('c'));

    expect(dec(mount.readFile('b.txt'))).toBe('b');
    expect(dec(mount.readFile('sub/c.txt'))).toBe('c');
    expect(mount.readdir('').map(e => e.name).sort()).toEqual(['a.txt', 'b.txt', 'sub']);
  });
});
