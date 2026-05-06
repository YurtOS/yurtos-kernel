//! Integration tests for SandboxManager — exercises the high-level sandbox
//! abstraction that the dispatcher uses.

#![allow(unused_variables)]

use yurt_runtime_wasmtime::sandbox::SandboxManager;

fn wasm_bytes() -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {}: {e}", path.display()))
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_create_and_run() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();
    let result = mgr.root_run("echo hello").await.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().contains("hello"));
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_file_ops() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();

    // write
    sb.shell.vfs_mut().write_file("/tmp/hello.txt", b"hello world", false).unwrap();

    // read
    let content = sb.shell.vfs().read_file("/tmp/hello.txt").unwrap();
    assert_eq!(content.as_slice(), b"hello world");

    // stat
    let st = sb.shell.vfs().stat("/tmp/hello.txt").unwrap();
    assert_eq!(st.size, 11);

    // list
    let entries = sb.shell.vfs().readdir("/tmp").unwrap();
    assert!(entries.iter().any(|e| e.name == "hello.txt"));

    // mkdir + list
    sb.shell.vfs_mut().mkdir("/tmp/subdir").unwrap();
    let entries2 = sb.shell.vfs().readdir("/tmp").unwrap();
    assert!(entries2.iter().any(|e| e.name == "subdir"));

    // rm (unlink)
    sb.shell.vfs_mut().unlink("/tmp/hello.txt").unwrap();
    assert!(sb.shell.vfs().read_file("/tmp/hello.txt").is_err());
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_file_ops_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    // create
    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");
    let (r, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
            "create",
            serde_json::json!({
                "shellWasmPath": wasm_path.to_str().unwrap(),
            }),
        )
        .await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // files.write
    let data = base64::engine::general_purpose::STANDARD.encode(b"test content");
    let (r2, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
            "files.write",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
                "data": data,
            }),
        )
        .await;
    assert!(r2.result.is_some(), "files.write failed: {:?}", r2.error);

    // files.read
    let (r3, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
            "files.read",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
            }),
        )
        .await;
    let result = r3.result.unwrap();
    let decoded =
        base64::engine::general_purpose::STANDARD.decode(result["data"].as_str().unwrap()).unwrap();
    assert_eq!(decoded, b"test content");

    // files.list
    let (r4, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)),
            "files.list",
            serde_json::json!({
                "path": "/tmp",
            }),
        )
        .await;
    let entries = r4.result.unwrap();
    let names: Vec<_> = entries["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["name"].as_str().unwrap().to_owned())
        .collect();
    assert!(names.contains(&"rpc_test.txt".to_owned()));

    // files.mkdir
    let (r5, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(5)),
            "files.mkdir",
            serde_json::json!({
                "path": "/tmp/newdir",
            }),
        )
        .await;
    assert!(r5.result.is_some(), "files.mkdir failed: {:?}", r5.error);

    // files.stat
    let (r6, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(6)),
            "files.stat",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
            }),
        )
        .await;
    let stat = r6.result.unwrap();
    assert_eq!(stat["type"].as_str().unwrap(), "file");

    // files.rm
    let (r7, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(7)),
            "files.rm",
            serde_json::json!({
                "path": "/tmp/rpc_test.txt",
            }),
        )
        .await;
    assert!(r7.result.is_some(), "files.rm failed: {:?}", r7.error);
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_run_and_env() {
    use tokio::sync::mpsc;
    let wasm = wasm_bytes();
    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");
    disp.dispatch(Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)), "create", serde_json::json!({
        "shellWasmPath": wasm_path.to_str().unwrap(),
    })).await;

    // basic run
    let (r, _) = disp.dispatch(Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)), "run", serde_json::json!({
        "command": "echo hello",
    })).await;
    let result = r.result.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().trim() == "hello");

    // env.set + env.get
    let (r2, _) = disp.dispatch(Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)), "env.set", serde_json::json!({
        "name": "MYVAR",
        "value": "testvalue",
    })).await;
    assert!(r2.result.is_some(), "env.set failed: {:?}", r2.error);

    let (r3, _) = disp.dispatch(Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)), "env.get", serde_json::json!({
        "name": "MYVAR",
    })).await;
    // After setting via 'export MYVAR=testvalue', the env should sync on next run.
    // env.get returns from manager.env which is synced after each run_command call.
    // Since env.set runs 'export ...' as a command, env is synced.
    assert_eq!(r3.result.unwrap()["value"].as_str().unwrap(), "testvalue");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_snapshot() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    sb.shell.vfs_mut().write_file("/tmp/before.txt", b"before", false).unwrap();

    let snap_id = sb.shell.vfs_mut().snapshot();
    sb.shell.vfs_mut().write_file("/tmp/after.txt", b"after", false).unwrap();
    assert!(sb.shell.vfs().read_file("/tmp/after.txt").is_ok());

    sb.shell.vfs_mut().restore(&snap_id).unwrap();
    assert!(sb.shell.vfs().read_file("/tmp/before.txt").is_ok());
    assert!(sb.shell.vfs().read_file("/tmp/after.txt").is_err());
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_mount() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    sb.shell.vfs_mut().mkdirp("/mnt/tools").unwrap();
    sb.shell.vfs_mut().write_file("/mnt/tools/greet.sh", b"echo greetings", false).unwrap();

    let result = sb.run("sh /mnt/tools/greet.sh").await.unwrap();
    assert!(result["stdout"].as_str().unwrap().contains("greetings"));
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_snapshot_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    // create
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // write a file
    let data = base64::engine::general_purpose::STANDARD.encode(b"original");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "files.write",
        serde_json::json!({"path": "/tmp/snap.txt", "data": data}),
    ).await;
    assert!(r.result.is_some(), "files.write failed: {:?}", r.error);

    // take snapshot
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
        "snapshot.create",
        serde_json::json!({}),
    ).await;
    assert!(r.result.is_some(), "snapshot.create failed: {:?}", r.error);
    let snap_id = r.result.unwrap()["id"].as_str().unwrap().to_string();

    // overwrite file
    let data2 = base64::engine::general_purpose::STANDARD.encode(b"modified");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)),
        "files.write",
        serde_json::json!({"path": "/tmp/snap.txt", "data": data2}),
    ).await;
    assert!(r.result.is_some(), "files.write 2 failed: {:?}", r.error);

    // restore snapshot
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(5)),
        "snapshot.restore",
        serde_json::json!({"id": snap_id}),
    ).await;
    assert!(r.result.is_some(), "snapshot.restore failed: {:?}", r.error);

    // verify original content restored
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(6)),
        "files.read",
        serde_json::json!({"path": "/tmp/snap.txt"}),
    ).await;
    assert!(r.result.is_some(), "files.read failed: {:?}", r.error);
    let b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();
    let content = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(content, b"original");

    // drain any pending notifications
    while rx.try_recv().is_ok() {}
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_mount_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    // create
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // mount files
    let script_b64 = base64::engine::general_purpose::STANDARD.encode(b"echo mounted");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "mount",
        serde_json::json!({
            "path": "/mnt/scripts",
            "files": {"run.sh": script_b64},
        }),
    ).await;
    assert!(r.result.is_some(), "mount failed: {:?}", r.error);

    // run the mounted script
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
        "run",
        serde_json::json!({"command": "sh /mnt/scripts/run.sh"}),
    ).await;
    assert!(r.result.is_some(), "run failed: {:?}", r.error);
    let stdout = r.result.unwrap()["stdout"].as_str().unwrap().to_string();
    assert!(stdout.contains("mounted"), "expected 'mounted' in stdout, got: {stdout}");

    // drain any pending notifications
    while rx.try_recv().is_ok() {}
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_snapshot_restore_invalid_id() {
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;

    let (resp, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "snapshot.restore",
        serde_json::json!({"id": "nonexistent-snap-id"}),
    ).await;

    assert!(resp.error.is_some(), "expected an error response");
    assert_eq!(resp.error.unwrap().code, -32602); // INVALID_PARAMS
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_mount_no_files() {
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;

    // mount with no files key — should succeed (just create the dir)
    let (resp, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "mount",
        serde_json::json!({"path": "/mnt/empty"}),
    ).await;
    assert!(resp.error.is_none(), "mount with no files should succeed: {:?}", resp.error);
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_persistence() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    sb.shell.vfs_mut().write_file("/tmp/persist.txt", b"persistent data", false).unwrap();

    let blob = sb.shell.vfs().export_bytes().unwrap();
    assert!(!blob.is_empty());

    // Import into a fresh VFS — verify the file is present
    let vfs2 = yurt_runtime_wasmtime::vfs::MemVfs::import_bytes(&blob).unwrap();
    let content = vfs2.read_file("/tmp/persist.txt").unwrap();
    assert_eq!(content, b"persistent data");

    // Accounting must reflect the actual imported tree, not init_layout defaults
    let total = vfs2.total_bytes();
    assert!(
        total >= b"persistent data".len(),
        "expected total_bytes >= 15 after import, got {total}"
    );
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_persistence_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    // create
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // Write a file
    let data_b64 = base64::engine::general_purpose::STANDARD.encode(b"hello persistence");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "files.write",
        serde_json::json!({"path": "/tmp/data.txt", "data": data_b64}),
    ).await;
    assert!(r.result.is_some(), "files.write failed: {:?}", r.error);

    // Export state
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
        "persistence.export",
        serde_json::json!({}),
    ).await;
    assert!(r.error.is_none(), "export failed: {:?}", r.error);
    let blob_b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();

    // Overwrite file with different content
    let data2_b64 = base64::engine::general_purpose::STANDARD.encode(b"overwritten");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)),
        "files.write",
        serde_json::json!({"path": "/tmp/data.txt", "data": data2_b64}),
    ).await;
    assert!(r.result.is_some(), "files.write 2 failed: {:?}", r.error);

    // Import state (restores original content)
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(5)),
        "persistence.import",
        serde_json::json!({"data": blob_b64}),
    ).await;
    assert!(r.error.is_none(), "import failed: {:?}", r.error);

    // Verify restored content
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(6)),
        "files.read",
        serde_json::json!({"path": "/tmp/data.txt"}),
    ).await;
    assert!(r.error.is_none(), "files.read failed: {:?}", r.error);
    let content_b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();
    let content = base64::engine::general_purpose::STANDARD.decode(content_b64).unwrap();
    assert_eq!(content, b"hello persistence");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_fork() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    sb.shell.vfs_mut().write_file("/tmp/shared.txt", b"shared", false).unwrap();
    let forked = sb.fork().await.unwrap();

    let fork_id = "f1".to_string();
    mgr.forks.insert(fork_id.clone(), forked);

    // Fork can read the file
    let fork = mgr.forks.get_mut(&fork_id).unwrap();
    let content = fork.shell.vfs().read_file("/tmp/shared.txt").unwrap();
    assert_eq!(content, b"shared");

    // Fork write does not affect root
    fork.shell.vfs_mut().write_file("/tmp/fork_only.txt", b"fork", false).unwrap();
    assert!(mgr.root.as_ref().unwrap().shell.vfs().read_file("/tmp/fork_only.txt").is_err());
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_sandbox_fork_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    // create root sandbox
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // Write file to root
    let root_data = base64::engine::general_purpose::STANDARD.encode(b"root data");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "files.write",
        serde_json::json!({"path": "/tmp/root.txt", "data": root_data}),
    ).await;
    assert!(r.result.is_some(), "files.write failed: {:?}", r.error);

    // Fork the root sandbox
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
        "sandbox.fork",
        serde_json::json!({}),
    ).await;
    assert!(r.error.is_none(), "fork failed: {:?}", r.error);
    let fork_id = r.result.unwrap()["sandboxId"].as_str().unwrap().to_string();

    // Read file in fork — should see root's data
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)),
        "files.read",
        serde_json::json!({"path": "/tmp/root.txt", "sandboxId": fork_id}),
    ).await;
    assert!(r.error.is_none(), "files.read in fork failed: {:?}", r.error);
    let b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();
    let content = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(content, b"root data");

    // Write in fork — should not affect root
    let fork_data = base64::engine::general_purpose::STANDARD.encode(b"fork only");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(5)),
        "files.write",
        serde_json::json!({"path": "/tmp/fork_only.txt", "sandboxId": fork_id, "data": fork_data}),
    ).await;
    assert!(r.result.is_some(), "files.write in fork failed: {:?}", r.error);

    // Reading fork_only.txt from root should fail
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(6)),
        "files.read",
        serde_json::json!({"path": "/tmp/fork_only.txt"}), // no sandboxId = root
    ).await;
    assert!(r.error.is_some(), "fork write should not affect root");

    // Destroy fork
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(7)),
        "sandbox.destroy",
        serde_json::json!({"sandboxId": fork_id}),
    ).await;
    assert!(r.error.is_none(), "sandbox.destroy failed: {:?}", r.error);

    // After destroy, accessing the fork should fail
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(8)),
        "files.read",
        serde_json::json!({"path": "/tmp/root.txt", "sandboxId": fork_id}),
    ).await;
    assert!(r.error.is_some(), "accessing destroyed fork should fail");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_sandbox_create_list_remove_rpc() {
    use base64::Engine as _;
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    // create root sandbox
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    // sandbox.list — should be empty initially
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "sandbox.list",
        serde_json::json!({}),
    ).await;
    assert!(r.error.is_none(), "sandbox.list failed: {:?}", r.error);
    let list = r.result.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 0, "expected empty named sandbox list");

    // sandbox.create
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
        "sandbox.create",
        serde_json::json!({}),
    ).await;
    assert!(r.error.is_none(), "sandbox.create failed: {:?}", r.error);
    let named_id = r.result.unwrap()["sandboxId"].as_str().unwrap().to_string();

    // sandbox.list — should have one entry
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)),
        "sandbox.list",
        serde_json::json!({}),
    ).await;
    assert!(r.error.is_none());
    let list = r.result.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);

    // Write file to named sandbox
    let data = base64::engine::general_purpose::STANDARD.encode(b"named data");
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(5)),
        "files.write",
        serde_json::json!({"path": "/tmp/named.txt", "sandboxId": named_id, "data": data}),
    ).await;
    assert!(r.result.is_some(), "files.write to named failed: {:?}", r.error);

    // Read from named sandbox
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(6)),
        "files.read",
        serde_json::json!({"path": "/tmp/named.txt", "sandboxId": named_id}),
    ).await;
    assert!(r.error.is_none(), "files.read from named failed: {:?}", r.error);
    let b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();
    let content = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
    assert_eq!(content, b"named data");

    // Named sandbox is isolated from root
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(7)),
        "files.read",
        serde_json::json!({"path": "/tmp/named.txt"}), // no sandboxId = root
    ).await;
    assert!(r.error.is_some(), "named sandbox write should not affect root");

    // sandbox.remove
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(8)),
        "sandbox.remove",
        serde_json::json!({"sandboxId": named_id}),
    ).await;
    assert!(r.error.is_none(), "sandbox.remove failed: {:?}", r.error);

    // sandbox.list — should be empty again
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(9)),
        "sandbox.list",
        serde_json::json!({}),
    ).await;
    assert!(r.error.is_none());
    let list = r.result.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 0);
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_history() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    mgr.root_run("echo first").await.unwrap();
    mgr.root_run("echo second").await.unwrap();

    let sb = mgr.root.as_mut().unwrap();
    let result = sb.run("history").await.unwrap();
    let stdout = result["stdout"].as_str().unwrap();
    // history output should contain the commands we ran
    assert!(stdout.contains("echo first"), "expected 'echo first' in history: {stdout}");
    assert!(stdout.contains("echo second"), "expected 'echo second' in history: {stdout}");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_removed_history_rpc_handlers() {
    use yurt_runtime_wasmtime::dispatcher::Dispatcher;
    use yurt_runtime_wasmtime::rpc::codes;
    use tokio::sync::mpsc;

    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");
    disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;

    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "shell.history.list",
        serde_json::json!({}),
    ).await;
    let err = r.error.expect("shell.history.list should be removed");
    assert_eq!(err.code, codes::METHOD_NOT_FOUND);
    assert!(err.message.contains("shell.history.list"));

    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
        "shell.history.clear",
        serde_json::json!({}),
    ).await;
    let err = r.error.expect("shell.history.clear should be removed");
    assert_eq!(err.code, codes::METHOD_NOT_FOUND);
    assert!(err.message.contains("shell.history.clear"));
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_offload_rehydrate() {
    use yurt_runtime_wasmtime::dispatcher::Dispatcher;
    use tokio::sync::mpsc;

    let (stdout_tx, mut stdout_rx) = mpsc::channel::<String>(16);
    let (cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = Dispatcher::new(stdout_tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");
    disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;

    // Write a file via files.write so it goes directly into the VFS
    let content_b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"stateful");
    disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
        "files.write",
        serde_json::json!({"path": "/stateful.txt", "data": content_b64}),
    ).await;

    // --- Offload ---
    // offload sends a storage.save callback to stdout and waits for a response
    // on cb_rx. We drive both sides concurrently.
    let (offload_resp, saved_state) = tokio::join!(
        disp.dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(3)),
            "offload",
            serde_json::json!({}),
        ),
        async {
            let raw = stdout_rx.recv().await.expect("storage.save callback");
            let cb_req: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(cb_req["method"].as_str().unwrap(), "storage.save");
            let cb_id = cb_req["id"].as_str().unwrap().to_string();
            let saved = cb_req["params"]["state"].as_str().unwrap().to_string();
            cb_tx.send(serde_json::to_string(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": cb_id,
                "result": "ok"
            })).unwrap()).await.unwrap();
            saved
        }
    );
    assert!(offload_resp.0.error.is_none(), "offload failed: {:?}", offload_resp.0.error);

    // --- Rehydrate ---
    // rehydrate sends a storage.load callback and expects the saved blob back
    let (rehydrate_resp, ()) = tokio::join!(
        disp.dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(4)),
            "rehydrate",
            serde_json::json!({}),
        ),
        async {
            let raw = stdout_rx.recv().await.expect("storage.load callback");
            let cb_req: serde_json::Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(cb_req["method"].as_str().unwrap(), "storage.load");
            let cb_id = cb_req["id"].as_str().unwrap().to_string();
            cb_tx.send(serde_json::to_string(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": cb_id,
                "result": saved_state
            })).unwrap()).await.unwrap();
        }
    );
    assert!(rehydrate_resp.0.error.is_none(), "rehydrate failed: {:?}", rehydrate_resp.0.error);

    // Verify the file is accessible after rehydrate via files.read
    let (r, _) = disp.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(5)),
        "files.read",
        serde_json::json!({"path": "/stateful.txt"}),
    ).await;
    assert!(r.error.is_none(), "files.read after rehydrate failed: {:?}", r.error);
    let data_b64 = r.result.unwrap()["data"].as_str().unwrap().to_string();
    let data = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &data_b64).unwrap();
    assert_eq!(data, b"stateful", "expected 'stateful' in file after rehydrate");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_streaming_run() {
    use yurt_runtime_wasmtime::dispatcher::Dispatcher;
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<String>(64);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut d = Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");
    d.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
        "create",
        serde_json::json!({"shellWasmPath": wasm_path.to_str().unwrap()}),
    ).await;
    // drain create response
    while rx.try_recv().is_ok() {}

    // Run with stream: true
    let (resp, _) = d.dispatch(
        Some(yurt_runtime_wasmtime::rpc::RequestId::Int(42)),
        "run",
        serde_json::json!({"command": "echo streaming_output", "stream": true}),
    ).await;
    assert!(resp.error.is_none(), "run failed: {:?}", resp.error);

    // The final response should have empty stdout and stderr (both were streamed)
    let result = resp.result.unwrap();
    assert_eq!(result["stdout"].as_str().unwrap_or("nope"), "");
    assert_eq!(result["stderr"].as_str().unwrap_or("nope"), "");
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);

    // The output notification should be in rx
    let mut found_notification = false;
    while let Ok(msg) = rx.try_recv() {
        let v: serde_json::Value = serde_json::from_str(&msg).unwrap();
        if v.get("method").and_then(|m| m.as_str()) == Some("output") {
            let params = &v["params"];
            assert_eq!(params["request_id"], serde_json::json!(42));
            assert_eq!(params["stream"].as_str().unwrap(), "stdout");
            assert!(params["data"].as_str().unwrap().contains("streaming_output"));
            found_notification = true;
        }
    }
    assert!(found_notification, "expected output notification in channel");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_timeout_kills_command() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    // 500ms timeout
    mgr.create(wasm, None, Some(500), 0, None).await.unwrap();
    let result = mgr.root_run("sleep 100").await.unwrap();
    assert_eq!(
        result["exitCode"].as_i64().unwrap(),
        124,
        "expected exit code 124 (timeout)"
    );
    assert!(result["stderr"].as_str().unwrap().contains("timeout"));
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_poisoned_after_timeout() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, Some(300), 0, None).await.unwrap();
    // First run times out
    let r = mgr.root_run("sleep 100").await.unwrap();
    assert_eq!(r["exitCode"].as_i64().unwrap(), 124);
    // Second run should fail because sandbox is poisoned
    let err = mgr.root_run("echo hello").await;
    assert!(err.is_err(), "expected error on poisoned sandbox");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_nice_doesnt_break_execution() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    // nice=19: yields every 1ms, but should still run correctly
    mgr.create(wasm, None, None, 19, None).await.unwrap();
    let result = mgr.root_run("echo 'nice works'").await.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().contains("nice works"));
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_nice_command_forwards_stdout() {
    // `nice echo hello` must produce stdout "hello\n" (regression: was empty
    // because run_child always wrapped commands through __run_command, causing
    // infinite recursion for non-builtin programs like `nice`).
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    // `nice` with no args → should print "0"
    let r = mgr.root_run("nice").await.unwrap();
    assert_eq!(r["exitCode"].as_i64().unwrap(), 0);
    assert_eq!(r["stdout"].as_str().unwrap().trim(), "0");

    // `nice echo hello` → should print "hello"
    let r = mgr.root_run("nice echo hello").await.unwrap();
    assert_eq!(r["exitCode"].as_i64().unwrap(), 0);
    assert_eq!(r["stdout"].as_str().unwrap().trim(), "hello");

    // `nice -n 10 echo world` → should print "world"
    let r = mgr.root_run("nice -n 10 echo world").await.unwrap();
    assert_eq!(r["exitCode"].as_i64().unwrap(), 0);
    assert_eq!(r["stdout"].as_str().unwrap().trim(), "world");
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_suspend_resume() {
    let wasm = wasm_bytes();
    let mut mgr = SandboxManager::new();
    mgr.create(wasm, None, None, 0, None).await.unwrap();

    // Pre-pause: suspend before the next run.
    let sb = mgr.root.as_mut().unwrap();
    sb.paused.store(true, std::sync::atomic::Ordering::Release);

    // Resume after a short delay from a background task.
    let notify = sb.resume_notify.clone();
    let paused = sb.paused.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        paused.store(false, std::sync::atomic::Ordering::Release);
        notify.notify_waiters();
    });

    // run() should block until the background task resumes it.
    let result = mgr.root_run("echo 'resumed'").await.unwrap();
    assert_eq!(result["exitCode"].as_i64().unwrap(), 0);
    assert!(result["stdout"].as_str().unwrap().contains("resumed"));
}

#[tokio::test]
#[ignore = "blocked on adapting imported shell-dependent integration tests to Yurt runtime semantics"]
async fn test_timeout_rpc() {
    use tokio::sync::mpsc;
    let (tx, _rx) = mpsc::channel::<String>(16);
    let (_cb_tx, cb_rx) = mpsc::channel::<String>(4);
    let mut disp = yurt_runtime_wasmtime::dispatcher::Dispatcher::new(tx, cb_rx);

    let wasm_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/kernel/src/platform/__tests__/fixtures/yurt-shell-exec.wasm");

    let (r, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(1)),
            "create",
            serde_json::json!({
                "shellWasmPath": wasm_path.to_str().unwrap(),
                "timeoutMs": 500,
            }),
        )
        .await;
    assert!(r.result.is_some(), "create failed: {:?}", r.error);

    let (r2, _) = disp
        .dispatch(
            Some(yurt_runtime_wasmtime::rpc::RequestId::Int(2)),
            "run",
            serde_json::json!({ "command": "sleep 100" }),
        )
        .await;
    assert!(r2.result.is_some(), "run should return result not error");
    assert_eq!(
        r2.result.unwrap()["exitCode"].as_i64().unwrap(),
        124
    );
}
