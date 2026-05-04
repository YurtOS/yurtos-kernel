export interface PackageMetadata {
  name: string;
  version: string;
  summary: string;
  dependencies: string[];
  /** Map of relative path -> file content, e.g. { 'numpy/__init__.py': '...' } */
  pythonFiles: Record<string, string>;
  /** If true, requires a native module compiled into python3.wasm */
  native: boolean;
  /**
   * Optional directory containing Python files for the package.
   * If set, pythonFiles is populated by scanning this directory at registry construction.
   * Path is relative to the package root (e.g. 'numpy-rust/python/numpy' -> scans for .py files).
   */
  pythonDir?: string;
  /** Prefix to strip from pythonDir paths when building pythonFiles keys. */
  pythonDirPrefix?: string;
}
