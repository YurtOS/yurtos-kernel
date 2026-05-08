import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { VFS } from '../vfs.js';

describe('VFS', () => {
  it('creates with default directory structure', () => {
    const vfs = new VFS();
    expect(vfs.stat('/')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/home/user')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/tmp')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/bin')).toMatchObject({ type: 'dir' });
    expect(vfs.stat('/usr/bin')).toMatchObject({ type: 'dir' });
  });

  it('empty disk layout starts with only virtual provider paths', () => {
    const vfs = new VFS({ layout: 'empty' });

    expect(vfs.readdir('/').map((entry) => entry.name).sort()).toEqual([
      'dev',
      'proc',
    ]);
    expect(vfs.getProviderPaths().sort()).toEqual(['/dev', '/proc']);
    expect(vfs.stat('/dev').type).toBe('dir');
    expect(vfs.stat('/proc').type).toBe('dir');
  });

  it('empty disk layout reserves virtual provider mount paths', () => {
    const vfs = new VFS({ layout: 'empty' });

    expect(() => vfs.mkdir('/dev')).toThrow(/EEXIST|EROFS|EACCES/);
    expect(() => vfs.writeFile('/proc', new Uint8Array())).toThrow();
    vfs.withWriteAccess(() => {
      vfs.mkdir('/bin');
      vfs.writeFile('/bin/tool', new Uint8Array([1]), 0o555);
    });
    expect(vfs.stat('/bin/tool').permissions).toBe(0o555);
  });

  it('creates and reads files', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('hello world');
    vfs.writeFile('/home/user/test.txt', data);
    const read = vfs.readFile('/home/user/test.txt');
    expect(new TextDecoder().decode(read)).toBe('hello world');
  });

  it('creates directories', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/src');
    expect(vfs.stat('/home/user/src')).toMatchObject({ type: 'dir' });
  });

  it('lists directory contents', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/a.txt', new Uint8Array());
    vfs.writeFile('/home/user/b.txt', new Uint8Array());
    vfs.mkdir('/home/user/sub');
    const entries = vfs.readdir('/home/user');
    expect(entries.map(e => e.name).sort()).toEqual(['a.txt', 'b.txt', 'sub']);
  });

  it('removes files', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new Uint8Array());
    vfs.unlink('/home/user/test.txt');
    expect(() => vfs.stat('/home/user/test.txt')).toThrow();
  });

  it('renames files', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('content');
    vfs.writeFile('/home/user/old.txt', data);
    vfs.rename('/home/user/old.txt', '/home/user/new.txt');
    expect(new TextDecoder().decode(vfs.readFile('/home/user/new.txt'))).toBe('content');
    expect(() => vfs.stat('/home/user/old.txt')).toThrow();
  });

  it('handles nested paths with mkdirp', () => {
    const vfs = new VFS();
    vfs.mkdirp('/home/user/a/b/c');
    expect(vfs.stat('/home/user/a/b/c')).toMatchObject({ type: 'dir' });
  });

  it('returns correct stat metadata', () => {
    const vfs = new VFS();
    const data = new TextEncoder().encode('12345');
    vfs.writeFile('/home/user/test.txt', data);
    const s = vfs.stat('/home/user/test.txt');
    expect(s.size).toBe(5);
    expect(s.type).toBe('file');
    expect(s.mtime).toBeInstanceOf(Date);
  });

  it('throws ENOENT for missing paths', () => {
    const vfs = new VFS();
    expect(() => vfs.stat('/nonexistent')).toThrow(/ENOENT/);
    expect(() => vfs.readFile('/nonexistent')).toThrow(/ENOENT/);
  });

  it('throws EEXIST for duplicate mkdir', () => {
    const vfs = new VFS();
    vfs.mkdir('/home/user/dir');
    expect(() => vfs.mkdir('/home/user/dir')).toThrow(/EEXIST/);
  });

  it('throws ENOTDIR when path component is a file', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/file.txt', new Uint8Array());
    expect(() => vfs.mkdir('/home/user/file.txt/sub')).toThrow(/ENOTDIR/);
  });
});

