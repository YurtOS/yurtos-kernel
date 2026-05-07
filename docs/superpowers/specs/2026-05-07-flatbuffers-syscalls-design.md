# FlatBuffers for Yurt Kernel Syscalls — Design

**Date:** 2026-05-07
**Status:** Draft, pending implementation plan
**Replaces:** ad-hoc JSON wire format used by every kernel ABI host import that carries non-scalar payloads, and by the resident PID-1 guest export protocol.

## Motivation

The kernel ABI currently uses JSON for every host import and guest export that carries non-scalar payloads. JSON is fine for small structured metadata but is the wrong shape for the calls that actually move bytes — `host_network_fetch` (which already pays an explicit base64 round-trip via the `body_base64` field), `host_run_command` (stdout/stderr), `host_spawn` (env vectors of arbitrary size), `host_socket_recv` / `host_socket_send` (data payloads), and the resident PID-1 protocol (`__run_command`, `__set_env`).

Switching the wire format to FlatBuffers buys:

- **Zero-copy reads on the consumer side.** Both the JS host (`Uint8Array` view directly into wasm linear memory) and Rust callers (slice borrowed from the buffer) skip a parse-and-allocate step. Discipline rules below cover the memory-growth invalidation case.
- **Native binary fields.** `[ubyte]` replaces base64 strings for fetch bodies, socket recv/send buffers, `__run_command` stdout/stderr, and any other byte payloads. ~33% size reduction on those calls plus the encode/decode CPU savings.
- **Schema discipline.** A single `.fbs` file is the source of truth; the host TS, Rust ABI crates, and C ABI shims all derive from it. No hand-rolled `json_emit_*` and `find_json_field` helpers across `abi/src/yurt_*.c`.
- **Discriminated error envelopes.** Every response carries a per-call `union { Ok, ErrorInfo }`. Callers can't accidentally read success fields on a failed call.
- **Consistency.** One wire format across the entire ABI surface. No mix of "this call uses JSON, that call uses raw bytes, this other one uses base64-in-JSON."

## Scope

### In scope

- Replace the wire format with FlatBuffers for **every** host import that has a buffer pointer in its current signature, regardless of whether the existing encoding is JSON, raw bytes, raw strings, or marshalled C structs. Complete inventory in the Schema section. The goal is one mechanism across the whole non-trivial surface — no mix of "this call uses JSON, that one uses raw bytes, this third one marshals a `struct termios`."
- Replace the wire format on the resident PID-1 guest exports (`__run_command`, `__set_env`).
- **Reduce the syscall surface where folds are obvious.** The wait family (`host_waitpid`, `host_waitpid_nohang`, `host_wait_any`, `host_wait_any_nohang`) collapses into a single `host_wait` whose request carries the pid (or `ANY` sentinel) and a `nohang: bool`. Four functions become one. Other folds may surface during implementation; the spec records each one as it lands.
- New schema file `abi/schema/yurt_abi.fbs`.
- New Rust crate `abi/rust/yurt-abi-fb` providing `flatbuffers`-crate Rust bindings to internal Rust callers and an `extern "C"` builder/reader surface to C ABI shims.
- TS bindings committed at `packages/kernel/src/host-imports/_generated/yurt_abi.ts`.
- Rip-and-replace migration: no JSON code path retained, no version bump (the ABI is still being finalized; current consumers are internal).
- Delete `host_native_invoke` outright. It's Python-bridge legacy; a purpose-built replacement will land with the CPython port.
- **Normalize every non-scalar host import onto the standard `(req_ptr, req_len, out_ptr, out_cap) -> i32` calling convention.** Several calls today have non-standard shapes — `host_spawn` has a two-ABI split (the generic `(req_ptr, req_len) -> pid` form and the legacy 4-arg shell-test form); `host_socket_close` is `(req_ptr, req_len) -> i32` with no out buffer; the path-based mutating calls (`host_chmod`, `host_chdir`, `host_mkdir`, `host_remove`, `host_rename`, `host_symlink`, `host_register_tool`, `host_write_fd`, `host_write_file`, `host_write_result`) take raw `(path_ptr, path_len, …)` args and return scalars without a response buffer. All of these gain a 4-arg form with an FB response. See "Calling convention" below for the blast-radius list.
- Update `test-fixtures/shell-exec/src/main.rs` and regenerate `bash.wasm` / `bash-asyncify.wasm` to consume/produce FlatBuffer payloads on the PID-1 protocol.
- CI drift check that the committed generated artifacts match the schema.

