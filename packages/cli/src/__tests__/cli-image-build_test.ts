import { assertEquals, assertStringIncludes } from "jsr:@std/assert@^1.0.19";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { exportVfsToYurtImage } from "../../../kernel/src/image-exporter.ts";
import { loadYurtImage } from "../../../kernel/src/image-loader.ts";
import { TarImageRootProvider } from "../../../kernel/src/vfs/tar-image-root-provider.ts";
import { VFS } from "../../../kernel/src/vfs/vfs.ts";

const CLI = resolve(
  decodeURIComponent(new URL("../cli.ts", import.meta.url).pathname),
);
const deno = Deno.execPath();
const enc = new TextEncoder();
const dec = new TextDecoder();

async function rootFromFile(path: string): Promise<TarImageRootProvider> {
  const loaded = await loadYurtImage(await readFile(path));
  return new TarImageRootProvider({
    id: loaded.baseId,
    image: loaded.tarBytes,
    index: loaded.index,
  });
}

Deno.test("yurt image build creates an image from empty disk", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-build-");
  const src = join(dir, "hello.txt");
  const out = join(dir, "out.yurtimg");
  await writeFile(src, "hello");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "--empty",
      "-o",
      out,
      "--copy",
      `${src}:/etc/hello.txt`,
      "--chmod",
      "640:/etc/hello.txt",
      "--chown",
      "10:20:/etc/hello.txt",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = dec.decode(result.stderr);
  assertEquals(result.code, 0, stderr);
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/hello.txt")), "hello");
  assertEquals(root.stat("/etc/hello.txt").permissions, 0o640);
  assertEquals(root.stat("/etc/hello.txt").uid, 10);
  assertEquals(root.stat("/etc/hello.txt").gid, 20);
});

Deno.test("yurt image build removes paths from a base image", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-build-");
  const base = join(dir, "base.yurtimg");
  const out = join(dir, "out.yurtimg");
  const vfs = new VFS({ layout: "empty" });
  vfs.withWriteAccess(() => {
    vfs.mkdir("/etc");
    vfs.writeFile("/etc/drop.txt", enc.encode("drop"));
    vfs.writeFile("/etc/keep.txt", enc.encode("keep"));
  });
  await writeFile(base, await exportVfsToYurtImage(vfs));

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      base,
      "-o",
      out,
      "--rm",
      "/etc/drop.txt",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = dec.decode(result.stderr);
  assertEquals(result.code, 0, stderr);
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/keep.txt")), "keep");
  try {
    root.stat("/etc/drop.txt");
    throw new Error("expected deleted path to be missing");
  } catch (error) {
    assertStringIncludes(String(error), "ENOENT");
  }
});

Deno.test("yurt image build uses explicit Yurtfile", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-yurtfile-");
  const src = join(dir, "hello.txt");
  const file = join(dir, "Yurtfile");
  const out = join(dir, "out.yurtimg");
  await writeFile(src, "hello from file");
  await writeFile(
    file,
    [
      "FROM empty",
      "COPY hello.txt /etc/hello.txt",
      "CHMOD 640 /etc/hello.txt",
      "CHOWN 10:20 /etc/hello.txt",
    ].join("\n"),
  );

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-f",
      file,
      "-o",
      out,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  const stderr = dec.decode(result.stderr);
  assertEquals(result.code, 0, stderr);
  const root = await rootFromFile(out);
  assertEquals(dec.decode(root.readFile("/etc/hello.txt")), "hello from file");
  assertEquals(root.stat("/etc/hello.txt").permissions, 0o640);
  assertEquals(root.stat("/etc/hello.txt").uid, 10);
  assertEquals(root.stat("/etc/hello.txt").gid, 20);
});

Deno.test("yurt image build does not auto-discover Yurtfile", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-no-auto-yurtfile-");
  await writeFile(join(dir, "Yurtfile"), "FROM empty\n");
  const out = join(dir, "out.yurtimg");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "-o",
      out,
    ],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 2);
  assertStringIncludes(
    dec.decode(result.stderr),
    "missing base image; pass --empty for an empty disk",
  );
});

Deno.test("yurt image build rejects Yurtfile mixed with flag operations and base inputs", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-yurtfile-mix-");
  const file = join(dir, "Yurtfile");
  await writeFile(file, "FROM empty\n");

  const cases = [
    ["--empty"],
    ["base.yurtimg"],
    ["--copy", "a:/a"],
    ["--chmod", "555:/a"],
    ["--chown", "0:0:/a"],
    ["--rm", "/a"],
    ["--run", "/bin/true"],
  ];

  for (const extra of cases) {
    const result = await new Deno.Command(deno, {
      args: [
        "run",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-env",
        CLI,
        "image",
        "build",
        "-f",
        file,
        "-o",
        join(dir, `out-${extra[0].replaceAll("/", "_")}.yurtimg`),
        ...extra,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();

    assertEquals(result.code, 2, dec.decode(result.stderr));
    assertStringIncludes(
      dec.decode(result.stderr),
      "-f/--file cannot be combined",
    );
  }
});

Deno.test("yurt image build rejects --allow-hostrun without a Yurtfile", async () => {
  const dir = await mkdtemp("/tmp/yurt-cli-hostrun-flag-mode-");
  const out = join(dir, "out.yurtimg");

  const result = await new Deno.Command(deno, {
    args: [
      "run",
      "--allow-read",
      "--allow-write",
      "--allow-run",
      "--allow-env",
      CLI,
      "image",
      "build",
      "--empty",
      "-o",
      out,
      "--allow-hostrun",
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();

  assertEquals(result.code, 2);
  assertStringIncludes(
    dec.decode(result.stderr),
    "--allow-hostrun requires -f/--file",
  );
});
