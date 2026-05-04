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

  it('chmod in 0o555 dir → EACCES', () => {
    const vfs = new VFS();
    // /bin is 0o555, so chmod on any child is denied
    vfs.withWriteAccess(() => {
      vfs.writeFile('/bin/tool', new Uint8Array(1));
    });
    expect(() => {
      vfs.chmod('/bin/tool', 0o777);
    }).toThrow(/EACCES/);
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
