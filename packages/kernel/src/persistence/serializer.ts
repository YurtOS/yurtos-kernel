/**
 * VFS state serializer.
 *
 * Binary format v2:
 *   [4 bytes: magic "WSND" = 0x57, 0x53, 0x4E, 0x44]
 *   [4 bytes: version = 2, little-endian uint32]
 *   [4 bytes: CRC32 of JSON payload]
 *   [rest:    JSON UTF-8 encoded SerializedState]
 *
 * Binary format v1 (legacy, read-only):
 *   [4 bytes: magic "WSND"]
 *   [4 bytes: version = 1, little-endian uint32]
 *   [rest:    JSON UTF-8 encoded SerializedState]
 *
 * Files are base64-encoded; directories use an empty data string.
 * Virtual provider paths (/dev, /proc) are excluded from export.
 */

import type { VfsLike } from '../vfs/vfs-like.js';
import type { ExportStateOptions, ImportStateOptions, SerializedState } from './types.js';

/** Encode bytes to base64 (works in both Node and browser). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** Decode base64 to bytes (works in both Node and browser). */
function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Magic bytes identifying a serialized state blob. */
const MAGIC = new Uint8Array([0x57, 0x53, 0x4e, 0x44]); // "WSND"

/** Current format version. */
const FORMAT_VERSION = 2;

/** Header size for v1: 4 bytes magic + 4 bytes version. */
const HEADER_SIZE_V1 = 8;

/** Header size for v2: 4 bytes magic + 4 bytes version + 4 bytes CRC32. */
const HEADER_SIZE_V2 = 12;

/** Paths whose subtrees are virtual providers and must not be serialized. */
const EXCLUDED_PREFIXES = ['/dev', '/proc'];

/** Paths that may be written during import. Entries outside these are silently skipped. */
const SAFE_IMPORT_PREFIXES = ['/home', '/tmp', '/usr/lib/python', '/usr/share/pkg'];

/** Normalize a path (resolve . and ..) and check it falls under a safe prefix. */
function isSafeImportPath(rawPath: string): boolean {
  const segments: string[] = [];
  for (const part of rawPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); }
    else { segments.push(part); }
  }
  const normalized = '/' + segments.join('/');
  return SAFE_IMPORT_PREFIXES.some(
    prefix => normalized === prefix || normalized.startsWith(prefix + '/')
  );
}

function mayContainSafeImportPath(rawPath: string): boolean {
  const segments: string[] = [];
  for (const part of rawPath.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { segments.pop(); }
    else { segments.push(part); }
  }
  const normalized = '/' + segments.join('/');
  if (isSafeImportPath(normalized)) return true;
  return SAFE_IMPORT_PREFIXES.some(
    prefix => normalized === '/' || prefix === normalized || prefix.startsWith(normalized + '/')
  );
}

// ---- CRC32 implementation ----

/** Pre-computed CRC32 lookup table (IEEE polynomial). */
const CRC32_TABLE = new Uint32Array(256);
{
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    CRC32_TABLE[i] = c;
  }
}

/** Compute CRC32 checksum of a Uint8Array. */
function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.byteLength; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Export the full VFS state (files + directories) and optional env vars
 * into a self-describing binary blob.
 */
export function exportState(
  vfs: VfsLike,
  env?: Map<string, string>,
  excludePathsOrOptions?: string[] | ExportStateOptions,
): Uint8Array {
  const includeBase = !Array.isArray(excludePathsOrOptions) && excludePathsOrOptions?.includeBase === true;
  const excludePaths = Array.isArray(excludePathsOrOptions) ? excludePathsOrOptions : undefined;
  const files: SerializedState['files'] = [];
  const exportedVfs = includeBase ? vfs : (vfs.exportUpperVfs?.() ?? vfs);
  walkTree(exportedVfs, '/', files, excludePaths ?? EXCLUDED_PREFIXES);

  const state: SerializedState = {
    version: FORMAT_VERSION,
    files,
  };
  if (includeBase) {
    state.includeBase = true;
  }
  const overlay = includeBase ? undefined : vfs.exportOverlayState?.();
  if (overlay) {
    state.overlay = overlay;
  }

  if (env && env.size > 0) {
    state.env = Array.from(env);
  }

  const json = JSON.stringify(state);
  const jsonBytes = new TextEncoder().encode(json);

  // Compute CRC32 of the JSON payload
  const checksum = crc32(jsonBytes);

  const blob = new Uint8Array(HEADER_SIZE_V2 + jsonBytes.byteLength);

  // Write magic
  blob.set(MAGIC, 0);

  // Write version (little-endian uint32)
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  view.setUint32(4, FORMAT_VERSION, true);

  // Write CRC32 checksum (little-endian uint32)
  view.setUint32(8, checksum, true);

  // Write JSON payload
  blob.set(jsonBytes, HEADER_SIZE_V2);

  return blob;
}

/**
 * Import a previously exported state blob into a VFS.
 *
 * Directories are created first (via mkdirp), then files are written.
 * All mutations go through `vfs.withWriteAccess()` to bypass read-only
 * path restrictions.
 *
 * Returns the restored environment map if one was stored in the blob.
 */
