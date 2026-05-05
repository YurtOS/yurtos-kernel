import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { normalize, resolve } from 'node:path';
import { VfsError, type DirEntry } from './inode.js';
import type {
  NodeDirectoryRootProviderOptions,
  RootProvider,
  RootProviderStat,
} from './root-provider.js';

function normalizeVfsPath(path: string): string {
  if (!path.startsWith('/')) throw new VfsError('ENOENT', `not absolute: ${path}`);
  const parts = path.split('/');
  let depth = 0;
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      depth--;
      if (depth < 0) throw new VfsError('ENOENT', `traversal blocked: ${path}`);
    } else {
      depth++;
    }
  }
  return normalize(path);
}

export class NodeDirectoryRootProvider implements RootProvider {
  readonly id: string;
  private readonly root: string;
  private readonly realRoot: string;
  private readonly metadata: Record<string, { uid: number; gid: number; mode: number }>;

  constructor(root: string, options: NodeDirectoryRootProviderOptions) {
    this.root = resolve(root);
    this.realRoot = realpathSync(this.root);
    this.id = options.id;
    this.metadata = Object.fromEntries(
      Object.entries(options.metadata ?? {}).map(([path, value]) => [normalizeVfsPath(path), value]),
    );
  }

  readFile(path: string): Uint8Array {
    const full = this.resolveHost(path, true);
    const st = statSync(full);
    if (st.isDirectory()) throw new VfsError('EISDIR', `is a directory: ${path}`);
    return new Uint8Array(readFileSync(full));
  }

  stat(path: string): RootProviderStat {
    return this.toStat(path, true);
  }

  lstat(path: string): RootProviderStat {
    return this.toStat(path, false);
  }

  readdir(path: string): DirEntry[] {
    const full = this.resolveHost(path, true);
    const st = statSync(full);
    if (!st.isDirectory()) throw new VfsError('ENOTDIR', `not a directory: ${path}`);
    return readdirSync(full, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file',
    }));
  }

  readlink(path: string): string {
    const full = this.resolveHost(path, false);
    const st = lstatSync(full);
    if (!st.isSymbolicLink()) throw new VfsError('ENOENT', `not a symlink: ${path}`);
    return readlinkSync(full);
  }

  private toStat(path: string, follow: boolean): RootProviderStat {
    const normalized = normalizeVfsPath(path);
    const full = this.resolveHost(normalized, follow);
    const st = follow ? statSync(full) : lstatSync(full);
    const metadata = this.metadata[normalized];
    return {
      type: st.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? readdirSync(full).length : st.size,
      permissions: metadata?.mode ?? (st.mode & 0o777),
      uid: metadata?.uid ?? st.uid,
      gid: metadata?.gid ?? st.gid,
      mtime: st.mtime,
      ctime: st.ctime,
      atime: st.atime,
    };
  }

  private resolveHost(path: string, follow: boolean): string {
    const normalized = normalizeVfsPath(path);
    const full = normalize(resolve(this.root, `.${normalized}`));
    if (!full.startsWith(`${this.root}/`) && full !== this.root) {
      throw new VfsError('ENOENT', `traversal blocked: ${path}`);
    }
    if (!follow) return full;
    const real = realpathSync(full);
    if (!real.startsWith(`${this.realRoot}/`) && real !== this.realRoot) {
      throw new VfsError('ENOENT', `symlink escape blocked: ${path}`);
    }
    return real;
  }
}
