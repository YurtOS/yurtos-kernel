import type { DirEntry, StatResult } from "./vfs/inode.js";
import type { VfsLike } from "./vfs/vfs-like.js";

const BLOCK_SIZE = 512;
const text = new TextEncoder();
const VIRTUAL_PREFIXES = ["/dev", "/proc"];

export interface ExportTarOptions {
  skipPrefixes?: string[];
}

export async function exportVfsToYurtImage(
  vfs: VfsLike,
  options: ExportTarOptions = {},
): Promise<Uint8Array> {
  return await zstdCompress(await exportVfsToTar(vfs, options));
}

export async function exportVfsToTar(
  vfs: VfsLike,
  options: ExportTarOptions = {},
): Promise<Uint8Array> {
  let tar: Uint8Array = new Uint8Array();
  vfs.withWriteAccess(() => {
    const skipPrefixes = new Set([
      ...VIRTUAL_PREFIXES,
      ...(vfs.getProviderPaths?.() ?? []),
      ...(options.skipPrefixes ?? []),
    ].map(normalizePath));
    const chunks: Uint8Array[] = [];

    for (const path of walk(vfs, skipPrefixes)) {
      const stat = vfs.lstat(path);
      if (stat.type === "dir") {
        chunks.push(tarEntry(path, stat, new Uint8Array(), "5"));
      } else if (stat.type === "symlink") {
        chunks.push(
          tarEntry(path, stat, new Uint8Array(), "2", vfs.readlink(path)),
        );
      } else {
        chunks.push(tarEntry(path, stat, vfs.readFile(path), "0"));
      }
    }

    chunks.push(new Uint8Array(BLOCK_SIZE * 2));
    tar = concat(chunks);
  });
  return tar;
}

function walk(vfs: VfsLike, skipPrefixes: Set<string>): string[] {
  const out: string[] = [];

  function visit(path: string): void {
    if (isSkipped(path, skipPrefixes)) return;

    const stat = vfs.lstat(path);
    if (path !== "/") out.push(path);
    if (stat.type !== "dir") return;

    const entries = vfs.readdir(path)
      .filter((entry: DirEntry) =>
        !isSkipped(joinPath(path, entry.name), skipPrefixes)
      )
      .sort((a, b) => compareCodepoint(a.name, b.name));
    for (const entry of entries) visit(joinPath(path, entry.name));
  }

  visit("/");
  return out;
}

function isSkipped(path: string, skipPrefixes: Set<string>): boolean {
  const normalized = normalizePath(path);
  for (const prefix of skipPrefixes) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

function joinPath(parent: string, name: string): string {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}

function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function tarEntry(
  path: string,
  stat: StatResult,
  data: Uint8Array,
  type: "0" | "2" | "5",
  linkname = "",
): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  const { name, prefix } = splitTarPath(path, type);
  const size = type === "0" ? data.byteLength : 0;
  header.set(stringField(name, 100), 0);
  header.set(octal(stat.permissions, 8), 100);
  header.set(octal(stat.uid, 8), 108);
  header.set(octal(stat.gid, 8), 116);
  header.set(octal(size, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(stringField(linkname, 100), 157);
  header.set(stringField("ustar", 6), 257);
  header.set(stringField("00", 2), 263);
  header.set(stringField(prefix, 155), 345);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.set(octal(sum, 8), 148);

  if (size === 0) return header;

  const padded = pad512(data);
  const out = new Uint8Array(BLOCK_SIZE + padded.byteLength);
  out.set(header, 0);
  out.set(padded, BLOCK_SIZE);
  return out;
}

function splitTarPath(path: string, type: "0" | "2" | "5"): {
  name: string;
  prefix: string;
} {
  const relative = normalizePath(path).slice(1) + (type === "5" ? "/" : "");
  if (text.encode(relative).byteLength <= 100) {
    return { name: relative, prefix: "" };
  }

  const parts = relative.split("/");
  for (let i = parts.length - 1; i > 0; i--) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (
      text.encode(prefix).byteLength <= 155 &&
      text.encode(name).byteLength <= 100
    ) {
      return { name, prefix };
    }
  }

  throw new Error(`tar path too long: ${path}`);
}

function stringField(value: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(text.encode(value).subarray(0, width));
  return out;
}

function octal(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(
    text.encode(Math.trunc(value).toString(8).padStart(width - 1, "0") + "\0")
      .subarray(0, width),
  );
  return out;
}

function pad512(bytes: Uint8Array): Uint8Array {
  const paddedSize = Math.ceil(bytes.byteLength / BLOCK_SIZE) * BLOCK_SIZE;
  const out = new Uint8Array(paddedSize);
  out.set(bytes, 0);
  return out;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function zstdCompress(bytes: Uint8Array): Promise<Uint8Array> {
  const { zstdCompress } = await import("node:zlib");
  return new Promise((resolve, reject) => {
    zstdCompress(bytes, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(result));
    });
  });
}
