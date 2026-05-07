# FlatBuffers for Yurt Kernel Syscalls — Design

**Date:** 2026-05-07
**Status:** Draft, pending implementation plan
**Replaces:** ad-hoc JSON wire format used by all "fat" kernel ABI host imports and resident PID-1 guest exports.

## Motivation

The kernel ABI currently uses JSON for every host import and guest export that carries non-scalar payloads. JSON is fine for small structured metadata but is the wrong shape for the calls that actually move bytes — `host_network_fetch` (which already pays an explicit base64 round-trip via the `body_base64` field), `host_run_command` (stdout/stderr), `host_spawn` (env vectors of arbitrary size), and the resident PID-1 protocol (`__run_command`, `__set_env`).

Switching the wire format to FlatBuffers buys:

- **Zero-copy reads on the consumer side.** Both the JS host (`Uint8Array` view directly into wasm linear memory) and Rust callers (slice borrowed from the buffer) skip a parse-and-allocate step.
- **Native binary fields.** `[ubyte]` replaces base64 strings for fetch bodies, `__run_command` stdout/stderr, and any other byte payloads. ~33% size reduction on those calls plus the encode/decode CPU savings.
- **Schema discipline.** A single `.fbs` file is the source of truth; the host TS, Rust ABI crates, and C ABI shims all derive from it. No hand-rolled `json_emit_*` and `find_json_field` helpers across `abi/src/yurt_*.c`.
- **Discriminated error envelopes.** Every response carries a per-call `union { Ok, ErrorInfo }`. Callers can't accidentally read success fields on a failed call.

## Scope

### In scope

- Replace JSON with FlatBuffers for **every** non-scalar host import and guest export.
- New schema file `abi/schema/yurt_abi.fbs`.
- New Rust crate `abi/rust/yurt-abi-fb` providing `flatbuffers`-crate Rust bindings to internal Rust callers and an `extern "C"` builder/reader surface to C ABI shims.
- TS bindings committed at `packages/kernel/src/host-imports/_generated/yurt_abi.ts`.
- Rip-and-replace migration: no JSON code path retained, no version bump (the ABI is still being finalized; current consumers are internal).
- Delete `host_native_invoke` outright. It's Python-bridge legacy; a purpose-built replacement will land with the CPython port.
- Update `test-fixtures/shell-exec/src/main.rs` and regenerate `bash.wasm` / `bash-asyncify.wasm` to consume/produce FlatBuffer payloads on the PID-1 protocol.
- CI drift check that the committed generated artifacts match the schema.

### Out of scope

- Streaming responses for very large bodies. The existing `(req_ptr, req_len, out_ptr, out_cap) -> i32` calling convention with retry-on-too-small is preserved; chunked streaming is future work.
- Backwards compatibility with JSON callers. There are none in the wild; rip-and-replace is the cheaper option.
- Pure-scalar host imports (`host_getpid`, `host_dup2`, `host_chmod`, etc.). They never used JSON; they don't change.
- Performance benchmarks. This change is a correctness/cleanliness/zero-copy cutover. If a regression appears in real workloads, it gets investigated as a separate workstream.
- Fuzzing. FlatBuffers' verifier rejects malformed buffers at the read site. Adding a fuzz harness is a separate effort.

## Architecture

### Components

1. **`abi/schema/yurt_abi.fbs`** — single FlatBuffers schema. Every ABI message lives here. Single-file is deliberate: with the actual fat-syscall list this is well under ~300 lines, and one file is easier to review than a tree of `include`d fragments.

2. **`abi/rust/yurt-abi-fb`** — new Rust crate with two faces:
    - Rust callers consume the generated bindings (`pub use generated::*`) idiomatically via the `flatbuffers` crate.
    - C consumers call a deliberately small, stable `extern "C"` surface — one `yurt_fb_build_<call>_request` and one `yurt_fb_read_<call>_response` per fat call. C-side `abi/src/yurt_*.c` shims hold no FlatBuffers wire-format knowledge.
    - Crate emits both `rlib` and `staticlib`; `libyurt_abi_fb.a` is linked into the C ABI build via `yurt-cc`'s existing `--whole-archive` flow.

