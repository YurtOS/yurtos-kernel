# Native Syscall ABI Rust Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace JSON/FlatBuffers host-call payloads with a native syscall ABI and move pointer/buffer record handling into Rust.

**Architecture:** Create `abi/rust/yurt-abi-core` as the single owner of native record layouts, errno constants, guest-memory helpers, and fixed-output encoders. Wire that core directly into the Rust Wasmtime runtime where Rust can read guest memory from `wasmtime::Caller`; keep the TypeScript runtime as a transitional compatibility harness while removing all JSON/FlatBuffers payloads from canaries and ABI shims.

**Tech Stack:** Rust 2024, Wasmtime, WASIp1, TypeScript/Deno tests, C ABI runtime, cargo-yurt/yurt-cc.

---

## Source Worktree Notes

Reuse these existing worktrees as reference material:

- `/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/rust-abi-pilot`
  - `abi/rust/yurt-abi-impl/src/lib.rs`: Rust-owned ABI implementation shape, marker/version pattern, errno setting, no-std C ABI compatibility.
  - `abi/rust/yurt-abi-sys`: build/link wrapper for `libyurt_abi.a`.
  - `packages/runtime-wasmtime/src/wasm/mod.rs`: direct Wasmtime `Caller` memory helpers (`read_mem`, `read_str`, `write_out`) and Rust host-import registration.
  - `packages/runtime-wasmtime/src/wasm/kernel.rs`: Rust process/fd kernel sketch.
- `/Users/sunny/work/yurtos/yurtos-kernel/.worktrees/rust-abi-high-impact`
  - `abi/rust/yurt-abi-fb/src/ffi/{buffer,build,read}.rs`: useful FFI boundary patterns and test structure, but do not keep FlatBuffers.
  - `abi/rust/yurt-abi-fb/tests/*.rs`: adapt into native-record round-trip tests.

Do not copy FlatBuffers schema or generated bindings into the target design.

## File Structure

- Create `abi/rust/yurt-abi-core/Cargo.toml`: Rust library for ABI records and memory helpers.
- Create `abi/rust/yurt-abi-core/src/lib.rs`: module exports.
- Create `abi/rust/yurt-abi-core/src/errno.rs`: POSIX errno constants used by Rust host code and tests.
- Create `abi/rust/yurt-abi-core/src/memory.rs`: `GuestMemory` trait plus an in-memory test implementation.
- Create `abi/rust/yurt-abi-core/src/layout.rs`: native ABI structs and constants.
- Create `abi/rust/yurt-abi-core/src/codec.rs`: decoders/encoders for compound records.
- Create `abi/rust/yurt-abi-core/tests/codec.rs`: record and output encoding tests.
- Modify `Cargo.toml`: add `abi/rust/yurt-abi-core`, remove `abi/rust/yurt-abi-fb` once no code depends on it.
- Modify `abi/include/yurt_abi.h`: native structs/import declarations matching `layout.rs`.
- Modify `abi/src/yurt_runtime.h`: remove JSON/FlatBuffers comments and old wait imports.
- Modify `abi/src/yurt_pipe.c`, `abi/src/yurt_dup.c`, `abi/src/yurt_process.c`, `abi/src/yurt_spawn.c`, `abi/src/yurt_command.c`, `abi/src/yurt_fetch.c`, `abi/src/yurt_socket.c`, `abi/src/yurt_netdb.c`: call native imports and remove JSON/FB helpers.
- Modify `packages/runtime-wasmtime/src/wasm/mod.rs`: replace local memory helpers with `yurt_abi_core` helpers and native outputs.
- Modify `packages/runtime-wasmtime/src/wasm/{kernel,spawn,network}.rs`: replace JSON structs with native request/response records.
- Modify `packages/kernel/src/host-imports/{common.ts,kernel-imports.ts}`: remove `writeJson`, FlatBuffers imports, and legacy JSON compatibility branches; keep only native scalar/span signatures for the V8 test harness.
- Delete `packages/kernel/src/host-imports/fb.ts`, `packages/kernel/src/host-imports/_generated/`, `abi/schema/yurt_abi.fbs`, and `abi/rust/yurt-abi-fb/` after conversion.
- Add `packages/kernel/src/host-imports/__tests__/native-abi-shape.test.ts`: native signature/grep tests for the V8 harness.
- Modify `packages/kernel/src/__tests__/abi.test.ts`: expect native ABI canaries only.
- Modify `abi/Makefile`: remove FlatBuffers build/link steps and include the new Rust ABI core checks.

---

### Task 1: Rust ABI Core Skeleton

**Files:**
- Create: `abi/rust/yurt-abi-core/Cargo.toml`
- Create: `abi/rust/yurt-abi-core/src/lib.rs`
- Create: `abi/rust/yurt-abi-core/src/errno.rs`
- Modify: `Cargo.toml`

- [ ] **Step 1: Add the crate manifest**

Create `abi/rust/yurt-abi-core/Cargo.toml`:

```toml
[package]
name = "yurt-abi-core"
version = "0.1.0"
edition = "2024"

[dependencies]
```

- [ ] **Step 2: Add the module root**

Create `abi/rust/yurt-abi-core/src/lib.rs`:

```rust
#![forbid(unsafe_code)]

pub mod codec;
pub mod errno;
pub mod layout;
pub mod memory;
```

- [ ] **Step 3: Add errno constants**

Create `abi/rust/yurt-abi-core/src/errno.rs`:

