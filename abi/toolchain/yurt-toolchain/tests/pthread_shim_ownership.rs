use std::fs;
use std::path::PathBuf;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("repo root")
}

#[test]
fn pthread_tls_state_lives_in_rust_not_c() {
    let root = repo_root();
    let c = fs::read_to_string(root.join("abi/src/yurt_pthread.c")).expect("read yurt_pthread.c");
    let rust = fs::read_to_string(root.join("abi/rust/yurt-libc/src/pthread.rs"))
        .expect("read pthread.rs");

    assert!(
        !c.contains("static yurt_tls_key_t tls_keys"),
        "pthread TLS key storage must not live in the C shim"
    );
    assert!(
        !c.contains(
            "typedef struct {\n  int in_use;\n  void (*destructor)(void *);\n  void *values"
        ),
        "pthread TLS state layout must not be owned by the C shim"
    );
    assert!(
        rust.contains("TLS_KEY_GENERATIONS") || rust.contains("generation"),
        "Rust pthread TLS must track key generations to prevent stale values"
    );
    assert!(
        rust.contains("yurt_rs_pthread_key_create"),
        "C may keep marker wrappers, but pthread_key_create state must delegate to Rust"
    );
}

#[test]
fn pthread_condattr_state_lives_in_rust_not_c() {
    let root = repo_root();
    let c = fs::read_to_string(root.join("abi/src/yurt_pthread.c")).expect("read yurt_pthread.c");
    let rust = fs::read_to_string(root.join("abi/rust/yurt-libc/src/pthread.rs"))
        .expect("read pthread.rs");

    assert!(
        !c.contains("yurt_attr_store_clock"),
        "pthread_condattr clock storage must not live in the C shim"
    );
    assert!(
        rust.contains("pthread_condattr_setclock"),
        "pthread_condattr behavior should be implemented in Rust"
    );
}
