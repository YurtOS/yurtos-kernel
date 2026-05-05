import { assertEquals } from "jsr:@std/assert@^1.0.19";
import { applyTarToVfs } from "../tar-install.ts";
import { VFS } from "../vfs.ts";

const text = new TextEncoder();

function octal(value: number, width: number): Uint8Array {
  const out = new Uint8Array(width);
  const encoded = text.encode(
    value.toString(8).padStart(width - 1, "0") + "\0",
  );
  out.set(encoded.subarray(0, width));
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
  const size = entries.reduce((sum, entry) => sum + entry.byteLength, 0) +
    end.byteLength;
  const out = new Uint8Array(size);
  let offset = 0;
  for (const entry of entries) {
    out.set(entry, offset);
    offset += entry.byteLength;
  }
  out.set(end, offset);
  return out;
}

Deno.test("applyTarToVfs installs files, links, modes, and owners", () => {
  const archive = tar([
    tarEntry({ name: "usr/", type: "5", mode: 0o755, uid: 0, gid: 0 }),
    tarEntry({ name: "usr/bin/", type: "5", mode: 0o755, uid: 0, gid: 0 }),
    tarEntry({
      name: "usr/bin/hello.wasm",
      mode: 0o755,
      uid: 1000,
      gid: 1000,
      data: text.encode("\0asm test fixture"),
    }),
    tarEntry({
      name: "bin/hello",
      type: "2",
      mode: 0o777,
      uid: 0,
      gid: 0,
      linkname: "/usr/bin/hello.wasm",
    }),
    tarEntry({
      name: "usr/bin/hello-hard",
      type: "1",
      uid: 0,
      gid: 0,
      linkname: "usr/bin/hello.wasm",
    }),
  ]);
  const vfs = new VFS();

  applyTarToVfs(vfs, archive);

  assertEquals(
    new TextDecoder().decode(vfs.readFile("/usr/bin/hello.wasm")),
    "\0asm test fixture",
  );
  assertEquals(vfs.stat("/usr/bin/hello.wasm").permissions, 0o755);
  assertEquals(vfs.stat("/usr/bin/hello.wasm").uid, 1000);
  assertEquals(vfs.stat("/usr/bin/hello.wasm").gid, 1000);
  assertEquals(vfs.readlink("/bin/hello"), "/usr/bin/hello.wasm");
  assertEquals(vfs.stat("/bin/hello").type, "file");

  vfs.writeFile("/usr/bin/hello-hard", text.encode("updated"), 0o755);
  assertEquals(
    new TextDecoder().decode(vfs.readFile("/usr/bin/hello.wasm")),
    "updated",
  );
});