```rust
pub const EPERM: i32 = 1;
pub const ENOENT: i32 = 2;
pub const ESRCH: i32 = 3;
pub const EINTR: i32 = 4;
pub const EIO: i32 = 5;
pub const ENOEXEC: i32 = 8;
pub const EBADF: i32 = 9;
pub const ECHILD: i32 = 10;
pub const EAGAIN: i32 = 11;
pub const EACCES: i32 = 13;
pub const EEXIST: i32 = 17;
pub const ENOTDIR: i32 = 20;
pub const EINVAL: i32 = 22;
pub const EOVERFLOW: i32 = 75;
pub const ENOTCONN: i32 = 107;
pub const ECONNRESET: i32 = 104;
pub const ECONNREFUSED: i32 = 111;
pub const EHOSTUNREACH: i32 = 113;

#[inline]
pub const fn neg(errno: i32) -> i32 {
    -errno
}
```

- [ ] **Step 4: Register the crate in the workspace**

Modify the root `Cargo.toml` `members` list to include:

```toml
  "abi/rust/yurt-abi-core",
```

Also add it to `default-members` while the migration is active:

```toml
  "abi/rust/yurt-abi-core",
```

- [ ] **Step 5: Run the skeleton check**

Run:

```bash
cargo check -p yurt-abi-core
```

Expected: `Finished dev profile` with no warnings.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml abi/rust/yurt-abi-core
git commit -m "Add native ABI core crate"
```

---

### Task 2: Guest Memory Trait And Tests

**Files:**
- Create: `abi/rust/yurt-abi-core/src/memory.rs`
- Create: `abi/rust/yurt-abi-core/tests/memory.rs`

- [ ] **Step 1: Add failing memory tests**

Create `abi/rust/yurt-abi-core/tests/memory.rs`:

```rust
use yurt_abi_core::errno;
use yurt_abi_core::memory::{GuestMemory, VecGuestMemory};

#[test]
fn read_span_copies_guest_bytes() {
    let mem = VecGuestMemory::from_bytes(b"abcdef".to_vec());
    assert_eq!(mem.read_span(1, 3).unwrap(), b"bcd");
}

#[test]
fn read_utf8_rejects_invalid_bytes() {
    let mem = VecGuestMemory::from_bytes(vec![0xff]);
    assert_eq!(mem.read_utf8(0, 1), Err(errno::neg(errno::EINVAL)));
}

#[test]
fn write_span_reports_required_size_without_partial_write() {
    let mut mem = VecGuestMemory::with_len(4);
    assert_eq!(mem.write_span(1, 2, b"abcd"), Ok(4));
    assert_eq!(mem.bytes(), &[0, 0, 0, 0]);
}

