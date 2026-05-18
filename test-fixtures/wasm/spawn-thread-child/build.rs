fn main() {
    // Export the wasm indirect function table so the Yurt JS host can resolve
    // thread function pointers via __indirect_function_table in spawnThread().
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=--export-table");
    }
}
