/**
 * Shell-legacy convenience host imports.
 *
 * These are the shell-specific `yurt` imports that remain after generic
 * process/network/native primitives moved to kernel-imports.ts. PR4 moves
 * this userland bucket out of the kernel package.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { ProcessManager } from '../process/manager.js';
import { readString, readBytes, writeJson, writeString, writeBytes } from './common.js';

// Error codes matching Rust's rc_to_error convention
const ERR_NOT_FOUND = -1;
const _ERR_PERMISSION_DENIED = -2;
const ERR_IO = -3;

// ── Glob helpers ──

/**
 * Convert a glob pattern to a RegExp.
 * Supports: * (any non-/ chars), ? (single non-/ char), [abc], [!abc]/[^abc],
 * and ** (matches any path segments including /).
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // ** matches everything including /
        re += '.*';
        i += 2;
        // Skip a trailing / after ** (e.g. **/ matches zero or more dirs)
        if (pattern[i] === '/') i++;
      } else {
        // * matches anything except /
        re += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      re += '[^/]';
      i++;
    } else if (ch === '[') {
      // Character class — find the closing ]
      let j = i + 1;
      // Handle negation
      if (j < pattern.length && (pattern[j] === '!' || pattern[j] === '^')) j++;
      // Handle ] as first char in class
      if (j < pattern.length && pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j++;
      if (j >= pattern.length) {
        // No closing ] — treat [ as literal
        re += '\\[';
        i++;
      } else {
        let cls = pattern.slice(i + 1, j);
        // Convert [!...] to [^...]
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls + ']';
        i = j + 1;
      }
    } else if ('.+^${}()|\\'.includes(ch)) {
      re += '\\' + ch;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp('^' + re + '$');
}

/**
 * Extract the base directory from a glob pattern.
 * This is everything up to (but not including) the path component
 * that contains the first glob metacharacter (*, ?, [).
 */
function globBaseDir(pattern: string): string {
  const parts = pattern.split('/');
  const base: string[] = [];
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break;
    base.push(part);
  }
  const dir = base.join('/');
  if (dir === '') return pattern.startsWith('/') ? '/' : '.';
  return dir;
}

/**
 * Recursively collect all file and directory paths under a given directory.
 */
