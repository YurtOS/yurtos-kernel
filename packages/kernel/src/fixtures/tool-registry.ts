/** A single WASM binary provided by a fixture tool bundle. */
export interface ToolBinary {
  /** Command name (e.g. 'pdftotext') */
  name: string;
  /** WASM filename relative to wasmDir (e.g. 'pdftotext.wasm') */
  wasm: string;
}

export interface ToolBundleMetadata {
  name: string;
  description: string;
  binaries: ToolBinary[];
  dependencies?: string[];
}

/**
 * Optional fixture tool bundles that are not available in the default sandbox.
 *
 * Each entry maps a bundle name (used in SandboxOptions.tools) to the
 * set of WASM binaries it provides.  The bundle name is also accepted as
 * an individual binary name when it matches exactly one binary.
 *
 * Core utilities (grep, sed, awk, …) are NOT listed here — they are
 * always available.  Only document-processing and other optional tools
 * belong in this registry.
 */
const TOOL_BUNDLES: ToolBundleMetadata[] = [
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
  // Future entries should move to the package-manager repository.
  // { name: 'sips', description: 'Image processing (resize, convert, rotate)', binaries: [{ name: 'sips', wasm: 'sips.wasm' }] },
  // { name: 'xlsx-tools', description: 'Excel spreadsheet conversion', binaries: [{ name: 'xlsx2csv', wasm: 'xlsx2csv.wasm' }, { name: 'csv2xlsx', wasm: 'csv2xlsx.wasm' }] },
];

export class ToolRegistry {
  private bundles = new Map<string, ToolBundleMetadata>();

  constructor() {
    for (const bundle of TOOL_BUNDLES) {
      this.bundles.set(bundle.name, bundle);
    }
  }

  available(): string[] {
    return [...this.bundles.keys()].sort();
  }

  get(name: string): ToolBundleMetadata | undefined {
    return this.bundles.get(name);
  }

  has(name: string): boolean {
    return this.bundles.has(name);
  }

  /**
   * Resolve a list of bundle names to the full set of binaries to register,
   * honouring dependency order and deduplicating binaries by name.
   */
  resolveBinaries(names: string[]): ToolBinary[] {
    const seen = new Set<string>();
    const result: ToolBinary[] = [];
    const visit = (name: string) => {
      const pkg = this.bundles.get(name);
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