### Out of scope

- Streaming responses for very large bodies. The existing `(req_ptr, req_len, out_ptr, out_cap) -> i32` calling convention with retry-on-too-small is preserved; chunked streaming is future work.
- Backwards compatibility with JSON callers. There are none in the wild; rip-and-replace is the cheaper option.
- Pure-scalar host imports — anything whose signature is "scalars in, scalar out" with **no** buffer pointers anywhere (`host_getpid`, `host_getppid`, `host_getuid` and the other cred getters, `host_dup2`, `host_dup_min`, `host_close_fd`, `host_file_lock`, `host_setresuid`/`gid`, `host_umask`, `host_setpgid`, `host_setsid`, `host_kill`, `host_killpg`, `host_isatty`, `host_setpriority`, `host_getpriority`, `host_setrlimit`, `host_socket_open`, `host_time`, `host_yield`, `host_fork`, `host_fchown`, `host_fchdir`, `host_mark_exec_child`, `host_set_fd_descriptor_flags`, `host_sched_getscheduler`/`setscheduler`/`getparam`/`setparam`, `host_tcsetpgrp`/`tcgetpgrp`/`tiocsctty`). Wrapping these in FB is pure overhead with no consistency win, and POSIX itself uses scalar returns for them.
- `host_setjmp` / `host_longjmp` — the `jmp_buf` pointer is opaque save state with bit-for-bit C compatibility requirements. FB-wrapping does not apply.
- Performance benchmarks. This change is a correctness/cleanliness/zero-copy cutover. If a regression appears in real workloads, it gets investigated as a separate workstream.
- Fuzzing. FlatBuffers' verifier rejects malformed buffers at the read site. Adding a fuzz harness is a separate effort.

## Architecture

### Components

1. **`abi/schema/yurt_abi.fbs`** — single FlatBuffers schema. Every ABI message lives here. Single-file is deliberate: even with the full inventory it stays under ~500 lines, and one file is easier to review than a tree of `include`d fragments.

2. **`abi/rust/yurt-abi-fb`** — new Rust crate with two faces:
    - Rust callers consume the generated bindings (`pub use generated::*`) idiomatically via the `flatbuffers` crate.
    - C consumers call a deliberately small, stable `extern "C"` surface — one `yurt_fb_build_<call>_request` and one `yurt_fb_read_<call>_response` per fat call. C-side `abi/src/yurt_*.c` shims hold no FlatBuffers wire-format knowledge.
    - Crate emits both `rlib` and `staticlib`; `libyurt_abi_fb.a` is linked into the C ABI build via `yurt-cc`'s existing `--whole-archive` flow.

3. **TS bindings at `packages/kernel/src/host-imports/_generated/yurt_abi.ts`** — `flatc --ts` output, committed. Consumed by `kernel-imports.ts` and `wasi-host.ts` instead of `JSON.parse`/`JSON.stringify`.

### Components removed

- `packages/kernel/src/host-imports/common.ts::writeJson` and every consumer.
- All hand-rolled JSON helpers in `abi/src/yurt_*.c`: `json_emit_string`, `json_emit_lit`, `json_emit_int`, `find_json_field`, `dup_json_string_field`, `append_json_string`.
- The `host_native_invoke` host import — TS implementation in `kernel-imports.ts`, C declaration in `yurt_runtime.h`, C call sites if any.

### Calling convention

Every host import that carries a structured payload uses `(req_ptr, req_len, out_ptr, out_cap) -> i32`. Buffer-too-small still returns the required size for caller retry. Negative values are reserved for transport-level errors (see Error Handling).

**ABI-shape changes.** Two host imports change their signatures (not just their wire format) as part of this cutover:

