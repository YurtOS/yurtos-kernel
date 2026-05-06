//! HTTP fetch implementation for `host_network_fetch`.
//!
//! Shares a single `reqwest::Client` (with a 30-second timeout and connection
//! pooling) across all sandboxes.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine as _;
use serde::{Deserialize, Serialize};

// ── Shared HTTP client ────────────────────────────────────────────────────────

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build HTTP client")
    })
}

// ── Wire types ────────────────────────────────────────────────────────────────

/// JSON request from the guest via `host_network_fetch`.
#[derive(Deserialize)]
struct FetchRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    /// Body as a UTF-8 string.
    body: Option<String>,
}

fn default_method() -> String {
    "GET".to_owned()
}

/// JSON response written back to the guest.
#[derive(Serialize)]
struct FetchResult<'a> {
    ok: bool,
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    body_base64: Option<String>,
    error: Option<&'a str>,
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Perform the HTTP request described by `req_json` and return the
/// JSON-encoded `FetchResult` as a `String`.
///
/// Never fails (errors are encoded in `FetchResult.error`).
pub async fn fetch(req_json: &str) -> String {
    match serde_json::from_str::<FetchRequest>(req_json) {
        Ok(req) => do_fetch(req).await,
        Err(e) => error_result(&format!("invalid request JSON: {e}")),
    }
}

async fn do_fetch(req: FetchRequest) -> String {
    // Build the reqwest request.
    let method = match req.method.to_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        other => match reqwest::Method::from_bytes(other.as_bytes()) {
            Ok(m) => m,
            Err(_) => return error_result(&format!("unknown HTTP method: {other}")),
        },
    };

    let mut builder = client().request(method, &req.url);

    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }

    if let Some(body) = req.body {
        builder = builder.body(body);
    }

    let response = match builder.send().await {
        Ok(r) => r,
        Err(e) => return error_result(&format!("request failed: {e}")),
    };

    let status = response.status().as_u16();
    let ok = response.status().is_success();

    // Collect response headers.
    let headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    // Read the body bytes.
    let body_bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => return error_result(&format!("reading response body: {e}")),
    };

    // Represent body as UTF-8 if possible; base64 otherwise.
    let (body, body_base64) = match String::from_utf8(body_bytes.to_vec()) {
        Ok(s) => (s, None),
        Err(e) => {
            let b64 = base64::engine::general_purpose::STANDARD.encode(e.into_bytes());
            (String::new(), Some(b64))
        }
    };

    serde_json::to_string(&FetchResult {
        ok,
        status,
        headers,
        body,
        body_base64,
        error: None,
    })
    .unwrap_or_else(|e| error_result(&format!("serializing response: {e}")))
}

fn error_result(msg: &str) -> String {
    serde_json::to_string(&FetchResult {
        ok: false,
        status: 0,
        headers: HashMap::new(),
        body: String::new(),
        body_base64: None,
        error: Some(msg),
    })
    .unwrap_or_else(|_| r#"{"ok":false,"status":0,"headers":{},"body":"","error":"serialization failed"}"#.to_owned())
}
