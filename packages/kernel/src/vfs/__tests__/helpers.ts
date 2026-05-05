import { VfsError } from '../inode.ts';
import type { DirEntry } from '../inode.ts';
import type { RootProvider, RootProviderStat } from '../root-provider.ts';

const enc = new TextEncoder();

export interface MemoryRootMetadata {
  permissions?: number;
  uid?: number;
  gid?: number;
}

function stat(
  type: 'file' | 'dir' | 'symlink',
  size = 0,
  metadata: MemoryRootMetadata = {},
): RootProviderStat {
  const now = new Date(0);
  return {
    type,
    size,
    permissions: metadata.permissions ?? 0o555,
    uid: metadata.uid ?? 0,
    gid: metadata.gid ?? 0,
    mtime: now,
    ctime: now,
    atime: now,
  };
}

function parentPath(path: string): string {
  const parent = path.slice(0, path.lastIndexOf('/'));
  return parent || '/';
}

export class MemoryRoot implements RootProvider {
  files = new Map<string, { data: Uint8Array; metadata: MemoryRootMetadata }>();
  dirs = new Map<string, MemoryRootMetadata>([['/', { permissions: 0o755, uid: 0, gid: 0 }]]);
  symlinks = new Map<string, { target: string; metadata: MemoryRootMetadata }>();

  constructor(readonly id = 'memory-root') {}

  addDir(path: string, metadata: MemoryRootMetadata = {}): void {
    const parts = path.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      if (!this.dirs.has(current)) this.dirs.set(current, current === path ? metadata : {});
    }
  }

  addFile(path: string, data: string, metadata: MemoryRootMetadata = {}): void {
    this.addDir(parentPath(path));
    this.files.set(path, { data: enc.encode(data), metadata });
  }

  addSymlink(path: string, target: string, metadata: MemoryRootMetadata = {}): void {
    this.addDir(parentPath(path));
    this.symlinks.set(path, { target, metadata });
  }

  readFile(path: string): Uint8Array {
    const file = this.files.get(path);
    if (!file) throw new VfsError('ENOENT', path);
    return file.data;
  }

  stat(path: string): RootProviderStat {
    return this.lstat(path);
  }

  lstat(path: string): RootProviderStat {
    const file = this.files.get(path);
    if (file) return stat('file', file.data.byteLength, file.metadata);
    const symlink = this.symlinks.get(path);
    if (symlink) return stat('symlink', symlink.target.length, symlink.metadata);
    const dir = this.dirs.get(path);
    if (dir) return stat('dir', 0, dir);
    throw new VfsError('ENOENT', path);
  }

  readdir(path: string): DirEntry[] {
    if (!this.dirs.has(path)) throw new VfsError('ENOENT', path);
    const prefix = path === '/' ? '/' : `${path}/`;
    const names = new Map<string, 'file' | 'dir' | 'symlink'>();
    for (const dir of this.dirs.keys()) {
      if (dir === path || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      const [name, ...tail] = rest.split('/');
      names.set(name, tail.length ? 'dir' : 'dir');
    }
    for (const file of this.files.keys()) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const [name, ...tail] = rest.split('/');
      names.set(name, tail.length ? 'dir' : 'file');
    }
    for (const link of this.symlinks.keys()) {
      if (!link.startsWith(prefix)) continue;
      const rest = link.slice(prefix.length);
      const [name, ...tail] = rest.split('/');
      names.set(name, tail.length ? 'dir' : 'symlink');
    }
    return Array.from(names, ([name, type]) => ({ name, type }));
  }

  readlink(path: string): string {
    const symlink = this.symlinks.get(path);
    if (!symlink) throw new VfsError('ENOENT', path);
    return symlink.target;
  }
}
