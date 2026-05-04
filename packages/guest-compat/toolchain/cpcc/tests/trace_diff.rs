use cpcc_toolchain::spec::{Case, Expected, Spec};
use cpcc_toolchain::trace::{diff_case, parse_trace_line, Mismatch, TraceLine};

fn case(name: &str, exp: Expected) -> Case {
    Case { name: name.into(), inputs: None, expected: exp }
}

#[test]
fn parses_well_formed_trace_line() {
    let line = r#"{"case":"happy","exit":0,"stdout":"ok"}"#;
    let t = parse_trace_line(line).unwrap();
    assert_eq!(t.case, "happy");
    assert_eq!(t.exit, 0);
    assert_eq!(t.stdout.as_deref(), Some("ok"));
    assert_eq!(t.errno, None);
}

#[test]
fn parses_trace_with_errno() {
    let line = r#"{"case":"bad","exit":1,"errno":8}"#;
    let t = parse_trace_line(line).unwrap();
    assert_eq!(t.errno, Some(8));
    assert_eq!(t.stdout, None);
}

#[test]
fn rejects_trace_with_no_case_field() {
    let line = r#"{"exit":0}"#;
    assert!(parse_trace_line(line).is_err());
}

#[test]
fn diff_passes_when_all_expected_fields_match() {
    let exp = Expected { exit: Some(0), stdout: Some("ok".into()), ..Default::default() };
    let trace = TraceLine { case: "happy".into(), exit: 0, stdout: Some("ok".into()), errno: None };
    let mismatches = diff_case(&case("happy", exp), &trace, /*process_exit*/ 0);
    assert!(mismatches.is_empty(), "got mismatches: {mismatches:?}");
}

#[test]
fn diff_reports_exit_mismatch() {
    let exp = Expected { exit: Some(0), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 1, stdout: None, errno: None };
    let mm = diff_case(&case("x", exp), &trace, 1);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Exit { expected: 0, actual: 1 })));
}

#[test]
fn diff_reports_process_vs_trace_exit_disagreement() {
    let exp = Expected { exit: Some(0), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 0, stdout: None, errno: None };
    // Trace says exit=0, but the process actually exited 2 — disagreement.
    let mm = diff_case(&case("x", exp), &trace, 2);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::ProcessTraceExitDisagree { .. })));
}

#[test]
fn diff_reports_stdout_mismatch() {
    let exp = Expected { exit: Some(0), stdout: Some("hi".into()), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 0, stdout: Some("hello".into()), errno: None };
    let mm = diff_case(&case("x", exp), &trace, 0);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Stdout { .. })));
}

#[test]
fn diff_reports_errno_mismatch() {
    let exp = Expected { exit: Some(1), errno: Some(8), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 1, stdout: None, errno: Some(28) };
    let mm = diff_case(&case("x", exp), &trace, 1);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Errno { expected: 8, actual: Some(28) })));
}

#[test]
fn diff_reports_missing_errno_when_expected() {
    let exp = Expected { exit: Some(1), errno: Some(8), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 1, stdout: None, errno: None };
    let mm = diff_case(&case("x", exp), &trace, 1);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::Errno { expected: 8, actual: None })));
}

#[test]
fn diff_reports_case_name_mismatch() {
    let exp = Expected { exit: Some(0), ..Default::default() };
    let trace = TraceLine { case: "wrong_name".into(), exit: 0, stdout: None, errno: None };
    let mm = diff_case(&case("expected_name", exp), &trace, 0);
    assert!(mm.iter().any(|m| matches!(m, Mismatch::CaseName { .. })));
}

#[test]
fn note_field_is_never_diffed() {
    let exp = Expected { exit: Some(0), note: Some("ignored".into()), ..Default::default() };
    let trace = TraceLine { case: "x".into(), exit: 0, stdout: None, errno: None };
    let mm = diff_case(&case("x", exp), &trace, 0);
    assert!(mm.is_empty(), "note must not contribute to diff");
}