3. **TS bindings at `packages/kernel/src/host-imports/_generated/yurt_abi.ts`** — `flatc --ts` output, committed. Consumed by `kernel-imports.ts` and `wasi-host.ts` instead of `JSON.parse`/`JSON.stringify`.

### Components removed

- `packages/kernel/src/host-imports/common.ts::writeJson` and every consumer.
- All hand-rolled JSON helpers in `abi/src/yurt_*.c`: `json_emit_string`, `json_emit_lit`, `json_emit_int`, `find_json_field`, `dup_json_string_field`, `append_json_string`.
- The `host_native_invoke` host import — TS implementation in `kernel-imports.ts`, C declaration in `yurt_runtime.h`, C call sites if any.

### Calling convention preserved

Every host import retains the `(req_ptr, req_len, out_ptr, out_cap) -> i32` signature. Only the contents of the buffers change. Buffer-too-small still returns the required size for caller retry. This is intentional: the convention works, all three language sides understand it, and changing it is unrelated to the wire-format question.

## Schema

### Shared types

```fbs
namespace YurtAbi;

table KvPair    { key: string; value: string; }
table EnvVar    { key: string; value: string; }
table ErrorInfo { code: int32; message: string; source: string; }
```

### Host import quartets

Each fat host import has a `(Request, Ok, Result union, Response)` quartet. The response always carries a discriminated union with `Ok` and `ErrorInfo` arms:

```fbs
table RunCommandRequest    { cmd: string; cwd: string; env: [EnvVar]; stdin_fd: int32; }
table RunCommandOk         { exit_code: int32; stdout: [ubyte]; stderr: [ubyte]; }
union RunCommandResult     { RunCommandOk, ErrorInfo }
table RunCommandResponse   { result: RunCommandResult; }

table SpawnRequest         { prog: string; argv0: string; args: [string]; env: [EnvVar];
                             cwd: string; stdin_fd: int32; stdout_fd: int32; stderr_fd: int32; }
table SpawnOk              { pid: int32; }
union SpawnResult          { SpawnOk, ErrorInfo }
table SpawnResponse        { result: SpawnResult; }

table FetchRequest         { url: string; method: string; headers: [KvPair];
                             body: [ubyte]; redirect: byte; /* 0=follow,1=manual */ }
table FetchOk              { status: int32; headers: [KvPair]; body: [ubyte]; }
union FetchResult          { FetchOk, ErrorInfo }
table FetchResponse        { result: FetchResult; }

table PipeOk               { read_fd: int32; write_fd: int32; }
union PipeResult           { PipeOk, ErrorInfo }
table PipeResponse         { result: PipeResult; }

table WaitOk               { pid: int32; exit_code: int32; }
union WaitResult           { WaitOk, ErrorInfo }
table WaitResponse         { result: WaitResult; }     // covers waitpid, waitall

table ProcessInfo          { pid: int32; ppid: int32; state: byte; cmd: string; }
table ListProcsOk          { processes: [ProcessInfo]; }
union ListProcsResult      { ListProcsOk, ErrorInfo }
table ListProcsResponse    { result: ListProcsResult; }

table SocketTlsRequest     { fd: int32; host: string; port: int32; tls: bool; }
table SocketTlsOk          {}
union SocketTlsResult      { SocketTlsOk, ErrorInfo }
table SocketTlsResponse    { result: SocketTlsResult; }
```

### Guest exports — PID-1 protocol

```fbs
table SetEnvRequest          { env: [EnvVar]; }    // merge semantics, per the existing __set_env contract
table SetEnvOk               {}
union SetEnvResult           { SetEnvOk, ErrorInfo }
table SetEnvResponse         { result: SetEnvResult; }

table Pid1RunCommandRequest  { cmd: string; }
table Pid1RunCommandOk       { exit_code: int32; stdout: [ubyte]; stderr: [ubyte]; }
union Pid1RunCommandResult   { Pid1RunCommandOk, ErrorInfo }
table Pid1RunCommandResponse { result: Pid1RunCommandResult; }
```