export function importState(
  vfs: VfsLike,
  blob: Uint8Array,
  options: ImportStateOptions = {},
): { env?: Map<string, string> } {
  if (blob.byteLength < HEADER_SIZE_V1) {
    throw new Error('Invalid state blob: too short');
  }

  // Validate magic
  for (let i = 0; i < MAGIC.length; i++) {
    if (blob[i] !== MAGIC[i]) {
      throw new Error('Invalid state blob: bad magic bytes');
    }
  }

  // Read version
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const version = view.getUint32(4, true);

  let jsonBytes: Uint8Array;

  if (version === 2) {
    // v2: validate CRC32 checksum
    if (blob.byteLength < HEADER_SIZE_V2) {
      throw new Error('Invalid state blob: too short for v2');
    }
    const storedChecksum = view.getUint32(8, true);
    jsonBytes = blob.subarray(HEADER_SIZE_V2);
    const computedChecksum = crc32(jsonBytes);
    if (storedChecksum !== computedChecksum) {
      throw new Error('State blob checksum mismatch: data may be corrupted');
    }
  } else if (version === 1) {
    // v1: no checksum (backwards compat)
    jsonBytes = blob.subarray(HEADER_SIZE_V1);
  } else {
    throw new Error(`Unsupported state version: ${version}`);
  }

  // Parse JSON payload
  const json = new TextDecoder().decode(jsonBytes);
  const state: SerializedState = JSON.parse(json);

  if (state.overlay && !vfs.importOverlayState) {
    throw new Error('State blob contains overlay state, but target VFS does not support overlays');
  }

  const allowSystemPaths = options.allowSystemPaths === true;

  if (state.overlay) {
    const whiteouts = allowSystemPaths
      ? state.overlay.whiteouts
      : [
        ...(vfs.exportOverlayState?.().whiteouts.filter(path => !isSafeImportPath(path)) ?? []),
        ...state.overlay.whiteouts.filter(isSafeImportPath),
      ];
    vfs.importOverlayState!({ ...state.overlay, whiteouts });
  }

  const targetVfs = state.overlay ? (vfs.exportUpperVfs?.() ?? vfs) : vfs;

  const safeFiles = allowSystemPaths
    ? state.files
    : state.files.filter(entry => isSafeImportPath(entry.path));

  // Restore filesystem: directories first, then files, then permissions
  targetVfs.withWriteAccess(() => {
    for (const entry of safeFiles) {
      if (entry.type === 'dir') {
        targetVfs.mkdirp(entry.path);
      }
    }
    for (const entry of safeFiles) {
      if (entry.type === 'file') {
        const content = fromBase64(entry.data);
        targetVfs.writeFile(entry.path, content);
      } else if (entry.type === 'symlink') {
        targetVfs.symlink(entry.data, entry.path);
      }
    }
    for (const entry of safeFiles) {
      if (entry.type === 'symlink') continue;
      if ((entry.uid !== undefined || entry.gid !== undefined) && targetVfs.chown) {
        targetVfs.chown(entry.path, entry.uid ?? 0, entry.gid ?? 0);
      }
      if (entry.permissions !== undefined) {
        targetVfs.chmod(entry.path, entry.permissions);
      }
    }
  });

  // Restore env
  if (state.env) {
    return { env: new Map(state.env) };
  }

  return {};
}

/**
 * Recursively walk the VFS tree starting at `dirPath`, collecting
 * file and directory entries. Skips excluded virtual provider paths.
 */
function walkTree(
  vfs: VfsLike,
  dirPath: string,
  out: SerializedState['files'],
  excludePrefixes: string[],
): void {
  const entries = vfs.readdir(dirPath);

  for (const entry of entries) {
    const childPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;

    // Skip virtual provider subtrees
    if (excludePrefixes.some(prefix => childPath === prefix || childPath.startsWith(prefix + '/'))) {
      continue;
    }

    if (entry.type === 'dir') {
      if (!mayContainSafeImportPath(childPath)) continue;
      const st = vfs.stat(childPath);
      if (isSafeImportPath(childPath)) {
        out.push({ path: childPath, data: '', type: 'dir', permissions: st.permissions, uid: st.uid, gid: st.gid });
      }
      walkTree(vfs, childPath, out, excludePrefixes);
    } else if (entry.type === 'file') {
      if (!isSafeImportPath(childPath)) continue;
      const content = vfs.readFile(childPath);
      const st = vfs.stat(childPath);
      const b64 = toBase64(content);
      out.push({ path: childPath, data: b64, type: 'file', permissions: st.permissions, uid: st.uid, gid: st.gid });
    } else if (entry.type === 'symlink') {
      if (!isSafeImportPath(childPath)) continue;
      const st = vfs.lstat(childPath);
      out.push({
        path: childPath,
        data: vfs.readlink(childPath),
        type: 'symlink',
        permissions: st.permissions,
        uid: st.uid,
        gid: st.gid,
      });
    }
  }
}
