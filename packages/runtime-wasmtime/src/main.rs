//! yurt-runtime-wasmtime — Wasmtime-based sandbox server.
//!
//! Reads newline-delimited JSON-RPC 2.0 from stdin, writes responses to stdout.
//! All diagnostic output goes to stderr so stdout stays clean for RPC.
//!
//! Transport contract (matches the TypeScript runtime server exactly):
//!   - One JSON object per line on stdin (request).
//!   - One JSON object per line on stdout (response or notification).
//!   - stderr: human-readable logs only.
//!   - First method must be `create`; last method is `kill` (exits the process).

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use yurt_runtime_wasmtime::dispatcher;
use yurt_runtime_wasmtime::rpc::{codes, Request, Response};

/// Maximum allowed request size (matches TypeScript runtime server default).
const MAX_REQUEST_BYTES: usize = 8 * 1024 * 1024; // 8 MB

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // All logs go to stderr — stdout is reserved for JSON-RPC responses.
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tracing::info!("yurt-runtime-wasmtime starting");

    // Single stdout writer task prevents response interleaving when parallel
    // dispatch is added in later phases.
    let (stdout_tx, stdout_rx) = mpsc::channel::<String>(64);
    tokio::spawn(stdout_writer(stdout_rx));

    // Callback channel: responses to host-initiated requests (id starts with "cb_").
    let (cb_tx, cb_rx) = mpsc::channel::<String>(4);

    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let mut dispatcher = dispatcher::Dispatcher::new(stdout_tx.clone(), cb_rx);

    while let Some(line) = lines.next_line().await? {
        // Guard against oversized payloads before parsing.
        if line.len() > MAX_REQUEST_BYTES {
            let resp = Response::err(None, codes::PARSE_ERROR, "request too large");
            send(&stdout_tx, &resp).await;
            continue;
        }

        // Check if this is a callback response (id is a string starting with "cb_"
        // and no "method" key): route to cb_tx and skip normal dispatch.
        if let Ok(raw) = serde_json::from_str::<serde_json::Value>(&line) {
            let is_cb = raw.get("id")
                .and_then(|v| v.as_str())
                .map(|s| s.starts_with("cb_"))
                .unwrap_or(false)
                && raw.get("method").is_none();
            if is_cb {
                let _ = cb_tx.send(line).await;
                continue;
            }
        }

        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                let resp =
                    Response::err(None, codes::PARSE_ERROR, format!("JSON parse error: {e}"));
                send(&stdout_tx, &resp).await;
                continue;
            }
        };

        tracing::debug!(method = %req.method, "dispatch");

        let id = req.id;
        let method = req.method.clone();
        let (resp, should_kill) = dispatcher.dispatch(id, &method, req.params).await;

        send(&stdout_tx, &resp).await;

        if should_kill {
            // Drop the sender so the writer task drains and exits cleanly.
            drop(stdout_tx);
            // Give the writer task a moment to flush the kill response.
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            std::process::exit(0);
        }
    }

    // stdin closed — clean exit.
    tracing::info!("stdin closed, exiting");
    Ok(())
}

/// Serialize a response and queue it for writing.  Logs on serialization error
/// (shouldn't happen with well-formed responses).
async fn send(tx: &mpsc::Sender<String>, resp: &Response) {
    match serde_json::to_string(resp) {
        Ok(line) => {
            let _ = tx.send(line).await;
        }
        Err(e) => tracing::error!("failed to serialize response: {e}"),
    }
}

/// Single-writer task: reads serialized responses from the channel and writes
/// them to stdout one line at a time.  Having a single writer guarantees that
/// concurrent responses (added in later phases) never interleave on the wire.
async fn stdout_writer(mut rx: mpsc::Receiver<String>) {
    let mut out = tokio::io::BufWriter::new(tokio::io::stdout());
    while let Some(line) = rx.recv().await {
        if out.write_all(line.as_bytes()).await.is_err() {
            break;
        }
        if out.write_all(b"\n").await.is_err() {
            break;
        }
        if out.flush().await.is_err() {
            break;
        }
    }
}
