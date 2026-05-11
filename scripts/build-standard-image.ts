#!/usr/bin/env -S deno run -A
/**
 * Fetch pre-built yurtpkg packages from YurtOS/yurt-packages and produce
 * a standard.yurtimg fixture used by Sandbox tests.
 *
 * Architecture note: package format extraction (zstd + tar walk) is host-land.
 * This script is the host.  It calls installYurtPackage() which walks tar
 * entries and writes files into a VFS, then exports the result as a yurtimg.
 *
 * Usage:
 *   deno run -A scripts/build-standard-image.ts
 *   YURT_PACKAGES_REF=main deno run -A scripts/build-standard-image.ts
 *
 * Output:
 *   test-fixtures/standard.yurtimg
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { VFS } from "../packages/kernel/src/vfs/vfs.js";
import { installYurtPackage } from "../packages/kernel/src/pkg-installer.js";
import { exportVfsToYurtImage } from "../packages/kernel/src/image-exporter.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(REPO_ROOT, "test-fixtures");
const OUT_IMG = resolve(OUT_DIR, "standard.yurtimg");
const CACHE_DIR = resolve(REPO_ROOT, "test-fixtures/.pkg-cache");

const PACKAGES_REF = Deno.env.get("YURT_PACKAGES_REF") ?? "main";
const PACKAGES_BASE =
  `https://raw.githubusercontent.com/YurtOS/yurt-packages/${PACKAGES_REF}`;

const PACKAGES = [
  {
    name: "busybox",
    version: "1.37.0",
    build: "yurt_0",
    path: "artifacts/busybox/1.37.0/busybox-1.37.0-yurt_0.yurtpkg",
  },
  {
    name: "pkg",
    version: "0.1.0",
    build: "yurt_0",
    path: "artifacts/pkg/0.1.0/pkg-0.1.0-yurt_0.yurtpkg",
  },
];

async function fetchOrCache(
  url: string,
  cacheKey: string,
): Promise<Uint8Array> {
  const cachePath = join(CACHE_DIR, cacheKey);
  if (existsSync(cachePath)) {
    console.log(`  cache hit: ${cacheKey}`);
    return new Uint8Array(readFileSync(cachePath));
  }
  console.log(`  fetching ${url}`);
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`fetch ${url} → HTTP ${resp.status}`);
  }
  const bytes = new Uint8Array(await resp.arrayBuffer());
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, bytes);
  return bytes;
}

async function main() {
  console.log("Building standard.yurtimg from pre-built yurtpkg packages...\n");

  const vfs = new VFS({ layout: "empty" });

  for (const pkg of PACKAGES) {
    const filename = `${pkg.name}-${pkg.version}-${pkg.build}.yurtpkg`;
    const url = `${PACKAGES_BASE}/${pkg.path}`;
    console.log(`Installing ${filename}`);

    const bytes = await fetchOrCache(url, filename);
    await installYurtPackage(bytes, vfs);
    console.log(`  OK`);
  }

  console.log("\nExporting standard.yurtimg...");
  const img = await exportVfsToYurtImage(vfs);
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_IMG, img);
  console.log(`  → ${OUT_IMG} (${(img.byteLength / 1024).toFixed(0)} KiB)\n`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  Deno.exit(1);
});