The `Pid1RunCommand*` family is intentionally distinct from the host-import `RunCommand*` family. Same naming root, different protocol; the type-level separation prevents one being mistaken for the other.

### Schema invariants

- **One `ErrorInfo` table reused everywhere.** Per-call unions point at the same shared error type.
- **Empty `Ok` tables are valid.** FlatBuffers unions cannot have a "null" arm; an empty table is the idiomatic way to signal void success.
- **Body bytes are `[ubyte]`, never strings.** No base64 anywhere.
- **Field IDs are never reused.** Deprecated fields go behind `(deprecated)`. This is the only versioning mechanism we lean on.

## Rust Helper Crate & C Boundary

### Crate layout

```
abi/rust/yurt-abi-fb/
  Cargo.toml             # depends on flatbuffers crate
  src/
    lib.rs               # re-exports generated bindings + FFI modules
    generated.rs         # COMMITTED. Output of `flatc --rust`.
    error_codes.rs       # COMMITTED. Mirror of the schema's error code constants.
    ffi/
      mod.rs
      build.rs           # extern "C" builders (Rust → buffer for C)
      read.rs            # extern "C" readers / accessors
      buffer.rs          # opaque buffer-handle lifetime management
```

`Cargo.toml`:

```toml
[package]
name = "yurt-abi-fb"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["rlib", "staticlib"]

[dependencies]
flatbuffers = "25"
```

### `extern "C"` surface (illustrative — fetch)

```rust
#[repr(C)]
pub struct YurtFbBuf { pub ptr: *mut u8, pub len: usize, pub _opaque: usize }

#[repr(C)]
pub struct YurtFbKv { pub key_ptr: *const u8, pub key_len: usize,
                      pub val_ptr: *const u8, pub val_len: usize }

#[no_mangle]
pub extern "C" fn yurt_fb_build_fetch_request(
    url: *const c_char,
    method: *const c_char,
    headers: *const YurtFbKv, headers_len: usize,
    body: *const u8, body_len: usize,
    redirect: u8,
) -> YurtFbBuf;

#[no_mangle]
pub extern "C" fn yurt_fb_free_buf(buf: YurtFbBuf);

#[repr(C)]
pub enum YurtFbFetchResultKind { Ok = 0, Err = 1 }

#[repr(C)]
pub struct YurtFbFetchOk {
    pub status: i32,
    pub headers: *const YurtFbKv, pub headers_len: usize,
    pub body: *const u8, pub body_len: usize,
}

#[repr(C)]
pub struct YurtFbErr {
    pub code: i32,
    pub message: *const u8, pub message_len: usize,
}

#[no_mangle]
pub extern "C" fn yurt_fb_read_fetch_response(
    bytes: *const u8, len: usize,
    out_kind: *mut YurtFbFetchResultKind,
    out_ok: *mut YurtFbFetchOk,
    out_err: *mut YurtFbErr,
) -> i32; // 0 = ok, -1 = malformed buffer
```

### Buffer ownership

- **Builder output (`YurtFbBuf`)** is heap-owned by `yurt-abi-fb`. C callers must call `yurt_fb_free_buf` after the host import returns. The `_opaque` field carries the reclaim handle (boxed `Vec<u8>`) so Rust safely reconstructs ownership.
- **Reader inputs** are caller-owned (the host writes into wasm linear memory). Reader output structs hold borrowed pointers into that buffer — valid only until the buffer is reused. C callers must consume the read result before issuing the next host import call. Strings/bytes are returned as `(ptr, len)` pairs, never null-terminated; C callers `memcpy` what they need to retain.

### TS side (illustrative)

