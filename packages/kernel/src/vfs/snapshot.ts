/**
 * Copy-on-write snapshot utilities for the VFS.
 *
 * Provides deep cloning of the inode tree with structural sharing:
 * directory structure is fully cloned (new Map instances), but file
 * content Uint8Arrays are shared by reference. Since writeFile replaces
 * (rather than mutates) content arrays, this gives natural COW semantics
 * without reference counting.
 */

import type { DirInode, Inode } from './inode.js';
import { createDirInode } from './inode.js';

/**
 * Deep-clone an inode tree. Directory nodes get new Map instances;
 * file content is shared by reference (COW via replacement semantics).
 */
export function deepCloneInode(inode: Inode): Inode {
  if (inode.type === 'file') {
    return {
      type: 'file',
      metadata: { ...inode.metadata },
      content: inode.content, // shared — COW via replacement
    };
  }

  if (inode.type === 'symlink') {
    return {
      type: 'symlink',
      metadata: { ...inode.metadata },
      target: inode.target,
    };
  }

  // Directory: recursively clone children into a new Map
  const cloned = createDirInode(inode.metadata.permissions);
  cloned.metadata = { ...inode.metadata };

  for (const [name, child] of inode.children) {
    cloned.children.set(name, deepCloneInode(child));
  }

  return cloned;
}

/** Deep-clone a DirInode root, preserving the directory type. */
export function deepCloneRoot(root: DirInode): DirInode {
  return deepCloneInode(root) as DirInode;
}
