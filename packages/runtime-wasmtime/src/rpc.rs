//! JSON-RPC 2.0 types for the stdio transport.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A request ID can be a number or a string (JSON-RPC 2.0 §5).
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    /// Integer request ID (alias: use `Int` in tests for readability).
    Num(i64),
    Str(String),
}

impl RequestId {
    /// Convenience constructor for integer IDs (mirrors `Num` but named `Int`
    /// to match the test code style).
    #[allow(non_snake_case, dead_code)]
    pub fn Int(n: i64) -> Self {
        Self::Num(n)
    }
}

/// Incoming JSON-RPC request.
#[derive(Debug, Deserialize)]
pub struct Request {
    #[allow(dead_code)]
    pub jsonrpc: String,
    /// None for notifications (no response expected).
    pub id: Option<RequestId>,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

/// Outgoing JSON-RPC response.
#[derive(Debug, Serialize)]
pub struct Response {
    pub jsonrpc: &'static str,
    pub id: Option<RequestId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<RpcError>,
}

/// JSON-RPC error object.
#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// Standard JSON-RPC 2.0 error codes.
pub mod codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    #[allow(dead_code)]
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
}

impl Response {
    pub fn ok(id: Option<RequestId>, result: Value) -> Self {
        Self { jsonrpc: "2.0", id, result: Some(result), error: None }
    }

    pub fn err(id: Option<RequestId>, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(RpcError { code, message: message.into(), data: None }),
        }
    }

    pub fn method_not_found(id: Option<RequestId>, method: &str) -> Self {
        Self::err(id, codes::METHOD_NOT_FOUND, format!("method not found: {method}"))
    }

    pub fn not_implemented(id: Option<RequestId>, method: &str) -> Self {
        Self::err(id, codes::INTERNAL_ERROR, format!("{method}: not yet implemented"))
    }
}
