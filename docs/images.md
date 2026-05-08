# Creating and Running Yurt Images

A `.yurtimg` is a zstd-compressed tar filesystem image. The kernel loads it as
the read-only base layer of the sandbox. Files created or changed while a
command runs go into an overlay upper layer, so the image file itself is not
modified at runtime.

## Build an Image

Use `yurt image build` through the Deno CLI entry point:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts image build \
  --empty \
  -o /tmp/echo.yurtimg \
  --copy packages/kernel/src/platform/__tests__/fixtures/true-cmd.wasm:/bin/true \
  --chmod 555:/bin/true \
  --copy packages/kernel/src/platform/__tests__/fixtures/echo-args.wasm:/bin/echo-args \
  --chmod 555:/bin/echo-args
```

This creates an image with `/bin/echo-args` plus `/bin/true`. The current CLI
uses `/bin/true` as its image boot probe, so runnable CLI images should include
that fixture until the boot path becomes configurable.

`yurt image build` accepts:

- `--empty`: start from an empty writable filesystem.
- `<base.yurtimg>`: start from an existing image instead of `--empty`.
- `-o, --output <path>`: write the resulting `.yurtimg`.
- `--copy <host-path>:/absolute/image/path`: copy a host file into the image.
- `--chmod <octal-mode>:/absolute/image/path`: set permissions.
- `--chown <uid>:<gid>:/absolute/image/path`: set ownership metadata.
- `--rm /absolute/image/path`: remove a path from the output image.
- `--run <argv...>`: run a command during the build before export.

Build from a base image and remove a path:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts image build \
  /tmp/base.yurtimg \
  -o /tmp/without-cache.yurtimg \
  --rm /var/cache/package.idx
```

Run a command during the build:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts image build \
  --empty \
  -o /tmp/generated.yurtimg \
  --copy packages/kernel/src/platform/__tests__/fixtures/true-cmd.wasm:/bin/true \
  --chmod 555:/bin/true \
  --copy packages/kernel/src/platform/__tests__/fixtures/echo-args.wasm:/bin/echo-args \
  --chmod 555:/bin/echo-args \
  --run /bin/echo-args build step
```

If `--run` exits non-zero, the CLI still writes the image and exits with that
command's exit code.

## Run an Image

Pass the image as the first CLI argument, followed by the command argv:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts /tmp/echo.yurtimg /bin/echo-args hello yurt
```

If no command is provided, the CLI tries `/bin/sh`:

```bash
deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts /tmp/dev.yurtimg
```

If the image does not contain `/bin/sh`, the CLI exits with:

```text
no command provided and /bin/sh is not present in image
```

## Image Layout

The image runtime supports regular files, directories, symlinks, hardlinks, and
the usual tar metadata: mode, uid, gid, and mtime. Paths inside the image are
absolute from the sandbox point of view. Build inputs such as `--copy` and
`--rm` require absolute image paths.

Images may include `/etc/yurt/base-image.json` with manifest metadata. The
current CLI does not require the manifest to run an image, but base-root
builders and higher-level package tooling use it to describe installed tools and
filesystem metadata.

## Cache

The image loader decompresses `.yurtimg` bytes into tar bytes and indexes the
tar. For path-based images, the CLI uses an image cache directory:

```bash
YURT_IMAGE_CACHE_DIR=/tmp/yurt-cache deno run --allow-read --allow-write --allow-run --allow-env \
  packages/kernel/src/cli.ts /tmp/echo.yurtimg /bin/echo-args cached
```

If `YURT_IMAGE_CACHE_DIR` is not set, the CLI uses a temporary directory under
the host OS temp location.

## Programmatic API

The kernel exports image helpers from `@yurt/kernel`:

```ts
import {
  exportVfsToYurtImage,
  loadYurtImage,
  TarImageRootProvider,
  YurtImageBuilder,
} from "@yurt/kernel";
```

`YurtImageBuilder.empty(...)` creates an image from an empty filesystem.
`YurtImageBuilder.create({ baseImage, ... })` starts from an existing
`.yurtimg`. Both export through `builder.exportImage()`.
