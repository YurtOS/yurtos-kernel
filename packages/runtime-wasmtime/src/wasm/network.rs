//! HTTP fetch implementation for `host_network_fetch`.
//!
//! Shares a single `reqwest::Client` (with a 30-second timeout and connection
//! pooling) across all sandboxes.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

// ── Shared HTTP client ────────────────────────────────────────────────────────

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static MANUAL_REDIRECT_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("failed to build HTTP client")
    })
}

fn manual_redirect_client() -> &'static reqwest::Client {
    MANUAL_REDIRECT_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build HTTP client")
    })
}

// ── Native wire types ─────────────────────────────────────────────────────────

#[derive(Debug, PartialEq, Eq)]
pub struct FetchRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
    redirect_mode: u32,
}

fn read_u16(bytes: &[u8], offset: usize) -> Option<u16> {
    Some(u16::from_le_bytes(
        bytes.get(offset..offset + 2)?.try_into().ok()?,
    ))
}

fn read_u32(bytes: &[u8], offset: usize) -> Option<u32> {
    Some(u32::from_le_bytes(
        bytes.get(offset..offset + 4)?.try_into().ok()?,
    ))
}

fn read_span(bytes: &[u8], offset: u32, len: u32) -> Option<&[u8]> {
    let offset = offset as usize;
    let len = len as usize;
    bytes.get(offset..offset.checked_add(len)?)
}

fn read_string(bytes: &[u8], offset: u32, len: u32) -> Result<String, String> {
    let span = read_span(bytes, offset, len).ok_or_else(|| "invalid fetch span".to_owned())?;
    std::str::from_utf8(span)
        .map(|s| s.to_owned())
        .map_err(|e| format!("invalid UTF-8 in fetch record: {e}"))
}

// ── Public entry point ────────────────────────────────────────────────────────

pub fn decode_fetch_request(record: &[u8]) -> Result<FetchRequest, String> {
    if record.len() < 44 {
        return Err("fetch request record too small".to_owned());
    }
    let size = read_u32(record, 0).ok_or_else(|| "missing fetch record size".to_owned())? as usize;
    let version = read_u16(record, 4).ok_or_else(|| "missing fetch record version".to_owned())?;
    if version != 1 || size != record.len() {
        return Err("invalid fetch request record header".to_owned());
    }

    let url = read_string(
        record,
        read_u32(record, 8).unwrap_or(0),
        read_u32(record, 12).unwrap_or(0),
    )?;
    let method = read_string(
        record,
        read_u32(record, 16).unwrap_or(0),
        read_u32(record, 20).unwrap_or(0),
    )
    .unwrap_or_else(|_| "GET".to_owned());
    let headers_offset = read_u32(record, 24).unwrap_or(0) as usize;
    let headers_count = read_u32(record, 28).unwrap_or(0) as usize;
    let header_bytes = record
        .get(headers_offset..headers_offset.saturating_add(headers_count * 16))
        .ok_or_else(|| "invalid fetch header vector".to_owned())?;
    let mut headers = HashMap::new();
    for idx in 0..headers_count {
        let at = idx * 16;
        let key = read_string(
            record,
            read_u32(header_bytes, at).unwrap_or(0),
            read_u32(header_bytes, at + 4).unwrap_or(0),
        )?;
        let value = read_string(
            record,
            read_u32(header_bytes, at + 8).unwrap_or(0),
            read_u32(header_bytes, at + 12).unwrap_or(0),
        )?;
        headers.insert(key, value);
    }
    let body = read_span(
        record,
        read_u32(record, 32).unwrap_or(0),
        read_u32(record, 36).unwrap_or(0),
    )
    .ok_or_else(|| "invalid fetch body span".to_owned())?
    .to_vec();
    let redirect_mode = read_u32(record, 40).unwrap_or(0);

    Ok(FetchRequest {
        url,
        method,
        headers,
        body,
        redirect_mode,
    })
}

pub async fn fetch(req_record: &[u8]) -> Vec<u8> {
    match decode_fetch_request(req_record) {
        Ok(req) => do_fetch(req).await,
        Err(e) => encode_fetch_response(0, &[], &[], Some(&e)),
    }
}

