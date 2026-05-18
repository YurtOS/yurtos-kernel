/**
 * Smoke tests for fixtures that CI builds from source instead of checking in.
 *
 * The broader ABI suite also covers these surfaces, but it currently
 * includes deferred python3 and Rust-std cases. This file is the CI guard that
 * proves source-built fixtures were copied into the kernel fixture directory
 * and are usable by the sandbox.
 */
import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import type { RunResult } from '../run-result.js';
import { NodeAdapter } from '../platform/node-adapter.js';
import { unsupportedRuntimeEngineBackend } from '../engine/backend.js';

const FIXTURES = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

/**
 * Assert a source-built fixture `.wasm` is present at the path the sandbox
 * resolves before any `sandbox.run(...)`. A missing/incompletely-restored
 * fixture cache is the #210-class regression this gate guards against; fail
 * with the resolved path named instead of an opaque downstream `127 != 0`.
 */
function assertFixturePresent(name: string): void {
  const path = resolve(FIXTURES, name);
  if (!existsSync(path)) {
    throw new Error(
      `source-built fixture missing: ${name} not found at ${path}. ` +
        `The CI fixture build/cache did not place this .wasm — check the ` +
        `"Build ${name.replace(/\.wasm$/, '')} fixture" step and its ` +
        `actions/cache path/key in .github/workflows/guest-compat.yml.`,
    );
  }
}

/**
 * Run a fixture command and fail loud on a non-zero exit: surface the exit
 * code, stderr and stdout so a regression is diagnosable instead of
 * surfacing as a bare `expect(127).toBe(0)`. Exit 127 here means the
 * sandbox could not load/exec the fixture (stale or ABI-incompatible
 * cached .wasm, or a kernel/runtime regression) — name that explicitly.
 */
async function runFixture(
  sandbox: Sandbox,
  command: string,
): Promise<RunResult> {
  const result = await sandbox.run(command);
  if (result.exitCode !== 0) {
    const hint = result.exitCode === 127
      ? ' (127 = sandbox could not load/exec the fixture: stale or ' +
        'ABI-incompatible cached .wasm, missing module, or kernel/runtime ' +
        'regression)'
      : '';
    throw new Error(
      `fixture command failed: \`${command}\` exited ${result.exitCode}${hint}\n` +
        `--- stderr ---\n${result.stderr}\n` +
        `--- stdout ---\n${result.stdout}`,
    );
  }
  return result;
}