```ts
// packages/kernel/src/host-imports/_generated/yurt_abi.ts (committed)
import { ByteBuffer, Builder } from 'flatbuffers';
export namespace YurtAbi { /* generated tables */ }

// kernel-imports.ts
import { YurtAbi } from './_generated/yurt_abi.js';

const req = YurtAbi.FetchRequest.getRootAsFetchRequest(
  new ByteBuffer(new Uint8Array(memory.buffer, reqPtr, reqLen)),
);
// req.body() returns Uint8Array view directly into wasm memory — zero copy
```

`writeJson` is replaced by a generic `writeFlatbuffer(memory, ptr, cap, builder.asUint8Array())` that follows the existing "return required size on overflow" convention.

## Build Pipeline

### Generated artifacts (committed)

| Target | Path | Regenerated by |
|---|---|---|
| Rust bindings | `abi/rust/yurt-abi-fb/src/generated.rs` | `flatc --rust -o abi/rust/yurt-abi-fb/src abi/schema/yurt_abi.fbs` |
| TS bindings | `packages/kernel/src/host-imports/_generated/yurt_abi.ts` | `flatc --ts -o packages/kernel/src/host-imports/_generated abi/schema/yurt_abi.fbs` |

No C bindings are generated — C goes through `yurt-abi-fb`'s `extern "C"` surface.

### Makefile target

```make
.PHONY: abi-fb-regen
abi-fb-regen:
	flatc --rust -o abi/rust/yurt-abi-fb/src abi/schema/yurt_abi.fbs
	flatc --ts   -o packages/kernel/src/host-imports/_generated abi/schema/yurt_abi.fbs
	@echo "✔ FlatBuffers bindings regenerated. Commit the diff."
```

Style follows the existing `scripts/sync-version.sh` precedent — single command for contributors after touching the schema.

### CI drift check

New job `abi-fb-drift` in `.github/workflows/`:

```yaml
abi-fb-drift:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - run: sudo apt-get install -y flatbuffers-compiler
    - run: make abi-fb-regen
    - name: Verify no drift
      run: git diff --exit-code -- abi/rust/yurt-abi-fb/src/generated.rs
                                  packages/kernel/src/host-imports/_generated/yurt_abi.ts
```

Pinned `flatc` version (recorded once in this spec and in the CI job) prevents compiler-upgrade-induced drift.

### Cargo workspace

`abi/rust/yurt-abi-fb` is added as a workspace member in the root `Cargo.toml`. The `abi/Makefile` adds `target/release/libyurt_abi_fb.a` as a link dependency for the C ABI build.

### Deno imports

`deno.json` `imports` entry: `"flatbuffers": "npm:flatbuffers@25"`. The committed TS bindings reference `flatbuffers` via this import; no bundling step.

### Schema-change workflow

1. Edit `abi/schema/yurt_abi.fbs`.
2. Run `make abi-fb-regen`.
3. Commit schema + both regenerated files in the same commit. Same-commit discipline keeps `git bisect` green.

### Why no `build.rs`-driven codegen

Deliberately not using `build.rs` to shell out to `flatc`. Reasons: (1) the crate stays buildable on machines without `flatc`; (2) incremental compile remains clean; (3) the drift check catches the "forgot to commit regenerated files" trap, which silent build-time codegen would mask.

### `flatc` install for contributors

- macOS: `brew install flatbuffers`
- Linux: `apt-get install flatbuffers-compiler`
- Source build: per upstream FlatBuffers docs

The pinned version goes in this spec **and** in the CI job (single source of truth).

## Error Handling

Errors flow through one of two channels. The spec is strict about which goes where.

### Channel 1 — Negative `i32` return value (transport-level)

Reserved for situations where the host can't produce a meaningful FlatBuffer response.

