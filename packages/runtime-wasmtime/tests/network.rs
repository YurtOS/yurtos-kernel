//! Integration tests for network::fetch (no WASM needed).

use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};
use yurt_runtime_wasmtime::wasm::network;

#[tokio::test]
async fn invalid_json_returns_error() {
    let result_str = network::fetch("not json").await;
    let v: serde_json::Value =
        serde_json::from_str(&result_str).expect("result should be valid JSON");
    assert_eq!(
        v["ok"], false,
        "ok should be false for invalid JSON request"
    );
    let error = v["error"].as_str().unwrap_or("");
    assert!(
        error.to_lowercase().contains("invalid request"),
        "error should mention 'invalid request', got: {error}"
    );
}

#[tokio::test]
async fn get_request_ok() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/hello"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"world"))
        .mount(&server)
        .await;

    let req = serde_json::json!({
        "url": format!("{}/hello", server.uri()),
        "method": "GET"
    });
    let result_str = network::fetch(&req.to_string()).await;
    let v: serde_json::Value =
        serde_json::from_str(&result_str).expect("result should be valid JSON");
    assert_eq!(v["ok"], true, "ok should be true for 200 response");
    assert_eq!(v["status"], 200, "status should be 200");
    assert_eq!(v["body"], "world", "body should be 'world'");
}

#[tokio::test]
async fn post_with_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/data"))
        .respond_with(ResponseTemplate::new(201).set_body_bytes(b"created"))
        .mount(&server)
        .await;

    let req = serde_json::json!({
        "url": format!("{}/data", server.uri()),
        "method": "POST",
        "body": "payload"
    });
    let result_str = network::fetch(&req.to_string()).await;
    let v: serde_json::Value =
        serde_json::from_str(&result_str).expect("result should be valid JSON");
    assert_eq!(v["ok"], true, "ok should be true for 201 response");
    assert_eq!(v["status"], 201, "status should be 201");
}

#[tokio::test]
async fn error_status_sets_ok_false() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_bytes(b"not found"))
        .mount(&server)
        .await;

    let req = serde_json::json!({
        "url": format!("{}/missing", server.uri()),
        "method": "GET"
    });
    let result_str = network::fetch(&req.to_string()).await;
    let v: serde_json::Value =
        serde_json::from_str(&result_str).expect("result should be valid JSON");
    assert_eq!(v["ok"], false, "ok should be false for 404 response");
    assert_eq!(v["status"], 404, "status should be 404");
}

#[tokio::test]
async fn binary_response_uses_base64() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/binary"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(&[0xFF, 0xFE]))
        .mount(&server)
        .await;

    let req = serde_json::json!({
        "url": format!("{}/binary", server.uri()),
        "method": "GET"
    });
    let result_str = network::fetch(&req.to_string()).await;
    let v: serde_json::Value =
        serde_json::from_str(&result_str).expect("result should be valid JSON");
    assert_eq!(v["ok"], true, "ok should be true for 200 response");
    assert_eq!(v["body"], "", "body should be empty for non-UTF8 response");
    assert!(
        !v["body_base64"].is_null(),
        "body_base64 should be non-null for non-UTF8 response"
    );
}
