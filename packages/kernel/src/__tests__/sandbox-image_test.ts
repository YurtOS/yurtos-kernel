import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdCompress } from "node:zlib";
import { NodeAdapter } from "../platform/node-adapter.ts";
import { Sandbox } from "../sandbox.ts";

const WASM_DIR = resolve(
  decodeURIComponent(
    new URL("../platform/__tests__/fixtures", import.meta.url).pathname,
  ),
);
const enc = new TextEncoder();
const dec = new TextDecoder();

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

function tarEntry(opts: {
  name: string;
  type?: "0" | "2" | "5" | "1";
  mode?: number;
  uid?: number;
  gid?: number;
  data?: Uint8Array;
  linkname?: string;
}): Uint8Array {
  const type = opts.type ?? "0";
  const data = opts.data ?? new Uint8Array();
  const header = new Uint8Array(512);
  header.set(stringField(opts.name, 100), 0);
  header.set(octal(opts.mode ?? (type === "5" ? 0o755 : 0o644), 8), 100);
  header.set(octal(opts.uid ?? 0, 8), 108);
  header.set(octal(opts.gid ?? 0, 8), 116);
  header.set(octal(type === "0" ? data.byteLength : 0, 12), 124);
  header.set(octal(0, 12), 136);
  header.fill(0x20, 148, 156);
  header[156] = type.charCodeAt(0);
  header.set(stringField(opts.linkname ?? "", 100), 157);
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

describe("Sandbox image root", { sanitizeResources: false, sanitizeOps: false }, () => {
  it("boots from a zstd .yurtimg and writes only to the upper layer", async () => {
    const tarBytes = tar([
      tarEntry({ name: "bin/", type: "5", mode: 0o755 }),
      tarEntry({
        name: "bin/true",
        mode: 0o555,
        data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")),
      }),
      tarEntry({ name: "etc/", type: "5", mode: 0o755 }),
      tarEntry({
        name: "etc/base-marker.txt",
        mode: 0o666,
        uid: 1000,
        gid: 1000,
        data: enc.encode("base"),
      }),
      tarEntry({ name: "etc/yurt/", type: "5", mode: 0o755 }),
      tarEntry({
        name: "etc/yurt/base-image.json",
        mode: 0o444,
        data: enc.encode(JSON.stringify({
          version: 1,
          id: "test-image",
          tools: [{ name: "true", path: "/bin/true" }],
        })),
      }),
    ]);
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      image: await zstd(tarBytes),
      bootArgv: ["/bin/true"],
    });

    try {
      expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe("base");
      sandbox.writeFile("/etc/base-marker.txt", enc.encode("upper"));
      expect(dec.decode(sandbox.readFile("/etc/base-marker.txt"))).toBe("upper");
      expect(dec.decode(tarBytes)).toContain("base");
    } finally {
      sandbox.destroy();
    }
  });

  it("accepts an image file path", async () => {
    const dir = await mkdtemp("/tmp/yurt-image-");
    const imagePath = join(dir, "test.yurtimg");
    await writeFile(imagePath, await zstd(tar([
      tarEntry({ name: "bin/", type: "5" }),
      tarEntry({
        name: "bin/true",
        mode: 0o555,
        data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")),
      }),
      tarEntry({ name: "etc/yurt/", type: "5" }),
      tarEntry({
        name: "etc/yurt/base-image.json",
        data: enc.encode(JSON.stringify({
          version: 1,
          id: "path-image",
          tools: [{ name: "true", path: "/bin/true" }],
        })),
      }),
    ])));

    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      image: imagePath,
      bootArgv: ["/bin/true"],
    });
    try {
      expect(sandbox.stat("/bin/true").type).toBe("file");
    } finally {
      sandbox.destroy();
    }
  });

  it("runs image commands with argv without shell joining", async () => {
    const image = await zstd(tar([
      tarEntry({ name: "bin/", type: "5" }),
      tarEntry({
        name: "bin/echo-args",
        mode: 0o555,
        data: await Deno.readFile(join(WASM_DIR, "echo-args.wasm")),
      }),
      tarEntry({
        name: "bin/true",
        mode: 0o555,
        data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")),
      }),
      tarEntry({ name: "etc/yurt/", type: "5" }),
      tarEntry({
        name: "etc/yurt/base-image.json",
        data: enc.encode(JSON.stringify({
          version: 1,
          id: "argv-image",
          tools: [
            { name: "true", path: "/bin/true" },
            { name: "echo-args", path: "/bin/echo-args" },
          ],
        })),
      }),
    ]));
    const sandbox = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      image,
      bootArgv: ["/bin/true"],
    });
    try {
      const result = await sandbox.runArgv(["/bin/echo-args", "a b", "$HOME"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("a b\n$HOME\n");
    } finally {
      sandbox.destroy();
    }
  });
});
