import { describe, it, beforeAll, afterAll } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HostFsProvider } from '../host-fs-provider.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

let testDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `host-fs-provider-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  writeFileSync(join(testDir, 'hello.txt'), 'Hello, world!');
  writeFileSync(join(testDir, 'data.bin'), Buffer.from([0x00, 0x01, 0x02]));
  mkdirSync(join(testDir, 'sub'), { recursive: true });
  writeFileSync(join(testDir, 'sub', 'nested.txt'), 'nested content');
  mkdirSync(join(testDir, 'empty-dir'), { recursive: true });
});

afterAll(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe('HostFsProvider', () => {
  // --- readFile ---

  it('reads a file from the host filesystem', () => {
    const provider = new HostFsProvider(testDir);
    expect(dec(provider.readFile('hello.txt'))).toBe('Hello, world!');
  });

  it('reads binary data', () => {
    const provider = new HostFsProvider(testDir);
    const data = provider.readFile('data.bin');
    expect(data).toEqual(new Uint8Array([0x00, 0x01, 0x02]));
  });

  it('reads nested files', () => {
    const provider = new HostFsProvider(testDir);
    expect(dec(provider.readFile('sub/nested.txt'))).toBe('nested content');
  });

  it('throws ENOENT for missing files', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readFile('nope.txt')).toThrow('ENOENT');
  });

  it('throws EISDIR when reading a directory', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readFile('sub')).toThrow('EISDIR');
  });

  // --- exists ---

  it('returns true for existing files', () => {
    const provider = new HostFsProvider(testDir);
    expect(provider.exists('hello.txt')).toBe(true);
  });

  it('returns true for existing directories', () => {
    const provider = new HostFsProvider(testDir);
    expect(provider.exists('sub')).toBe(true);
  });

  it('returns true for root', () => {
    const provider = new HostFsProvider(testDir);
    expect(provider.exists('')).toBe(true);
  });

  it('returns false for missing paths', () => {
    const provider = new HostFsProvider(testDir);
    expect(provider.exists('nope')).toBe(false);
  });

  // --- stat ---

  it('stat returns file info', () => {
    const provider = new HostFsProvider(testDir);
    const s = provider.stat('hello.txt');
    expect(s.type).toBe('file');
    expect(s.size).toBe(13); // "Hello, world!" = 13 bytes
  });

  it('stat returns dir info', () => {
    const provider = new HostFsProvider(testDir);
    const s = provider.stat('sub');
    expect(s.type).toBe('dir');
    expect(s.size).toBe(1); // one entry: nested.txt
  });

  it('stat returns root info', () => {
    const provider = new HostFsProvider(testDir);
    const s = provider.stat('');
    expect(s.type).toBe('dir');
  });

  it('stat throws ENOENT for missing paths', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.stat('nope')).toThrow('ENOENT');
  });

  // --- readdir ---

  it('readdir lists root children', () => {
    const provider = new HostFsProvider(testDir);
    const entries = provider.readdir('');
    const names = entries.map(e => e.name).sort();
    expect(names).toContain('hello.txt');
    expect(names).toContain('sub');
    expect(names).toContain('data.bin');
    expect(entries.find(e => e.name === 'sub')?.type).toBe('dir');
    expect(entries.find(e => e.name === 'hello.txt')?.type).toBe('file');
  });

  it('readdir lists subdirectory children', () => {
    const provider = new HostFsProvider(testDir);
    const entries = provider.readdir('sub');
    expect(entries).toEqual([{ name: 'nested.txt', type: 'file' }]);
  });

  it('readdir lists empty directory', () => {
    const provider = new HostFsProvider(testDir);
    const entries = provider.readdir('empty-dir');
    expect(entries).toEqual([]);
  });

  it('readdir throws ENOENT for missing dirs', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readdir('nope')).toThrow('ENOENT');
  });

  it('readdir throws ENOTDIR for files', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readdir('hello.txt')).toThrow('ENOTDIR');
  });

  // --- writeFile ---

  it('throws EROFS when not writable', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.writeFile('new.txt', enc('x'))).toThrow('EROFS');
  });

  it('writes files when writable', () => {
    const writeDir = join(testDir, 'write-test');
    mkdirSync(writeDir, { recursive: true });
    const provider = new HostFsProvider(writeDir, { writable: true });
    provider.writeFile('new.txt', enc('hello'));
    expect(dec(provider.readFile('new.txt'))).toBe('hello');
  });

  it('creates intermediate directories when writing', () => {
    const writeDir = join(testDir, 'write-test-nested');
    mkdirSync(writeDir, { recursive: true });
    const provider = new HostFsProvider(writeDir, { writable: true });
    provider.writeFile('a/b/c.txt', enc('deep'));
    expect(dec(provider.readFile('a/b/c.txt'))).toBe('deep');
    expect(provider.stat('a').type).toBe('dir');
    expect(provider.stat('a/b').type).toBe('dir');
  });

  // --- Path traversal prevention ---

  it('blocks .. traversal', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readFile('../../../etc/passwd')).toThrow('ENOENT');
  });

  it('blocks .. traversal in nested paths', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readFile('sub/../../etc/passwd')).toThrow('ENOENT');
  });

  it('blocks traversal via exists()', () => {
    const provider = new HostFsProvider(testDir);
    expect(provider.exists('../../../etc/passwd')).toBe(false);
  });

  it('blocks traversal via stat()', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.stat('../../../etc/passwd')).toThrow('ENOENT');
  });

  it('blocks traversal via readdir()', () => {
    const provider = new HostFsProvider(testDir);
    expect(() => provider.readdir('../../../etc')).toThrow('ENOENT');
  });

  it('blocks traversal via writeFile()', () => {
    const provider = new HostFsProvider(testDir, { writable: true });
    expect(() => provider.writeFile('../../../tmp/evil.txt', enc('x'))).toThrow('ENOENT');
  });

  // --- Symlink escape prevention ---
  //
  // The bug previously: when a path didn't exist (typical for
  // writeFile creating a new file), resolveHost fell back to the
  // pre-symlink-resolved string. If a parent of that path was a
  // symlink pointing outside the mount, writeFile happily wrote
  // through it. These cases pin the fix.

  it('blocks writeFile through a parent symlink pointing outside the mount', () => {
    const mount = join(testDir, 'sym-escape-mount');
    const outside = join(testDir, 'sym-escape-outside');
    mkdirSync(mount, { recursive: true });
    mkdirSync(outside, { recursive: true });
    // Inside the mount, plant a symlink whose target is outside.
    symlinkSync(outside, join(mount, 'escape'));

    const provider = new HostFsProvider(mount, { writable: true });
    expect(() => provider.writeFile('escape/pwned.txt', enc('escaped'))).toThrow('ENOENT');
    // The outside directory must be untouched.
    expect(existsSync(join(outside, 'pwned.txt'))).toBe(false);
  });

  it('blocks writeFile through a deeply nested ancestor symlink', () => {
    const mount = join(testDir, 'sym-deep-mount');
    const outside = join(testDir, 'sym-deep-outside');
    mkdirSync(mount, { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(mount, 'a'), { recursive: true });
    symlinkSync(outside, join(mount, 'a', 'esc'));

    const provider = new HostFsProvider(mount, { writable: true });
    expect(() =>
      provider.writeFile('a/esc/deeper/file.txt', enc('x')),
    ).toThrow('ENOENT');
    expect(existsSync(join(outside, 'deeper'))).toBe(false);
  });

  it('blocks readFile through an escaping ancestor symlink', () => {
    const mount = join(testDir, 'sym-read-mount');
    const outside = join(testDir, 'sym-read-outside');
    mkdirSync(mount, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'leaked');
    symlinkSync(outside, join(mount, 'leak'));

    const provider = new HostFsProvider(mount);
    expect(() => provider.readFile('leak/secret.txt')).toThrow('ENOENT');
  });

  it('allows writeFile through an internal symlink that stays inside the mount', () => {
    // Symlinks within the mount are fine — that's existing behaviour
    // for readFile and we preserve it for writeFile too. Pin it so a
    // future tightening doesn't regress the legitimate case.
    const mount = join(testDir, 'sym-internal-mount');
    mkdirSync(mount, { recursive: true });
    mkdirSync(join(mount, 'real'), { recursive: true });
    symlinkSync('real', join(mount, 'alias'));

    const provider = new HostFsProvider(mount, { writable: true });
    provider.writeFile('alias/inside.txt', enc('ok'));

    // Visible via the symlinked name and the real path.
    expect(dec(provider.readFile('alias/inside.txt'))).toBe('ok');
    expect(dec(new Uint8Array(readFileSync(join(mount, 'real', 'inside.txt'))))).toBe('ok');
  });
});
