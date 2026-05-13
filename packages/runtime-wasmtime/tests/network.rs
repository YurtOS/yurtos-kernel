//! Integration tests for network::fetch (no WASM needed).

use wiremock::matchers::{body_bytes, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};
use yurt_runtime_wasmtime::wasm::network;

#[tokio::test]
async fn invalid_native_record_returns_error_record() {
    let record = network::fetch(b"not a native record").await;
    let response = decode_response(&record);
    assert_eq!(response.status, 0);
    assert!(
        response.error.to_lowercase().contains("fetch request"),
        "error should mention invalid fetch request, got: {}",
        response.error
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

    let req = request_record(&format!("{}/hello", server.uri()), "GET", &[], b"");
    let result = decode_response(&network::fetch(&req).await);
    assert_eq!(result.status, 200, "status should be 200");
    assert_eq!(result.body, b"world", "body should be 'world'");
}

#[tokio::test]
async fn post_with_headers_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/data"))
        .and(header("authorization", "Bearer token"))
        .and(header("content-type", "text/plain"))
        .and(body_bytes("payload"))
        .respond_with(ResponseTemplate::new(201).set_body_bytes(b"created"))
        .mount(&server)
        .await;

    let req = request_record(
        &format!("{}/data", server.uri()),
        "POST",
        &[
            ("authorization", "Bearer token"),
            ("content-type", "text/plain"),
        ],
        b"payload",
    );
    let result = decode_response(&network::fetch(&req).await);
    assert_eq!(result.status, 201, "status should be 201");
    assert_eq!(result.body, b"created");
}

#[tokio::test]
async fn error_status_preserves_status_and_body() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/missing"))
        .respond_with(ResponseTemplate::new(404).set_body_bytes(b"not found"))
        .mount(&server)
        .await;

    let req = request_record(&format!("{}/missing", server.uri()), "GET", &[], b"");
    let result = decode_response(&network::fetch(&req).await);
    assert_eq!(result.status, 404, "status should be 404");
    assert_eq!(result.body, b"not found");
}

#[tokio::test]
async fn binary_response_is_raw_body_bytes() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/binary"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes([0xFF, 0xFE]))
        .mount(&server)
        .await;

    let req = request_record(&format!("{}/binary", server.uri()), "GET", &[], b"");
    let result = decode_response(&network::fetch(&req).await);
    assert_eq!(result.status, 200);
    assert_eq!(result.body, [0xff, 0xfe]);
}

#[tokio::test]
async fn manual_redirect_mode_returns_redirect_response() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/redirect"))
        .respond_with(
            ResponseTemplate::new(302)
                .insert_header("location", "/final")
                .set_body_bytes(b"redirect body"),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/final"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(b"final body"))
        .mount(&server)
        .await;

    let req = request_record(&format!("{}/redirect", server.uri()), "GET", &[], b"");
    let result = decode_response(&network::fetch(&req).await);
    assert_eq!(result.status, 302);
    assert_eq!(result.body, b"redirect body");
}

struct FetchResponse {
    status: u32,
    body: Vec<u8>,
    error: String,
}

fn request_record(url: &str, method: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let header_size = 44usize;
    let pair_size = 16usize;
    let pairs_offset = header_size;
    let mut cursor = pairs_offset + headers.len() * pair_size;
    let url_offset = cursor;
    cursor += url.len();
    let method_offset = cursor;
    cursor += method.len();
    let mut pairs = Vec::new();
    for (key, value) in headers {
        let key_offset = cursor;
        cursor += key.len();
        let value_offset = cursor;
        cursor += value.len();
        pairs.push((key_offset, key.len(), value_offset, value.len()));
    }
    let body_offset = cursor;
    let size = body_offset + body.len();
    let mut record = vec![0u8; size];
    write_u32(&mut record, 0, size as u32);
    write_u16(&mut record, 4, 1);
    write_u32(&mut record, 8, url_offset as u32);
    write_u32(&mut record, 12, url.len() as u32);
    write_u32(&mut record, 16, method_offset as u32);
    write_u32(&mut record, 20, method.len() as u32);
    write_u32(&mut record, 24, pairs_offset as u32);
    write_u32(&mut record, 28, headers.len() as u32);
    write_u32(&mut record, 32, body_offset as u32);
    write_u32(&mut record, 36, body.len() as u32);
    write_u32(&mut record, 40, 1);
    for (idx, (key_offset, key_len, value_offset, value_len)) in pairs.iter().enumerate() {
        let at = pairs_offset + idx * pair_size;
        write_u32(&mut record, at, *key_offset as u32);
        write_u32(&mut record, at + 4, *key_len as u32);
        write_u32(&mut record, at + 8, *value_offset as u32);
        write_u32(&mut record, at + 12, *value_len as u32);
    }
    let mut write_cursor = pairs_offset + headers.len() * pair_size;
    record[write_cursor..write_cursor + url.len()].copy_from_slice(url.as_bytes());
    write_cursor += url.len();
    record[write_cursor..write_cursor + method.len()].copy_from_slice(method.as_bytes());
    write_cursor += method.len();
    for (key, value) in headers {
        record[write_cursor..write_cursor + key.len()].copy_from_slice(key.as_bytes());
        write_cursor += key.len();
        record[write_cursor..write_cursor + value.len()].copy_from_slice(value.as_bytes());
        write_cursor += value.len();
    }
    record[body_offset..].copy_from_slice(body);
    record
}

fn decode_response(record: &[u8]) -> FetchResponse {
    assert!(record.len() >= 36);
    assert_eq!(read_u32(record, 0) as usize, record.len());
    assert_eq!(u16::from_le_bytes(record[4..6].try_into().unwrap()), 1);
    let status = read_u32(record, 8);
    let body_offset = read_u32(record, 20) as usize;
    let body_len = read_u32(record, 24) as usize;
    let error_offset = read_u32(record, 28) as usize;
    let error_len = read_u32(record, 32) as usize;
    FetchResponse {
        status,
        body: record[body_offset..body_offset + body_len].to_vec(),
        error: String::from_utf8(record[error_offset..error_offset + error_len].to_vec()).unwrap(),
    }
}

fn write_u16(record: &mut [u8], offset: usize, value: u16) {
    record[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(record: &mut [u8], offset: usize, value: u32) {
    record[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u32(record: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(record[offset..offset + 4].try_into().unwrap())
}
