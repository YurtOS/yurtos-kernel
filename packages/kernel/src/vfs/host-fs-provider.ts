/**
 * HostFsProvider — a VirtualProvider backed by the host filesystem.
 *
 * Unlike HostMount (which snapshots files into memory), this provider reads
 * lazily from the host on each call via node:fs sync APIs. This is useful for
 * MCP server mounts where the host project may be large and change over time.
 *
 * Path traversal is prevented: all resolved paths must stay under hostRoot.
 */

import { readFileSync, writeFileSync, statSync, readdirSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { resolve, normalize, dirname, join } from 'node:path';
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
   *
   * For paths that don't exist yet (e.g. writeFile creating a new file),
   * we walk up to find the nearest existing ancestor, realpath() *that*,
   * and verify the resolved ancestor is under realRoot. The unresolved
   * residual is then re-attached, giving us a path that writes will
   * land under the real mount even if an intermediate ancestor is a
   * symlink to outside the mount — those get rejected.
   */
  private resolveHost(subpath: string): string {
    // For root access (empty subpath), return hostRoot itself
    if (subpath === '' || subpath === '.') {
      return this.hostRoot;
    }
    const full = normalize(resolve(this.hostRoot, subpath));
    // Pre-symlink containment check (textual; catches `..` escapes).
    if (!full.startsWith(this.hostRoot + '/') && full !== this.hostRoot) {
      throw new VfsError('ENOENT', `path traversal blocked: ${subpath}`);
    }
    const realRoot = realpathSync(this.hostRoot);

    // Walk up until realpathSync succeeds. For an existing leaf this
    // resolves on the first try; for non-existent paths it keeps
    // peeling components until it finds an ancestor that *does*
    // exist, so any symlink along the way is followed by realpath
    // and exposed to the containment check below.
    let probe = full;
    const residual: string[] = [];
    while (true) {
      try {
        const realProbe = realpathSync(probe);
        if (!realProbe.startsWith(realRoot + '/') && realProbe !== realRoot) {
          throw new VfsError('ENOENT', `symlink traversal blocked: ${subpath}`);
        }
        return residual.length === 0 ? realProbe : join(realProbe, ...residual);
      } catch (err) {
        if (err instanceof VfsError) throw err;
        // realpathSync also throws ENOENT for *dangling* symlinks (the
        // link exists but its target doesn't). Without this check, the
        // catch arm would pop the dangling-symlink leaf into `residual`,
        // pass containment on its in-mount parent, and return a path
        // that subsequent writeFileSync would follow out of the mount.
        try {
          if (lstatSync(probe).isSymbolicLink()) {
            throw new VfsError('ENOENT', `symlink traversal blocked: ${subpath}`);
          }
        } catch (lerr) {
          if (lerr instanceof VfsError) throw lerr;
          // probe truly doesn't exist — fall through to pop and continue.
        }
        const parent = dirname(probe);
        if (parent === probe) {
          // Walked all the way to the filesystem root without
          // finding any existing ancestor. hostRoot is created at
          // construction time so this should never happen, but bail
          // rather than fall through to an uncontained path.
          throw new VfsError('ENOENT', `path traversal blocked: ${subpath}`);
        }
        residual.unshift(probe.slice(parent.length + 1));
        probe = parent;
      }
    }
  }
}