| Value | Meaning |
|---|---|
| `>=0` and `<=out_cap` | Bytes written into `out_ptr`. Caller parses a `*Response` FlatBuffer. |
| `>out_cap` | Required buffer size for retry (existing semantics). |
| `-1` | Host crashed / unhandled exception during dispatch. |
| `-2` | Request FlatBuffer is malformed / wrong root type. |
| `-3` | Required size overflowed `i32`. (Practically unreachable; reserved.) |
| `-4..=-7` | Reserved for future transport-layer errors. |

Negative codes never carry message text. There is **no `errno`-style side channel** — the host doesn't maintain per-thread error state. Callers retry, log, or surface upward.

### Channel 2 — `ErrorInfo` in the response union (kernel-level)

Normal "the call ran but failed" case. A well-formed response is written; its union arm is `ErrorInfo`. Examples:

- DNS failure on fetch → `ErrorInfo { code: -100, message: "getaddrinfo: example.invalid", source: "host_network_fetch" }`. Transport `i32` is `bytes_written`.
- Program not found on spawn → `ErrorInfo { code: 2 /* ENOENT */, message: "no such file: /bin/foo", source: "host_spawn" }`.

### Error code numbering

| Range | Meaning |
|---|---|
| `1..=255` | POSIX-aligned errnos. `2` = `ENOENT`, `13` = `EACCES`, etc. |
| `-1..=-99` | Reserved (do not allocate). Gap that protects future Channel-1 expansion. |
| `-100..=-199` | Network / fetch errors. `-100` = DNS, `-101` = TLS handshake, `-102` = redirect-limit, etc. |
| `-200..=-299` | Process / spawn errors. `-200` = wasm validation, `-201` = entry-point missing. |
| `-300..=-399` | VFS / filesystem-extension errors. |
| `-400..=-499` | Reserved for future syscall families. |
| `-500..=-999` | Reserved. |
| `-1000..` | Reserved for downstream userland use. Kernel never emits these. |

Numbering lives in `abi/schema/yurt_abi.fbs` as commented constants alongside `ErrorInfo`. Mirrored into `abi/rust/yurt-abi-fb/src/error_codes.rs` and a TS sibling at `packages/kernel/src/host-imports/_generated/yurt_abi_error_codes.ts` as named constants. Mirrors are hand-maintained; the `abi-fb-drift` CI job greps the `.fbs` for `code:` constants and asserts each appears in both mirrors.

### Discipline rules

1. Hosts never return Channel-1 negatives for kernel-domain failures. "DNS lookup failed" goes through `ErrorInfo`, not `-1`.
2. Callers must check the union discriminator before reading the success arm. The FlatBuffers API enforces this on both languages.
3. `message` is for humans, `code` is for code. Callers must not string-match on `message`. Branching on `code` is the only supported error-handling discipline.
4. `source` is debugging-only. Optional but encouraged. Never load-bearing.
5. Retired error codes are never reused. Deprecation comments stay in the schema; the constant stays defined so old binaries don't silently misinterpret.

### What this replaces

- The current JSON `{ ok: false, error: "..." }` shape → `Response.result == ErrorInfo`.
- Today's implicit "host returned -1, just guess what went wrong" → explicit `-1` / `-2` reservations above.
- The current `yurt_pclose`-style "captured raw exit code" pattern is preserved (exit codes stay in `RunCommandOk.exit_code`); only error metadata moves.

## Testing Strategy

### Layer 1 — Schema round-trip

`abi/rust/yurt-abi-fb/tests/round_trip.rs` (Rust) and a sibling Deno test. For each table: build with representative data, read back, assert all fields match. Cross-language byte-for-byte parity asserted via a tmp-file fixture exchange. Catches schema/code mismatches, endianness assumptions, vtable hash divergence between language emitters.

### Layer 2 — `yurt-abi-fb` `extern "C"` boundary

`abi/rust/yurt-abi-fb/tests/ffi.rs`: every `yurt_fb_build_*` and `yurt_fb_read_*` exercised. Build via FFI / read via Rust API and vice-versa. Negative cases (malformed bytes return -1, oversize inputs respect bounds, error-arm responses correctly discriminated). Lifetime correctness via miri or ASan in CI catches use-after-free.

