import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { zstdCompress } from "node:zlib";
import { loadYurtImage } from "../image-loader.ts";

const enc = new TextEncoder();

function zstd(data: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zstdCompress(data, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(result));
    });
  });
}

function octal(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(
    enc.encode(value.toString(8).padStart(width - 1, "0") + "\0").subarray(
      0,
      width,
    ),
  );
  return out;
}

function stringField(value: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(enc.encode(value).subarray(0, width));
  return out;
}

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(stringField(name, 100), 0);
  header.set(octal(0o644, 8), 100);
  header.set(octal(0, 8), 108);
  header.set(octal(0, 8), 116);
  header.set(octal(data.byteLength, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.set(stringField("ustar", 6), 257);
  header.set(stringField("00", 2), 263);
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.set(octal(checksum, 8), 148);
  const paddedSize = Math.ceil(data.byteLength / 512) * 512;
  const out = new Uint8Array(512 + paddedSize);
  out.set(header, 0);
  out.set(data, 512);
  return out;
}

function tar(entries: Uint8Array[]): Uint8Array {
  const end = new Uint8Array(1024);
  const out = new Uint8Array(
    entries.reduce((sum, entry) => sum + entry.byteLength, 0) + end.byteLength,
  );
  let offset = 0;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.byteLength;
  }
  out.set(end, offset);
  return out;
}

describe("loadYurtImage", () => {
  it("decompresses .yurtimg zstd bytes into indexed tar bytes", async () => {
    const tarBytes = tar([tarEntry("hello.txt", enc.encode("hello"))]);
    const loaded = await loadYurtImage(await zstd(tarBytes));

    expect(loaded.tarBytes).toEqual(tarBytes);
    expect(loaded.index.entries["/hello.txt"]?.type).toBe("file");
    expect(loaded.baseId).toBe(`sha256:${loaded.tarSha256}`);
  });

  it("rejects raw tar bytes because .yurtimg is compressed", async () => {
    const tarBytes = tar([tarEntry("raw.txt", enc.encode("raw"))]);

    await expect(loadYurtImage(tarBytes)).rejects.toThrow();
  });

  it("caches path images as decompressed tar bytes for reuse", async () => {
    const dir = await mkdtemp("/tmp/yurt-image-loader-");
    const cacheDir = join(dir, "cache");
    await mkdir(cacheDir);
    const imagePath = join(dir, "image.yurtimg");
    const tarBytes = tar([tarEntry("cached.txt", enc.encode("cached"))]);
    await writeFile(imagePath, await zstd(tarBytes));

    const first = await loadYurtImage(imagePath, { cacheDir });
    const cachePath = first.cachePath;
    expect(cachePath).toBeDefined();
    expect(new Uint8Array(await readFile(cachePath!))).toEqual(tarBytes);

    const second = await loadYurtImage(imagePath, { cacheDir });
    expect(second.cacheHit).toBe(true);
    expect(second.tarBytes).toEqual(tarBytes);
  });
});
