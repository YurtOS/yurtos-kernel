import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { VFS } from '../vfs.ts';
import { OverlayVFS } from '../overlay-vfs.ts';
import { MemoryRoot } from './helpers.ts';
import { exportState, importState } from '../../persistence/serializer.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

describe('OverlayVFS', () => {
  it('reads base files without copying them into the upper VFS', () => {
    const base = new MemoryRoot();
    base.addFile('/opt/base/readme.txt', 'base');
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    expect(dec.decode(vfs.readFile('/opt/base/readme.txt'))).toBe('base');
    expect(() => upper.readFile('/opt/base/readme.txt')).toThrow(/ENOENT/);
  });

  it('rejects writes to root-owned base files that the runtime user cannot modify', () => {
    const base = new MemoryRoot();
    base.addFile('/opt/base/readme.txt', 'base', { uid: 0, gid: 0, permissions: 0o644 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    expect(() => vfs.writeFile('/opt/base/readme.txt', enc.encode('upper'))).toThrow(/EACCES/);
    expect(dec.decode(vfs.readFile('/opt/base/readme.txt'))).toBe('base');
    expect(() => upper.readFile('/opt/base/readme.txt')).toThrow(/ENOENT/);
  });

  it('non-root cannot shadow root-owned base entries in upper', () => {
    const base = new MemoryRoot();
    base.addDir('/bin', { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile('/bin/python', 'base', { uid: 0, gid: 0, permissions: 0o755 });
    base.addDir('/etc', { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile('/etc/yurt.conf', 'config', { uid: 0, gid: 0, permissions: 0o644 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    expect(() => vfs.writeFile('/bin/python', enc.encode('shadow'))).toThrow(/EACCES/);
    expect(() => vfs.unlink('/bin/python')).toThrow(/EACCES/);
    expect(() => vfs.symlink('/tmp/fake-python', '/bin/python')).toThrow(/EACCES/);
    expect(() => vfs.writeFile('/etc/yurt.conf', enc.encode('shadow'))).toThrow(/EACCES/);
    expect(() => vfs.mkdir('/etc/backdoor.d')).toThrow(/EACCES/);
    expect(() => upper.readFile('/bin/python')).toThrow(/ENOENT/);
    expect(() => upper.readFile('/etc/yurt.conf')).toThrow(/ENOENT/);
    expect(dec.decode(vfs.readFile('/bin/python'))).toBe('base');
    expect(dec.decode(vfs.readFile('/etc/yurt.conf'))).toBe('config');
  });

  it('copies up writable user-owned base files and leaves base unchanged', () => {
    const base = new MemoryRoot();
    base.addFile('/opt/base/readme.txt', 'base', { uid: 1000, gid: 1000, permissions: 0o644 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    vfs.writeFile('/opt/base/readme.txt', enc.encode('upper'));

    expect(dec.decode(vfs.readFile('/opt/base/readme.txt'))).toBe('upper');
    expect(dec.decode(base.readFile('/opt/base/readme.txt'))).toBe('base');
    expect(dec.decode(upper.readFile('/opt/base/readme.txt'))).toBe('upper');
  });

  it('materializes base parent directories in upper using setup authority', () => {
    const base = new MemoryRoot();
    base.addDir('/opt/base', { uid: 1000, gid: 1000, permissions: 0o755 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    vfs.writeFile('/opt/base/generated.txt', enc.encode('upper'));

    expect(dec.decode(vfs.readFile('/opt/base/generated.txt'))).toBe('upper');
    expect(dec.decode(upper.readFile('/opt/base/generated.txt'))).toBe('upper');
    expect(upper.stat('/opt').uid).toBe(0);
    expect(upper.stat('/opt/base').uid).toBe(1000);
  });

  it('creates directories and symlinks inside writable base-only parents', () => {
    const base = new MemoryRoot();
    base.addDir('/opt/base', { uid: 1000, gid: 1000, permissions: 0o755 });
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    vfs.mkdir('/opt/base/dir');
    vfs.symlink('dir', '/opt/base/link');

    expect(vfs.stat('/opt/base/dir').type).toBe('dir');
    expect(vfs.readlink('/opt/base/link')).toBe('dir');
    expect(upper.stat('/opt/base').uid).toBe(1000);
  });

  it('mutates upper-only files using upper metadata before consulting base', () => {
    const base = new MemoryRoot();
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });
    vfs.withWriteAccess(() => {
      vfs.mkdirp('/tmp');
      vfs.chown('/tmp', 1000, 1000);
      vfs.chmod('/tmp', 0o755);
      vfs.writeFile('/tmp/upper.txt', enc.encode('old'));
      vfs.chown('/tmp/upper.txt', 1000, 1000);
      vfs.chmod('/tmp/upper.txt', 0o644);
    });

    vfs.writeFile('/tmp/upper.txt', enc.encode('new'));

    expect(dec.decode(vfs.readFile('/tmp/upper.txt'))).toBe('new');
  });

  it('does not assume upper-layer files are all user-owned', () => {
    const base = new MemoryRoot();
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });
    vfs.withWriteAccess(() => {
      vfs.mkdirp('/tmp');
      vfs.chown('/tmp', 1000, 1000);
      vfs.chmod('/tmp', 0o755);
      vfs.writeFile('/tmp/root-owned.txt', enc.encode('root'));
      vfs.chown('/tmp/root-owned.txt', 0, 0);
      vfs.chmod('/tmp/root-owned.txt', 0o644);
    });

    expect(() => vfs.writeFile('/tmp/root-owned.txt', enc.encode('user'))).toThrow(/EACCES/);
    expect(() => vfs.chmod('/tmp/root-owned.txt', 0o777)).toThrow(/EACCES/);
    expect(dec.decode(vfs.readFile('/tmp/root-owned.txt'))).toBe('root');
  });

  it('mkdir and symlink reject existing base entries unless whiteouted', () => {
    const base = new MemoryRoot();
    base.addDir('/opt/base', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/opt/base/existing.txt', 'base', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    expect(() => vfs.mkdir('/opt/base/existing.txt')).toThrow(/EEXIST/);
    expect(() => vfs.symlink('target', '/opt/base/existing.txt')).toThrow(/EEXIST/);
    vfs.unlink('/opt/base/existing.txt');
    vfs.symlink('target', '/opt/base/existing.txt');
    expect(vfs.readlink('/opt/base/existing.txt')).toBe('target');
  });

  it('renames files, symlinks, and empty directories from writable base paths', () => {
    const base = new MemoryRoot();
    base.addDir('/work', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/work/file.txt', 'file', { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir('/work/empty', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addSymlink('/work/link', 'missing.txt', { uid: 1000, gid: 1000, permissions: 0o777 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rename('/work/file.txt', '/work/file2.txt');
    vfs.rename('/work/link', '/work/link2');
    vfs.rename('/work/empty', '/work/empty2');

    expect(dec.decode(vfs.readFile('/work/file2.txt'))).toBe('file');
    expect(vfs.readlink('/work/link2')).toBe('missing.txt');
    expect(vfs.stat('/work/empty2').type).toBe('dir');
  });

  it('rename can replace a whiteouted destination', () => {
    const base = new MemoryRoot();
    base.addDir('/work', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/work/source.txt', 'source', { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addFile('/work/dest.txt', 'dest', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink('/work/dest.txt');
    vfs.rename('/work/source.txt', '/work/dest.txt');

    expect(dec.decode(vfs.readFile('/work/dest.txt'))).toBe('source');
    expect(() => vfs.readFile('/work/source.txt')).toThrow(/ENOENT/);
  });

  it('rename replaces existing destination files and directories', () => {
    const base = new MemoryRoot();
    base.addDir('/work', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/work/a.txt', 'a', { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addFile('/work/b.txt', 'b', { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir('/work/src-dir', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addDir('/work/dst-dir', { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rename('/work/a.txt', '/work/b.txt');
    vfs.rename('/work/src-dir', '/work/dst-dir');

    expect(dec.decode(vfs.readFile('/work/b.txt'))).toBe('a');
    expect(() => vfs.readFile('/work/a.txt')).toThrow(/ENOENT/);
    expect(vfs.stat('/work/dst-dir').type).toBe('dir');
    expect(() => vfs.stat('/work/src-dir')).toThrow(/ENOENT/);
  });

  it('rename same missing path still reports ENOENT', () => {
    const vfs = new OverlayVFS({ base: new MemoryRoot(), upper: new VFS() });

    expect(() => vfs.rename('/missing', '/missing')).toThrow(/ENOENT/);
  });

  it('rename preflights non-empty source directories before replacing destination', () => {
    const base = new MemoryRoot();
    base.addDir('/work', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addDir('/work/src-dir', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/work/src-dir/file.txt', 'x', { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addDir('/work/dst-dir', { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    expect(() => vfs.rename('/work/src-dir', '/work/dst-dir')).toThrow(/ENOTEMPTY/);
    expect(vfs.stat('/work/dst-dir').type).toBe('dir');
  });

  it('does not fall through to base when upper shadows with another type', () => {
    const base = new MemoryRoot();
    base.addFile('/opt/base/readme.txt', 'base');
    const upper = new VFS();
    const vfs = new OverlayVFS({ base, upper });

    upper.withWriteAccess(() => upper.mkdirp('/opt/base/readme.txt'));

    expect(() => vfs.readFile('/opt/base/readme.txt')).toThrow(/EISDIR/);
    expect(() => vfs.unlink('/opt/base/readme.txt')).toThrow(/EISDIR/);
  });

  it('whiteouts hide deleted user-owned base files', () => {
    const base = new MemoryRoot();
    base.addDir('/user', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/user/file.txt', 'base', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink('/user/file.txt');

    expect(() => vfs.readFile('/user/file.txt')).toThrow(/ENOENT/);
    expect(vfs.readdir('/user').some((entry) => entry.name === 'file.txt')).toBe(false);
  });

  it('fires onChange for upper writes and whiteout-only deletes', () => {
    const base = new MemoryRoot();
    base.addDir('/user', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/user/base.txt', 'base', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });
    let changes = 0;
    vfs.setOnChange(() => changes++);

    vfs.writeFile('/user/new.txt', enc.encode('new'));
    vfs.unlink('/user/base.txt');
    vfs.mkdir('/user/dir');
    vfs.symlink('new.txt', '/user/link');

    expect(changes).toBe(4);
  });

  it('fires one rename notification only after overlay state is consistent', () => {
    const base = new MemoryRoot('base:test');
    base.addDir('/home', { uid: 0, gid: 0, permissions: 0o755 });
    base.addDir('/home/user', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/home/user/a.txt', 'a', { uid: 1000, gid: 1000, permissions: 0o644 });
    base.addFile('/home/user/b.txt', 'b', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });
    const exportedStates: any[] = [];
    vfs.setOnChange(() => {
      exportedStates.push(JSON.parse(dec.decode(exportState(vfs).subarray(12))));
    });

    vfs.rename('/home/user/a.txt', '/home/user/b.txt');

    expect(exportedStates.length).toBe(1);
    expect(exportedStates[0].overlay.whiteouts).toEqual(['/home/user/a.txt']);

    const restored = new OverlayVFS({ base, upper: new VFS() });
    importState(restored, exportState(vfs), { allowSystemPaths: true });
    expect(dec.decode(vfs.readFile('/home/user/b.txt'))).toBe('a');
    expect(dec.decode(restored.readFile('/home/user/b.txt'))).toBe('a');
  });

  it('does not fire onChange for clearFileContents', () => {
    const vfs = new OverlayVFS({ base: new MemoryRoot(), upper: new VFS() });
    let changes = 0;
    vfs.writeFile('/tmp/file.txt', enc.encode('data'));
    vfs.setOnChange(() => changes++);

    vfs.clearFileContents();

    expect(changes).toBe(0);
  });

  it('does not recreate files below a whiteouted base directory', () => {
    const base = new MemoryRoot();
    base.dirs.set('/', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addDir('/gone', { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.rmdir('/gone');

    expect(() => vfs.writeFile('/gone/file.txt', enc.encode('x'))).toThrow(/ENOENT/);
    expect(() => vfs.writeFile('/x/../gone/file.txt', enc.encode('x'))).toThrow(/ENOENT/);
    expect(() => vfs.readdir('/gone')).toThrow(/ENOENT/);
  });

  it('imports whiteouts canonically', () => {
    const base = new MemoryRoot('base:test');
    base.addDir('/gone', { uid: 1000, gid: 1000, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.importOverlayState({ baseId: 'base:test', whiteouts: ['/x/../gone'] });

    expect(() => vfs.stat('/gone')).toThrow(/ENOENT/);
  });

  it('delete permission depends on the parent directory, not the file', () => {
    const base = new MemoryRoot();
    base.addDir('/writable', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/writable/root-owned.txt', 'base', { uid: 0, gid: 0, permissions: 0o644 });
    base.addDir('/locked', { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile('/locked/user-owned.txt', 'base', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.unlink('/writable/root-owned.txt');
    expect(() => vfs.readFile('/writable/root-owned.txt')).toThrow(/ENOENT/);
    expect(() => vfs.unlink('/locked/user-owned.txt')).toThrow(/EACCES/);
  });

  it('rename permission depends on source and destination parents', () => {
    const base = new MemoryRoot();
    base.addDir('/bin', { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile('/bin/tool', 'tool', { uid: 0, gid: 0, permissions: 0o755 });
    base.addDir('/etc', { uid: 0, gid: 0, permissions: 0o755 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.writeFile('/tmp/payload', enc.encode('payload'));

    expect(() => vfs.rename('/bin/tool', '/tmp/tool')).toThrow(/EACCES/);
    expect(() => vfs.rename('/tmp/payload', '/etc/payload')).toThrow(/EACCES/);
    expect(dec.decode(vfs.readFile('/bin/tool'))).toBe('tool');
    expect(dec.decode(vfs.readFile('/tmp/payload'))).toBe('payload');
    expect(() => vfs.readFile('/tmp/tool')).toThrow(/ENOENT/);
    expect(() => vfs.readFile('/etc/payload')).toThrow(/ENOENT/);
  });

  it('preserves POSIX directory deletion semantics for base directories', () => {
    const base = new MemoryRoot();
    base.addDir('/base-dir', { uid: 1000, gid: 1000, permissions: 0o755 });
    base.addFile('/base-dir/file.txt', 'x', { uid: 1000, gid: 1000, permissions: 0o644 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    expect(() => vfs.unlink('/base-dir')).toThrow(/EISDIR/);
    expect(() => vfs.rmdir('/base-dir')).toThrow(/ENOTEMPTY/);
  });

  it('chmod on base directories depends on ownership, not write bits', () => {
    const base = new MemoryRoot();
    base.addDir('/user-dir', { uid: 1000, gid: 1000, permissions: 0o555 });
    const vfs = new OverlayVFS({ base, upper: new VFS() });

    vfs.chmod('/user-dir', 0o755);

    expect(vfs.stat('/user-dir').permissions).toBe(0o755);
  });

  it('chmod and chown on root-owned base entries require ownership or root', () => {
    const base = new MemoryRoot();
    base.addDir('/etc', { uid: 0, gid: 0, permissions: 0o755 });
    base.addFile('/etc/root.conf', 'root', { uid: 0, gid: 0, permissions: 0o644 });
    const userVfs = new OverlayVFS({ base, upper: new VFS() });
    const rootVfs = new OverlayVFS({ base, upper: new VFS(), credential: { uid: 0, gid: 0 } });

    expect(() => userVfs.chmod('/etc/root.conf', 0o666)).toThrow(/EACCES/);
    expect(() => userVfs.chown('/etc/root.conf', 1000, 1000)).toThrow(/EACCES/);

    rootVfs.chmod('/etc/root.conf', 0o600);
    rootVfs.chown('/etc/root.conf', 1000, 1000);

    expect(rootVfs.stat('/etc/root.conf').permissions).toBe(0o600);
    expect(rootVfs.stat('/etc/root.conf').uid).toBe(1000);
    expect(rootVfs.stat('/etc/root.conf').gid).toBe(1000);
    expect(base.stat('/etc/root.conf').uid).toBe(0);
    expect(base.stat('/etc/root.conf').permissions).toBe(0o644);
  });

  it('can clone the upper layer while sharing the same base', () => {
    const base = new MemoryRoot();
    base.addFile('/base.txt', 'base');
    const vfs = new OverlayVFS({ base, upper: new VFS() });
    vfs.withWriteAccess(() => vfs.writeFile('/upper.txt', enc.encode('upper')));

    const clone = vfs.cowClone();
    clone.withWriteAccess(() => clone.writeFile('/upper.txt', enc.encode('clone')));

    expect(dec.decode(vfs.readFile('/upper.txt'))).toBe('upper');
    expect(dec.decode(clone.readFile('/upper.txt'))).toBe('clone');
    expect(dec.decode(clone.readFile('/base.txt'))).toBe('base');
  });
});
