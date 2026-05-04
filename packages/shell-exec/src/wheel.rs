//! Wheel (.whl) extraction — unzips Python wheels into the VFS.
//!
//! A Python wheel is a ZIP file. We extract all files, skipping
//! .dist-info/ and .data/ directories which contain metadata only.

use std::io::{Cursor, Read};

/// A single extracted file from a wheel.
#[derive(Debug)]
pub struct WheelFile {
    /// Relative path (e.g. "tabulate/__init__.py")
    pub path: String,
    /// File contents as a string (for writing to VFS via host.write_file)
    pub content: String,
}

/// Extract files from a wheel (ZIP) archive.
///
/// The `data` parameter is the raw bytes of the .whl file.
/// Returns a list of (path, content) pairs for files to install.
///
/// Skips:
/// - `*.dist-info/` directories (metadata)
/// - `*.data/` directories (scripts, headers)
/// - `__pycache__/` directories
pub fn extract_wheel(data: &[u8]) -> Result<Vec<WheelFile>, String> {
    let cursor = Cursor::new(data);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("invalid wheel/zip: {e}"))?;

    let mut files = Vec::new();

    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("zip entry {i}: {e}"))?;

        let name = entry.name().to_string();

        // Skip directories
        if name.ends_with('/') {
            continue;
        }

        // Skip dist-info and data directories
        if name.contains(".dist-info/") || name.contains(".data/") {
            continue;
        }

        // Skip __pycache__
        if name.contains("__pycache__/") {
            continue;
        }

        // Read content
        let mut content = String::new();
        entry
            .read_to_string(&mut content)
            .map_err(|e| format!("reading {name}: {e}"))?;

        files.push(WheelFile {
            path: name,
            content,
        });
    }

    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_real_wheel_structure() {
        // Build a minimal wheel-like ZIP in memory
        use std::io::Write;
        let buf = Vec::new();
        let cursor = Cursor::new(buf);
        let mut zip = zip::ZipWriter::new(cursor);

        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);

        // Package files
        zip.start_file("tabulate/__init__.py", options).unwrap();
        zip.write_all(b"__version__ = '0.9.0'\n").unwrap();

        zip.start_file("tabulate/tabulate.py", options).unwrap();
        zip.write_all(b"def tabulate(data): pass\n").unwrap();

        // dist-info (should be skipped)
        zip.start_file("tabulate-0.9.0.dist-info/METADATA", options)
            .unwrap();
        zip.write_all(b"Name: tabulate\nVersion: 0.9.0\n")
            .unwrap();

        zip.start_file("tabulate-0.9.0.dist-info/RECORD", options)
            .unwrap();
        zip.write_all(b"tabulate/__init__.py,sha256=abc,42\n")
            .unwrap();

        // __pycache__ (should be skipped)
        zip.start_file("tabulate/__pycache__/__init__.cpython-311.pyc", options)
            .unwrap();
        zip.write_all(b"\x00\x00\x00\x00").unwrap();

        let result = zip.finish().unwrap();
        let bytes = result.into_inner();

        let files = extract_wheel(&bytes).unwrap();
        let paths: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();

        assert_eq!(paths, vec!["tabulate/__init__.py", "tabulate/tabulate.py"]);
        assert!(files[0].content.contains("__version__"));
        assert!(files[1].content.contains("def tabulate"));
    }

    #[test]
    fn empty_zip_returns_empty() {
        use std::io::Write;
        let buf = Vec::new();
        let cursor = Cursor::new(buf);
        let zip = zip::ZipWriter::new(cursor);
        let result = zip.finish().unwrap();
        let bytes = result.into_inner();

        let files = extract_wheel(&bytes).unwrap();
        assert!(files.is_empty());
    }

    #[test]
    fn invalid_data_returns_error() {
        let result = extract_wheel(b"not a zip file");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("invalid wheel/zip"));
    }
}
