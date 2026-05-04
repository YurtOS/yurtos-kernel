/** Inode types and metadata for the in-memory VFS. */

export type InodeType = 'file' | 'dir' | 'symlink';

export interface InodeMetadata {
  permissions: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export interface FileInode {
  type: 'file';
  metadata: InodeMetadata;
  content: Uint8Array;
}

export interface DirInode {
  type: 'dir';
  metadata: InodeMetadata;
  children: Map<string, Inode>;
}

export interface SymlinkInode {
  type: 'symlink';
  metadata: InodeMetadata;
  target: string;
}

export type Inode = FileInode | DirInode | SymlinkInode;

export type Errno = 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'ENOSPC' | 'EROFS' | 'EACCES';

export class VfsError extends Error {
  errno: Errno;

  constructor(errno: Errno, message: string) {
    super(`${errno}: ${message}`);
    this.name = 'VfsError';
    this.errno = errno;
  }
}

export interface StatResult {
  type: InodeType;
  size: number;
  permissions: number;
  mtime: Date;
  ctime: Date;
  atime: Date;
}

export interface DirEntry {
  name: string;
  type: InodeType;
}

function createMetadata(permissions: number): InodeMetadata {
  const now = new Date();
  return { permissions, mtime: now, ctime: now, atime: now };
}

export function createDirInode(permissions = 0o755): DirInode {
  return {
    type: 'dir',
    metadata: createMetadata(permissions),
    children: new Map(),
  };
}

export function createFileInode(content: Uint8Array, permissions = 0o644): FileInode {
  return {
    type: 'file',
    metadata: createMetadata(permissions),
    content,
  };
}

export function createSymlinkInode(target: string): SymlinkInode {
  return {
    type: 'symlink',
    metadata: createMetadata(0o777),
    target,
  };
}
