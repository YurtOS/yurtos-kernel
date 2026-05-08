import { sha256Hex } from "./process/module-cache.js";
import {
  buildTarImageIndex,
  type TarImageIndex,
} from "./vfs/tar-image-root-provider.js";

export interface LoadYurtImageOptions {
  /** Directory for decompressed tar cache entries. Node/Deno path loads only. */
  cacheDir?: string;
}

export interface LoadedYurtImage {
  compressedBytes: Uint8Array;
  compressedSha256: string;
  tarBytes: Uint8Array;
  tarSha256: string;
  baseId: string;
  index: TarImageIndex;
  cachePath?: string;
  cacheHit: boolean;
}

export async function loadYurtImage(
  image: string | Uint8Array,
  options: LoadYurtImageOptions = {},
): Promise<LoadedYurtImage> {
  const compressedBytes = typeof image === "string"
    ? new Uint8Array(await (await import("node:fs/promises")).readFile(image))
    : image;
  const compressedSha256 = await sha256Hex(compressedBytes);
  const cachePath = typeof image === "string" && options.cacheDir
    ? await buildCachePath(options.cacheDir, compressedSha256)
    : undefined;

  let cacheHit = false;
  let tarBytes: Uint8Array;
  if (cachePath) {
    const cached = await readOptional(cachePath);
    if (cached) {
      tarBytes = cached;
      cacheHit = true;
    } else {
      tarBytes = await decompressZstd(compressedBytes);
      await (await import("node:fs/promises")).writeFile(cachePath, tarBytes);
    }
  } else {
    tarBytes = await decompressZstd(compressedBytes);
  }

  const index = await buildTarImageIndex(tarBytes);
  const tarSha256 = index.imageSha256;
  return {
    compressedBytes,
    compressedSha256,
    tarBytes,
    tarSha256,
    baseId: `sha256:${tarSha256}`,
    index,
    cachePath,
    cacheHit,
  };
}

async function buildCachePath(
  cacheDir: string,
  compressedSha256: string,
): Promise<string> {
  const [{ join }, fs] = await Promise.all([
    import("node:path"),
    import("node:fs/promises"),
  ]);
  await fs.mkdir(cacheDir, { recursive: true });
  return join(cacheDir, `sha256-${compressedSha256}.tar`);
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await (await import("node:fs/promises")).readFile(path));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function decompressZstd(bytes: Uint8Array): Promise<Uint8Array> {
  const native = await decompressWithNativeStream(bytes);
  if (native) return native;

  const { zstdDecompress } = await import("node:zlib");
  return new Promise((resolve, reject) => {
    zstdDecompress(bytes, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(new Uint8Array(result));
    });
  });
}

async function decompressWithNativeStream(
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
  await writer.write(toArrayBuffer(bytes));
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
