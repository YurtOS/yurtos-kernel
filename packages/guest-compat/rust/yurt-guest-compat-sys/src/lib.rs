//! Bindings to the yurt guest compatibility runtime archive
//! (libyurt_guest_compat.a). This crate exists for yurt-authored
//! Rust guests that want plain `cargo build` to also work; under
//! `cargo-yurt` the wrapper handles link injection and this crate
//! becomes a no-op linkage carrier.
//!
//! The actual Tier 1 ABI is reached through `libc::*` calls — those
//! resolve to the C archive's strong defs at link time. This crate
//! deliberately exports no Rust functions of its own.
#![no_std]

/// Compile-time version constant matching YURT_GUEST_COMPAT_VERSION_MAJOR/MINOR
/// in `packages/guest-compat/include/yurt_compat.h` (§Versioning).
pub const VERSION: u32 = (1 << 16) | 0;