- **`host_spawn`** today has two forms — the generic `(req_ptr, req_len) -> pid` (returns the new pid as the i32 directly) and a legacy 4-arg form for the shell test path. This split is folded into the 4-arg form. After the cutover, `host_spawn(req_ptr, req_len, out_ptr, out_cap) -> i32` is the only ABI; the host writes a `SpawnResponse` containing either `SpawnOk { pid }` or `ErrorInfo`. The C `posix_spawn` shim (`abi/src/yurt_spawn.c`) reads the response, returns the pid (or sets `errno` from `ErrorInfo.code` and returns `-1`). The `syncSpawn` legacy callback type in `kernel-imports.ts` is replaced by a single spawn handler that writes a `SpawnResponse`. All call sites that today consume the i32 return as a pid get updated.

- **`host_socket_close`** today is `(req_ptr, req_len) -> i32` with no output buffer; the `i32` carries the close result directly. After the cutover, `host_socket_close(req_ptr, req_len, out_ptr, out_cap) -> i32` becomes the signature; the host writes a `SocketCloseResponse` containing either `SocketCloseOk` (empty) or `ErrorInfo` so close failures can be surfaced with a typed POSIX errno. C call sites in `abi/src/yurt_socket.c` are updated to pass an output buffer.

These are the only "wire-format-only" boundary crossings — all other quartet additions preserve their existing 4-arg signatures.

### Per-table file identifiers (wrong-root guarantee)

FlatBuffers' verifier alone can't distinguish "valid `FetchRequest`" from "valid `SpawnRequest` decoded as `FetchRequest`" — vtable layout collisions can let a wrong-type buffer read as defaults. The spec uses **per-call file identifiers** to close that gap:

- Each top-level request and response table is built with a distinct 4-byte ASCII tag (e.g. `"FREQ"` for `FetchRequest`, `"FRSP"` for `FetchResponse`, `"SREQ"` for `SpawnRequest`, etc.).
- Builders call `builder.finish(root, "<TAG>")` (Rust: `fbb.finish(root, Some("<TAG>"))`).
- Readers call the language-equivalent `<Tag>BufferHasIdentifier(buf, "<TAG>")` (or `flatbuffers::buffer_has_identifier`) before any other access.
- A mismatch returns transport-level `-2` ("Request FlatBuffer is malformed / wrong root type"). No further parsing is attempted.

The per-call tag table is part of the schema (commented constants alongside each table) and mirrored into Rust + TS as named constants. The tag space is namespaced: requests `*REQ`, responses `*RSP`. Implementation plan will assign concrete tags.

## Schema

### Shared types

```fbs
namespace YurtAbi;

table KvPair    { key: string; value: string; }
table EnvVar    { key: string; value: string; }
table ErrorInfo { code: int32; message: string; source: string; }

// Per-call file identifiers go in named constants (mirrored into Rust + TS):
//   FREQ = "FREQ" (FetchRequest)         FRSP = "FRSP" (FetchResponse)
//   SREQ = "SREQ" (SpawnRequest)         SRSP = "SRSP" (SpawnResponse)
//   ... one tag per table; full table assigned at implementation time.
```

### Quartet shape (representative)

Each call follows the same `(Request, Ok, Result union, Response)` quartet pattern. Three fully-drawn examples; the full inventory follows.

```fbs
table FetchRequest         { url: string; method: string; headers: [KvPair];
                             body: [ubyte]; redirect: byte; /* 0=follow,1=manual */ }
table FetchOk              { status: int32; headers: [KvPair]; body: [ubyte]; }
union FetchResult          { FetchOk, ErrorInfo }
table FetchResponse        { result: FetchResult; }

table SpawnRequest         { prog: string; argv0: string; args: [string]; env: [EnvVar];
                             cwd: string; stdin_fd: int32; stdout_fd: int32; stderr_fd: int32; }
table SpawnOk              { pid: int32; }
union SpawnResult          { SpawnOk, ErrorInfo }
table SpawnResponse        { result: SpawnResult; }

table SocketRecvRequest    { fd: int32; max_bytes: int32; nonblocking: bool; }
table SocketRecvOk         { data: [ubyte]; }
union SocketRecvResult     { SocketRecvOk, ErrorInfo }
table SocketRecvResponse   { result: SocketRecvResult; }
```

### Full inventory

Every host import with a buffer pointer in its current signature gets a quartet, regardless of today's encoding. Pure-scalar imports (no buffer pointers anywhere) stay scalar. Naming convention: `<Family><Verb>Request/Ok/Result/Response`.

