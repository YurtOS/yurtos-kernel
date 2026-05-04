import { resolve } from 'node:path';

import { Sandbox } from '../../sandbox.js';
import { NodeAdapter } from '../../platform/node-adapter.js';
import type { VFS } from '../../vfs/vfs.js';
import type { ProcessManager } from '../../process/manager.js';
import type { RunCommandHandler } from '../../run-command.ts';
import type { SandboxOptions } from '../../sandbox.ts';
import { bashBootImports } from '../../../../sdk-server/src/bash-host-imports.ts';
import { makeRunCommandHandler, runCommand } from '../../../../sdk-server/src/bash-dispatch.ts';

export const FIXTURES = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures');

const STANDALONE_TOOLS = [
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'true', 'false',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr',
  'diff', 'du', 'df',
  'gzip', 'gunzip', 'tar',
  'bc', 'dc',
  'sqlite3',
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
  'rg', 'dd', 'pdftotext', 'sips', 'python3',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

export interface BashConformanceRunner {
  run(cmd: string): ReturnType<typeof runCommand>;
  getEnv(name: string): string | undefined;
}

export interface BashConformanceHarness {
  sandbox: Sandbox;
  runner: BashConformanceRunner;
  vfs: VFS;
}

export interface BashConformanceHarnessOptions {
  busyboxApplets?: string[];
}

export async function createBashConformanceHarness(
  options: BashConformanceHarnessOptions = {},
): Promise<BashConformanceHarness> {
  const sandbox = await Sandbox.create({
    wasmDir: FIXTURES,
    adapter: new NodeAdapter(),
    bootImports: bashBootImports as unknown as SandboxOptions['bootImports'],
    runCommandHandler: makeRunCommandHandler() as unknown as RunCommandHandler,
  });
  const mgr = (sandbox as unknown as { mgr: ProcessManager }).mgr;
  for (const tool of STANDALONE_TOOLS) {
    mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
  }
  if (options.busyboxApplets?.length) {
    mgr.registerMulticallTool(
      'busybox',
      resolve(FIXTURES, 'busybox.wasm'),
      options.busyboxApplets,
    );
  }
  await mgr.preloadModules();
  const runner: BashConformanceRunner = {
    run: (cmd) => runCommand(sandbox as Parameters<typeof runCommand>[0], cmd),
    getEnv: (name) => sandbox.getEnv(name),
  };
  return {
    sandbox,
    runner,
    vfs: (sandbox as unknown as { vfs: VFS }).vfs,
  };
}
