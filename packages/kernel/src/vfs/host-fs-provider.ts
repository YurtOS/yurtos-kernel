/**
 * HostFsProvider — a VirtualProvider backed by the host filesystem.
 *
 * Unlike HostMount (which snapshots files into memory), this provider reads
 * lazily from the host on each call via node:fs sync APIs. This is useful for
 * MCP server mounts where the host project may be large and change over time.
 *
 * Path traversal is prevented: all resolved paths must stay under hostRoot.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, normalize, dirname } from 'node:path';
import { VfsError } from './inode.js';
import type { VirtualProvider } from './provider.js';

export interface HostFsProviderOptions {
  /** Allow writes to this mount. Default false (read-only). */
  writable?: boolean;
}

export class HostFsProvider implements VirtualProvider {
  readonly fsType = 'hostfs';

  private hostRoot: string;
  private writable: boolean;

  constructor(hostPath: string, options?: HostFsProviderOptions) {
    this.hostRoot = resolve(hostPath);
    this.writable = options?.writable ?? false;
  }

  readFile(subpath: string): Uint8Array {
    const full = this.resolveHost(subpath);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        throw new VfsError('EISDIR', `is a directory: ${subpath}`);
      }
      return new Uint8Array(readFileSync(full));
    } catch (err: unknown) {
      if (err instanceof VfsError) throw err;
      throw new VfsError('ENOENT', `no such file: ${subpath}`);
    }
  }

  writeFile(subpath: string, data: Uint8Array): void {
    if (!this.writable) {
      throw new VfsError('EROFS', 'read-only mount');
    }
    const full = this.resolveHost(subpath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }

  exists(subpath: string): boolean {
    try {
      const full = this.resolveHost(subpath);
      statSync(full);
      return true;
    } catch {
      return false;
    }
  }

  stat(subpath: string): { type: 'file' | 'dir'; size: number } {
    const full = this.resolveHost(subpath);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        const entries = readdirSync(full);
        return { type: 'dir', size: entries.length };
      }
      return { type: 'file', size: st.size };
    } catch {
      throw new VfsError('ENOENT', `no such file: ${subpath}`);
    }
  }

  readdir(subpath: string): Array<{ name: string; type: 'file' | 'dir' }> {
    const full = this.resolveHost(subpath);
    try {
      const st = statSync(full);
      if (!st.isDirectory()) {
        throw new VfsError('ENOTDIR', `not a directory: ${subpath}`);
      }
    } catch (err: unknown) {
      if (err instanceof VfsError) throw err;
      throw new VfsError('ENOENT', `no such directory: ${subpath}`);
    }

    const entries = readdirSync(full, { withFileTypes: true });
    return entries.map(entry => ({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' as const : 'file' as const,
    }));
  }

  /**
   * Resolve a VFS subpath to an absolute host path, preventing path traversal.
   * Throws if the resolved path escapes hostRoot.
   */
  private resolveHost(subpath: string): string {
    // For root access (empty subpath), return hostRoot itself
    if (subpath === '' || subpath === '.') {
      return this.hostRoot;
    }
    const full = normalize(resolve(this.hostRoot, subpath));
    // Ensure the resolved path is still under hostRoot (pre-symlink check)
    if (!full.startsWith(this.hostRoot + '/') && full !== this.hostRoot) {
      throw new VfsError('ENOENT', `path traversal blocked: ${subpath}`);
    }
    // Resolve symlinks and re-check containment to prevent symlink escapes
    try {
      const real = realpathSync(full);
      const realRoot = realpathSync(this.hostRoot);
      if (!real.startsWith(realRoot + '/') && real !== realRoot) {
        throw new VfsError('ENOENT', `symlink traversal blocked: ${subpath}`);
      }
      return real;
    } catch (err) {
      if (err instanceof VfsError) throw err;
      // Path doesn't exist yet (e.g. writeFile to new path) — use normalized path
      return full;
    }
  }
}