function walkVfs(vfs: VfsLike, dir: string): string[] {
  const results: string[] = [];
  let entries;
  try {
    entries = vfs.readdir(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = dir === '/' ? '/' + entry.name : dir + '/' + entry.name;
    results.push(fullPath);
    if (entry.type === 'dir') {
      results.push(...walkVfs(vfs, fullPath));
    }
  }
  return results;
}

/**
 * Perform glob matching against the VFS.
 * Returns an array of matching absolute paths, sorted.
 */
function globMatch(vfs: VfsLike, pattern: string): string[] {
  // Normalize: ensure pattern is absolute
  const absPattern = pattern.startsWith('/') ? pattern : '/' + pattern;

  const baseDir = globBaseDir(absPattern);
  const regex = globToRegExp(absPattern);

  // Walk from the base directory
  const allPaths = walkVfs(vfs, baseDir);
  const matches = allPaths.filter(p => regex.test(p));
  matches.sort();
  return matches;
}

export interface ShellImportsOptions {
  vfs: VfsLike;
  mgr: ProcessManager;
  memory: WebAssembly.Memory;
}

export function createShellImports(opts: ShellImportsOptions): Record<string, WebAssembly.ImportValue> {
  const { vfs, mgr, memory } = opts;

  return {
    host_has_tool(namePtr: number, nameLen: number): number {
      const name = readString(memory, namePtr, nameLen);
      return mgr.hasTool(name) ? 1 : 0;
    },

    host_time(): number {
      return Date.now() / 1000;
    },

    // ── Filesystem ──

    host_stat(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const s = vfs.stat(path);
        const info = {
          exists: true,
          is_file: s.type === 'file',
          is_dir: s.type === 'dir',
          is_symlink: s.type === 'symlink',
          size: s.size,
          mode: s.permissions,
          mtime_ms: s.mtime ? s.mtime.getTime() : 0,
        };
        return writeJson(memory, outPtr, outCap, info);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_read_file(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const data = vfs.readFile(path);
        return writeBytes(memory, outPtr, outCap, data);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_write_file(
      pathPtr: number, pathLen: number,
      dataPtr: number, dataLen: number,
      mode: number,
    ): number {
      const path = readString(memory, pathPtr, pathLen);
      const data = readBytes(memory, dataPtr, dataLen);
      try {
        if (mode === 1) {
          // Append mode
          try {
            const existing = vfs.readFile(path);
            const combined = new Uint8Array(existing.length + data.length);
            combined.set(existing);
            combined.set(data, existing.length);
            vfs.writeFile(path, combined);
          } catch {
            // File doesn't exist yet — create it
            vfs.writeFile(path, data);
          }
        } else {
          // Truncate mode (mode 0)
          vfs.writeFile(path, data);
        }
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readdir(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const entries = vfs.readdir(path).map(e => e.name);
        return writeJson(memory, outPtr, outCap, entries);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_mkdir(pathPtr: number, pathLen: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        vfs.mkdir(path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_remove(pathPtr: number, pathLen: number, recursive: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        if (recursive) {
          vfs.rmdir(path);
        } else {
          try {
            vfs.unlink(path);
          } catch {
            vfs.rmdir(path);
          }
        }
        return 0;
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    host_chmod(pathPtr: number, pathLen: number, mode: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        vfs.chmod(path, mode);
        return 0;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : '';
        if (msg.includes('ENOENT') || msg.includes('no such file')) {
          return ERR_NOT_FOUND;
        }
        return ERR_IO;
      }
    },

    host_glob(
      patternPtr: number, patternLen: number,
      outPtr: number, outCap: number,
    ): number {
      const pattern = readString(memory, patternPtr, patternLen);
      try {
        const matches = globMatch(vfs, pattern);
        return writeJson(memory, outPtr, outCap, matches);
      } catch {
        return writeJson(memory, outPtr, outCap, []);
      }
    },

    host_rename(fromPtr: number, fromLen: number, toPtr: number, toLen: number): number {
      const from = readString(memory, fromPtr, fromLen);
      const to = readString(memory, toPtr, toLen);
      try {
        vfs.rename(from, to);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_symlink(targetPtr: number, targetLen: number, linkPtr: number, linkLen: number): number {
      const target = readString(memory, targetPtr, targetLen);
      const link = readString(memory, linkPtr, linkLen);
      try {
        vfs.symlink(target, link);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    host_readlink(pathPtr: number, pathLen: number, outPtr: number, outCap: number): number {
      const path = readString(memory, pathPtr, pathLen);
      try {
        const target = vfs.readlink(path);
        return writeString(memory, outPtr, outCap, target);
      } catch {
        return ERR_NOT_FOUND;
      }
    },

    // ── Network / Tool registration ──
    // Note: host_is_extension, host_extension_invoke, and host_network_fetch
    // are all provided by kernel-imports.ts (createKernelImports).
    // The shell's Rust code calls host_network_fetch directly.

    // host_register_tool(name_ptr, name_len, path_ptr, path_len) -> i32
    // Register a pkg-installed tool with the process manager.
    async host_register_tool(
      namePtr: number, nameLen: number,
      pathPtr: number, pathLen: number,
    ): Promise<number> {
      const name = readString(memory, namePtr, nameLen);
      const path = readString(memory, pathPtr, pathLen);
      try {
        // __native__ prefix: load as a native Python module (bridge), not a tool
        if (name.startsWith('__native__')) {
          const moduleName = name.slice('__native__'.length);
          const wasmBytes = vfs.readFile(path);
          await mgr.registerNativeModule(moduleName, wasmBytes);
          return 0;
        }
        // Async register + preload so dynamically installed tools are immediately usable
        await mgr.registerAndLoadTool(name, path);
        return 0;
      } catch {
        return ERR_IO;
      }
    },

    // ── Shell session ──
    // These are placeholders retained for legacy shell-exec imports. The
    // resident command loop is driven through __run_command.

    host_read_command(outPtr: number, outCap: number): number {
      void outPtr;
      void outCap;
      // Placeholder -- retained for legacy ABI compatibility.
      return 0;
    },

    host_write_result(resultPtr: number, resultLen: number): void {
      void resultPtr;
      void resultLen;
      // Placeholder -- retained for legacy ABI compatibility.
    },
  };
}
