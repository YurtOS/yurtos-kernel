import type { DirEntry, StatResult } from './inode.js';

export interface RootProviderStat {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  permissions: number;
  uid: number;
  gid: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export interface RootProvider {
  readonly id: string;
  readFile(path: string): Uint8Array;
  stat(path: string): RootProviderStat;
  lstat(path: string): RootProviderStat;
  readdir(path: string): DirEntry[];
  readlink(path: string): string;
}

export interface NodeDirectoryRootProviderOptions {
  id: string;
  metadata?: Record<string, { uid: number; gid: number; mode: number }>;
}

export function rootStatToVfsStat(stat: RootProviderStat): StatResult {
  return {
    type: stat.type,
    size: stat.size,
    permissions: stat.permissions,
    uid: stat.uid,
    gid: stat.gid,
    mtime: stat.mtime,
    ctime: stat.ctime,
    atime: stat.atime,
  };
}