**Process / exec.**

| Host import | Quartet root | Notes |
|---|---|---|
| `host_pipe` | `Pipe` (response only) | No request payload. |
| `host_spawn` | `Spawn` | ABI-shape change; see "Calling convention". |
| `host_run_command` | `RunCommand` | stdout/stderr as `[ubyte]`. |
| `host_wait` | `Wait` | **Fold of four:** `host_waitpid`, `host_waitpid_nohang`, `host_wait_any`, `host_wait_any_nohang`. Request carries `pid: int32` (or sentinel for "any") and `nohang: bool`. |
| `host_list_processes` | `ListProcs` | `[ProcessInfo]` payload. |
| `host_dup` | `Dup` | |
| `host_read_fd` | `ReadFd` | Currently mixed format (raw bytes on success, JSON on error). After cutover: uniform `ReadFdResponse`. |
| `host_write_fd` | `WriteFd` | ABI-shape change: gains a response buffer. Today: `(fd, data_ptr, data_len) -> i32`. After: 4-arg with `WriteFdResponse`. |
| `host_read_command` | `ReadCommand` | Currently raw bytes out. |
| `host_write_result` | `WriteResult` | ABI-shape change: gains a response buffer. Today: `(result_ptr, result_len) -> void`. After: 4-arg with response. |

**Network.**

| Host import | Quartet root | Notes |
|---|---|---|
| `host_network_fetch` | `Fetch` | `body` is `[ubyte]` — no base64. |
| `host_dns_resolve` | `DnsResolve` | Currently raw bytes; FB-ified for uniformity. |
| `host_extension_invoke` | `ExtensionInvoke` | |
| `host_native_invoke` | — | **Deleted**, no replacement in this cutover. |
| `host_get_local_addr` | `GetLocalAddr` | Currently raw bytes. |

**Sockets.**

| Host import | Quartet root | Notes |
|---|---|---|
| `host_socket_connect` | `SocketConnect` | |
| `host_socket_bind` | `SocketBind` | |
| `host_socket_listen` | `SocketListen` | |
| `host_socket_accept` | `SocketAccept` | |
| `host_socket_addr` | `SocketAddr` | |
| `host_socket_send` | `SocketSend` | |
| `host_socket_recv` | `SocketRecv` | |
| `host_socket_option` | `SocketOption` | |
| `host_socket_close` | `SocketClose` | ABI-shape change; see "Calling convention". |

(`host_socket_open` stays scalar — no buffer pointers.)

**VFS / filesystem.**

| Host import | Quartet root | Notes |
|---|---|---|
| `host_stat` | `Stat` | |
| `host_readdir` | `Readdir` | |
| `host_glob` | `Glob` | |
| `host_read_file` | `ReadFile` | Currently raw bytes out. |
| `host_write_file` | `WriteFile` | ABI-shape change: gains response buffer. |
| `host_readlink` | `Readlink` | Currently raw string out. |
| `host_getcwd` | `Getcwd` | Currently raw string out. |
| `host_chdir` | `Chdir` | ABI-shape change: gains response buffer. |
| `host_chmod` | `Chmod` | ABI-shape change: gains response buffer. |
| `host_chown` | `Chown` | ABI-shape change: gains response buffer. |
| `host_mkdir` | `Mkdir` | ABI-shape change: gains response buffer. |
| `host_remove` | `Remove` | ABI-shape change: gains response buffer. |
| `host_rename` | `Rename` | ABI-shape change: gains response buffer. |
| `host_symlink` | `Symlink` | ABI-shape change: gains response buffer. |
| `host_register_tool` | `RegisterTool` | ABI-shape change: gains response buffer. |
| `host_has_tool` | `HasTool` | Currently `(name_ptr, name_len) -> i32` boolean. ABI-shape change. |

(`host_setjmp` / `host_longjmp` stay raw — `jmp_buf` is opaque save state with bit-for-bit C ABI compatibility requirements.)

**TTY / process resources.**

