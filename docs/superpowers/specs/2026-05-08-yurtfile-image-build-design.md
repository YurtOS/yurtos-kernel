# Yurtfile Image Build Design

**Status:** Draft
**Date:** 2026-05-08
**Repository:** `YurtOS/yurtos-kernel`

## Summary

Add a Dockerfile-like `Yurtfile` frontend for `yurt image build`. The file is an
ordered image construction script: each instruction mutates the build state or
runs a command, and later instructions observe earlier changes.

The kernel should not become a package dependency solver. Dependency ordering is
encoded by the line order in the file. Higher-level tooling such as `pkg` may
resolve package graphs and generate a `Yurtfile`, but the kernel executes the
instructions it is given.

## Goals

- Support `yurt image build -f Yurtfile -o out.yurtimg`.
- Preserve the existing flag-based `yurt image build` interface.
- Provide ordered instructions for the operations that already exist on the
  image builder: start from a base, copy files, change metadata, remove paths,
  and run image commands.
- Add an explicit host execution instruction, `HOSTRUN`, for producing build
  artifacts before they are copied into the image.
- Keep host execution opt-in so reading a `Yurtfile` does not silently execute
  arbitrary host commands.
- Make failures easy to diagnose by reporting the file, line number, and
  instruction.

## Non-Goals

- Dockerfile compatibility.
- A package dependency graph or `requires` language.
- Automatic discovery of `cargo-yurt`, Make targets, Python, pip, or package
  artifacts.
- Registry, layer, cache, or provenance semantics.
- Shell-compatible parsing for every Dockerfile edge case.

## File Model

The conventional file name is `Yurtfile`. The first implementation only uses a
build file when the caller passes `-f, --file <path>`.

`yurt image build -o out.yurtimg` must keep the existing flag-mode behavior and
fail because no `--empty` flag or base image was provided. It must not
implicitly discover `./Yurtfile`, because that would change the current parser
contract when the caller intended a flag-only build.

The first non-comment instruction must be `FROM`:

```yurtfile
FROM empty
```

or:

```yurtfile
FROM ./base.yurtimg
```

`empty` is a reserved keyword meaning the same thing as the existing `--empty`
flag. Any other value is treated as a host path to a `.yurtimg` base image,
resolved relative to the `Yurtfile` directory unless absolute.

Blank lines and full-line comments are ignored:

```yurtfile
# Build a minimal image.
FROM empty
```

## Instructions

The initial instruction set maps closely to the current CLI and builder API.

```yurtfile
FROM empty
COPY packages/kernel/src/platform/__tests__/fixtures/true-cmd.wasm /bin/true
CHMOD 555 /bin/true
COPY packages/kernel/src/platform/__tests__/fixtures/echo-args.wasm /bin/echo-args
CHMOD 555 /bin/echo-args
RUN /bin/echo-args build step
```

### FROM

`FROM <base>` starts the build from an empty filesystem or an existing image.
Only one `FROM` is allowed, and it must appear before any mutating instruction.

### COPY

`COPY <host-path> <image-path>` copies one host file into the image. The host
path is resolved relative to the `Yurtfile` directory unless absolute. The image
path must be absolute.

Directory copy is deferred. The first implementation should reject directories
with this error shape rather than guessing recursive metadata behavior:

```text
COPY does not support directories yet; copy individual files
```

### CHMOD

`CHMOD <octal-mode> <image-path>` applies file mode metadata. The mode must be
octal digits only, matching the existing `--chmod` parser. Symbolic modes such
as `u+x` are not supported. The image path must be absolute.

### CHOWN

`CHOWN <uid>:<gid> <image-path>` applies ownership metadata. The image path must
be absolute.

### RM

`RM <image-path>` recursively removes the path from the build result. The image
path must be absolute.

### RUN

`RUN <argv...>` runs a command inside the image sandbox against the current build
filesystem. It uses argv-native execution, not shell string execution. The
command's writes are included in later instructions and in the exported image.

Build-file `RUN` starts with explicit defaults matching the current
`YurtImageBuilder` runtime:

- `cwd`: `/`
- `HOME`: `/`
- `PATH`: `/bin:/usr/bin`
- `PWD`: `/`
- `USER`: `root`

Future `WORKDIR` or `ENV` instructions may alter these defaults, but the first
implementation does not include those instructions.

### HOSTRUN

`HOSTRUN <shell-command>` runs a command through the host shell. It exists for
producing artifacts that later `COPY` instructions can place into the image:

```yurtfile
FROM empty
HOSTRUN make -C runtimes/python python.wasm
COPY runtimes/python/python.wasm /bin/python
CHMOD 555 /bin/python
RUN /bin/python -m ensurepip
RUN /bin/python -m pip install numpy
```

`HOSTRUN` is intentionally mechanical. It does not mean "build a package"; it
means "run this host command now." Package-aware flows belong in `pkg`, which can
generate a sequence of `HOSTRUN`, `COPY`, and `RUN` instructions or call the
same builder API directly.

Host commands run with the `Yurtfile` directory as their working directory by
default. This keeps relative artifacts predictable across local and CI runs.
Host commands inherit the CLI process environment, including `PATH`, `HOME`, and
toolchain-specific variables. Shell resolution follows the host shell rules:
`make` is found through the inherited `PATH`, while `./scripts/build.sh` resolves
relative to the `Yurtfile` directory because that is the command working
directory.

