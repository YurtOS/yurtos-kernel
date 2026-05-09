use std::ffi::OsString;

pub fn crate_name(args: &[OsString]) -> Option<String> {
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        if arg == "--crate-name" {
            return iter
                .next()
                .and_then(|name| name.to_str())
                .map(str::to_owned);
        }
    }
    None
}

pub fn filter_args(crate_name: Option<&str>, args: Vec<OsString>) -> Vec<OsString> {
    if crate_name != Some("libc") {
        return args;
    }

    let mut filtered = Vec::with_capacity(args.len());
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--cfg" {
            match iter.next() {
                Some(value) if value == "unix" => continue,
                Some(value) => {
                    filtered.push(arg);
                    filtered.push(value);
                }
                None => filtered.push(arg),
            }
        } else if arg == "--cfg=unix" {
            continue;
        } else {
            filtered.push(arg);
        }
    }
    filtered
}

#[cfg(test)]
mod tests {
    use super::{crate_name, filter_args};
    use std::ffi::OsString;

    fn args(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn finds_crate_name() {
        assert_eq!(
            crate_name(&args(&["--crate-name", "libc", "--cfg", "unix"])).as_deref(),
            Some("libc")
        );
    }

    #[test]
    fn strips_unix_cfg_only_for_libc() {
        let filtered = filter_args(
            Some("libc"),
            args(&["--crate-name", "libc", "--cfg", "yurt", "--cfg", "unix"]),
        );
        assert_eq!(filtered, args(&["--crate-name", "libc", "--cfg", "yurt"]));
    }

    #[test]
    fn preserves_unix_cfg_for_other_crates() {
        let original = args(&["--crate-name", "user_crate", "--cfg", "unix"]);
        assert_eq!(filter_args(Some("user_crate"), original.clone()), original);
    }
}
