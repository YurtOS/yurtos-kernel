import { type DirEntry, VfsError } from "./inode.ts";
import { sha256Hex } from "../process/module-cache.ts";
import type { RootProvider, RootProviderStat } from "./root-provider.ts";

const BLOCK_SIZE = 512;
const decoder = new TextDecoder();

export interface TarImageRootProviderOptions {
  id: string;
  image: Uint8Array;
  index?: TarImageIndex;
}

export interface TarImageIndex {
  imageSha256: string;
  entries: Record<string, TarImageEntry>;
}

export type TarImageEntry =
  | { type: "dir"; mode: number; uid: number; gid: number; mtime: number }
  | {
    type: "file";
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    offset: number;
    size: number;
  }
  | {
    type: "symlink";
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    target: string;
  }
  | {
    type: "hardlink";
    mode: number;
    uid: number;
    gid: number;
    mtime: number;
    target: string;
  };

interface RawTarHeader {
  path: string;
  type: string;
  mode: number;
  uid: number;
  gid: number;
  mtime: number;
  size: number;
  linkname: string;
}

export class TarImageRootProvider implements RootProvider {
  readonly id: string;
  private readonly image: Uint8Array;
  private readonly index: TarImageIndex;

  constructor(options: TarImageRootProviderOptions) {
    this.id = options.id;
    this.image = options.image;
    this.index = options.index ?? buildTarImageIndexSync(options.image);
  }

  readFile(path: string): Uint8Array {
    const entry = this.resolveFileEntry(path);
    return this.image.slice(entry.offset, entry.offset + entry.size);
  }

  stat(path: string): RootProviderStat {
    const resolved = this.resolveSymlinkWithPath(normalizeImagePath(path));
    return this.toStat(resolved.entry, resolved.path);
  }

  lstat(path: string): RootProviderStat {
    const normalized = normalizeImagePath(path);
    return this.toStat(this.lookup(normalized), normalized);
  }

