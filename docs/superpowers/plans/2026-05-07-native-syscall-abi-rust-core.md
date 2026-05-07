# Native Syscall ABI Host-Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove JSON and FlatBuffers from the syscall boundary without pushing ABI complexity into guest programs. Guests call normal Wasm host imports. Rust/Wasmtime and TS/Deno/browser hosts decode guest memory at the host boundary.

**Architecture:** `abi/contract/yurt_abi.toml` is the inspectable ABI contract. It generates the C guest header, Rust host constants/layouts, TypeScript host metadata, and Markdown reference. There is no guest-side ABI codec crate. The C ABI runtime only contains thin libc/POSIX compatibility wrappers and small local request builders where a compound request is unavoidable. Rust Wasmtime import handlers read/write guest memory directly through `wasmtime::Caller`. The TypeScript host fallback uses the same import signatures and decodes the same guest memory bytes in TS. Shared byte fixtures enforce Rust/TS parser equivalence.

**Tech Stack:** Rust 2024, Wasmtime, WASIp1, TypeScript/Deno tests, C ABI runtime, cargo-yurt/yurt-cc.

---

## File Structure

- Keep `abi/contract/yurt_abi.toml`: authoritative human-readable ABI contract.
- Keep `scripts/generate-native-abi.ts`: generator for committed ABI views.
- Keep generated `abi/include/yurt_abi.h`: guest-facing C declarations and small structs.
- Keep generated `packages/runtime-wasmtime/src/wasm/native_abi_generated.rs`: Rust host constants/layout structs.
- Keep generated `packages/kernel/src/host-imports/native-generated.ts`: TS host metadata.
- Keep generated `docs/abi/native-syscall-abi.md`: reviewable complete ABI reference.
- Do not create `abi/rust/yurt-abi-core`.
- Modify `abi/src/yurt_runtime.h`, `abi/src/yurt_pipe.c`, `abi/src/yurt_dup.c`, `abi/src/yurt_spawn.c`, `abi/src/yurt_command.c`, `abi/src/yurt_fetch.c`, `abi/src/yurt_socket.c`, and `abi/src/yurt_netdb.c`: call native imports and remove JSON/FB helpers.
- Modify `packages/runtime-wasmtime/src/wasm/{mod,kernel,spawn,network}.rs`: decode pointer/span inputs in host import handlers.
- Modify `packages/kernel/src/host-imports/{common.ts,kernel-imports.ts}`: remove `writeJson`, FlatBuffers imports, and legacy JSON compatibility branches; decode native request bytes in TS fallback.
- Add shared parser fixtures under `packages/kernel/src/host-imports/__fixtures__/native-abi/` and test them from Rust and TS.
- Delete `packages/kernel/src/host-imports/fb.ts`, `packages/kernel/src/host-imports/_generated/`, `abi/schema/yurt_abi.fbs`, `abi/rust/yurt-abi-fb/`, and `abi/src/yurt_fb.h` after no import uses them.

---

### Task 1: Keep ABI Contract, Remove Core Crate

**Files:**
- Modify: `scripts/generate-native-abi.ts`
- Modify: `scripts/generate-native-abi.test.ts`
- Delete: `abi/rust/yurt-abi-core/`
- Modify: `Cargo.toml`
- Modify: `Cargo.lock`

- [ ] **Step 1: Generate Rust metadata into the host runtime**

The generator writes Rust output to:

```text
packages/runtime-wasmtime/src/wasm/native_abi_generated.rs
```

It must not write to `abi/rust/yurt-abi-core`.

- [ ] **Step 2: Remove the core crate**

Delete `abi/rust/yurt-abi-core/` and remove it from workspace `members`, `default-members`, and `Cargo.lock`.

- [ ] **Step 3: Verify contract drift**

Run:

```bash
make -C abi check-native-abi-contract
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write scripts/generate-native-abi.test.ts
```

Expected: both pass.

- [ ] **Step 4: Commit**

```bash
git add scripts/generate-native-abi.ts scripts/generate-native-abi.test.ts packages/runtime-wasmtime/src/wasm/native_abi_generated.rs Cargo.toml Cargo.lock abi/rust/yurt-abi-core
git commit -m "Keep native ABI decoding at host boundary"
```

---

### Task 2: Native Pipe, Dup, And Wait

**Files:**
- Modify: `abi/src/yurt_runtime.h`
- Modify: `abi/src/yurt_pipe.c`
- Modify: `abi/src/yurt_dup.c`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/runtime-wasmtime/src/wasm/kernel.rs`

- [ ] **Step 1: Declare only native imports**

`abi/src/yurt_runtime.h` declares:

```c
int yurt_host_pipe(int out_ptr, int out_cap);
int yurt_host_dup(int fd, int out_ptr, int out_cap);
int yurt_host_wait(int pid, int flags, int out_ptr, int out_cap);
```

Remove old wait-family imports and `yurt_host_run_command`.

- [ ] **Step 2: Use fixed output structs**

`host_pipe` writes `yurt_pipe_result_v1`. `host_wait` writes `yurt_wait_result_v1`. Small-buffer behavior uses required-size/no-partial-write semantics because these are structured outputs.

- [ ] **Step 3: Verify**

Run:

```bash
make -C abi copy-fixtures rust-canaries rust-std-canaries
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi.test.ts
```

Expected: pipe, dup, wait, and process canaries pass.

---

### Task 3: Stream File And Socket I/O

**Files:**
- Modify: `abi/src/yurt_socket.c`
- Modify: `abi/src/yurt_fetch.c`
- Modify: `abi/src/yurt_netdb.c`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/runtime-wasmtime/src/wasm/network.rs`

