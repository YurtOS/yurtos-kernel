import type { ExtensionConfig, ExtensionInvokeArgs, ExtensionInvokeResult } from './types.js';

const _HELP_TEXT = `\
Usage: extensions <subcommand> [options]

Subcommands:
  list [--category <cat>] [--json]   List all registered extensions
  info <name>                        Show details for a specific extension
`;

function _handleList(extensions: ExtensionConfig[], args: string[]): ExtensionInvokeResult {
  const categoryIdx = args.indexOf('--category');
  const filterCat = categoryIdx !== -1 ? args[categoryIdx + 1] : undefined;
  const jsonMode = args.includes('--json');

  const filtered = filterCat
    ? extensions.filter((e) => e.category === filterCat)
    : extensions;

  if (jsonMode) {
    const data = filtered.map((e) => ({
      name: e.name,
      category: e.category ?? '',
      description: e.description ?? '',
    }));
    return { stdout: JSON.stringify(data) + '\n', exitCode: 0 };
  }

  if (filtered.length === 0) {
    return { stdout: '(no extensions registered)\n', exitCode: 0 };
  }

  const nameW = Math.max(4, ...filtered.map((e) => e.name.length));
  const catW = Math.max(8, ...filtered.map((e) => (e.category ?? '').length));
  const header = `${'NAME'.padEnd(nameW)}  ${'CATEGORY'.padEnd(catW)}  DESCRIPTION`;
  const sep = '─'.repeat(header.length);
  const rows = filtered.map(
    (e) => `${e.name.padEnd(nameW)}  ${(e.category ?? '').padEnd(catW)}  ${e.description ?? ''}`,
  );
  return { stdout: [header, sep, ...rows].join('\n') + '\n', exitCode: 0 };
}

function _handleInfo(extensions: ExtensionConfig[], args: string[]): ExtensionInvokeResult {
  const name = args[0];
  if (!name) {
    return { stdout: '', stderr: 'extensions info: missing extension name\n', exitCode: 1 };
  }
  const ext = extensions.find((e) => e.name === name);
  if (!ext) {
    return { stdout: '', stderr: `extensions: unknown extension: ${name}\n`, exitCode: 1 };
  }

  const lines: string[] = [
    `Name:        ${ext.name}`,
    `Category:    ${ext.category ?? ''}`,
    `Description: ${ext.description ?? ''}`,
  ];
  if (ext.usage) lines.push(`Usage:       ${ext.usage}`);
  if (ext.examples && ext.examples.length > 0) {
    lines.push('Examples:');
    for (const ex of ext.examples) {
      lines.push(`  ${ex}`);
    }
  }
  return { stdout: lines.join('\n') + '\n', exitCode: 0 };
}

function makeBuiltinHandler(
  getExtensions: () => ExtensionConfig[],
): (input: ExtensionInvokeArgs) => ExtensionInvokeResult {
  return (input) => {
    const { args } = input;
    if (!args.length || args[0] === '--help' || args[0] === '-h') {
      return { stdout: _HELP_TEXT, exitCode: 0 };
    }
    const subcmd = args[0];
    const rest = args.slice(1);
    const exts = getExtensions();
    if (subcmd === 'list') return _handleList(exts, rest);
    if (subcmd === 'info') return _handleInfo(exts, rest);
    return {
      stdout: '',
      stderr: `extensions: unknown subcommand: ${subcmd}\n${_HELP_TEXT}`,
      exitCode: 1,
    };
  };
}

const BUILTIN_NAME = 'extensions';

export class ExtensionRegistry {
  private extensions = new Map<string, ExtensionConfig>();

  register(ext: ExtensionConfig): void {
    this.extensions.set(ext.name, ext);
  }

  get(name: string): ExtensionConfig | undefined {
    return this.extensions.get(name);
  }

  has(name: string): boolean {
    return this.extensions.has(name);
  }

  /** Returns only user-registered extensions (excludes the built-in discovery command). */
  list(): ExtensionConfig[] {
    return Array.from(this.extensions.values()).filter((e) => e.name !== BUILTIN_NAME);
  }

  getCommandNames(): string[] {
    return this.list()
      .filter((e) => e.command != null)
      .map((e) => e.name);
  }

  getPackageNames(): string[] {
    return this.list()
      .filter((e) => e.pythonPackage != null)
      .map((e) => e.name);
  }

  /**
   * Register the built-in `extensions` discovery command.
   * Should be called once after all user extensions are registered.
   * The handler reads from this registry at invocation time.
   */
  registerBuiltinDiscovery(): ExtensionConfig {
    const builtin: ExtensionConfig = {
      name: BUILTIN_NAME,
      command: makeBuiltinHandler(() => this.list()),
    };
    this.extensions.set(BUILTIN_NAME, builtin);
    return builtin;
  }

  async invoke(name: string, input: ExtensionInvokeArgs): Promise<ExtensionInvokeResult> {
    const ext = this.extensions.get(name);
    if (!ext?.command) {
      throw new Error(`Extension "${name}" not found or has no command handler`);
    }
    // Intercept --help: return the extension's description if available
    if (input.args.includes('--help') && ext.description && name !== BUILTIN_NAME) {
      return { stdout: ext.description + '\n', exitCode: 0 };
    }
    return ext.command(input);
  }
}