### Layer 3 — TS host-import unit tests

Migrate every existing `kernel-imports.ts` test to the FlatBuffers shape. Files under `packages/kernel/src/host-imports/__tests__/`. Per fat call: at least one happy-path test, one `ErrorInfo`-arm test, one buffer-too-small (retry-with-required-size) test. New helper `__tests__/fb-helpers.ts` keeps individual tests short.

### Layer 4 — C ABI conformance canaries

Existing `abi/conformance/c/` canaries call high-level C ABI functions (`yurt_system`, `yurt_popen`, `yurt_fetch_text`); they don't speak the wire format directly and should pass unchanged after the C-side refactor. New canaries:

- `fetch-binary-canary.c` — fetch a known binary blob, verify bytes match. Was previously impossible due to base64 round-trip.
- `spawn-large-env-canary.c` — `posix_spawn` with a 256-entry env vector. Validates the `[EnvVar]` path under realistic load.

### Layer 5 — Resident PID-1 fixture validation

`test-fixtures/shell-exec/src/main.rs` is updated so `__set_env` and `__run_command` consume FB requests and produce FB responses. Rust unit tests for the round-trip. Existing kernel tests that drive these exports (e.g., the env-propagation cases introduced by PR #7) get switched to FB request construction. Two regenerated `.wasm` fixtures (`bash.wasm`, `bash-asyncify.wasm`) land in the same commit as the source change — same discipline as PR #7.

### Layer 6 — Drift check

The CI `abi-fb-drift` job (already detailed in the Build Pipeline section). Listed here because schema/code drift is functionally a regression class.

### Layer 7 — End-to-end smoke

The full `deno test` over `packages/kernel` is the integration backstop. Pass criterion: every test that passed on `main` passes after the cutover, with the same expected outputs. The PR-#7-era yurt-greet runtime smoke tests must remain green against the new FB ABI.

### Test plan checklist (will be reused in the implementation PR)

- [ ] `cargo test -p yurt-abi-fb` green (Layers 1–2).
- [ ] `cd abi && make canaries` green; new fetch-binary + spawn-large-env canaries land.
- [ ] `deno task test` over `packages/kernel` green (Layer 3, 7).
- [ ] `bash.wasm` + `bash-asyncify.wasm` regenerated and committed; `__set_env` / `__run_command` tests pass.
- [ ] CI `abi-fb-drift` job green.
- [ ] Manual: REPL `cli.ts -c 'echo hello'` still produces `hello` (smoke).

## Open questions deferred to implementation

- Exact error code allocations beyond the placeholder examples (`-100`, `-200`, etc.) — assigned per-call as the implementation lands.
- `flatc` version pinning (e.g., `25.x.y`) — chosen against the latest stable at implementation time; recorded in this spec via a follow-up edit.
- Optional stretch: extracting a `make abi-fb-codegen-check` that runs `cargo check -p yurt-abi-fb` as part of the drift CI, to catch generated code that compiles in isolation but breaks downstream callers. Default: not included; add only if the layered test suite proves insufficient.

## Migration & rollout

Single PR delivers the entire cutover on a worktree:

1. Add `abi/schema/yurt_abi.fbs`.
2. Add `abi/rust/yurt-abi-fb` crate (generated.rs, FFI surface, Cargo workspace entry).
3. Switch `kernel-imports.ts`, `wasi-host.ts`, and friends to the FB code path; delete `writeJson` and JSON.parse paths.
4. Switch `abi/src/yurt_*.c` shims to call `yurt_fb_build_*` / `yurt_fb_read_*`; delete hand-rolled JSON helpers.
5. Delete `host_native_invoke` end-to-end.
6. Update `test-fixtures/shell-exec/src/main.rs`; regenerate `bash.wasm` and `bash-asyncify.wasm`.
7. Migrate and extend tests across all layers.
8. Add the `abi-fb-drift` CI job.

There is no JSON/FB coexistence period.