  readdir(path: string): DirEntry[] {
    const normalized = normalizeImagePath(path);
    const entry = this.lookup(normalized);
    if (entry.type !== "dir") {
      throw new VfsError("ENOTDIR", `not a directory: ${path}`);
    }

    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entries = new Map<string, DirEntry>();
    for (const candidate of Object.keys(this.index.entries)) {
      if (candidate === normalized || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      const child = this.index.entries[candidate];
      entries.set(rest, {
        name: rest,
        type: child.type === "dir"
          ? "dir"
          : child.type === "symlink"
          ? "symlink"
          : "file",
      });
    }
    return Array.from(entries.values());
  }

  readlink(path: string): string {
    const entry = this.lookup(normalizeImagePath(path));
    if (entry.type !== "symlink") {
      throw new VfsError("ENOENT", `not a symlink: ${path}`);
    }
    return entry.target;
  }

  private lookup(path: string): TarImageEntry {
    const entry = this.index.entries[path];
    if (!entry) throw new VfsError("ENOENT", `no such path: ${path}`);
    return entry;
  }

  private resolveFileEntry(
    path: string,
  ): Extract<TarImageEntry, { type: "file" }> {
    const entry = this.resolveSymlink(normalizeImagePath(path));
    if (entry.type === "file") return entry;
    if (entry.type === "hardlink") return this.resolveHardlink(entry);
    if (entry.type === "dir") {
      throw new VfsError("EISDIR", `is a directory: ${path}`);
    }
    throw new VfsError("EACCES", `unresolved symlink: ${path}`);
  }

  private resolveSymlink(
    path: string,
    seen = new Set<string>(),
  ): TarImageEntry {
    return this.resolveSymlinkWithPath(path, seen).entry;
  }

  private resolveSymlinkWithPath(
    path: string,
    seen = new Set<string>(),
  ): { path: string; entry: TarImageEntry } {
    const entry = this.lookup(path);
    if (entry.type !== "symlink") return { path, entry };
    if (seen.has(path)) throw new VfsError("EACCES", `symlink loop: ${path}`);
    seen.add(path);
    return this.resolveSymlinkWithPath(resolveLinkTarget(path, entry.target), seen);
  }

  private resolveHardlink(
    entry: Extract<TarImageEntry, { type: "hardlink" }>,
  ): Extract<TarImageEntry, { type: "file" }> {
    const target = this.lookup(normalizeImagePath(entry.target));
    if (target.type !== "file") {
      throw new VfsError(
        "ENOENT",
        `hardlink target is not a file: ${entry.target}`,
      );
    }
    return target;
  }

  private toStat(entry: TarImageEntry, path: string): RootProviderStat {
    const fileEntry = entry.type === "hardlink"
      ? this.resolveHardlink(entry)
      : undefined;
    const size = entry.type === "dir"
      ? this.childCount(path)
      : entry.type === "file"
      ? entry.size
      : entry.type === "hardlink"
      ? fileEntry!.size
      : entry.target.length;
    const date = new Date(entry.mtime * 1000);
    return {
      type: entry.type === "dir"
        ? "dir"
        : entry.type === "symlink"
        ? "symlink"
        : "file",
      size,
      permissions: entry.mode,
      uid: entry.uid,
      gid: entry.gid,
      mtime: date,
      ctime: date,
      atime: date,
    };
  }

  private childCount(path: string): number {
    const prefix = path === "/" ? "/" : `${path}/`;
    let count = 0;
    for (const candidate of Object.keys(this.index.entries)) {
      if (candidate === path || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest && !rest.includes("/")) count++;
    }
    return count;
  }
}

export async function buildTarImageIndex(
  image: Uint8Array,
): Promise<TarImageIndex> {
  const index = buildTarImageIndexSync(image);
  return { ...index, imageSha256: await sha256Hex(image) };
}

function buildTarImageIndexSync(image: Uint8Array): TarImageIndex {
  const entries: Record<string, TarImageEntry> = {
    "/": { type: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0 },
  };
  let offset = 0;
  while (offset + BLOCK_SIZE <= image.byteLength) {
    const block = image.subarray(offset, offset + BLOCK_SIZE);
    offset += BLOCK_SIZE;
    if (isZeroBlock(block)) break;

    const header = readHeader(block);
    const path = normalizeTarEntryPath(header.path);
    const dataOffset = offset;
    offset += Math.ceil(header.size / BLOCK_SIZE) * BLOCK_SIZE;
    const common = {
      mode: header.mode,
      uid: header.uid,
      gid: header.gid,
      mtime: header.mtime,
    };
    addEntry(entries, path, toEntry(header, dataOffset, common));
  }
  validateHardlinks(entries);
  return { imageSha256: "unhashed", entries };
}

function toEntry(
  header: RawTarHeader,
  offset: number,
  common: { mode: number; uid: number; gid: number; mtime: number },
): TarImageEntry {
  switch (header.type) {
    case "":
    case "0":
      return { type: "file", ...common, offset, size: header.size };
    case "5":
      return { type: "dir", ...common };
    case "2":
      return { type: "symlink", ...common, target: header.linkname };
    case "1":
      return {
        type: "hardlink",
        ...common,
        target: normalizeTarEntryPath(header.linkname),
      };
    default:
      throw new VfsError("EACCES", `unsupported tar entry type ${header.type}`);
  }
}

function readHeader(block: Uint8Array): RawTarHeader {
  const path = readString(block, 0, 100);
  const prefix = readString(block, 345, 155);
  return {
    path: prefix ? `${prefix}/${path}` : path,
    mode: readOctal(block, 100, 8) || 0o644,
    uid: readOctal(block, 108, 8),
    gid: readOctal(block, 116, 8),
    size: readOctal(block, 124, 12),
    mtime: readOctal(block, 136, 12),
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

function normalizeImagePath(path: string): string {
  if (!path) throw new VfsError("ENOENT", "empty image path");
  const pieces = path.split("/").filter((piece) =>
    piece.length > 0 && piece !== "."
  );
  const normalized: string[] = [];
  for (const piece of pieces) {
    if (piece === "..") {
      if (normalized.length === 0) {
        throw new VfsError("EACCES", `path escapes image root: ${path}`);
      }
      normalized.pop();
    } else {
      normalized.push(piece);
    }
  }
  return normalized.length === 0 ? "/" : `/${normalized.join("/")}`;
}

function normalizeTarEntryPath(path: string): string {
  if (!path) throw new VfsError("ENOENT", "empty tar entry path");
  const pieces = path.split("/").filter((piece) =>
    piece.length > 0 && piece !== "."
  );
  const normalized: string[] = [];
  for (const piece of pieces) {
    if (piece === "..") {
      throw new VfsError("EACCES", `tar entry escapes image root: ${path}`);
    }
    normalized.push(piece);
  }
  return normalized.length === 0 ? "/" : `/${normalized.join("/")}`;
}

function resolveLinkTarget(path: string, target: string): string {
  if (target.startsWith("/")) return normalizeImagePath(target);
  const parent = path.replace(/\/[^/]*$/, "") || "/";
  return normalizeImagePath(`${parent}/${target}`);
}

function addEntry(
  entries: Record<string, TarImageEntry>,
  path: string,
  entry: TarImageEntry,
): void {
  if (path === "/") throw new VfsError("EEXIST", "tar entry duplicates root");
  if (entries[path]) {
    throw new VfsError("EEXIST", `duplicate tar entry: ${path}`);
  }
  ensureImplicitParents(entries, path);
  entries[path] = entry;
}

function ensureImplicitParents(
  entries: Record<string, TarImageEntry>,
  path: string,
): void {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts.slice(0, -1)) {
    current = `${current}/${part}`;
    const existing = entries[current];
    if (!existing) {
      entries[current] = { type: "dir", mode: 0o755, uid: 0, gid: 0, mtime: 0 };
    } else if (existing.type !== "dir") {
      throw new VfsError(
        "ENOTDIR",
        `tar parent is not a directory: ${current}`,
      );
    }
  }
}

function validateHardlinks(entries: Record<string, TarImageEntry>): void {
  for (const entry of Object.values(entries)) {
    if (entry.type !== "hardlink") continue;
    const target = entries[normalizeImagePath(entry.target)];
    if (!target || target.type !== "file") {
      throw new VfsError(
        "ENOENT",
        `hardlink target is not a file: ${entry.target}`,
      );
    }
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}
