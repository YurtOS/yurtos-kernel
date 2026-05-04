export interface ExtensionInvokeArgs {
  args: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
}

export interface ExtensionInvokeResult {
  stdout: string;
  stderr?: string;
  exitCode: number;
}

export type ExtensionHandler =
  (input: ExtensionInvokeArgs) => ExtensionInvokeResult | Promise<ExtensionInvokeResult>;

export interface PythonPackageSpec {
  version: string;
  summary?: string;
  files: Record<string, string>; // relative path → Python source
}

export interface ExtensionConfig {
  name: string;
  description?: string;
  usage?: string;
  examples?: string[];
  category?: string;
  command?: ExtensionHandler;
  pythonPackage?: PythonPackageSpec;
}
