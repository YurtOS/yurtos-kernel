import { assertEquals, assertStringIncludes } from "@std/assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { zstdCompress } from "node:zlib";

const WASM_DIR = resolve(
  decodeURIComponent(
    new URL("../../../kernel/src/platform/__tests__/fixtures", import.meta.url)
      .pathname,
  ),
);
const CLI = resolve(
  decodeURIComponent(new URL("../cli.ts", import.meta.url).pathname),
);
const deno = Deno.execPath();
const enc = new TextEncoder();

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

Deno.test("yurt CLI runs an argv command from an image", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-image-");
  const imagePath = join(dir, "test.yurtimg");
  await writeFile(
    imagePath,
    await zstd(tar([
      tarEntry({ name: "bin/", type: "5" }),
      tarEntry({
        name: "bin/true",
        mode: 0o555,
        data: await Deno.readFile(join(WASM_DIR, "true-cmd.wasm")),
      }),
      tarEntry({
        name: "bin/echo-args",
        mode: 0o555,
        data: await Deno.readFile(join(WASM_DIR, "echo-args.wasm")),
      }),
      tarEntry({ name: "etc/yurt/", type: "5" }),
      tarEntry({
        name: "etc/yurt/base-image.json",
        data: enc.encode(JSON.stringify({
          version: 1,
          id: "cli-image",
          tools: [
            { name: "true", path: "/bin/true" },
            { name: "echo-args", path: "/bin/echo-args" },
          ],
        })),
      }),
    ])),
  );

  const command = new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      CLI,
      imagePath,
      "/bin/echo-args",
      "a b",
      "$HOME",
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(result.code, 0, stderr);
  assertEquals(stdout, "a b\n$HOME\n");
});

Deno.test("yurt CLI fails clearly when no command and /bin/sh is missing", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-image-");
  const imagePath = join(dir, "test.yurtimg");
  await writeFile(
    imagePath,
    await zstd(tar([
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
          id: "cli-image",
          tools: [{ name: "true", path: "/bin/true" }],
        })),
      }),
    ])),
  );

  const command = new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-env",
      CLI,
      imagePath,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  const stderr = new TextDecoder().decode(result.stderr);

  assertEquals(result.code, 127);
  assertStringIncludes(
    stderr,
    "no command provided and /bin/sh is not present in image",
  );
});
