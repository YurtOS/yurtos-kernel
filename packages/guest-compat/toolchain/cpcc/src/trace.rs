//! JSONL trace line parsing and diff against `Spec` expectations
//! (§Conformance Driver). The diff returns a Vec<Mismatch> so a single case
//! can report multiple problems at once, surfaced by the conformance driver.

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::spec::Case;

#[derive(Debug, Clone, PartialEq)]
pub struct TraceLine {
    pub case: String,
    pub exit: i32,
    pub stdout: Option<String>,
    pub errno: Option<i32>,
}

#[derive(Deserialize)]
struct RawTrace {
    case: String,
    exit: i32,
    #[serde(default)]
    stdout: Option<String>,
    #[serde(default)]
    errno: Option<i32>,
}

pub fn parse_trace_line(line: &str) -> Result<TraceLine> {
    let raw: RawTrace = serde_json::from_str(line.trim_end_matches('\n'))
        .with_context(|| format!("parsing trace line: {line}"))?;
    if raw.case.is_empty() {
        return Err(anyhow!("trace line has empty case field: {line}"));
    }
    Ok(TraceLine {
        case: raw.case,
        exit: raw.exit,
        stdout: raw.stdout,
        errno: raw.errno,
    })
}

#[derive(Debug, PartialEq)]
pub enum Mismatch {
    CaseName { expected: String, actual: String },
    Exit { expected: i32, actual: i32 },
    ProcessTraceExitDisagree { trace: i32, process: i32 },
    Stdout { expected: String, actual: Option<String> },
    Errno { expected: i32, actual: Option<i32> },
}

/// Compare one trace line against its case spec. The third argument is the
/// process exit code captured by the driver — it must match the trace's
/// self-reported `exit` field, otherwise the canary lied.
pub fn diff_case(case: &Case, trace: &TraceLine, process_exit: i32) -> Vec<Mismatch> {
    let mut out = Vec::new();
    if trace.case != case.name {
        out.push(Mismatch::CaseName {
            expected: case.name.clone(),
            actual: trace.case.clone(),
        });
    }
    if trace.exit != process_exit {
        out.push(Mismatch::ProcessTraceExitDisagree {
            trace: trace.exit,
            process: process_exit,
        });
    }
    if let Some(expected_exit) = case.expected.exit {
        if expected_exit != trace.exit {
            out.push(Mismatch::Exit {
                expected: expected_exit,
                actual: trace.exit,
            });
        }
    }
    if let Some(expected_stdout) = &case.expected.stdout {
        if trace.stdout.as_deref() != Some(expected_stdout.as_str()) {
            out.push(Mismatch::Stdout {
                expected: expected_stdout.clone(),
                actual: trace.stdout.clone(),
            });
        }
    }
    if let Some(expected_errno) = case.expected.errno {
        if trace.errno != Some(expected_errno) {
            out.push(Mismatch::Errno {
                expected: expected_errno,
                actual: trace.errno,
            });
        }
    }
    out
}
