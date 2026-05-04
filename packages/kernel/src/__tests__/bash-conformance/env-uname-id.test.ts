/**
 * Conformance tests for env, printenv, uname, hostname, whoami, id, nproc,
 * yes, sleep, timeout — system info and environment commands.
 */
import { describe, it, beforeEach } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';

import { ResidentBashRunner } from '../../resident-bash-runner.js';
import { ProcessManager } from '../../process/manager.js';
import { VFS } from '../../vfs/vfs.js';
import { NodeAdapter } from '../../platform/node-adapter.js';

const FIXTURES = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures');
const SHELL_EXEC_WASM = resolve(import.meta.dirname!, '../../platform/__tests__/fixtures/yurt-shell-exec.wasm');

const TOOLS = [
  'cat', 'echo', 'printf', 'env', 'printenv', 'uname', 'hostname',
  'whoami', 'id', 'nproc', 'yes', 'head', 'sleep', 'timeout',
  'true', 'false',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

describe('env/uname/id conformance', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    const adapter = new NodeAdapter();
    vfs = new VFS();
    const mgr = new ProcessManager(vfs, adapter);
    for (const tool of TOOLS) {
      mgr.registerTool(tool, resolve(FIXTURES, wasmName(tool)));
    }
    await mgr.preloadModules();
    runner = await ResidentBashRunner.create(vfs, mgr, adapter, SHELL_EXEC_WASM, {
      syncSpawn: (cmd, args, env, stdin, cwd) => mgr.spawnSync(cmd, args, env, stdin, cwd),
    });
  });

  // ---------------------------------------------------------------------------
  // uname
  // ---------------------------------------------------------------------------
  describe('uname', () => {
    it('outputs kernel name', async () => {
      const r = await runner.run('uname');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });

    it('-s outputs kernel name', async () => {
      const r = await runner.run('uname -s');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });

    it('-a outputs full info', async () => {
      const r = await runner.run('uname -a');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });

    it('-m outputs machine type', async () => {
      const r = await runner.run('uname -m');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // hostname
  // ---------------------------------------------------------------------------
  describe('hostname', () => {
    it('outputs a hostname', async () => {
      const r = await runner.run('hostname');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // whoami
  // ---------------------------------------------------------------------------
  describe('whoami', () => {
    it('outputs a username', async () => {
      const r = await runner.run('whoami');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // id
  // ---------------------------------------------------------------------------
  describe('id', () => {
    it('shows uid/gid info', async () => {
      const r = await runner.run('id');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('uid=');
    });

    it('-u outputs uid info', async () => {
      const r = await runner.run('id -u');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });

    it('-g outputs gid info', async () => {
      const r = await runner.run('id -g');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim().length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // nproc
  // ---------------------------------------------------------------------------
  describe('nproc', () => {
    it('outputs a number', async () => {
      const r = await runner.run('nproc');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+$/);
    });
  });

  // ---------------------------------------------------------------------------
  // yes
  // ---------------------------------------------------------------------------
  describe('yes', () => {
    it('yes | head -3 outputs 3 y lines', async () => {
      const r = await runner.run('yes | head -3');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('y\ny\ny\n');
    });

    it('yes custom | head -2 outputs custom string', async () => {
      const r = await runner.run('yes hello | head -2');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe('hello\nhello\n');
    });
  });

  // ---------------------------------------------------------------------------
  // sleep
  // ---------------------------------------------------------------------------
  describe('sleep', () => {
    it('sleep 0 exits immediately', async () => {
      const r = await runner.run('sleep 0');
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // timeout
  // ---------------------------------------------------------------------------
  describe('timeout', () => {
    it('runs a command within time limit', async () => {
      const r = await runner.run('timeout 5 true');
      expect(r.exitCode).toBe(0);
    });
  });
});
