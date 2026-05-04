/** A single WASM binary provided by a tool package. */
export interface ToolBinary {
  /** Command name (e.g. 'pdftotext') */
  name: string;
  /** WASM filename relative to wasmDir (e.g. 'pdftotext.wasm') */
  wasm: string;
}

export interface ToolPackageMetadata {
  name: string;
  description: string;
  binaries: ToolBinary[];
  dependencies?: string[];
}

/**
 * Optional tool packages that are not available in the default sandbox.
 *
 * Each entry maps a package name (used in SandboxOptions.tools) to the
 * set of WASM binaries it provides.  The package name is also accepted as
 * an individual binary name when it matches exactly one binary.
 *
 * Core utilities (grep, sed, awk, …) are NOT listed here — they are
 * always available.  Only document-processing and other optional tools
 * belong in this registry.
 */
const TOOL_PACKAGES: ToolPackageMetadata[] = [
  {
    name: 'pdf-tools',
    description: 'PDF manipulation (info, split, merge, text extraction)',
    binaries: [
      { name: 'pdfinfo', wasm: 'pdfinfo.wasm' },
      { name: 'pdfseparate', wasm: 'pdfseparate.wasm' },
      { name: 'pdfunite', wasm: 'pdfunite.wasm' },
      { name: 'pdftotext', wasm: 'pdftotext.wasm' },
    ],
  },
  {
    name: 'pdftotext',
    description: 'Extract text from PDF files (Poppler-compatible)',
    binaries: [{ name: 'pdftotext', wasm: 'pdftotext.wasm' }],
  },
  // Future entries (matching yurt-packages/pkg-index.json):
  // { name: 'sips', description: 'Image processing (resize, convert, rotate)', binaries: [{ name: 'sips', wasm: 'sips.wasm' }] },
  // { name: 'xlsx-tools', description: 'Excel spreadsheet conversion', binaries: [{ name: 'xlsx2csv', wasm: 'xlsx2csv.wasm' }, { name: 'csv2xlsx', wasm: 'csv2xlsx.wasm' }] },
];

export class ToolRegistry {
  private packages = new Map<string, ToolPackageMetadata>();

  constructor() {
    for (const pkg of TOOL_PACKAGES) {
      this.packages.set(pkg.name, pkg);
    }
  }

  available(): string[] {
    return [...this.packages.keys()].sort();
  }

  get(name: string): ToolPackageMetadata | undefined {
    return this.packages.get(name);
  }

  has(name: string): boolean {
    return this.packages.has(name);
  }

  /**
   * Resolve a list of package names to the full set of binaries to register,
   * honouring dependency order and deduplicating binaries by name.
   */
  resolveBinaries(names: string[]): ToolBinary[] {
    const seen = new Set<string>();
    const result: ToolBinary[] = [];
    const visit = (name: string) => {
      const pkg = this.packages.get(name);
      if (!pkg) return;
      for (const dep of pkg.dependencies ?? []) {
        visit(dep);
      }
      for (const bin of pkg.binaries) {
        if (!seen.has(bin.name)) {
          seen.add(bin.name);
          result.push(bin);
        }
      }
    };
    for (const name of names) {
      visit(name);
    }
    return result;
  }
}
