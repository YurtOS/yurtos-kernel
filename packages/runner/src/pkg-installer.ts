/**
 * Host-side yurtpkg extractor.
 *
 * In the eventual kernel.wasm architecture, this split matters:
 *   - Loading a tar as a read-only L1 VFS layer is kernel-land (→ kernel.wasm).
 *   - File format extraction (zstd, tar walk) and calling VFS write ops is host-land.
 *
 * This module is the host-land half: it decompresses a yurtpkg archive and
 * materialises its contents into a writable VFS by calling writeFile / mkdir /
 * symlink / link directly.  The kernel VFS is the authority on what lands in
 * the sandbox filesystem; this code is the transport that hands each entry over.
 */

import type { VfsLike } from "./vfs/vfs-like.js";

const BLOCK_SIZE = 512;
const decoder = new TextDecoder();

/**
 * Decompress and install a yurtpkg archive (zstd-compressed tar) into `vfs`.
 *
 * The `info/` metadata subtree is intentionally omitted — it is package-manager
 * data (checksums, dependency graph) that the VFS doesn't need.
 */
export async function installYurtPackage(
  bytes: Uint8Array,
  vfs: VfsLike,
): Promise<void> {
  const tar = await decompressYurtPkg(bytes);
  installYurtPackageTar(tar, vfs);
}

/**
 * Install a raw (uncompressed) yurtpkg tar into `vfs`.
 *
 * Called by installYurtPackage after decompression, or directly by callers
 * that already hold the decompressed bytes (e.g. test fixtures).
 */
export function installYurtPackageTar(
  tarBytes: Uint8Array,
  vfs: VfsLike,
): void {
  // Map VFS paths → their data so we can resolve hardlinks in-order.
  const fileData = new Map<string, Uint8Array>();

  let offset = 0;
  vfs.withWriteAccess(() => {
    while (offset + BLOCK_SIZE <= tarBytes.byteLength) {
      const block = tarBytes.subarray(offset, offset + BLOCK_SIZE);
      offset += BLOCK_SIZE;
      if (isZeroBlock(block)) break;

      const header = readHeader(block);
      const dataOffset = offset;
      offset += Math.ceil(header.size / BLOCK_SIZE) * BLOCK_SIZE;

      // info/ subtree is package-manager metadata — not VFS content.
      if (header.path === "info" || header.path.startsWith("info/")) continue;

      const rawPath = validatePath(header.path);
      if (!rawPath) continue; // root dir entry — skip
      const vfsPath = `/${rawPath}`;

      switch (header.type) {
        case "":
        case "0": {
          const data = tarBytes.slice(dataOffset, dataOffset + header.size);
          ensureParent(vfs, vfsPath);
          vfs.writeFile(vfsPath, data, header.mode & 0o7777);
          vfs.chown(vfsPath, header.uid, header.gid);
          fileData.set(vfsPath, data);
          break;
        }
        case "5": {
          try {
            vfs.mkdirp(vfsPath);
          } catch {
            // already exists — fine
          }
          vfs.chmod(vfsPath, header.mode & 0o7777);
          vfs.chown(vfsPath, header.uid, header.gid);
          break;
        }
        case "2": {
          ensureParent(vfs, vfsPath);
          try {
            vfs.unlink(vfsPath);
          } catch {
            // not present — fine
          }
          vfs.symlink(header.linkname, vfsPath);
          break;
        }
        case "1": {
          // hardlink — target path is stored relative to archive root
          const targetRaw = validatePath(header.linkname);
          if (!targetRaw) break;
          const targetVfs = `/${targetRaw}`;
          ensureParent(vfs, vfsPath);
          if (vfs.link) {
            vfs.link(targetVfs, vfsPath);
          } else {
            // VfsProxy doesn't support link yet — fall back to a copy.
            const data = fileData.get(targetVfs);
            if (!data) {
              throw new Error(
                `pkg-installer: hardlink target not yet extracted: ${targetVfs}`,
              );
            }
            vfs.writeFile(vfsPath, data, header.mode & 0o7777);
            vfs.chown(vfsPath, header.uid, header.gid);
          }
          break;
        }
          // char/block devices, fifos, sockets — not meaningful inside a sandbox.
      }
    }
  });
}

/**
 * Decompress a zstd-compressed yurtpkg archive.  Tries the browser
 * DecompressionStream API first, falls back to node:zlib on Node/Deno.
 */
export async function decompressYurtPkg(
  bytes: Uint8Array,
): Promise<Uint8Array> {
  const native = await tryDecompressStream(bytes);
  if (native) return native;

  const { zstdDecompress } = await import("node:zlib");
  return new Promise((resolve, reject) => {
    zstdDecompress(bytes, (err, result) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(new Uint8Array(result));
    });
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ensureParent(vfs: VfsLike, absPath: string): void {
  const slash = absPath.lastIndexOf("/");
  const parent = slash <= 0 ? "/" : absPath.slice(0, slash);
  if (parent !== "/") vfs.mkdirp(parent);
}

/**
 * Validate and normalise a raw tar path.
 * Returns the normalised relative string (no leading slash) or null for root.
 * Throws for absolute paths and traversal attempts.
 */
function validatePath(raw: string): string | null {
  if (raw.startsWith("/")) {
    throw new Error(`pkg-installer: absolute path in archive: ${raw}`);
  }
  const parts = raw.split("/").filter((p) => p && p !== ".");
  const normalized: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      throw new Error(`pkg-installer: path traversal in archive: ${raw}`);
    }
    normalized.push(part);
  }
  return normalized.length === 0 ? null : normalized.join("/");
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < BLOCK_SIZE; i++) {
    if (block[i] !== 0) return false;
  }
  return true;
}

interface TarHeader {
  path: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  type: string;
  linkname: string;
}

function readHeader(block: Uint8Array): TarHeader {
  const name = readStr(block, 0, 100);
  const prefix = readStr(block, 345, 155);
  return {
    path: prefix ? `${prefix}/${name}` : name,
    mode: readOct(block, 100, 8) || 0o644,
    uid: readOct(block, 108, 8),
    gid: readOct(block, 116, 8),
    size: readOct(block, 124, 12),
    type: readStr(block, 156, 1),
    linkname: readStr(block, 157, 100),
  };
}

function readStr(block: Uint8Array, start: number, len: number): string {
  const field = block.subarray(start, start + len);
  const end = field.indexOf(0);
  return decoder.decode(end >= 0 ? field.subarray(0, end) : field).trimEnd();
}

function readOct(block: Uint8Array, start: number, len: number): number {
  const raw = readStr(block, start, len).trim();
  if (!raw) return 0;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

async function tryDecompressStream(
  bytes: Uint8Array,
): Promise<Uint8Array | undefined> {
  if (typeof DecompressionStream !== "function") return undefined;
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream("zstd" as CompressionFormat);
  } catch {
    return undefined;
  }
  const writer = stream.writable.getWriter();
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  await writer.write(ab);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}
