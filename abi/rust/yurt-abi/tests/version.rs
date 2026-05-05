#[test]
fn version_constant_matches_phase_a_major_minor() {
    // Step 1 set YURT_ABI_VERSION_MAJOR=1, MINOR=0 in the C header.
    // The Rust constant must agree, otherwise the cross-language version
    // check in Task 18 would silently mismatch.
    assert_eq!(yurt_abi::VERSION, (1u32 << 16) | 0);
}