| Host import | Quartet root | Notes |
|---|---|---|
| `host_tcgetattr` | `Tcgetattr` | Currently marshals raw `struct termios`. |
| `host_tcsetattr` | `Tcsetattr` | ABI-shape change: gains response buffer. |
| `host_winsize` | `Winsize` | Currently raw struct out. |
| `host_getrlimit` | `Getrlimit` | Currently raw struct out. |
| `host_sched_getaffinity` | `SchedGetaffinity` | Currently raw cpu_set out. |
| `host_sched_setaffinity` | `SchedSetaffinity` | ABI-shape change: gains response buffer. |

**Resident PID-1 protocol (guest exports).**

| Export | Quartet root |
|---|---|
| `__run_command` | `Pid1RunCommand` |
| `__set_env` | `SetEnv` |

The `Pid1RunCommand*` family is intentionally distinct from the host-import `RunCommand*` family. Same naming root, different protocol; the type-level separation prevents one being mistaken for the other.

### Schema invariants

- **One `ErrorInfo` table reused everywhere.** Per-call unions point at the same shared error type.
- **Empty `Ok` tables are valid.** FlatBuffers unions cannot have a "null" arm; an empty table is the idiomatic way to signal void success (e.g., `SocketBindOk`, `SetEnvOk`).
- **Body bytes are `[ubyte]`, never strings.** No base64 anywhere.
- **Field IDs are never reused.** Deprecated fields go behind `(deprecated)`. This is the only versioning mechanism we lean on.
- **Every top-level request and response table has a unique file identifier**, enforced at build/finish and verified at read.

## Rust Helper Crate & C Boundary

### Crate layout

```
abi/rust/yurt-abi-fb/
  Cargo.toml             # depends on flatbuffers crate
  src/
    lib.rs               # re-exports generated bindings + FFI modules
    generated.rs         # COMMITTED. Output of `flatc --rust`.
    error_codes.rs       # COMMITTED. Mirror of the schema's error code constants.
    identifiers.rs       # COMMITTED. Per-table file-identifier constants.
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
) -> YurtFbBuf;     // builder calls fbb.finish_with_identifier(root, "FREQ")

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
) -> i32; // 0 = ok, -1 = malformed buffer, -2 = wrong root identifier
```

### C-side ergonomics — pattern macros

The build/call/read/free dance is uniform across C shims. To keep each shim short, the C side provides a small set of pattern macros in a new header `abi/include/yurt_fb.h`, e.g.:

```c
// Path-string mutating syscall: builds a single-path request, calls the host
// import, reads the response, sets errno from ErrorInfo.code on failure, and
// returns 0 / -1 in POSIX shape.
#define YURT_FB_PATH_OP(call, build_fn, read_fn, path)        \
  /* expands to: build req → host_##call() → read resp →     \
     map ErrorInfo.code to errno → free → return 0/-1 */

// Two-path syscalls (rename, symlink), fd+arg syscalls (chown/fchown), etc.
// have analogous macros following the same shape.
```

A C shim like `int chmod(const char *path, mode_t mode)` collapses to one or two lines using these macros. The macros live in the C ABI library, not generated. They are not part of the public C API — only the `yurt_*` shims use them.

### Buffer ownership

- **Builder output (`YurtFbBuf`)** is heap-owned by `yurt-abi-fb`. C callers must call `yurt_fb_free_buf` after the host import returns. The `_opaque` field carries the reclaim handle (boxed `Vec<u8>`) so Rust safely reconstructs ownership.
- **Reader inputs** are caller-owned (the host writes into wasm linear memory). Reader output structs hold borrowed pointers into that buffer — valid only until the buffer is reused. C callers must consume the read result before issuing the next host import call. Strings/bytes are returned as `(ptr, len)` pairs, never null-terminated; C callers `memcpy` what they need to retain.

### TS side

```ts
// packages/kernel/src/host-imports/_generated/yurt_abi.ts (committed)
import { ByteBuffer, Builder } from 'flatbuffers';
export namespace YurtAbi { /* generated tables */ }

// kernel-imports.ts
import { YurtAbi } from './_generated/yurt_abi.js';

// IMPORTANT: copy bytes off wasm memory before any async work — see caveat below.
const reqBytes = new Uint8Array(memory.buffer, reqPtr, reqLen).slice();
const req = YurtAbi.FetchRequest.getRootAsFetchRequest(new ByteBuffer(reqBytes));
```

**`writeJson` is replaced** by a generic `writeFlatbuffer(memory, ptr, cap, builder.asUint8Array())` that follows the existing "return required size on overflow" convention.

