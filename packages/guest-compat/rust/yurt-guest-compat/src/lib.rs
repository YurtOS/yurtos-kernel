//! Safe Rust wrappers over the Tier 1 ABI defined in
//! `docs/superpowers/specs/2026-04-19-guest-compat-runtime-design.md`
//! §Compatibility Tiers > Tier 1.
//!
//! These wrappers translate POSIX-style return values into idiomatic
//! Rust `Result`s. They do NOT contain implementations — every Tier 1
//! call ultimately reaches the C archive `libyurt_guest_compat.a`
//! through the link-time override (§Override And Link Precedence).

#![cfg_attr(not(test), no_std)]
extern crate alloc;

pub mod dup2;
pub mod sched;
pub mod signal;

/// Re-export the version constant so callers can do an at-runtime check
/// against the runtime they're actually linked against. (§Versioning.)
pub use yurt_guest_compat_sys::VERSION;