async fn do_fetch(req: FetchRequest) -> Vec<u8> {
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
            Err(_) => {
                return encode_fetch_response(
                    0,
                    &[],
                    &[],
                    Some(&format!("unknown HTTP method: {other}")),
                );
            }
        },
    };

    let http_client = if req.redirect_mode == 1 {
        manual_redirect_client()
    } else {
        client()
    };
    let mut builder = http_client.request(method, &req.url);

    for (k, v) in &req.headers {
        builder = builder.header(k.as_str(), v.as_str());
    }

    if !req.body.is_empty() {
        builder = builder.body(req.body);
    }

    let response = match builder.send().await {
        Ok(r) => r,
        Err(e) => {
            return encode_fetch_response(0, &[], &[], Some(&format!("request failed: {e}")));
        }
    };

    let status = response.status().as_u16();

    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();

    let body_bytes = match response.bytes().await {
        Ok(b) => b,
        Err(e) => {
            return encode_fetch_response(
                0,
                &[],
                &[],
                Some(&format!("reading response body: {e}")),
            );
        }
    };

    encode_fetch_response(status.into(), &headers, &body_bytes, None)
}

pub fn encode_fetch_response(
    status: u32,
    headers: &[(String, String)],
    body: &[u8],
    error: Option<&str>,
) -> Vec<u8> {
    let header_size = 36usize;
    let pair_size = 16usize;
    let pairs_offset = header_size;
    let mut cursor = pairs_offset + headers.len() * pair_size;
    let mut strings = Vec::new();
    let mut pairs = Vec::new();
    for (key, value) in headers {
        let key_offset = cursor;
        strings.push(key.as_bytes());
        cursor += key.len();
        let value_offset = cursor;
        strings.push(value.as_bytes());
        cursor += value.len();
        pairs.push((key_offset, key.len(), value_offset, value.len()));
    }
    let body_offset = cursor;
    cursor += body.len();
    let error_bytes = error.unwrap_or("").as_bytes();
    let error_offset = cursor;
    cursor += error_bytes.len();

    let mut record = vec![0u8; cursor];
    record[0..4].copy_from_slice(&(cursor as u32).to_le_bytes());
    record[4..6].copy_from_slice(&1u16.to_le_bytes());
    record[8..12].copy_from_slice(&status.to_le_bytes());
    record[12..16].copy_from_slice(&(pairs_offset as u32).to_le_bytes());
    record[16..20].copy_from_slice(&(headers.len() as u32).to_le_bytes());
    record[20..24].copy_from_slice(&(body_offset as u32).to_le_bytes());
    record[24..28].copy_from_slice(&(body.len() as u32).to_le_bytes());
    record[28..32].copy_from_slice(&(error_offset as u32).to_le_bytes());
    record[32..36].copy_from_slice(&(error_bytes.len() as u32).to_le_bytes());
    for (idx, (key_offset, key_len, value_offset, value_len)) in pairs.iter().enumerate() {
        let at = pairs_offset + idx * pair_size;
        record[at..at + 4].copy_from_slice(&(*key_offset as u32).to_le_bytes());
        record[at + 4..at + 8].copy_from_slice(&(*key_len as u32).to_le_bytes());
        record[at + 8..at + 12].copy_from_slice(&(*value_offset as u32).to_le_bytes());
        record[at + 12..at + 16].copy_from_slice(&(*value_len as u32).to_le_bytes());
    }
    let mut write_cursor = pairs_offset + headers.len() * pair_size;
    for bytes in strings {
        record[write_cursor..write_cursor + bytes.len()].copy_from_slice(bytes);
        write_cursor += bytes.len();
    }
    record[body_offset..body_offset + body.len()].copy_from_slice(body);
    record[error_offset..error_offset + error_bytes.len()].copy_from_slice(error_bytes);
    record
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_fetch_request_decodes_header_pairs_and_body() {
        let record = test_fetch_request_record(
            "https://example.test/data",
            "POST",
            &[
                ("Authorization", "Bearer token"),
                ("Content-Type", "text/plain"),
            ],
            b"hello",
        );

        let req = decode_fetch_request(&record).expect("request decodes");

        assert_eq!(req.url, "https://example.test/data");
        assert_eq!(req.method, "POST");
        assert_eq!(req.headers.get("Authorization").unwrap(), "Bearer token");
        assert_eq!(req.headers.get("Content-Type").unwrap(), "text/plain");
        assert_eq!(req.body, b"hello");
    }

    #[test]
    fn native_fetch_response_encodes_headers_body_and_error_span() {
        let record = encode_fetch_response(
            201,
            &[("content-type".to_owned(), "text/plain".to_owned())],
            b"created",
            None,
        );

        assert_eq!(
            u32::from_le_bytes(record[0..4].try_into().unwrap()) as usize,
            record.len()
        );
        assert_eq!(u16::from_le_bytes(record[4..6].try_into().unwrap()), 1);
        assert_eq!(u32::from_le_bytes(record[8..12].try_into().unwrap()), 201);
        assert_eq!(u32::from_le_bytes(record[16..20].try_into().unwrap()), 1);
        let body_offset = u32::from_le_bytes(record[20..24].try_into().unwrap()) as usize;
        let body_len = u32::from_le_bytes(record[24..28].try_into().unwrap()) as usize;
        assert_eq!(&record[body_offset..body_offset + body_len], b"created");
        assert_eq!(u32::from_le_bytes(record[32..36].try_into().unwrap()), 0);
    }

    fn test_fetch_request_record(
        url: &str,
        method: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> Vec<u8> {
        let header_size = 44usize;
        let pair_size = 16usize;
        let pairs_offset = header_size;
        let mut cursor = pairs_offset + headers.len() * pair_size;
        let mut strings = Vec::new();
        let url_offset = cursor;
        strings.push(url.as_bytes());
        cursor += url.len();
        let method_offset = cursor;
        strings.push(method.as_bytes());
        cursor += method.len();
        let mut pairs = Vec::new();
        for (key, value) in headers {
            let key_offset = cursor;
            strings.push(key.as_bytes());
            cursor += key.len();
            let value_offset = cursor;
            strings.push(value.as_bytes());
            cursor += value.len();
            pairs.push((key_offset, key.len(), value_offset, value.len()));
        }
        let body_offset = cursor;
        let size = body_offset + body.len();
        let mut record = vec![0u8; size];
        record[0..4].copy_from_slice(&(size as u32).to_le_bytes());
        record[4..6].copy_from_slice(&1u16.to_le_bytes());
        record[8..12].copy_from_slice(&(url_offset as u32).to_le_bytes());
        record[12..16].copy_from_slice(&(url.len() as u32).to_le_bytes());
        record[16..20].copy_from_slice(&(method_offset as u32).to_le_bytes());
        record[20..24].copy_from_slice(&(method.len() as u32).to_le_bytes());
        record[24..28].copy_from_slice(&(pairs_offset as u32).to_le_bytes());
        record[28..32].copy_from_slice(&(headers.len() as u32).to_le_bytes());
        record[32..36].copy_from_slice(&(body_offset as u32).to_le_bytes());
        record[36..40].copy_from_slice(&(body.len() as u32).to_le_bytes());
        record[40..44].copy_from_slice(&1u32.to_le_bytes());
        for (idx, (key_offset, key_len, value_offset, value_len)) in pairs.iter().enumerate() {
            let at = pairs_offset + idx * pair_size;
            record[at..at + 4].copy_from_slice(&(*key_offset as u32).to_le_bytes());
            record[at + 4..at + 8].copy_from_slice(&(*key_len as u32).to_le_bytes());
            record[at + 8..at + 12].copy_from_slice(&(*value_offset as u32).to_le_bytes());
            record[at + 12..at + 16].copy_from_slice(&(*value_len as u32).to_le_bytes());
        }
        let mut write_cursor = pairs_offset + headers.len() * pair_size;
        for bytes in strings {
            record[write_cursor..write_cursor + bytes.len()].copy_from_slice(bytes);
            write_cursor += bytes.len();
        }
        record[body_offset..].copy_from_slice(body);
        record
    }
}
