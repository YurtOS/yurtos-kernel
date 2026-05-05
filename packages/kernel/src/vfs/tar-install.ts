import { VfsError } from "./inode.ts";
import type { VFS } from "./vfs.ts";

export interface ApplyTarOptions {
  /**
   * Absolute destination prefix. Tar entry names are resolved under this root.
   * Defaults to '/'.
   */
  root?: string;
}

interface TarHeader {
  path: string;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  size: number;
  linkname: string;
}

const BLOCK_SIZE = 512;
const decoder = new TextDecoder();

export function applyTarToVfs(
  vfs: VFS,
  archive: Uint8Array,
  options: ApplyTarOptions = {},
): void {
  const root = normalizeInstallPath(options.root ?? "/");
  const hardlinks: Array<{ from: string; to: string }> = [];
  let offset = 0;

  vfs.withWriteAccess(() => {
    while (offset + BLOCK_SIZE <= archive.byteLength) {
      const block = archive.subarray(offset, offset + BLOCK_SIZE);
      offset += BLOCK_SIZE;
      if (isZeroBlock(block)) break;

      const header = readHeader(block);
      const path = resolveTarPath(root, header.path);
      const data = archive.subarray(offset, offset + header.size);
      offset += Math.ceil(header.size / BLOCK_SIZE) * BLOCK_SIZE;

      switch (header.type) {
        case "":
        case "0":
          ensureParent(vfs, path);
          vfs.writeFile(path, data.slice(), header.mode);
          vfs.chown(path, header.uid, header.gid);
          vfs.chmod(path, header.mode);
          break;
        case "5":
          vfs.mkdirp(path);
          vfs.chown(path, header.uid, header.gid);
          vfs.chmod(path, header.mode);
          break;
        case "2":
          ensureParent(vfs, path);
          vfs.symlink(header.linkname, path);
          vfs.chown(path, header.uid, header.gid, false);
          break;
        case "1":
          hardlinks.push({
            from: resolveTarPath(root, header.linkname),
            to: path,
          });
          break;
        default:
          throw new VfsError(
            "EACCES",
            `unsupported tar entry type ${header.type}`,
          );
      }
    }

    for (const link of hardlinks) {
      ensureParent(vfs, link.to);
      vfs.link(link.from, link.to);
    }
  });
}

function readHeader(block: Uint8Array): TarHeader {
  const path = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  const fullPath = prefix ? `${prefix}/${path}` : path;
  return {
    path: fullPath,
    mode: readOctal(block, 100, 8) || 0o644,
    uid: readOctal(block, 108, 8),
    gid: readOctal(block, 116, 8),
    size: readOctal(block, 124, 12),
    type: readString(block, 156, 1),
    linkname: readString(block, 157, 100),
  };
}

function readString(block: Uint8Array, start: number, length: number): string {
  const field = block.subarray(start, start + length);
  const end = field.indexOf(0);
  return decoder.decode(end >= 0 ? field.subarray(0, end) : field).trimEnd();
}

function readOctal(block: Uint8Array, start: number, length: number): number {
  const raw = readString(block, start, length).trim();
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 8);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function ensureParent(vfs: VFS, path: string): void {
  const parent = path.replace(/\/[^/]*$/, "") || "/";
  vfs.mkdirp(parent);
}

function normalizeInstallPath(path: string): string {
  if (!path.startsWith("/")) path = `/${path}`;
  return resolveTarPath("/", path);
}

function resolveTarPath(root: string, entryPath: string): string {
  if (!entryPath) throw new VfsError("ENOENT", "empty tar entry path");
  const pieces = `${root}/${entryPath}`
    .split("/")
    .filter((piece) => piece.length > 0 && piece !== ".");
  const normalized: string[] = [];
  for (const piece of pieces) {
    if (piece === "..") {
      throw new VfsError(
        "EACCES",
        `tar entry escapes install root: ${entryPath}`,
      );
    }
    normalized.push(piece);
  }
  return `/${normalized.join("/")}`;
}