**TS zero-copy caveat (memory growth).** `Uint8Array` views over `WebAssembly.Memory.buffer` are only valid while the underlying `ArrayBuffer` is current. Two events invalidate them:

1. The wasm guest grows linear memory (`memory.grow`).
2. In Node/Deno, the memory backing buffer is detached when transferred.

For synchronous host imports this is not an issue — the guest is suspended for the call duration and cannot grow memory. For **async host imports** (JSPI: `host_network_fetch`, `host_socket_accept`, `host_kill`, `host_yield`, `host_dns_resolve`, `host_run_command`, `host_extension_invoke`, etc.), the host must:

1. **Read the request as a `.slice()` copy** before any `await`. Never hold a `ByteBuffer` over a yield point.
2. **Re-derive the response-buffer view** (`new Uint8Array(memory.buffer, outPtr, outCap)`) **after** the awaited work completes, immediately before writing. Don't capture a `Uint8Array` view, await, and then write to the captured view.

The replacement `writeFlatbuffer(memory, ...)` helper takes `memory` (not a pre-derived view) so it always reads `memory.buffer` fresh. This is enforced at the helper API; callers don't get a footgun.

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
      run: |
        git diff --exit-code -- \
          abi/rust/yurt-abi-fb/src/generated.rs \
          packages/kernel/src/host-imports/_generated/yurt_abi.ts