- [ ] **Step 1: Use direct span imports for byte streams**

Use:

```text
host_read_fd(fd, out_ptr, out_cap)
host_write_fd(fd, data_ptr, data_len)
host_socket_recv(fd, out_ptr, out_cap, flags)
host_socket_send(fd, data_ptr, data_len, flags)
```

These calls follow POSIX partial transfer semantics: return bytes transferred, `0` for EOF on reads, negative errno on failure, and `-EAGAIN` for nonblocking no-progress. They never use required-size retry behavior.

- [ ] **Step 2: Keep structured outputs only where needed**

DNS and fetch may use compact native records because their outputs are structured/variable. Decoding happens in host import handlers, not in a shared guest codec crate.

- [ ] **Step 3: Verify**

Run socket/fd tests plus ABI canaries:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__ packages/kernel/src/__tests__/abi.test.ts
```

---

### Task 4: Spawn And Command Compatibility

**Files:**
- Modify: `abi/src/yurt_spawn.c`
- Modify: `abi/src/yurt_command.c`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/runtime-wasmtime/src/wasm/spawn.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/command.rs`

- [ ] **Step 1: Keep guest spawn builder local**

`abi/src/yurt_spawn.c` may build the minimal native spawn request record needed by `host_spawn`. This builder is local C runtime code, not a general ABI framework.

- [ ] **Step 2: Decode spawn at the host boundary**

Rust Wasmtime decodes request bytes inside the `host_spawn` implementation. TS fallback decodes the same bytes in `kernel-imports.ts`.

- [ ] **Step 3: Remove command execution syscall**

`host_run_command` is not part of the ABI. Delete `yurt_json_call`, command JSON builders, command JSON parsers, and any host command import.

Implement `yurt_system`, `yurt_popen`, Python subprocess compatibility, and PID-1 command helpers through normal process operations: spawn shell/executable, pipe stdin/stdout/stderr, read/write fds, and wait.

- [ ] **Step 4: Verify**

Run:

```bash
make -C abi copy-fixtures rust-canaries rust-std-canaries
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi.test.ts
```

Expected: `system`, `popen`, Rust std process canaries, and shell-exec fixtures pass.

---

### Task 5: Parser Equivalence Fixtures

**Files:**
- Create: `packages/kernel/src/host-imports/__fixtures__/native-abi/`
- Create: `packages/kernel/src/host-imports/__tests__/native-record-fixtures.test.ts`
- Create or modify: `packages/runtime-wasmtime/src/wasm/*_tests.rs`

- [ ] **Step 1: Add shared bytes**

Add valid and malformed request fixtures for compound records that remain, starting with spawn and network fetch. Include malformed cases for:

- logical size larger than request length;
- logical size smaller than minimum;
- unaligned offsets;
- offset+length overflow;
- vector count out of bounds;
- invalid UTF-8;
- unknown version.

- [ ] **Step 2: Assert equivalent results**

Rust and TS parsers must return the same decoded value for valid fixtures and the same negative errno for malformed fixtures.

- [ ] **Step 3: Verify**

Run:

```bash
cargo test -p runtime-wasmtime native_abi
/Users/sunny/.deno/bin/deno test --no-check --allow-read packages/kernel/src/host-imports/__tests__/native-record-fixtures.test.ts
```

---

### Task 6: Delete JSON And FlatBuffers ABI Artifacts

**Files:**
- Delete: `abi/schema/yurt_abi.fbs`
- Delete: `abi/rust/yurt-abi-fb/`
- Delete: `packages/kernel/src/host-imports/fb.ts`
- Delete: `packages/kernel/src/host-imports/_generated/`
- Delete: `abi/src/yurt_fb.h`
- Modify: `Cargo.toml`
- Modify: `abi/Makefile`

- [ ] **Step 1: Remove old artifacts**

Remove schema generation, FB build rules, generated TS bindings, and the FB Rust crate once no import uses them.

- [ ] **Step 2: Add grep guard**

Reject ABI-boundary references to:

```text
writeJson
JSON.parse(readString
FlatBuffer|flatbuffers|yurt_fb|yurt_abi.fbs
host_waitpid|host_wait_any
host_run_command|RunCommand|run_command|yurt_json_call
```

- [ ] **Step 3: Final verification**

Run:

```bash
make -C abi check-native-abi-contract
cargo check --target wasm32-wasip1 -p yurt-shell-exec
make -C abi copy-fixtures rust-canaries rust-std-canaries
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi.test.ts
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__
```

Expected: every command passes. Any preexisting unrelated failure must be documented with the exact failing test and reason before merge.

---

## Self-Review

- Guest complexity: guests call host imports and local libc wrappers only; no shared ABI codec crate.
- Host ownership: Rust/Wasmtime and TS fallback decode guest memory at their import boundary.
- Browser/Deno support: TS fallback remains first-class and is tested with shared fixtures.
- Contract clarity: generated docs and headers keep the ABI inspectable without adding runtime schema dependencies.
- Command execution: shell execution is normal process execution, not a host syscall.
