use cpcc_toolchain::spec::{Expected, Spec};

#[test]
fn parses_minimal_spec_with_one_case() {
    let text = r#"
canary = "dup2-canary"
summary = "test"

[[case]]
name = "happy_path"
expected.exit = 0
expected.stdout = "dup2-ok"
"#;
    let spec: Spec = Spec::from_str(text).unwrap();
    assert_eq!(spec.canary, "dup2-canary");
    assert_eq!(spec.cases.len(), 1);
    assert_eq!(spec.cases[0].name, "happy_path");
    assert_eq!(spec.cases[0].expected.exit, Some(0));
    assert_eq!(spec.cases[0].expected.stdout.as_deref(), Some("dup2-ok"));
    assert_eq!(spec.cases[0].expected.errno, None);
}

#[test]
fn parses_errno_field() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "invalid_fd"
expected.exit = 1
expected.errno = 8
"#;
    let spec: Spec = Spec::from_str(text).unwrap();
    assert_eq!(spec.cases[0].expected.errno, Some(8));
}

#[test]
fn rejects_unknown_expected_field() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "happy_path"
expected.something_made_up = 42
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("unknown field") || err.contains("something_made_up"),
            "expected closed-schema error, got: {err}");
}

#[test]
fn rejects_case_with_no_expected_fields() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "empty"
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("at least one expected"),
            "expected at-least-one-expected error, got: {err}");
}

#[test]
fn rejects_duplicate_case_names() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "happy_path"
expected.exit = 0

[[case]]
name = "happy_path"
expected.exit = 1
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("duplicate"),
            "expected duplicate-name error, got: {err}");
}

#[test]
fn rejects_invalid_case_name() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "Bad-Name!"
expected.exit = 0
"#;
    let err = Spec::from_str(text).unwrap_err().to_string();
    assert!(err.contains("invalid case name") || err.contains("Bad-Name"),
            "expected invalid-name error, got: {err}");
}

#[test]
fn allows_optional_inputs_and_note_fields() {
    let text = r#"
canary = "dup2-canary"

[[case]]
name = "happy"
inputs = "dup2(1, 2)"
expected.exit = 0
expected.note = "renumber"
"#;
    let spec = Spec::from_str(text).unwrap();
    assert_eq!(spec.cases[0].inputs.as_deref(), Some("dup2(1, 2)"));
    assert_eq!(spec.cases[0].expected.note.as_deref(), Some("renumber"));
}

#[test]
fn loads_from_directory() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("dup2.spec.toml"), r#"
canary = "dup2-canary"
[[case]]
name = "happy_path"
expected.exit = 0
"#).unwrap();
    std::fs::write(dir.path().join("getgroups.spec.toml"), r#"
canary = "getgroups-canary"
[[case]]
name = "count_only"
expected.exit = 0
"#).unwrap();
    let specs = Spec::load_dir(dir.path()).unwrap();
    assert_eq!(specs.len(), 2);
    let dup2 = specs.iter().find(|s| s.symbol == "dup2").unwrap();
    assert_eq!(dup2.canary, "dup2-canary");
}