```

The pinned `flatc` version is recorded **only** in the CI workflow file (single source of truth, listed in "Open questions" until set at implementation time). The spec deliberately does not duplicate the version pin; the workflow file is authoritative.

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

The pinned version is set in the CI job at implementation time and listed in "Open questions" below until then.

## Error Handling

Errors flow through one of two channels. The spec is strict about which goes where.

### Channel 1 — Negative `i32` return value (transport-level)

Reserved for situations where the host can't produce a meaningful FlatBuffer response.

| Value | Meaning |
|---|---|
| `>=0` and `<=out_cap` | Bytes written into `out_ptr`. Caller parses a `*Response` FlatBuffer. |
| `>out_cap` | Required buffer size for retry (existing semantics). |
| `-1` | Host crashed / unhandled exception during dispatch. |
| `-2` | Request FlatBuffer is malformed or has the wrong root identifier. |
| `-3` | Required size overflowed `i32`. (Practically unreachable; reserved.) |
| `-4..=-7` | Reserved for future transport-layer errors. |

Negative codes never carry message text. There is **no `errno`-style side channel** — the host doesn't maintain per-thread error state. Callers retry, log, or surface upward.

The wrong-root case is detected by the per-table file identifier check (see "Per-table file identifiers" in Architecture).

### Channel 2 — `ErrorInfo` in the response union (kernel-level)

Normal "the call ran but failed" case. A well-formed response is written; its union arm is `ErrorInfo`. Examples:

- DNS failure on fetch → `ErrorInfo { code: -100, message: "getaddrinfo: example.invalid", source: "host_network_fetch" }`. Transport `i32` is `bytes_written`.
- Program not found on spawn → `ErrorInfo { code: 2 /* ENOENT */, message: "no such file: /bin/foo", source: "host_spawn" }`.

### Error code numbering — POSIX errnos

`ErrorInfo.code` carries a **POSIX errno** in its standard positive range. No parallel custom range. The kernel implements POSIX where reasonable; reusing POSIX errnos avoids a parallel namespace and lets the C ABI shims map `ErrorInfo.code` straight into `errno` with no translation.

The full POSIX-errno space (1..~256, depending on platform) is available. Where a yurt-specific cause maps onto a POSIX errno, use it:

| Cause | POSIX errno | Numeric (Linux) |
|---|---|---|
| File / fd not found | `ENOENT` | 2 |
| Bad fd | `EBADF` | 9 |
| Permission denied | `EACCES` | 13 |
| Path component is not a directory | `ENOTDIR` | 20 |
| Already exists | `EEXIST` | 17 |
| Invalid argument / malformed payload | `EINVAL` | 22 |
| Buffer too small (caller side) | `EOVERFLOW` | 75 |
| Bad UTF-8 in payload | `EILSEQ` | 84 |
| DNS / host unreachable | `EHOSTUNREACH` | 113 |
| TLS handshake / connection reset | `ECONNRESET` | 104 |
| Connection refused | `ECONNREFUSED` | 111 |
| Redirect limit exceeded | `ELOOP` | 40 |
| WASM validation / entry-point missing | `ENOEXEC` | 8 |
| Process not found | `ESRCH` | 3 |
| No process: would block | `EAGAIN` | 11 |
| Operation not permitted | `EPERM` | 1 |

When POSIX has multiple plausible candidates and none fits cleanly, pick the closest and put the precise cause in `message`. Callers branch on `code` (POSIX errno), surface `message` to humans, and use `source` for debugging — same discipline as in the prior draft.

**Yurt-specific extension range — not used in this cutover.** If a future kernel concept genuinely has no POSIX analogue, codes ≥ 256 are reserved for yurt-specific extensions (placing them safely above any current Linux errno). This range stays empty in this cutover; an explicit decision plus a spec amendment are required to allocate from it.

Numbering — i.e., the curated mapping table — lives in `abi/schema/yurt_abi.fbs` as commented constants alongside `ErrorInfo`. Mirrored into `abi/rust/yurt-abi-fb/src/error_codes.rs` and a TS sibling at `packages/kernel/src/host-imports/_generated/yurt_abi_error_codes.ts` as named constants (the standard `E*` POSIX names). Mirrors are hand-maintained; the `abi-fb-drift` CI job greps the `.fbs` for the `code` annotation block and asserts each appears in both mirrors.

### Discipline rules

1. Hosts never return Channel-1 negatives for kernel-domain failures. "DNS lookup failed" goes through `ErrorInfo`, not `-1`.
2. Callers must check the union discriminator before reading the success arm. The FlatBuffers API enforces this on both languages.
3. `message` is for humans, `code` is for code. Callers must not string-match on `message`. Branching on `code` is the only supported error-handling discipline.
4. `source` is debugging-only. Optional but encouraged. Never load-bearing.
5. Retired error codes are never reused. Deprecation comments stay in the schema; the constant stays defined so old binaries don't silently misinterpret.

### What this replaces

- The current JSON `{ ok: false, error: "..." }` shape → `Response.result == ErrorInfo` with a POSIX errno.
- Today's implicit "host returned -1, just guess what went wrong" → explicit `-1` / `-2` reservations above (transport-level only).
- The current `host_spawn` "negative pid means error, look at errno" → `SpawnResponse.result == ErrorInfo` with a typed POSIX errno.
- The current `host_read_fd` mixed format (raw bytes on success, JSON `{error}` on failure) → uniform `ReadFdResponse` quartet.
- The current `yurt_pclose`-style "captured raw exit code" pattern is preserved (exit codes stay in `RunCommandOk.exit_code`); only error metadata moves.
- The wait family's four separate ABIs → single `host_wait`.

## Testing Strategy

### Layer 1 — Schema round-trip

`abi/rust/yurt-abi-fb/tests/round_trip.rs` (Rust) and a sibling Deno test. For each table: build with representative data, read back, assert all fields match. Cross-language byte-for-byte parity asserted via a tmp-file fixture exchange. Catches schema/code mismatches, endianness assumptions, vtable hash divergence between language emitters.

Identifier verification: every quartet has a test that builds a buffer with the wrong identifier and asserts the reader rejects it.

### Layer 2 — `yurt-abi-fb` `extern "C"` boundary

`abi/rust/yurt-abi-fb/tests/ffi.rs`: every `yurt_fb_build_*` and `yurt_fb_read_*` exercised. Build via FFI / read via Rust API and vice-versa. Negative cases (malformed bytes return -1, wrong identifier returns -2, oversize inputs respect bounds, error-arm responses correctly discriminated). Lifetime correctness via miri or ASan in CI catches use-after-free.

### Layer 3 — TS host-import unit tests

Migrate every existing `kernel-imports.ts` test to the FlatBuffers shape. Files under `packages/kernel/src/host-imports/__tests__/`. Per fat call: at least one happy-path test, one `ErrorInfo`-arm test, one buffer-too-small (retry-with-required-size) test, and (for async imports) one memory-growth test that grows wasm memory across the await and asserts no stale-view crash. New helper `__tests__/fb-helpers.ts` keeps individual tests short.

### Layer 4 — C ABI conformance canaries

Existing `abi/conformance/c/` canaries call high-level C ABI functions (`yurt_system`, `yurt_popen`, `yurt_fetch_text`); they don't speak the wire format directly and should pass unchanged after the C-side refactor. New canaries:

- `fetch-binary-canary.c` — fetch a known binary blob, verify bytes match. Was previously impossible due to base64 round-trip.
- `spawn-large-env-canary.c` — `posix_spawn` with a 256-entry env vector. Validates the `[EnvVar]` path under realistic load.
- `socket-recv-binary-canary.c` — exercise the socket-recv binary path.

### Layer 5 — Resident PID-1 fixture validation

`test-fixtures/shell-exec/src/main.rs` is updated so `__set_env` and `__run_command` consume FB requests and produce FB responses. Rust unit tests for the round-trip. Existing kernel tests that drive these exports (e.g., the env-propagation cases introduced by PR #7) get switched to FB request construction. Two regenerated `.wasm` fixtures (`bash.wasm`, `bash-asyncify.wasm`) land in the same commit as the source change — same discipline as PR #7.

### Layer 6 — Drift check

The CI `abi-fb-drift` job (already detailed in the Build Pipeline section). Listed here because schema/code drift is functionally a regression class.

### Layer 7 — End-to-end smoke

The full `deno test` over `packages/kernel` is the integration backstop. Pass criterion: every test that passed on `main` passes after the cutover, with the same expected outputs. The PR-#7-era yurt-greet runtime smoke tests must remain green against the new FB ABI.

### Test plan checklist (will be reused in the implementation PR)

- [ ] `cargo test -p yurt-abi-fb` green (Layers 1–2).
- [ ] `cd abi && make canaries` green; new fetch-binary, spawn-large-env, socket-recv-binary canaries land.
- [ ] `deno task test` over `packages/kernel` green (Layer 3, 7).
- [ ] `bash.wasm` + `bash-asyncify.wasm` regenerated and committed; `__set_env` / `__run_command` tests pass.
- [ ] CI `abi-fb-drift` job green.
- [ ] Manual: REPL `cli.ts -c 'echo hello'` still produces `hello` (smoke).

## Open questions deferred to implementation

- Concrete field layouts for every quartet in the inventory (the spec spells out the pattern; the implementation plan fills in field-by-field tables).
- Concrete 4-byte file identifiers for every quartet (the spec assigns them at implementation time per the `*REQ` / `*RSP` namespacing rule).
- Per-call POSIX errno mapping for cases not in the curated table above — assigned per-call as the implementation lands. Default discipline: pick the closest standard POSIX errno; only allocate from the ≥256 yurt-extension range with an explicit spec amendment.
- Pinned `flatc` version (e.g., `25.x.y`) — chosen against the latest stable at implementation time; recorded in the CI workflow file (single source of truth).
- Optional: extracting a `make abi-fb-codegen-check` that runs `cargo check -p yurt-abi-fb` as part of the drift CI, to catch generated code that compiles in isolation but breaks downstream callers. Default: not included; add only if the layered test suite proves insufficient.

## Migration & rollout

Single PR delivers the entire cutover on a worktree:

1. Add `abi/schema/yurt_abi.fbs` (full inventory).
2. Add `abi/rust/yurt-abi-fb` crate (generated.rs, error_codes, identifiers, FFI surface, Cargo workspace entry).
3. Switch `kernel-imports.ts`, `wasi-host.ts`, and friends to the FB code path; delete `writeJson` and `JSON.parse` paths.
4. Switch `abi/src/yurt_*.c` shims to call `yurt_fb_build_*` / `yurt_fb_read_*`; delete hand-rolled JSON helpers.
5. Normalize `host_spawn` onto the 4-arg ABI; update every spawn caller and the `syncSpawn` legacy-handler type.
6. Delete `host_native_invoke` end-to-end.
7. Update `test-fixtures/shell-exec/src/main.rs`; regenerate `bash.wasm` and `bash-asyncify.wasm`.
8. Migrate and extend tests across all layers.
9. Add the `abi-fb-drift` CI job.

There is no JSON/FB coexistence period.
