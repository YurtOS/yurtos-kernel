import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@^1.0.19";
import {
  buildTarImageIndex,
  TarImageRootProvider,
} from "../tar-image-root-provider.ts";

const text = new TextEncoder();
const dec = new TextDecoder();

function octal(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(
    text.encode(value.toString(8).padStart(width - 1, "0") + "\0").subarray(
      0,
      width,
    ),
  );
  return out;
}

function stringField(value: string, width: number): Uint8Array {
  const out = new Uint8Array(width);
  out.set(text.encode(value).subarray(0, width));
  return out;
}

function tarEntry(opts: {
  name: string;
  type?: "0" | "2" | "5" | "1";
  mode?: number;
  uid?: number;
  gid?: number;
  mtime?: number;
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
  header.set(octal(opts.mtime ?? 0, 12), 136);
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

Deno.test("TarImageRootProvider serves files, directories, symlinks, hardlinks, and metadata", async () => {
  const archive = tar([
    tarEntry({ name: "usr/", type: "5", mode: 0o755, uid: 0, gid: 0 }),
    tarEntry({ name: "usr/bin/", type: "5", mode: 0o755, uid: 0, gid: 0 }),
    tarEntry({
      name: "usr/bin/hello",
      mode: 0o555,
      uid: 10,
      gid: 20,
      data: text.encode("hello\n"),
    }),
    tarEntry({
      name: "usr/bin/hello-hard",
      type: "1",
      mode: 0o755,
      uid: 30,
      gid: 40,
      linkname: "usr/bin/hello",
    }),
    tarEntry({ name: "bin/", type: "5", mode: 0o755 }),
    tarEntry({
      name: "bin/hello",
      type: "2",
      mode: 0o777,
      linkname: "/usr/bin/hello",
    }),
  ]);
  const index = await buildTarImageIndex(archive);
  const provider = new TarImageRootProvider({
    id: "test",
    image: archive,
    index,
  });

  assertEquals(dec.decode(provider.readFile("/usr/bin/hello")), "hello\n");
  assertEquals(dec.decode(provider.readFile("/usr/bin/hello-hard")), "hello\n");
  assertEquals(provider.lstat("/usr/bin/hello-hard").type, "file");
  assertEquals(provider.lstat("/usr/bin/hello-hard").uid, 30);
  assertEquals(provider.lstat("/usr/bin/hello-hard").gid, 40);
  assertEquals(provider.lstat("/usr/bin/hello-hard").size, 6);
  assertEquals(provider.readlink("/bin/hello"), "/usr/bin/hello");
  assertEquals(provider.stat("/bin/hello").type, "file");
  assertEquals(provider.readdir("/usr/bin").map((entry) => entry.name).sort(), [
    "hello",
    "hello-hard",
  ]);
});

Deno.test("TarImageRootProvider rejects unsafe, duplicate, and unsupported entries", async () => {
  await assertRejects(() =>
    buildTarImageIndex(
      tar([tarEntry({ name: "../escape", data: text.encode("x") })]),
    )
  );
  await assertRejects(() =>
    buildTarImageIndex(tar([
      tarEntry({ name: "dup", data: text.encode("a") }),
      tarEntry({ name: "dup", data: text.encode("b") }),
    ]))
  );
  const unsupported = tar([
    tarEntry({ name: "fifo", type: "0", data: text.encode("x") }),
  ]);
  unsupported[156] = "6".charCodeAt(0);
  await assertRejects(() => buildTarImageIndex(unsupported));
});

Deno.test("TarImageRootProvider rejects hardlinks that do not resolve to regular files", async () => {
  await assertRejects(() =>
    buildTarImageIndex(tar([
      tarEntry({ name: "dir/", type: "5" }),
      tarEntry({ name: "bad", type: "1", linkname: "dir" }),
    ]))
  );
  await assertRejects(() =>
    buildTarImageIndex(tar([
      tarEntry({ name: "missing", type: "1", linkname: "nope" }),
    ]))
  );
});

Deno.test("TarImageRootProvider throws VFS-shaped errors for missing paths and type mismatches", () => {
  const archive = tar([
    tarEntry({ name: "dir/", type: "5" }),
    tarEntry({ name: "dir/file", data: text.encode("x") }),
  ]);
  const provider = new TarImageRootProvider({ id: "test", image: archive });

  assertThrows(() => provider.readFile("/missing"), Error, "ENOENT");
  assertThrows(() => provider.readFile("/dir"), Error, "EISDIR");
  assertThrows(() => provider.readdir("/dir/file"), Error, "ENOTDIR");
  assertThrows(() => provider.readlink("/dir/file"), Error, "ENOENT");
});
