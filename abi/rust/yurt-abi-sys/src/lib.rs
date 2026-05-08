//! Bindings to the yurt kernel ABI runtime archive
//! (libyurt_abi.a). This crate exists for yurt-authored
//! Rust guests that want plain `cargo build` to also work; under
//! `cargo-yurt` the wrapper handles link injection and this crate
//! becomes a no-op linkage carrier.
//!
//! The actual Tier 1 ABI is reached through `libc::*` calls — those
//! resolve to the C archive's strong defs at link time. This crate
//! deliberately exports no Rust functions of its own.
#![no_std]

/// Compile-time version constant matching YURT_ABI_VERSION_MAJOR/MINOR
/// in `abi/include/yurt_abi.h` (§Versioning).
pub const VERSION: u32 = 1 << 16;