## CLI Surface

The existing flag form remains valid:

```bash
yurt image build --empty -o out.yurtimg --copy ./tool.wasm:/bin/tool
```

The build-file form is:

```bash
yurt image build -f Yurtfile -o out.yurtimg
```

If the file contains `HOSTRUN`, the caller must opt in:

```bash
yurt image build -f Yurtfile -o out.yurtimg --allow-hostrun
```

Without `--allow-hostrun`, parsing may succeed but preflight fails before any
instruction executes. The error must name the first `HOSTRUN` instruction and
the required flag.

The first implementation should reject mixing `-f/--file` with build-source
inputs or operation flags:

- `--empty`;
- a positional base image;
- `--copy`;
- `--chmod`;
- `--chown`;
- `--rm`;
- `--run`.

`-o/--output` and `--allow-hostrun` remain CLI-level options. This avoids
ambiguous ordering between `FROM` and CLI base inputs, and between file
instructions and CLI operations.

## Parsing Rules

Use a small line-oriented parser:

- trim leading and trailing whitespace;
- ignore blank lines and lines whose first non-whitespace character is `#`;
- split unquoted whitespace into tokens for every instruction except `HOSTRUN`;
- support single-quoted and double-quoted tokens for paths or args containing
  spaces;
- support only `\\`, `\"`, and `\'` escapes inside quoted strings, plus
  backslash-escaped whitespace in unquoted tokens;
- reject unterminated quotes, unknown instructions, wrong arity, missing `FROM`,
  duplicate `FROM`, and relative image paths.

Inline comments are not part of the first pass. A `#` character inside a command
argument is treated as ordinary text unless the whole line is a comment:

```yurtfile
RUN /bin/echo-args "# header"
```

For `HOSTRUN`, the parser treats everything after `HOSTRUN` and following
whitespace as one raw shell command string. The host shell then applies its own
quoting, escaping, and comment rules.

## Execution Model

The CLI parses the `Yurtfile` into a typed instruction list, then executes it
from top to bottom:

1. Create `YurtImageBuilder.empty(...)` for `FROM empty`, or
   `YurtImageBuilder.create({ baseImage })` for a base image.
2. Run preflight checks, including the `HOSTRUN` permission gate.
3. For each instruction:
   - `COPY` calls `builder.copyIn`.
   - `CHMOD` calls `builder.chmod`.
   - `CHOWN` calls `builder.chown`.
   - `RM` calls `builder.remove`.
   - `RUN` calls `builder.run`.
   - `HOSTRUN` runs the raw command text through the host shell using the
     CLI's Node-compatible process execution layer.
4. Stop at the first failed instruction.
5. Export the image only if all instructions succeed.

This differs from the current `--run` flag behavior, which writes the image even
when the command exits non-zero. For build files, a failed ordered step means the
recipe failed and should not produce a new output image.

Output writes must be atomic for build-file mode: write the exported image bytes
to a temporary file in the output directory, then rename that file to the final
output path only after every instruction succeeds and export completes. If
parsing, preflight, an instruction, or export fails, an existing output image
must remain untouched.

## Error Handling

Errors should include the source location. The path in diagnostics is the path
the user passed to `-f/--file`, preserving relative paths for editor-friendly
`file:line` links:

```text
Yurtfile:6: RUN exited with status 1: /bin/python -m pip install numpy
```

Parser errors should use exit code `2`, matching the current CLI argument error
behavior. Instruction execution failures should return the failing command's
exit code when available, otherwise `1`.

Host command stdout and stderr should stream or be forwarded to the CLI stdout
and stderr. A failing `HOSTRUN` should stop the build and return the host
command's exit code when available. Sandbox `RUN` output should keep the current
image-builder behavior: write captured stdout and stderr to the corresponding
CLI streams.

## Security And Permissions

`HOSTRUN` executes arbitrary host code, so it must be gated by
`--allow-hostrun`. This is a Yurt policy gate; the JavaScript runtime or host
wrapper may also require its own permission for process execution.

The CLI should not infer trust from file names or repository paths. A `Yurtfile`
containing `HOSTRUN` requires the opt-in flag every time.

## Testing

Add focused Deno tests for:

- parsing valid `FROM empty`, `COPY`, `CHMOD`, `CHOWN`, `RM`, `RUN`, and
  `HOSTRUN` instructions;
- quoted and escaped arguments;
- rejecting missing or duplicate `FROM`;
- rejecting relative image paths;
- resolving `FROM <relative-path>` against the `Yurtfile` directory, not the
  process cwd;
- building an image from a `Yurtfile` without `HOSTRUN`;
- rejecting `HOSTRUN` without `--allow-hostrun`;
- running `HOSTRUN` with `--allow-hostrun`, then copying its generated artifact
  into the image;
- propagating a failing `HOSTRUN` exit code and leaving the output untouched;
- stopping on a failing `RUN` without writing the output image;
- preserving an existing output image when a build-file instruction fails;
- rejecting `-f` mixed with `--empty`, a positional base image, or operation
  flags.

## Documentation

Update `docs/images.md` and the CLI help output with a `Yurtfile` example and
the security note for `HOSTRUN`. Keep the existing flag-based example because it
remains useful for small one-off images and tests.