describe('VFS symlinks', () => {
  it('resolves a simple symlink', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/real.txt', new TextEncoder().encode('content'));
    vfs.symlink('/tmp/real.txt', '/tmp/link.txt');
    const data = vfs.readFile('/tmp/link.txt');
    expect(new TextDecoder().decode(data)).toBe('content');
  });

  it('resolves a chain of symlinks within depth limit', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/target.txt', new TextEncoder().encode('ok'));
    // Create a short chain: link3 -> link2 -> link1 -> target.txt
    vfs.symlink('/tmp/target.txt', '/tmp/link1');
    vfs.symlink('/tmp/link1', '/tmp/link2');
    vfs.symlink('/tmp/link2', '/tmp/link3');
    expect(new TextDecoder().decode(vfs.readFile('/tmp/link3'))).toBe('ok');
  });

  it('resolves relative symlink targets from the containing directory', () => {
    const vfs = new VFS();
    vfs.mkdir('/tmp/root');
    vfs.mkdir('/tmp/root/real');
    vfs.mkdir('/tmp/root/sub');
    vfs.writeFile('/tmp/root/real/file.txt', new TextEncoder().encode('ok'));
    vfs.symlink('../real', '/tmp/root/sub/fake');

    const stat = vfs.stat('/tmp/root/sub/fake');
    expect(stat.type).toBe('dir');
    expect(new TextDecoder().decode(vfs.readFile('/tmp/root/sub/fake/file.txt')))
      .toBe('ok');
  });

  it('applies parent traversal after resolving symlink path components', () => {
    const vfs = new VFS();
    vfs.mkdirp('/tmp/root/dir3/subdir');
    vfs.mkdirp('/tmp/root/dir3/hello');
    vfs.writeFile('/tmp/root/dir3/hello/world', new TextEncoder().encode('ok'));
    vfs.symlink('dir3/subdir', '/tmp/root/link');

    expect(new TextDecoder().decode(vfs.readFile('/tmp/root/link/../hello/world')))
      .toBe('ok');
  });

  it('throws on symlink chain exceeding max depth', () => {
    const vfs = new VFS();
    // Create 41 directories to hold symlinks, each pointing to the next
    vfs.writeFile('/tmp/end.txt', new TextEncoder().encode('unreachable'));
    // Build chain: /tmp/s0 -> /tmp/s1 -> ... -> /tmp/s40 -> /tmp/end.txt
    vfs.symlink('/tmp/end.txt', '/tmp/s40');
    for (let i = 39; i >= 0; i--) {
      vfs.symlink(`/tmp/s${i + 1}`, `/tmp/s${i}`);
    }
    // Chain of 41 symlinks should exceed MAX_SYMLINK_DEPTH (40)
    expect(() => vfs.readFile('/tmp/s0')).toThrow(/too many symlinks/);
  });

  it('counts depth across recursive resolve calls', () => {
    const vfs = new VFS();
    // Create symlinks as intermediate path components to test cross-recursion depth
    // /tmp/d0/target.txt, /tmp/d1/hop -> /tmp/d0, etc.
    vfs.mkdirp('/tmp/d0');
    vfs.writeFile('/tmp/d0/target.txt', new TextEncoder().encode('found'));

    // Build 41 directories with symlinks between them
    for (let i = 40; i >= 1; i--) {
      vfs.mkdirp(`/tmp/d${i}`);
      vfs.symlink(`/tmp/d${i - 1}`, `/tmp/d${i}/hop`);
    }
    // /tmp/d41/hop -> /tmp/d40, /tmp/d40/hop -> /tmp/d39, ..., /tmp/d1/hop -> /tmp/d0
    // Traversing /tmp/d41/hop/hop/hop/.../hop/target.txt requires 41 symlink follows
    // This should exceed the limit
    vfs.mkdirp('/tmp/d41');
    vfs.symlink('/tmp/d40', '/tmp/d41/hop');
    const deepPath = '/tmp/d41' + '/hop'.repeat(41) + '/target.txt';
    expect(() => vfs.readFile(deepPath)).toThrow(/too many symlinks/);
  });
});

describe('VFS size limit', () => {
  it('allows writes within limit', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    const data = new Uint8Array(500);
    vfs.writeFile('/tmp/a.txt', data);
    expect(vfs.stat('/tmp/a.txt').size).toBe(500);
  });

  it('rejects writes exceeding limit', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    expect(() => {
      vfs.writeFile('/tmp/b.txt', new Uint8Array(300));
    }).toThrow(/ENOSPC/);
  });

  it('reclaims space on overwrite', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    vfs.writeFile('/tmp/a.txt', new Uint8Array(100));
    vfs.writeFile('/tmp/b.txt', new Uint8Array(900));
    expect(vfs.stat('/tmp/b.txt').size).toBe(900);
  });

  it('reclaims space on unlink', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    vfs.unlink('/tmp/a.txt');
    vfs.writeFile('/tmp/b.txt', new Uint8Array(800));
    expect(vfs.stat('/tmp/b.txt').size).toBe(800);
  });

  it('no limit by default', () => {
    const vfs = new VFS();
    const data = new Uint8Array(10_000_000);
    vfs.writeFile('/tmp/big.txt', data);
    expect(vfs.stat('/tmp/big.txt').size).toBe(10_000_000);
  });
});