describe('source-built fixture smoke tests', () => {
  let sandbox: Sandbox | null = null;

  afterEach(() => {
    sandbox?.destroy();
    sandbox = null;
  });

  it('has generated C canaries copied into the fixture directory', () => {
    for (const name of [
      'stdio-canary.wasm',
      'exec-canary.wasm',
      'fork-canary.wasm',
      'locale-canary.wasm',
      'posix-runtime-canary.wasm',
    ]) {
      expect(existsSync(resolve(FIXTURES, name))).toBe(true);
    }
  });

  it('runs representative ABI canaries', async () => {
    for (
      const name of [
        'stdio-canary.wasm',
        'posix-runtime-canary.wasm',
        'exec-canary.wasm',
        'locale-canary.wasm',
      ]
    ) {
      assertFixturePresent(name);
    }

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/in.txt', new TextEncoder().encode('hello fixture\n'));

    const stdio = await runFixture(sandbox, 'stdio-canary /tmp/in.txt /tmp/out.txt');
    expect(stdio.stdout.trim()).toBe('stdio-ok');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/out.txt'))).toBe('hello fixture\n');

    sandbox.destroy();
    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      runtimeBackend: unsupportedRuntimeEngineBackend,
    });
    const priority = await runFixture(
      sandbox,
      'posix-runtime-canary --case priority_unsupported',
    );
    expect(priority.stdout.trim()).toBe(
      '{"case":"priority_unsupported","exit":0,"stdout":"priority_unsupported:ok"}',
    );

    const execDenied = await runFixture(sandbox, 'exec-canary execv_eacces');
    expect(execDenied.stdout.trim()).toBe('{"case":"execv_eacces","exit":0,"errno":2}');

    const locale = await runFixture(sandbox, 'locale-canary unicode_quote_ascii');
    expect(locale.stdout).toContain('locale:strftime_invalid=0 first=120');
  });

  it('runs BusyBox applets through the multicall fixture', async () => {
    assertFixturePresent('busybox.wasm');
    expect(existsSync(resolve(FIXTURES, 'busybox.manifest.json'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.txt', new TextEncoder().encode('foo\nbar\n'));

    const link = await sandbox.run('readlink /usr/bin/grep');
    expect(link.stdout.trim()).toBe('/usr/bin/busybox');

    const binEchoLink = await sandbox.run('readlink /bin/echo');
    expect(binEchoLink.exitCode).toBe(0);
    expect(binEchoLink.stdout.trim()).toBe('/usr/bin/busybox');

    const chmod = await runFixture(
      sandbox,
      "touch /tmp/executable.sh && chmod 755 /tmp/executable.sh && stat -c '%a' /tmp/executable.sh",
    );
    expect(chmod.stdout.trim()).toBe('755');

    const grep = await runFixture(sandbox, 'grep foo /tmp/data.txt');
    expect(grep.stdout.trim()).toBe('foo');

    const seq = await runFixture(sandbox, 'busybox seq 3');
    expect(seq.stdout).toBe('1\n2\n3\n');
  });

  it('runs BusyBox ash as /usr/bin/sh', async () => {
    assertFixturePresent('busybox.wasm');
    expect(existsSync(resolve(FIXTURES, 'busybox.manifest.json'))).toBe(true);

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const binSh = await sandbox.run('readlink /bin/sh');
    expect(binSh.exitCode).toBe(0);
    expect(binSh.stdout.trim()).toBe('/usr/bin/busybox');

    const shell = await runFixture(
      sandbox,
      "sh -c 'x=3; echo ash:$((x + 2)); echo payload > /tmp/ash.txt'",
    );
    expect(shell.stdout.trim()).toBe('ash:5');
    expect(new TextDecoder().decode(sandbox.readFile('/tmp/ash.txt')).trim()).toBe('payload');

    const direct = await runFixture(sandbox, "busybox ash -c 'printf direct-ash'");
    expect(direct.stdout).toBe('direct-ash');

    const pipeline = await runFixture(sandbox, "ash -c 'seq 3 | wc -l'");
    expect(pipeline.stdout.trim()).toBe('3');

    const redirected = await runFixture(
      sandbox,
      "ash -c 'seq 3 > /tmp/seq.out; wc -l /tmp/seq.out'",
    );
    expect(redirected.stdout.trim()).toBe('3 /tmp/seq.out');
  });

  it('runs zsh as a source-built fixture', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(sandbox, "zsh -fc 'print zsh:$((2 + 3))'");
    expect(shell.stdout.trim()).toBe('zsh:5');
  });

  it('lets zsh unload static modules with special hash parameters', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(
      sandbox,
      "zsh -fc 'zmodload zsh/parameter; zmodload -u zsh/parameter; print after' 2>&1",
    );
    expect(shell.stdout).toBe('after\n');
  });

  it('runs the ncurses terminfo source-built fixture', async () => {
    assertFixturePresent('terminfo-canary.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const terminfo = await runFixture(sandbox, 'terminfo-canary');
    expect(terminfo.stdout.trim()).toBe('terminfo-ok');
  });

  it('lets zsh fork and exec another zsh', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(
      sandbox,
      "zsh -fc '/usr/bin/zsh -fc \"print nested\"' 2>&1",
    );
    expect(shell.stdout.trim()).toBe('nested');
  });

  it('lets zsh continue after a forked external command', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(
      sandbox,
      "zsh -fc 'print before; /bin/echo child; print after' 2>&1",
    );
    expect(shell.stdout.trim()).toBe('before\nchild\nafter');
  });

  it('lets zsh override argv0 for an executed program', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(
      sandbox,
      "zsh -fc \"exec -a /bin/SPLATTER /bin/sh -c 'echo \\$0'\" 2>&1",
    );
    expect(shell.stdout.trim()).toBe('/bin/SPLATTER');
  });

  it('keeps redirected stdout open across zsh fork and exec cleanup', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/repro.zsh', new TextEncoder().encode([
      "/usr/bin/zsh -fc '{ ( ) } always { echo foo }' > /tmp/out",
      'echo status:$?',
      'cat /tmp/out',
      '',
    ].join('\n')));

    const shell = await runFixture(sandbox, 'zsh -f /tmp/repro.zsh 2>&1');
    expect(shell.stdout).toBe('status:0\nfoo\n');
  });

  it('starts spawned zsh processes in the parent current directory', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(
      sandbox,
      "mkdir -p /tmp/zdir; cd /tmp/zdir; zsh -fc 'pwd; print PWD=$PWD' 2>&1",
    );
    expect(shell.stdout.trim()).toBe('/tmp/zdir\nPWD=/tmp/zdir');
  });

  it('lets zsh enforce noclobber through fd-based regular-file stat', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });

    const shell = await runFixture(
      sandbox,
      [
        "zsh -fc '",
        "setopt noclobber clobberempty; ",
        "rm -f /tmp/foo; touch /tmp/foo; ",
        "print Works >/tmp/foo; cat /tmp/foo; ",
        "print Works\\\\ not >/tmp/foo; cat /tmp/foo",
        "' 2>&1",
      ].join(''),
    );
    expect(shell.stdout).toBe('Works\nzsh:1: file exists: /tmp/foo\nWorks\n');
  });

  it('executes relative-PATH shebang scripts from the process cwd', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({ wasmDir: FIXTURES, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/repro.zsh', new TextEncoder().encode([
      'mkdir -p /tmp/command.tmp/dir1 /tmp/command.tmp/dir2',
      'cd /tmp/command.tmp',
      'shcmd="$(which sh)"',
      'print "#!${shcmd}\\necho This is top" >tstcmd',
      'chmod 755 tstcmd',
      'path=(. command.tmp/dir{1,2})',
      'tstcmd',
      '',
    ].join('\n')));

    const shell = await runFixture(sandbox, 'zsh -f /tmp/repro.zsh 2>&1');
    expect(shell.stdout).toBe('This is top\n');
  });

  it('releases zsh background children killed while sleeping', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      timeoutMs: 2_000,
    });

    const shell = await runFixture(
      sandbox,
      [
        "zsh -fc '",
        "sleep 1000 & pid=$!; ",
        "kill $pid; ",
        "wait $pid; ",
        "print waited:$?",
        "' 2>&1",
      ].join(''),
    );
    expect(shell.stdout).toContain('waited:143');
  });

  it('lets zsh subshells resume after sleeping children', async () => {
    assertFixturePresent('zsh.wasm');

    sandbox = await Sandbox.create({
      wasmDir: FIXTURES,
      adapter: new NodeAdapter(),
      timeoutMs: 3_000,
    });

    const shell = await runFixture(
      sandbox,
      "zsh -fc '( sleep 1; echo hello ); echo status:$?' 2>&1",
    );
    expect(shell.stdout).toBe('hello\nstatus:0\n');
  });
});
