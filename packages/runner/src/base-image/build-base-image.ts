import { createHash } from "node:crypto";
import {
  chmod,
  chown,
  copyFile,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const MANIFEST_PATH = "/etc/yurt/base-image.json";

export interface BaseImageFile {
  src: string;
  dest: string;
  uid?: number;
  gid?: number;
  mode?: number;
}

export interface BaseImageTool {
  name: string;
  path: string;
}

export interface BaseImageSymlink {
  target: string;
  link: string;
  uid?: number;
  gid?: number;
  mode?: number;
}

export interface BuildBaseImageOptions {
  outDir: string;
  dirs?: Array<{ path: string; uid?: number; gid?: number; mode?: number }>;
  files: BaseImageFile[];
  symlinks?: BaseImageSymlink[];
  tools?: BaseImageTool[];
}

export interface BaseImageManifest {
  version: 1;
  id: string;
  files: Array<
    {
      path: string;
      type: "file" | "dir" | "symlink";
      uid: number;
      gid: number;
      mode: number;
      target?: string;
    }
  >;
  tools: BaseImageTool[];
}

type BaseImageManifestEntry = BaseImageManifest["files"][number];

function validateBasePath(path: string, kind: string): void {
  const parts = path.split("/").filter(Boolean);
  if (!path.startsWith("/") || parts.includes("..")) {
    throw new Error(`invalid base image ${kind}: ${path}`);
  }
  for (const part of parts) {
    if (part === ".") {
      throw new Error(`invalid base image ${kind}: ${path}`);
    }
  }
}

function parentDirs(path: string): string[] {
  const parts = dirname(path).split("/").filter(Boolean);
  const dirs = ["/"];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    dirs.push(current);
  }
  return dirs;
}

async function chownIfAllowed(
  path: string,
  uid: number,
  gid: number,
): Promise<void> {
  try {
    await chown(path, uid, gid);
  } catch {
    // The manifest is authoritative when local development cannot chown.
  }
}

async function materializeDir(
  root: string,
  path: string,
  entries: Map<string, BaseImageManifestEntry>,
  metadata: { uid?: number; gid?: number; mode?: number } = {},
  explicit = false,
): Promise<void> {
  if (entries.has(path) && !explicit) return;

  const uid = metadata.uid ?? 0;
  const gid = metadata.gid ?? 0;
  const mode = metadata.mode ?? 0o755;
  const hostPath = join(root, `.${path}`);

  await mkdir(hostPath, { recursive: true });
  await chmod(hostPath, mode);
  await chownIfAllowed(hostPath, uid, gid);

  entries.set(path, { path, type: "dir", uid, gid, mode });
}

async function copyFileEntry(
  root: string,
  file: BaseImageFile,
  entries: Map<string, BaseImageManifestEntry>,
): Promise<void> {
  validateBasePath(file.dest, "destination");
  for (const dir of parentDirs(file.dest)) {
    await materializeDir(root, dir, entries);
  }

  const uid = file.uid ?? 0;
  const gid = file.gid ?? 0;
  const mode = file.mode ?? 0o644;
  const hostPath = join(root, `.${file.dest}`);

  await copyFile(file.src, hostPath);
  await chmod(hostPath, mode);
  await chownIfAllowed(hostPath, uid, gid);

  entries.set(file.dest, { path: file.dest, type: "file", uid, gid, mode });
}

async function createSymlinkEntry(
  root: string,
  link: BaseImageSymlink,
  entries: Map<string, BaseImageManifestEntry>,
): Promise<void> {
  validateBasePath(link.link, "symlink");
  if (!link.target) {
    throw new Error(`invalid base image symlink target: ${link.link}`);
  }
  for (const dir of parentDirs(link.link)) {
    await materializeDir(root, dir, entries);
  }

  const uid = link.uid ?? 0;
  const gid = link.gid ?? 0;
  const mode = link.mode ?? 0o777;
  const hostPath = join(root, `.${link.link}`);

  await symlink(link.target, hostPath);
  entries.set(link.link, {
    path: link.link,
    type: "symlink",
    uid,
    gid,
    mode,
    target: link.target,
  });
}

async function computeId(
  root: string,
  entries: BaseImageManifestEntry[],
  tools: BaseImageTool[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update(JSON.stringify({
      type: entry.type,
      uid: entry.uid,
      gid: entry.gid,
      mode: entry.mode,
    }));
    if (entry.type === "file") {
      if (entry.path === MANIFEST_PATH) continue;
      hash.update(await readFile(join(root, `.${entry.path}`)));
    }
    if (entry.type === "symlink") hash.update(entry.target ?? "");
  }
  hash.update(JSON.stringify(tools));
  return hash.digest("hex");
}

export async function buildBaseImage(
  options: BuildBaseImageOptions,
): Promise<BaseImageManifest> {
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });

  const entries = new Map<string, BaseImageManifestEntry>();
  for (const dir of options.dirs ?? []) {
    validateBasePath(dir.path, "directory");
    for (const parent of parentDirs(`${dir.path}/.keep`).slice(0, -1)) {
      await materializeDir(options.outDir, parent, entries);
    }
    await materializeDir(options.outDir, dir.path, entries, dir, true);
  }

  for (const file of options.files) {
    await copyFileEntry(options.outDir, file, entries);
  }

  for (const link of options.symlinks ?? []) {
    await createSymlinkEntry(options.outDir, link, entries);
  }

  await materializeDir(options.outDir, "/etc", entries);
  await materializeDir(options.outDir, "/etc/yurt", entries);
  entries.set(MANIFEST_PATH, {
    path: MANIFEST_PATH,
    type: "file",
    uid: 0,
    gid: 0,
    mode: 0o644,
  });

  const sortedEntries = Array.from(entries.values())
    .sort((a, b) => a.path.localeCompare(b.path));
  const tools = options.tools ?? [];
  const manifest: BaseImageManifest = {
    version: 1,
    id: await computeId(options.outDir, sortedEntries, tools),
    files: sortedEntries,
    tools,
  };

  await writeFile(
    join(options.outDir, `.${MANIFEST_PATH}`),
    JSON.stringify(manifest, null, 2),
  );
  await chmod(join(options.outDir, `.${MANIFEST_PATH}`), 0o644);
  await chownIfAllowed(join(options.outDir, `.${MANIFEST_PATH}`), 0, 0);

  return manifest;
}
