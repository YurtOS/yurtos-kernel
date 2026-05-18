// Stage host-supplied files (mounts + image roots) into the Rust kernel's
// in-memory ramfs before any guest runs. The Rust kernel owns the VFS; the
// host only seeds bytes via KERNEL_REGISTER_FILE (KernelHostInterface.
// registerRamfsFile).

import type { KernelHostInterface } from "@yurt/kernel-host-interface-js";
import { s } from "@yurt/kernel-host-interface-js";
import { loadYurtImage } from "./image-loader.ts";
import { TarImageRootProvider } from "./vfs/tar-image-root-provider.ts";

export interface MountConfig {
  /** Absolute mount path inside the sandbox, e.g. "/fixtures". */
  path: string;
  /** file name → bytes. Staged at `${path}/${name}`. */
  files: Record<string, Uint8Array>;
}

function joinPath(dir: string, name: string): string {
  const d = dir.endsWith("/") ? dir.slice(0, -1) : dir;
  const n = name.startsWith("/") ? name.slice(1) : name;
  return `${d}/${n}`;
}

/**
 * Register every file from `mounts` into the kernel ramfs, also recording the
 * bytes in `host` so the Runner can resolve a program path to its module
 * bytes (the pure h/k interface spawns from bytes, not a kernel path).
 */
export function stageMounts(
  mk: KernelHostInterface,
  mounts: MountConfig[] | undefined,
  host: Map<string, Uint8Array>,
): void {
  if (!mounts) return;
  for (const m of mounts) {
    for (const [name, bytes] of Object.entries(m.files)) {
      const path = joinPath(m.path, name);
      mk.registerRamfsFile(s(path), bytes);
      host.set(path, bytes);
    }
  }
}

/**
 * Load a .yurtimg (or raw tar bytes) and stage every regular-file entry into
 * the kernel ramfs at its absolute path.
 */
export async function stageImage(
  mk: KernelHostInterface,
  image: string | Uint8Array | undefined,
  cacheDir: string | undefined,
  host: Map<string, Uint8Array>,
): Promise<void> {
  if (image === undefined) return;
  const loaded = await loadYurtImage(image, { cacheDir });
  const provider = new TarImageRootProvider({
    id: loaded.baseId,
    index: loaded.index,
    image: loaded.tarBytes,
  });
  for (const [path, entry] of Object.entries(loaded.index.entries)) {
    if (entry.type !== "file") continue;
    const bytes = provider.readFile(path);
    mk.registerRamfsFile(s(path), bytes);
    host.set(path, bytes);
  }
}