describe('file count limit', () => {
  // Default layout creates 13 dirs: /home, /home/user, /tmp, /bin, /usr, /usr/bin, /usr/lib, /usr/lib/python, /etc, /etc/yurt, /usr/share, /usr/share/pkg, /mnt
  const DEFAULT_INODES = 13;

  it('rejects file creation when file count limit reached', () => {
    const vfs = new VFS({ fileCount: DEFAULT_INODES + 3 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/c.txt', new Uint8Array(1));
    expect(() => {
      vfs.writeFile('/tmp/d.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
  });

  it('rejects mkdir when file count limit reached', () => {
    const vfs = new VFS({ fileCount: DEFAULT_INODES + 1 });
    vfs.mkdir('/tmp/sub');
    expect(() => {
      vfs.mkdir('/tmp/sub2');
    }).toThrow(/ENOSPC/);
  });

  it('allows creation after deletion frees a slot', () => {
    const vfs = new VFS({ fileCount: DEFAULT_INODES + 1 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    expect(() => {
      vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
    vfs.unlink('/tmp/a.txt');
    vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    expect(vfs.readFile('/tmp/b.txt')).toEqual(new Uint8Array(1));
  });

  it('overwriting existing file does not increment count', () => {
    const vfs = new VFS({ fileCount: DEFAULT_INODES + 1 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/a.txt', new Uint8Array(2));
    expect(vfs.readFile('/tmp/a.txt')).toEqual(new Uint8Array(2));
  });

  it('no limit when fileCount is undefined', () => {
    const vfs = new VFS();
    for (let i = 0; i < 100; i++) {
      vfs.writeFile(`/tmp/f${i}.txt`, new Uint8Array(1));
    }
  });
});

describe('cowClone option propagation', () => {
  it('propagates fsLimitBytes to cloned VFS', () => {
    const vfs = new VFS({ fsLimitBytes: 1024 });
    vfs.writeFile('/tmp/a.txt', new Uint8Array(800));
    const child = vfs.cowClone();
    expect(() => {
      child.writeFile('/tmp/b.txt', new Uint8Array(300));
    }).toThrow(/ENOSPC/);
  });

  it('propagates fileCount to cloned VFS', () => {
    const vfs = new VFS({ fileCount: 15 }); // 13 default dirs + 2 files
    vfs.writeFile('/tmp/a.txt', new Uint8Array(1));
    vfs.writeFile('/tmp/b.txt', new Uint8Array(1));
    const child = vfs.cowClone();
    expect(() => {
      child.writeFile('/tmp/c.txt', new Uint8Array(1));
    }).toThrow(/ENOSPC/);
  });

  it('COW clone inherits mode bits', () => {
    const vfs = new VFS();
    const child = vfs.cowClone();
    // /bin is 0o555 — writes should be denied
    expect(() => {
      child.writeFile('/bin/evil', new Uint8Array(1));
    }).toThrow(/EACCES/);
    // /tmp is 0o777 — writes should succeed
    child.writeFile('/tmp/ok.txt', new Uint8Array(1));
  });
});

describe('mode-bit enforcement', () => {
  it('write to 0o755 dir succeeds', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/test.txt', new Uint8Array(1));
    expect(vfs.stat('/home/user/test.txt').type).toBe('file');
  });

  it('write to 0o555 dir → EACCES', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.writeFile('/bin/evil', new Uint8Array(1));
    }).toThrow(/EACCES/);
  });

  it('overwrite 0o644 file succeeds', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/f.txt', new Uint8Array([1]));
    vfs.writeFile('/home/user/f.txt', new Uint8Array([2]));
    expect(vfs.readFile('/home/user/f.txt')).toEqual(new Uint8Array([2]));
  });

  it('overwrite 0o444 file → EACCES', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/f.txt', new Uint8Array([1]));
    vfs.withWriteAccess(() => {
      vfs.chmod('/home/user/f.txt', 0o444);
    });
    expect(() => {
      vfs.writeFile('/home/user/f.txt', new Uint8Array([2]));
    }).toThrow(/EACCES/);
  });

  it('chmod in 0o755 dir succeeds', () => {
    const vfs = new VFS();
    vfs.writeFile('/home/user/f.txt', new Uint8Array(1));
    vfs.chmod('/home/user/f.txt', 0o444);
    expect(vfs.stat('/home/user/f.txt').permissions).toBe(0o444);
  });

  it('chmod owner-owned file succeeds even when parent dir is not writable', () => {
    const vfs = new VFS();
    vfs.mkdir('/tmp/owned-dir');
    vfs.writeFile('/tmp/owned-dir/file.txt', new Uint8Array(1));
    vfs.withWriteAccess(() => {
      vfs.chmod('/tmp/owned-dir', 0o555);
    });
    vfs.chmod('/tmp/owned-dir/file.txt', 0o444);
    expect(vfs.stat('/tmp/owned-dir/file.txt').permissions).toBe(0o444);
  });

  it('chmod denies non-owners and masks file type bits from raw st_mode values', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.writeFile('/tmp/mode.txt', new Uint8Array(1));
    const other = owner.cowClone({ uid: 3000, gid: 3000 });

    expect(() => other.chmod('/tmp/mode.txt', 0o777)).toThrow(/EACCES/);

    owner.chmod('/tmp/mode.txt', 0o100644);
    expect(owner.stat('/tmp/mode.txt').permissions).toBe(0o644);
  });

  it('chown is root-only and lchown mutates the symlink inode', () => {
    const owner = new VFS({ uid: 1000, gid: 1000 });
    owner.writeFile('/tmp/target.txt', new Uint8Array(1));
    owner.symlink('/tmp/target.txt', '/tmp/link.txt');

    expect(() => owner.chown('/tmp/target.txt', 2000, 2000)).toThrow(/EACCES/);

    const root = owner.cowClone({ uid: 0, gid: 0 });
    root.chown('/tmp/link.txt', 2000, 2000, false);
    expect(root.lstat('/tmp/link.txt').uid).toBe(2000);
    expect(root.stat('/tmp/target.txt').uid).toBe(1000);
  });

  it('uses group write bit when uid differs but gid matches', () => {
    const owner = new VFS({ uid: 2000, gid: 1000 });
    owner.writeFile('/tmp/group-writable.txt', new Uint8Array([1]));
    owner.chmod('/tmp/group-writable.txt', 0o660);

    const groupPeer = owner.cowClone({ uid: 3000, gid: 1000 });
    groupPeer.writeFile('/tmp/group-writable.txt', new Uint8Array([2]));
    expect(groupPeer.readFile('/tmp/group-writable.txt')).toEqual(new Uint8Array([2]));
  });

  it('uses other write bit when neither uid nor gid matches', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.writeFile('/tmp/world-writable.txt', new Uint8Array([1]));
    owner.chmod('/tmp/world-writable.txt', 0o606);

    const other = owner.cowClone({ uid: 3000, gid: 3000 });
    other.writeFile('/tmp/world-writable.txt', new Uint8Array([2]));
    expect(other.readFile('/tmp/world-writable.txt')).toEqual(new Uint8Array([2]));
  });

  it('denies write when uid, gid, and other write bits do not grant access', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.writeFile('/tmp/private.txt', new Uint8Array([1]));
    owner.chmod('/tmp/private.txt', 0o640);

    const other = owner.cowClone({ uid: 3000, gid: 3000 });
    expect(() => {
      other.writeFile('/tmp/private.txt', new Uint8Array([2]));
    }).toThrow(/EACCES/);
  });

  it('readFile uses owner, group, and other read bits', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.writeFile('/tmp/private.txt', new Uint8Array([1]));
    owner.chmod('/tmp/private.txt', 0o640);

    const groupPeer = owner.cowClone({ uid: 3000, gid: 2000 });
    expect(groupPeer.readFile('/tmp/private.txt')).toEqual(new Uint8Array([1]));

    const other = owner.cowClone({ uid: 3000, gid: 3000 });
    expect(() => other.readFile('/tmp/private.txt')).toThrow(/EACCES/);

    const root = owner.cowClone({ uid: 0, gid: 0 });
    expect(root.readFile('/tmp/private.txt')).toEqual(new Uint8Array([1]));
  });

  it('directory search requires execute permission on every traversed directory', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.mkdir('/tmp/private-dir');
    owner.writeFile('/tmp/private-dir/file.txt', new Uint8Array([1]));
    owner.chmod('/tmp/private-dir', 0o600);

    const other = owner.cowClone({ uid: 3000, gid: 3000 });
    expect(() => other.stat('/tmp/private-dir/file.txt')).toThrow(/EACCES/);
    expect(() => other.readFile('/tmp/private-dir/file.txt')).toThrow(/EACCES/);
  });

  it('directory listing requires read permission on the directory', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.mkdir('/tmp/listable');
    owner.writeFile('/tmp/listable/file.txt', new Uint8Array([1]));
    owner.chmod('/tmp/listable', 0o711);

    const other = owner.cowClone({ uid: 3000, gid: 3000 });
    expect(() => other.readdir('/tmp/listable')).toThrow(/EACCES/);
    expect(other.stat('/tmp/listable/file.txt').type).toBe('file');
  });

  it('creating entries in a directory requires write and execute permission', () => {
    const owner = new VFS({ uid: 2000, gid: 2000 });
    owner.mkdir('/tmp/dropbox');
    owner.chmod('/tmp/dropbox', 0o622);

    const other = owner.cowClone({ uid: 3000, gid: 3000 });
    expect(() => {
      other.writeFile('/tmp/dropbox/new.txt', new Uint8Array([1]));
    }).toThrow(/EACCES/);

    owner.chmod('/tmp/dropbox', 0o733);
    const searchableOther = owner.cowClone({ uid: 3000, gid: 3000 });
    searchableOther.writeFile('/tmp/dropbox/new.txt', new Uint8Array([1]));
    expect(searchableOther.stat('/tmp/dropbox/new.txt').type).toBe('file');
  });

  it('mkdir in 0o555 dir → EACCES', () => {
    const vfs = new VFS();
    expect(() => {
      vfs.mkdir('/bin/subdir');
    }).toThrow(/EACCES/);
  });

  it('unlink in 0o555 dir → EACCES', () => {
    const vfs = new VFS();
    vfs.withWriteAccess(() => {
      vfs.writeFile('/bin/tool', new Uint8Array(1));
    });
    expect(() => {
      vfs.unlink('/bin/tool');
    }).toThrow(/EACCES/);
  });

  it('withWriteAccess bypasses mode checks', () => {
    const vfs = new VFS();
    // /bin is 0o555 — normally blocked
    vfs.withWriteAccess(() => {
      vfs.writeFile('/bin/tool', new Uint8Array(1));
    });
    expect(vfs.stat('/bin/tool').type).toBe('file');
  });

  it('preserves setuid, setgid, and sticky mode bits', () => {
    const vfs = new VFS();
    vfs.mkdir('/tmp/modish');
    vfs.chmod('/tmp/modish', 0o7710);
    expect(vfs.stat('/tmp/modish').permissions).toBe(0o7710);
  });

  it('creating top-level dirs → EACCES', () => {
    const vfs = new VFS();
    // Root is 0o555
    expect(() => {
      vfs.mkdir('/newdir');
    }).toThrow(/EACCES/);
  });

  it('symlink from writable dir to system dir does not grant write access', () => {
    const vfs = new VFS();
    // Create symlink /tmp/escape → /bin (allowed: /tmp is 0o777)
    vfs.symlink('/bin', '/tmp/escape');
    // Write through symlink: resolveParent follows it to /bin (0o555) → EACCES
    expect(() => {
      vfs.writeFile('/tmp/escape/evil', new Uint8Array(1));
    }).toThrow(/EACCES/);
  });

  it('rename through symlink to system dir is denied', () => {
    const vfs = new VFS();
    vfs.writeFile('/tmp/payload.txt', new Uint8Array(1));
    vfs.symlink('/bin', '/tmp/sysdir');
    // Destination parent resolves through symlink to /bin (0o555)
    expect(() => {
      vfs.rename('/tmp/payload.txt', '/tmp/sysdir/payload.txt');
    }).toThrow(/EACCES/);
    // Source file should still exist
    expect(vfs.stat('/tmp/payload.txt').type).toBe('file');
  });

  it('mkdir through symlink to system dir is denied', () => {
    const vfs = new VFS();
    vfs.symlink('/usr', '/tmp/syslink');
    expect(() => {
      vfs.mkdir('/tmp/syslink/evil');
    }).toThrow(/EACCES/);
  });

  it('unlink through symlink to system dir is denied', () => {
    const vfs = new VFS();
    vfs.symlink('/bin', '/tmp/syslink');
    expect(() => {
      vfs.unlink('/tmp/syslink/sh');
    }).toThrow(/EACCES/);
  });
});