#[test]
fn write_span_writes_when_capacity_is_sufficient() {
    let mut mem = VecGuestMemory::with_len(8);
    assert_eq!(mem.write_span(2, 4, b"abcd"), Ok(4));
    assert_eq!(&mem.bytes()[2..6], b"abcd");
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cargo test -p yurt-abi-core --test memory
```

Expected: compile failure because `memory` module items are not defined.

- [ ] **Step 3: Implement memory helpers**

Create `abi/rust/yurt-abi-core/src/memory.rs`:

```rust
use crate::errno;

pub trait GuestMemory {
    fn read_span(&self, ptr: u32, len: u32) -> Result<Vec<u8>, i32>;

    fn read_utf8(&self, ptr: u32, len: u32) -> Result<String, i32> {
        let bytes = self.read_span(ptr, len)?;
        String::from_utf8(bytes).map_err(|_| errno::neg(errno::EINVAL))
    }

    fn write_span(&mut self, ptr: u32, cap: u32, data: &[u8]) -> Result<i32, i32>;
}

#[derive(Clone, Debug)]
pub struct VecGuestMemory {
    bytes: Vec<u8>,
}

impl VecGuestMemory {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub fn with_len(len: usize) -> Self {
        Self { bytes: vec![0; len] }
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

impl GuestMemory for VecGuestMemory {
    fn read_span(&self, ptr: u32, len: u32) -> Result<Vec<u8>, i32> {
        let start = ptr as usize;
        let len = len as usize;
        let end = start.checked_add(len).ok_or(errno::neg(errno::EOVERFLOW))?;
        if end > self.bytes.len() {
            return Err(errno::neg(errno::EFAULT));
        }
        Ok(self.bytes[start..end].to_vec())
    }

    fn write_span(&mut self, ptr: u32, cap: u32, data: &[u8]) -> Result<i32, i32> {
        if data.len() > cap as usize {
            return Ok(data.len() as i32);
        }
        let start = ptr as usize;
        let end = start
            .checked_add(data.len())
            .ok_or(errno::neg(errno::EOVERFLOW))?;
        if end > self.bytes.len() {
            return Err(errno::neg(errno::EFAULT));
        }
        self.bytes[start..end].copy_from_slice(data);
        Ok(data.len() as i32)
    }
}
```

- [ ] **Step 4: Run tests**

Run:

```bash
cargo test -p yurt-abi-core --test memory
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add abi/rust/yurt-abi-core/src/memory.rs abi/rust/yurt-abi-core/tests/memory.rs
git commit -m "Add Rust guest memory helpers"
```

---

### Task 3: Native Layouts And Codecs

**Files:**
- Create: `abi/rust/yurt-abi-core/src/layout.rs`
- Create: `abi/rust/yurt-abi-core/src/codec.rs`
- Create: `abi/rust/yurt-abi-core/tests/codec.rs`

- [ ] **Step 1: Add codec tests**

Create `abi/rust/yurt-abi-core/tests/codec.rs`:

```rust
use yurt_abi_core::codec;
use yurt_abi_core::layout::{YURT_ABI_RECORD_VERSION, YurtWaitResultV1};

#[test]
fn wait_result_encodes_little_endian_c_layout() {
    let bytes = codec::encode_wait_result(YurtWaitResultV1 {
        pid: 42,
        exit_code: 7,
        signal: 0,
        flags: 1,
    });
    assert_eq!(bytes.len(), 16);
    assert_eq!(&bytes[0..4], &42_i32.to_le_bytes());
    assert_eq!(&bytes[4..8], &7_i32.to_le_bytes());
    assert_eq!(&bytes[8..12], &0_i32.to_le_bytes());
    assert_eq!(&bytes[12..16], &1_i32.to_le_bytes());
}

#[test]
fn spawn_record_decodes_offsets() {
    let record = codec::test_spawn_record("/bin/echo", "echo", &["hello", "world"], &[("A", "B")], "/", &[3, 4]);
    let decoded = codec::decode_spawn_request(&record).unwrap();
    assert_eq!(decoded.version, YURT_ABI_RECORD_VERSION);
    assert_eq!(decoded.prog, "/bin/echo");
    assert_eq!(decoded.argv0, "echo");
    assert_eq!(decoded.args, ["hello", "world"]);
    assert_eq!(decoded.env, [("A".to_string(), "B".to_string())]);
    assert_eq!(decoded.cwd, "/");
    assert_eq!(decoded.pass_fds, [3, 4]);
}

#[test]
fn spawn_record_rejects_out_of_bounds_offset() {
    let mut record = codec::test_spawn_record("/bin/echo", "echo", &[], &[], "/", &[]);
    record[8..12].copy_from_slice(&9999_u32.to_le_bytes());
    assert!(codec::decode_spawn_request(&record).is_err());
}
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cargo test -p yurt-abi-core --test codec
```

Expected: compile failure because `layout` and `codec` contents are missing.

- [ ] **Step 3: Add native layouts**

Create `abi/rust/yurt-abi-core/src/layout.rs`:

```rust
pub const YURT_ABI_RECORD_VERSION: u16 = 1;
pub const YURT_WAIT_NOHANG: u32 = 1;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YurtAbiRecordHeader {
    pub size: u32,
    pub version: u16,
    pub flags: u16,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YurtWaitResultV1 {
    pub pid: i32,
    pub exit_code: i32,
    pub signal: i32,
    pub flags: i32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YurtPipeResultV1 {
    pub read_fd: i32,
    pub write_fd: i32,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct YurtSpawnResultV1 {
    pub pid: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedSpawnRequest {
    pub version: u16,
    pub flags: u16,
    pub prog: String,
    pub argv0: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    pub stdin_fd: i32,
    pub stdout_fd: i32,
    pub stderr_fd: i32,
    pub pass_fds: Vec<i32>,
}
```

- [ ] **Step 4: Add codec implementation**

Create `abi/rust/yurt-abi-core/src/codec.rs` with the exact helpers below:

```rust
use crate::errno;
use crate::layout::{DecodedSpawnRequest, YURT_ABI_RECORD_VERSION, YurtWaitResultV1};

fn u16_at(bytes: &[u8], off: usize) -> Result<u16, i32> {
    let end = off.checked_add(2).ok_or(errno::neg(errno::EOVERFLOW))?;
    let src = bytes.get(off..end).ok_or(errno::neg(errno::EINVAL))?;
    Ok(u16::from_le_bytes([src[0], src[1]]))
}

fn u32_at(bytes: &[u8], off: usize) -> Result<u32, i32> {
    let end = off.checked_add(4).ok_or(errno::neg(errno::EOVERFLOW))?;
    let src = bytes.get(off..end).ok_or(errno::neg(errno::EINVAL))?;
    Ok(u32::from_le_bytes([src[0], src[1], src[2], src[3]]))
}

fn i32_at(bytes: &[u8], off: usize) -> Result<i32, i32> {
    Ok(u32_at(bytes, off)? as i32)
}

fn span_utf8(bytes: &[u8], off: u32, len: u32) -> Result<String, i32> {
    if off == 0 && len == 0 {
        return Ok(String::new());
    }
    let start = off as usize;
    let end = start
        .checked_add(len as usize)
        .ok_or(errno::neg(errno::EOVERFLOW))?;
    let src = bytes.get(start..end).ok_or(errno::neg(errno::EINVAL))?;
    String::from_utf8(src.to_vec()).map_err(|_| errno::neg(errno::EINVAL))
}

fn string_from_off(bytes: &[u8], field_off: usize) -> Result<String, i32> {
    let off = u32_at(bytes, field_off)?;
    let len = u32_at(bytes, field_off + 4)?;
    span_utf8(bytes, off, len)
}

pub fn encode_wait_result(result: YurtWaitResultV1) -> Vec<u8> {
    let mut out = Vec::with_capacity(16);
    out.extend_from_slice(&result.pid.to_le_bytes());
    out.extend_from_slice(&result.exit_code.to_le_bytes());
    out.extend_from_slice(&result.signal.to_le_bytes());
    out.extend_from_slice(&result.flags.to_le_bytes());
    out
}

pub fn decode_spawn_request(bytes: &[u8]) -> Result<DecodedSpawnRequest, i32> {
    if bytes.len() < 60 {
        return Err(errno::neg(errno::EINVAL));
    }
    let size = u32_at(bytes, 0)? as usize;
    if size != bytes.len() {
        return Err(errno::neg(errno::EINVAL));
    }
    let version = u16_at(bytes, 4)?;
    let flags = u16_at(bytes, 6)?;
    if version != YURT_ABI_RECORD_VERSION {
        return Err(errno::neg(errno::EINVAL));
    }

    let args_vec_off = u32_at(bytes, 24)? as usize;
    let env_vec_off = u32_at(bytes, 28)? as usize;
    let pass_fds_vec_off = u32_at(bytes, 52)? as usize;

    Ok(DecodedSpawnRequest {
        version,
        flags,
        prog: string_from_off(bytes, 8)?,
        argv0: string_from_off(bytes, 16)?,
        args: read_string_vec(bytes, args_vec_off)?,
        env: read_env_vec(bytes, env_vec_off)?,
        cwd: string_from_off(bytes, 32)?,
        stdin_fd: i32_at(bytes, 40)?,
        stdout_fd: i32_at(bytes, 44)?,
        stderr_fd: i32_at(bytes, 48)?,
        pass_fds: read_i32_vec(bytes, pass_fds_vec_off)?,
    })
}

fn read_string_vec(bytes: &[u8], off: usize) -> Result<Vec<String>, i32> {
    if off == 0 {
        return Ok(Vec::new());
    }
    let count = u32_at(bytes, off)? as usize;
    let mut out = Vec::with_capacity(count);
    let mut cursor = off + 4;
    for _ in 0..count {
        let item_off = u32_at(bytes, cursor)?;
        let item_len = u32_at(bytes, cursor + 4)?;
        out.push(span_utf8(bytes, item_off, item_len)?);
        cursor += 8;
    }
    Ok(out)
}

fn read_env_vec(bytes: &[u8], off: usize) -> Result<Vec<(String, String)>, i32> {
    if off == 0 {
        return Ok(Vec::new());
    }
    let count = u32_at(bytes, off)? as usize;
    let mut out = Vec::with_capacity(count);
    let mut cursor = off + 4;
    for _ in 0..count {
        let key = span_utf8(bytes, u32_at(bytes, cursor)?, u32_at(bytes, cursor + 4)?)?;
        let value = span_utf8(bytes, u32_at(bytes, cursor + 8)?, u32_at(bytes, cursor + 12)?)?;
        out.push((key, value));
        cursor += 16;
    }
    Ok(out)
}

fn read_i32_vec(bytes: &[u8], off: usize) -> Result<Vec<i32>, i32> {
    if off == 0 {
        return Ok(Vec::new());
    }
    let count = u32_at(bytes, off)? as usize;
    let mut out = Vec::with_capacity(count);
    let mut cursor = off + 4;
    for _ in 0..count {
        out.push(i32_at(bytes, cursor)?);
        cursor += 4;
    }
    Ok(out)
}

pub fn test_spawn_record(
    prog: &str,
    argv0: &str,
    args: &[&str],
    env: &[(&str, &str)],
    cwd: &str,
    pass_fds: &[i32],
) -> Vec<u8> {
    fn push_str(buf: &mut Vec<u8>, s: &str) -> (u32, u32) {
        let off = buf.len() as u32;
        buf.extend_from_slice(s.as_bytes());
        (off, s.len() as u32)
    }
    fn put_u32(buf: &mut [u8], off: usize, value: u32) {
        buf[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }
    fn put_i32(buf: &mut [u8], off: usize, value: i32) {
        buf[off..off + 4].copy_from_slice(&value.to_le_bytes());
    }

    let mut buf = vec![0; 60];
    buf[4..6].copy_from_slice(&YURT_ABI_RECORD_VERSION.to_le_bytes());

    let (prog_off, prog_len) = push_str(&mut buf, prog);
    let (argv0_off, argv0_len) = push_str(&mut buf, argv0);
    let (cwd_off, cwd_len) = push_str(&mut buf, cwd);

    let arg_spans = args.iter().map(|s| push_str(&mut buf, s)).collect::<Vec<_>>();
    let env_spans = env
        .iter()
        .map(|(k, v)| (push_str(&mut buf, k), push_str(&mut buf, v)))
        .collect::<Vec<_>>();

    let args_vec_off = buf.len() as u32;
    buf.extend_from_slice(&(arg_spans.len() as u32).to_le_bytes());
    for (off, len) in arg_spans {
        buf.extend_from_slice(&off.to_le_bytes());
        buf.extend_from_slice(&len.to_le_bytes());
    }

    let env_vec_off = buf.len() as u32;
    buf.extend_from_slice(&(env_spans.len() as u32).to_le_bytes());
    for ((key_off, key_len), (value_off, value_len)) in env_spans {
        buf.extend_from_slice(&key_off.to_le_bytes());
        buf.extend_from_slice(&key_len.to_le_bytes());
        buf.extend_from_slice(&value_off.to_le_bytes());
        buf.extend_from_slice(&value_len.to_le_bytes());
    }

    let pass_fds_vec_off = buf.len() as u32;
    buf.extend_from_slice(&(pass_fds.len() as u32).to_le_bytes());
    for fd in pass_fds {
        buf.extend_from_slice(&fd.to_le_bytes());
    }

    let size = buf.len() as u32;
    put_u32(&mut buf, 0, size);
    put_u32(&mut buf, 8, prog_off);
    put_u32(&mut buf, 12, prog_len);
    put_u32(&mut buf, 16, argv0_off);
    put_u32(&mut buf, 20, argv0_len);
    put_u32(&mut buf, 24, args_vec_off);
    put_u32(&mut buf, 28, env_vec_off);
    put_u32(&mut buf, 32, cwd_off);
    put_u32(&mut buf, 36, cwd_len);
    put_i32(&mut buf, 40, 0);
    put_i32(&mut buf, 44, 1);
    put_i32(&mut buf, 48, 2);
    put_u32(&mut buf, 52, pass_fds_vec_off);
    buf
}
```

- [ ] **Step 5: Run codec tests**

Run:

```bash
cargo test -p yurt-abi-core --test codec
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add abi/rust/yurt-abi-core/src/layout.rs abi/rust/yurt-abi-core/src/codec.rs abi/rust/yurt-abi-core/tests/codec.rs
git commit -m "Add native ABI record codecs"
```

---

### Task 4: C Header And Runtime Declarations

**Files:**
- Modify: `abi/include/yurt_abi.h`
- Modify: `abi/src/yurt_runtime.h`

- [ ] **Step 1: Add C header layout declarations**

Replace the ABI-struct section of `abi/include/yurt_abi.h` with:

```c
#define YURT_ABI_RECORD_VERSION 1u
#define YURT_WAIT_NOHANG 1u

typedef struct {
  uint32_t size;
  uint16_t version;
  uint16_t flags;
} yurt_abi_record_header;

typedef struct {
  int32_t pid;
  int32_t exit_code;
  int32_t signal;
  int32_t flags;
} yurt_wait_result_v1;

typedef struct {
  int32_t read_fd;
  int32_t write_fd;
} yurt_pipe_result_v1;

typedef struct {
  int32_t pid;
} yurt_spawn_result_v1;
```

- [ ] **Step 2: Replace host import comments and declarations**

In `abi/src/yurt_runtime.h`, replace the JSON/FlatBuffers process declarations with:

```c
__attribute__((import_module("yurt"), import_name("host_pipe")))
int yurt_host_pipe(int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_dup")))
int yurt_host_dup(int fd, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_spawn")))
int yurt_host_spawn(int req_ptr, int req_len, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_wait")))
int yurt_host_wait(int pid, int flags, int out_ptr, int out_cap);

__attribute__((import_module("yurt"), import_name("host_run_command")))
int yurt_host_run_command(int req_ptr, int req_len, int out_ptr, int out_cap);
```

Remove declarations for:

```c
yurt_host_waitpid
yurt_host_waitpid_nohang
yurt_host_wait_any
yurt_host_wait_any_nohang
```

- [ ] **Step 3: Verify no old wait declarations remain**

Run:

```bash
rg -n "host_waitpid|host_wait_any" abi/src abi/include
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add abi/include/yurt_abi.h abi/src/yurt_runtime.h
git commit -m "Declare native process ABI"
```

---

### Task 5: Native Pipe, Dup, And Wait In TS Harness

**Files:**
- Modify: `packages/kernel/src/host-imports/common.ts`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Create: `packages/kernel/src/host-imports/__tests__/native-abi-shape.test.ts`

- [ ] **Step 1: Add native ABI tests**

Create `packages/kernel/src/host-imports/__tests__/native-abi-shape.test.ts`:

```ts
import { assertEquals } from "@std/assert";
import { createKernelImports } from "../kernel-imports.ts";

function readI32(memory: WebAssembly.Memory, ptr: number): number {
  return new DataView(memory.buffer).getInt32(ptr, true);
}

Deno.test("host_pipe writes native pipe result struct", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  let nextFd = 10;
  const kernel = {
    createPipe: () => ({ readFd: nextFd++, writeFd: nextFd++ }),
  } as never;
  const imports = createKernelImports({ memory, kernel });
  const rc = (imports.host_pipe as (...args: number[]) => number)(64, 8);
  assertEquals(rc, 8);
  assertEquals(readI32(memory, 64), 10);
  assertEquals(readI32(memory, 68), 11);
});

Deno.test("host_pipe reports required size for small buffer", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const kernel = { createPipe: () => ({ readFd: 3, writeFd: 4 }) } as never;
  const imports = createKernelImports({ memory, kernel });
  assertEquals((imports.host_pipe as (...args: number[]) => number)(64, 4), 8);
});

Deno.test("legacy wait imports are absent", () => {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const imports = createKernelImports({ memory });
  assertEquals("host_waitpid" in imports, false);
  assertEquals("host_waitpid_nohang" in imports, false);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env packages/kernel/src/host-imports/__tests__/native-abi-shape.test.ts
```

Expected: `host_pipe` test fails because current implementation writes FlatBuffers or JSON.

- [ ] **Step 3: Add native write helpers and remove writeJson**

In `packages/kernel/src/host-imports/common.ts`, delete `writeJson` and add:

```ts
export function writeI32Struct(memory: WebAssembly.Memory, ptr: number, cap: number, values: number[]): number {
  const required = values.length * 4;
  if (required > cap) return required;
  const view = new DataView(memory.buffer);
  for (let i = 0; i < values.length; i += 1) {
    view.setInt32(ptr + i * 4, values[i], true);
  }
  return required;
}
```

- [ ] **Step 4: Convert `host_pipe`, `host_dup`, and `host_wait` in the TS harness**

In `packages/kernel/src/host-imports/kernel-imports.ts`:

Remove imports from `./fb.ts` for pipe/dup/wait. Import `writeI32Struct` from `./common.ts`.

Replace `host_pipe` with:

```ts
host_pipe(outPtr: number, outCap: number): number {
  if (!opts.kernel) return -EINVAL;
  const { readFd, writeFd } = opts.kernel.createPipe(callerPid);
  return writeI32Struct(memory, outPtr, outCap, [readFd, writeFd]);
},
```

Replace `host_dup` with:

```ts
host_dup(fd: number, outPtr: number, outCap: number): number {
  if (!opts.kernel || isActivePreopenFd(fd)) return -EBADF;
  try {
    const newFd = opts.kernel.dup(callerPid, fd);
    return writeI32Struct(memory, outPtr, outCap, [newFd]);
  } catch {
    return -EBADF;
  }
},
```

Replace `host_wait` with a native fixed output:

```ts
async host_wait(pid: number, flags: number, outPtr: number, outCap: number): Promise<number> {
  if (!opts.kernel) return -ECHILD;
  const nohang = (flags & 1) !== 0;
  if (nohang) {
    const result = pid <= 0 ? opts.kernel.waitAnyChildNohang(callerPid) : { state: "done" as const, exitCode: opts.kernel.waitpidNohang(pid, callerPid), pid };
    if (result.state === "running") return -EAGAIN;
    if (result.state === "none" || result.exitCode < 0) return -ECHILD;
    opts.kernel.flushVfsFds(callerPid);
    return writeI32Struct(memory, outPtr, outCap, [result.pid, result.exitCode, 0, 0]);
  }
  await yieldToScheduler();
  const waited = pid <= 0
    ? await opts.kernel.waitAnyChildInterruptible(callerPid, new Promise<void>(() => {}))
    : await opts.kernel.waitpidInterruptible(pid, callerPid, new Promise<void>(() => {}));
  if ("interrupted" in waited && waited.interrupted) return -EINTR;
  const result = pid <= 0 ? waited.result : { pid, exitCode: waited.exitCode };
  if (!result || result.exitCode < 0) return -ECHILD;
  opts.kernel.flushVfsFds(callerPid);
  return writeI32Struct(memory, outPtr, outCap, [result.pid, result.exitCode, 0, 0]);
},
```

Delete `host_waitpid` and `host_waitpid_nohang`.

- [ ] **Step 5: Run native ABI shape tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env packages/kernel/src/host-imports/__tests__/native-abi-shape.test.ts
```

Expected: 3 passed.

- [ ] **Step 6: Commit**

```bash
git add packages/kernel/src/host-imports/common.ts packages/kernel/src/host-imports/kernel-imports.ts packages/kernel/src/host-imports/__tests__/native-abi-shape.test.ts
git commit -m "Use native ABI for pipe dup and wait"
```

---

### Task 6: Convert C Pipe, Dup, And Wait Shims

**Files:**
- Modify: `abi/src/yurt_pipe.c`
- Modify: `abi/src/yurt_dup.c`
- Modify: `abi/src/yurt_process.c`

- [ ] **Step 1: Update pipe shim**

In `abi/src/yurt_pipe.c`, replace JSON response parsing with:

```c
#include "yurt_abi.h"

int pipe2(int pipefd[2], int flags) {
  yurt_pipe_result_v1 result;
  int rc = yurt_host_pipe((int)(intptr_t)&result, (int)sizeof(result));
  if (rc < 0) {
    errno = -rc;
    return -1;
  }
  if (rc > (int)sizeof(result)) {
    errno = EOVERFLOW;
    return -1;
  }
  pipefd[0] = result.read_fd;
  pipefd[1] = result.write_fd;
  if (flags & O_CLOEXEC) {
    yurt_host_set_fd_descriptor_flags(pipefd[0], FD_CLOEXEC);
    yurt_host_set_fd_descriptor_flags(pipefd[1], FD_CLOEXEC);
  }
  return 0;
}
```

Keep the existing `pipe()` wrapper calling `pipe2(pipefd, 0)`.

- [ ] **Step 2: Update dup shim**

In `abi/src/yurt_dup.c`, replace JSON parsing with:

```c
int dup(int fd) {
  int32_t new_fd = -1;
  int rc = yurt_host_dup(fd, (int)(intptr_t)&new_fd, (int)sizeof(new_fd));
  if (rc < 0) {
    errno = -rc;
    return -1;
  }
  if (rc > (int)sizeof(new_fd)) {
    errno = EOVERFLOW;
    return -1;
  }
  return new_fd;
}
```

- [ ] **Step 3: Update wait shim**

In `abi/src/yurt_process.c`, replace all `host_waitpid*` and `host_wait_any*` calls with:

```c
static int yurt_wait_host(pid_t pid, int options, int *status) {
  yurt_wait_result_v1 result;
  int flags = (options & WNOHANG) ? YURT_WAIT_NOHANG : 0;
  int rc = yurt_host_wait((int)pid, flags, (int)(intptr_t)&result, (int)sizeof(result));
  if (rc < 0) {
    errno = -rc;
    return -1;
  }
  if (rc > (int)sizeof(result)) {
    errno = EOVERFLOW;
    return -1;
  }
  if (status) *status = (result.exit_code & 0xff) << 8;
  return result.pid;
}
```

Make `waitpid(pid, status, options)` call `yurt_wait_host(pid, options, status)`. Make `wait(status)` call `yurt_wait_host(-1, 0, status)`.

- [ ] **Step 4: Run C canary build**

Run:

```bash
make -C abi canaries
```

Expected: canaries build; no references to `waitpid_parse_exit`, `pipe_parse_int_field`, or JSON parsing remain in these three files.

- [ ] **Step 5: Commit**

```bash
git add abi/src/yurt_pipe.c abi/src/yurt_dup.c abi/src/yurt_process.c
git commit -m "Convert process shims to native ABI"
```

---

### Task 7: Wasmtime Rust Memory Adapter

**Files:**
- Create: `packages/runtime-wasmtime/src/wasm/abi_memory.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/mod.rs`
- Modify: `packages/runtime-wasmtime/Cargo.toml`

- [ ] **Step 1: Add dependency**

In `packages/runtime-wasmtime/Cargo.toml`, add:

```toml
yurt-abi-core = { path = "../../abi/rust/yurt-abi-core" }
```

- [ ] **Step 2: Add Wasmtime memory adapter**

Create `packages/runtime-wasmtime/src/wasm/abi_memory.rs`:

```rust
use wasmtime::Caller;
use yurt_abi_core::errno;
use yurt_abi_core::memory::GuestMemory;

use super::StoreData;

pub struct CallerMemory<'a, 'b> {
    caller: &'a mut Caller<'b, StoreData>,
}

impl<'a, 'b> CallerMemory<'a, 'b> {
    pub fn new(caller: &'a mut Caller<'b, StoreData>) -> Self {
        Self { caller }
    }
}

impl GuestMemory for CallerMemory<'_, '_> {
    fn read_span(&self, _ptr: u32, _len: u32) -> Result<Vec<u8>, i32> {
        Err(errno::neg(errno::EINVAL))
    }

    fn write_span(&mut self, _ptr: u32, _cap: u32, _data: &[u8]) -> Result<i32, i32> {
        Err(errno::neg(errno::EINVAL))
    }
}
```

Then replace the stub methods with the working implementation:

```rust
fn read_span(&self, ptr: u32, len: u32) -> Result<Vec<u8>, i32> {
    let Some(mem) = self.caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Err(errno::neg(errno::EINVAL));
    };
    let start = ptr as usize;
    let end = start
        .checked_add(len as usize)
        .ok_or(errno::neg(errno::EOVERFLOW))?;
    let data = mem.data(&self.caller);
    if end > data.len() {
        return Err(errno::neg(errno::EINVAL));
    }
    Ok(data[start..end].to_vec())
}

fn write_span(&mut self, ptr: u32, cap: u32, data: &[u8]) -> Result<i32, i32> {
    if data.len() > cap as usize {
        return Ok(data.len() as i32);
    }
    let Some(mem) = self.caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return Err(errno::neg(errno::EINVAL));
    };
    let start = ptr as usize;
    let end = start
        .checked_add(data.len())
        .ok_or(errno::neg(errno::EOVERFLOW))?;
    let dst = mem.data_mut(&mut self.caller);
    if end > dst.len() {
        return Err(errno::neg(errno::EINVAL));
    }
    dst[start..end].copy_from_slice(data);
    Ok(data.len() as i32)
}
```

- [ ] **Step 3: Export module and remove duplicate helpers**

In `packages/runtime-wasmtime/src/wasm/mod.rs`, add:

```rust
mod abi_memory;
```

Replace direct `read_mem`, `read_str`, and `write_out` use sites in `add_fs_imports`, `add_io_imports`, `add_process_imports`, `add_network_imports`, and `add_misc_imports` with:

```rust
let mut mem = abi_memory::CallerMemory::new(&mut c);
let path = mem.read_utf8(path_ptr, path_len)?;
```

For host-import closures that must return `i32`, map errors directly:

```rust
let path = match mem.read_utf8(path_ptr, path_len) {
    Ok(path) => path,
    Err(rc) => return rc,
};
```

- [ ] **Step 4: Run Wasmtime checks**

Run:

```bash
cargo test -p yurt-runtime-wasmtime
```

Expected: existing Wasmtime tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-wasmtime/Cargo.toml packages/runtime-wasmtime/src/wasm
git commit -m "Use Rust ABI core for Wasmtime guest memory"
```

---

### Task 8: Native File And Socket Byte I/O

**Files:**
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `abi/src/yurt_socket.c`
- Modify: `abi/src/yurt_fetch.c`
- Modify: `abi/src/yurt_netdb.c`
- Modify: `packages/kernel/src/host-imports/__tests__/socket-fds.test.ts`

- [ ] **Step 1: Change TS harness signatures for byte I/O**

Replace FlatBuffer request parsing in TS for:

```ts
host_read_fd(fd, outPtr, outCap)
host_write_fd(fd, dataPtr, dataLen)
host_socket_send(fd, dataPtr, dataLen, flags)
host_socket_recv(fd, outPtr, outCap, flags)
host_dns_resolve(hostPtr, hostLen, outPtr, outCap)
```

Use `readString`, `readBytes`, and `writeBytes` only. Return negative errno on error.

- [ ] **Step 2: Update C socket shims**

In `abi/src/yurt_socket.c`, remove `yurt_fb.h` usage and call direct imports:

```c
int n = yurt_host_socket_send(sockfd, (int)(intptr_t)buf, (int)len, flags);
if (n < 0) { errno = -n; return -1; }
return (ssize_t)n;
```

For recv:

```c
int n = yurt_host_socket_recv(sockfd, (int)(intptr_t)buf, (int)len, flags);
if (n < 0) { errno = -n; return -1; }
return (ssize_t)n;
```

- [ ] **Step 3: Update fetch and DNS shims**

Keep fetch as a native record only if direct scalar/span fields are insufficient. For this cut, use:

```c
yurt_host_network_fetch(req_ptr, req_len, out_ptr, out_cap)
```

where `req_ptr` points to a native record built by Rust ABI core helper or C inline builder. DNS becomes:

```c
yurt_host_dns_resolve(host_ptr, host_len, out_ptr, out_cap)
```

- [ ] **Step 4: Run socket and ABI tests**

Run:

```bash
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__/socket-fds.test.ts packages/kernel/src/__tests__/abi.test.ts
```

Expected: socket tests and ABI canaries pass.

- [ ] **Step 5: Commit**

```bash
git add packages/kernel/src/host-imports/kernel-imports.ts abi/src/yurt_socket.c abi/src/yurt_fetch.c abi/src/yurt_netdb.c packages/kernel/src/host-imports/__tests__/socket-fds.test.ts
git commit -m "Use native ABI for byte IO"
```

---

### Task 9: Native Spawn And Command Records

**Files:**
- Modify: `abi/src/yurt_spawn.c`
- Modify: `abi/src/yurt_command.c`
- Modify: `packages/kernel/src/host-imports/kernel-imports.ts`
- Modify: `packages/runtime-wasmtime/src/wasm/spawn.rs`
- Modify: `packages/runtime-wasmtime/src/wasm/network.rs`
- Test: `packages/kernel/src/__tests__/abi.test.ts`

- [ ] **Step 1: Replace spawn JSON building**

In `abi/src/yurt_spawn.c`, delete `json_emit_string`, `json_emit_lit`, and `json_emit_int`. Build `yurt_spawn_request_v1` plus offset vectors as documented in `yurt-abi-core::codec::test_spawn_record`, then call:

```c
yurt_spawn_result_v1 result;
int rc = yurt_host_spawn((int)(intptr_t)record, (int)record_len, (int)(intptr_t)&result, (int)sizeof(result));
if (rc < 0) { errno = -rc; return -1; }
*pid = result.pid;
return 0;
```

- [ ] **Step 2: Replace command JSON building**

In `abi/src/yurt_command.c`, delete `yurt_json_call`, `build_command_request`, `parse_exit_code`, and `parse_json_string_field`. Build a native command request record and parse the native command response offsets returned by the host.

- [ ] **Step 3: Decode spawn and command records in Rust**

In `packages/runtime-wasmtime/src/wasm/spawn.rs`, replace:

```rust
#[derive(Deserialize, Debug)]
pub struct SpawnRequest {
    pub prog: String,
    pub args: Vec<String>,
    pub env: Vec<[String; 2]>,
    pub cwd: String,
    pub stdin_fd: i32,
    pub stdout_fd: i32,
    pub stderr_fd: i32,
    pub stdin_data: String,
    pub nice: u8,
}
```

with:

```rust
pub type SpawnRequest = yurt_abi_core::layout::DecodedSpawnRequest;
```

Decode guest bytes with:

```rust
let req = yurt_abi_core::codec::decode_spawn_request(&req_bytes)?;
```

- [ ] **Step 4: Update TS harness to use Rust-compatible native record decoding**

Until the V8 runtime is retired, implement the same native record decoding in `kernel-imports.ts` using small local functions named `decodeSpawnRecord` and `decodeCommandRecord`. These must mirror `yurt-abi-core` tests byte-for-byte. Delete all `JSON.parse(readString(...))` fallback branches.

- [ ] **Step 5: Run process canaries**

Run:

```bash
make -C abi copy-fixtures rust-canaries rust-std-canaries
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi.test.ts
```

Expected: `system-canary`, `popen-canary`, Rust `std::process::*` canaries, and BusyBox process tests pass.

- [ ] **Step 6: Commit**

```bash
git add abi/src/yurt_spawn.c abi/src/yurt_command.c packages/kernel/src/host-imports/kernel-imports.ts packages/runtime-wasmtime/src/wasm/spawn.rs packages/runtime-wasmtime/src/wasm/network.rs packages/kernel/src/platform/__tests__/fixtures
git commit -m "Use native ABI for spawn and command execution"
```

---

### Task 10: Delete FlatBuffers And JSON ABI Artifacts

**Files:**
- Delete: `abi/schema/yurt_abi.fbs`
- Delete: `abi/rust/yurt-abi-fb/`
- Delete: `packages/kernel/src/host-imports/fb.ts`
- Delete: `packages/kernel/src/host-imports/_generated/`
- Delete: `abi/src/yurt_fb.h`
- Modify: `Cargo.toml`
- Modify: `abi/Makefile`

- [ ] **Step 1: Remove FlatBuffers workspace member**

Delete `abi/rust/yurt-abi-fb` from the root `Cargo.toml` `members` list.

- [ ] **Step 2: Remove generated TS bindings and schema**

Delete:

```bash
abi/schema/yurt_abi.fbs
packages/kernel/src/host-imports/fb.ts
packages/kernel/src/host-imports/_generated/
abi/src/yurt_fb.h
```

- [ ] **Step 3: Remove Makefile FlatBuffers dependencies**

In `abi/Makefile`, remove references to `yurt-abi-fb`, `yurt_fb.h`, schema generation, and generated binding drift checks.

- [ ] **Step 4: Run grep checks**

Run:

```bash
rg -n "FlatBuffer|flatbuffers|yurt_abi\\.fbs|writeJson|JSON\\.parse\\(readString|host_waitpid|host_wait_any|yurt_fb" abi packages/kernel/src Cargo.toml
```

Expected: no output except historical design docs under `docs/` if the command is widened to include docs.

- [ ] **Step 5: Commit**

```bash
git add -A abi packages/kernel/src/host-imports Cargo.toml abi/Makefile
git commit -m "Remove JSON and FlatBuffers ABI artifacts"
```

---

### Task 11: Final Verification And CI Guard

**Files:**
- Create: `scripts/check-native-abi-clean.sh`
- Modify: `.github/workflows/ci.yml` if present

- [ ] **Step 1: Add cleanup script**

Create `scripts/check-native-abi-clean.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

bad=0

check_absent() {
  local pattern="$1"
  local path="$2"
  if rg -n "$pattern" "$path"; then
    bad=1
  fi
}

check_absent 'writeJson' packages/kernel/src/host-imports
check_absent 'JSON\.parse\(readString' packages/kernel/src/host-imports
check_absent 'host_waitpid|host_wait_any|host_waitpid_nohang|host_wait_any_nohang' abi packages/kernel/src
check_absent 'FlatBuffer|flatbuffers|yurt_fb|yurt_abi\.fbs' abi packages/kernel/src/host-imports Cargo.toml

exit "$bad"
```

- [ ] **Step 2: Make it executable**

Run:

```bash
chmod +x scripts/check-native-abi-clean.sh
```

- [ ] **Step 3: Run full verification**

Run:

```bash
cargo test -p yurt-abi-core
cargo check --target wasm32-wasip1 -p yurt-shell-exec
make -C abi copy-fixtures rust-canaries rust-std-canaries
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/__tests__/abi.test.ts
/Users/sunny/.deno/bin/deno test --no-check --allow-read --allow-write --allow-env --allow-net packages/kernel/src/host-imports/__tests__
scripts/check-native-abi-clean.sh
```

Expected: every command passes.

- [ ] **Step 4: Commit**

```bash
git add scripts/check-native-abi-clean.sh .github/workflows/ci.yml
git commit -m "Add native ABI cleanup guard"
```

---

## Self-Review

- Spec coverage: covers native syscall ABI, JSON removal, FlatBuffers removal, Rust-owned buffer/pointer processing, wait fold, shell-as-normal-process constraint, C/Rust canaries, and cleanup grep checks.
- Type consistency: `YurtWaitResultV1`, `YurtPipeResultV1`, `YurtSpawnResultV1`, `GuestMemory`, and native return conventions are defined before use.
- Known risk: direct Rust pointer processing is practical in `packages/runtime-wasmtime` because Wasmtime exposes memory to Rust. The V8/Deno TS runtime cannot give Rust direct guest-memory access without a native addon or FFI bridge; this plan avoids adding that abstraction and treats TS as a transitional compatibility harness.
