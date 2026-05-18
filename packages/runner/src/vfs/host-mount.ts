/**
 * HostMount — a VirtualProvider backed by an in-memory file tree.
 *
 * Hosts use this to inject files into the VFS at arbitrary mount points
 * (e.g. /mnt/tools, /mnt/uploads, Python library paths).
 *
 * Flat key maps like { 'lib/__init__.py': data } auto-create intermediate
 * directory nodes so the tree is always consistent.
 */

import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

export interface HostMountOptions {
  /** Allow writes to this mount. Default false (read-only). */
  writable?: boolean;
}

interface FileNode {
  type: 'file';
  data: Uint8Array;
}

interface DirNode {
  type: 'dir';
  children: Map<string, FileNode | DirNode>;
}

type Node = FileNode | DirNode;

function makeDirNode(): DirNode {
  return { type: 'dir', children: new Map() };
}

export class HostMount implements VirtualProvider {
  readonly fsType = 'hostmount';

  private root: DirNode = makeDirNode();
  private writable: boolean;

  constructor(files: Record<string, Uint8Array>, options?: HostMountOptions) {
    this.writable = options?.writable ?? false;
    for (const [path, data] of Object.entries(files)) {
      this.insertFile(path, data);
    }
  }

  /** Add a file after construction. Creates intermediate dirs as needed. */
  addFile(subpath: string, data: Uint8Array): void {
    this.insertFile(subpath, data);
  }

  private insertFile(subpath: string, data: Uint8Array): void {
    const parts = splitPath(subpath);
    if (parts.length === 0) {
      throw new VfsError('ENOENT', 'empty path');
    }

    let current = this.root;
    // Create intermediate directories
    for (let i = 0; i < parts.length - 1; i++) {
      let child = current.children.get(parts[i]);
      if (!child) {
        child = makeDirNode();
        current.children.set(parts[i], child);
      } else if (child.type !== 'dir') {
        throw new VfsError('ENOTDIR', `not a directory: ${parts.slice(0, i + 1).join('/')}`);
      }
      current = child;
    }

    const name = parts[parts.length - 1];
    current.children.set(name, { type: 'file', data });
  }

  private resolve(subpath: string): Node | undefined {
    if (subpath === '') return this.root;
    const parts = splitPath(subpath);
    let current: Node = this.root;
    for (const part of parts) {
      if (current.type !== 'dir') return undefined;
      const child = current.children.get(part);
      if (!child) return undefined;
      current = child;
    }
    return current;
  }

  readFile(subpath: string): Uint8Array {
    const node = this.resolve(subpath);
    if (!node) {
      throw new VfsError('ENOENT', `no such file: ${subpath}`);
    }
    if (node.type === 'dir') {
      throw new VfsError('EISDIR', `is a directory: ${subpath}`);
    }
    return node.data;
  }

  writeFile(subpath: string, data: Uint8Array): void {
    if (!this.writable) {
      throw new VfsError('EROFS', `read-only mount`);
    }
    this.insertFile(subpath, data);
  }

  exists(subpath: string): boolean {
    return this.resolve(subpath) !== undefined;
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    const node = this.resolve(subpath);
    if (!node) {
      throw new VfsError('ENOENT', `no such file: ${subpath}`);
    }
    if (node.type === 'file') {
      return { type: 'file', size: node.data.byteLength };
    }
    return { type: 'dir', size: node.children.size };
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    const node = this.resolve(subpath);
    if (!node) {
      throw new VfsError('ENOENT', `no such directory: ${subpath}`);
    }
    if (node.type !== 'dir') {
      throw new VfsError('ENOTDIR', `not a directory: ${subpath}`);
    }
    return Array.from(node.children.entries()).map(([name, child]) => ({
      name,
      type: child.type,
    }));
  }
}

/** Split a relative path on '/', filtering empty/dot segments. */
function splitPath(p: string): string[] {
  return p.split('/').filter(s => s !== '' && s !== '.');
}
