/**
 * Conformance tests for find — exercises features beyond basic integration tests.
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
  'cat', 'echo', 'head', 'tail', 'wc', 'sort', 'uniq', 'grep',
  'ls', 'mkdir', 'rm', 'cp', 'mv', 'touch', 'tee', 'tr', 'cut',
  'basename', 'dirname', 'env', 'printf',
  'find', 'sed', 'awk', 'jq',
  'true', 'false',
  'uname', 'whoami', 'id', 'printenv', 'yes', 'rmdir', 'sleep', 'seq',
  'ln', 'readlink', 'realpath', 'mktemp', 'tac',
  'xargs', 'expr',
  'diff',
  'du', 'df',
  'gzip', 'gunzip', 'tar',
  'bc', 'dc',
  'sqlite3',
  'hostname', 'base64', 'sha256sum', 'md5sum', 'stat', 'xxd', 'rev', 'nproc',
  'fmt', 'fold', 'nl', 'expand', 'unexpand', 'paste', 'comm', 'join',
  'split', 'strings', 'od', 'cksum', 'truncate',
  'tree', 'patch', 'file', 'column', 'cmp', 'timeout', 'numfmt', 'csplit', 'zip', 'unzip',
  'rg',
];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  if (tool === 'gunzip') return 'gzip.wasm';
  return `${tool}.wasm`;
}

describe('find conformance', () => {
  let vfs: VFS;
  let runner: ResidentBashRunner;

  beforeEach(async () => {
    vfs = new VFS();
    const adapter = new NodeAdapter();
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
  // Name matching
  // ---------------------------------------------------------------------------
  describe('name matching', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/project/src /home/user/project/docs /home/user/project/.git');
      vfs.writeFile('/home/user/project/src/main.c', new TextEncoder().encode('int main() {}'));
      vfs.writeFile('/home/user/project/src/util.h', new TextEncoder().encode('#pragma once'));
      vfs.writeFile('/home/user/project/src/util.c', new TextEncoder().encode('void util() {}'));
      vfs.writeFile('/home/user/project/docs/readme.txt', new TextEncoder().encode('hello'));
      vfs.writeFile('/home/user/project/docs/NOTES.TXT', new TextEncoder().encode('notes'));
      vfs.writeFile('/home/user/project/.git/config', new TextEncoder().encode('[core]'));
    });

    it('-name with exact filename match', async () => {
      const result = await runner.run('find /home/user/project -name main.c | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('/home/user/project/src/main.c\n');
    });

    it('-name with wildcard * pattern', async () => {
      const result = await runner.run("find /home/user/project -name '*.c' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/project/src/main.c\n' +
        '/home/user/project/src/util.c\n'
      );
    });

    it('-name with ? single-character wildcard', async () => {
      const result = await runner.run("find /home/user/project -name 'util.?' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/project/src/util.c\n' +
        '/home/user/project/src/util.h\n'
      );
    });

    it('-iname case-insensitive match', async () => {
      const result = await runner.run("find /home/user/project -iname '*.txt' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/project/docs/NOTES.TXT\n' +
        '/home/user/project/docs/readme.txt\n'
      );
    });

    it('-name with character class [ch]', async () => {
      const result = await runner.run("find /home/user/project -name '*.[ch]' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/project/src/main.c\n' +
        '/home/user/project/src/util.c\n' +
        '/home/user/project/src/util.h\n'
      );
    });

    it('-not -name exclusion', async () => {
      // Find all files in src/ excluding .c files
      const result = await runner.run("find /home/user/project/src -type f -not -name '*.c' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('/home/user/project/src/util.h\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Type filtering
  // ---------------------------------------------------------------------------
  describe('type filtering', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/tree/sub1 /home/user/tree/sub2');
      vfs.writeFile('/home/user/tree/file1.txt', new TextEncoder().encode('one'));
      vfs.writeFile('/home/user/tree/sub1/file2.txt', new TextEncoder().encode('two'));
      vfs.writeFile('/home/user/tree/sub2/file3.txt', new TextEncoder().encode('three'));
    });

    it('-type f finds files only', async () => {
      const result = await runner.run('find /home/user/tree -type f | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/tree/file1.txt\n' +
        '/home/user/tree/sub1/file2.txt\n' +
        '/home/user/tree/sub2/file3.txt\n'
      );
    });

    it('-type d finds directories only', async () => {
      const result = await runner.run('find /home/user/tree -type d | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/tree\n' +
        '/home/user/tree/sub1\n' +
        '/home/user/tree/sub2\n'
      );
    });

    it('-type l finds symlinks', async () => {
      await runner.run('ln -s /home/user/tree/file1.txt /home/user/tree/link1');
      await runner.run('ln -s /home/user/tree/sub1 /home/user/tree/link2');
      const result = await runner.run('find /home/user/tree -maxdepth 1 -type l | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/tree/link1\n' +
        '/home/user/tree/link2\n'
      );
    });

    it('combines -type f with -name pattern', async () => {
      await runner.run('mkdir -p /home/user/tree/sub1/deep');
      vfs.writeFile('/home/user/tree/sub1/deep/file4.txt', new TextEncoder().encode('four'));
      vfs.writeFile('/home/user/tree/sub1/deep/data.csv', new TextEncoder().encode('a,b'));
      const result = await runner.run("find /home/user/tree -type f -name '*.txt' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/tree/file1.txt\n' +
        '/home/user/tree/sub1/deep/file4.txt\n' +
        '/home/user/tree/sub1/file2.txt\n' +
        '/home/user/tree/sub2/file3.txt\n'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Depth control
  // ---------------------------------------------------------------------------
  describe('depth control', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/d/a/b/c');
      vfs.writeFile('/home/user/d/top.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/d/a/mid.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/d/a/b/deep.txt', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/d/a/b/c/bottom.txt', new TextEncoder().encode(''));
    });

    it('-maxdepth 1 shows only start dir and its immediate children', async () => {
      const result = await runner.run('find /home/user/d -maxdepth 1 | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/d\n' +
        '/home/user/d/a\n' +
        '/home/user/d/top.txt\n'
      );
    });

    it('-maxdepth 2 goes two levels deep', async () => {
      const result = await runner.run('find /home/user/d -maxdepth 2 -type f | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/d/a/mid.txt\n' +
        '/home/user/d/top.txt\n'
      );
    });

    it('-mindepth 1 excludes the start directory itself', async () => {
      const result = await runner.run('find /home/user/d -mindepth 1 -type d | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/d/a\n' +
        '/home/user/d/a/b\n' +
        '/home/user/d/a/b/c\n'
      );
    });

    it('combines -mindepth and -maxdepth to select a depth band', async () => {
      // mindepth 2, maxdepth 3 => depth 2 and 3 relative to start
      const result = await runner.run('find /home/user/d -mindepth 2 -maxdepth 3 | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/d/a/b\n' +
        '/home/user/d/a/b/c\n' +
        '/home/user/d/a/b/deep.txt\n' +
        '/home/user/d/a/mid.txt\n'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Size predicates
  // ---------------------------------------------------------------------------
  describe('size predicates', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/sizes');
      // Empty file: 0 bytes
      vfs.writeFile('/home/user/sizes/empty.txt', new TextEncoder().encode(''));
      // Small file: 5 bytes
      vfs.writeFile('/home/user/sizes/small.txt', new TextEncoder().encode('hello'));
      // Medium file: 50 bytes
      vfs.writeFile('/home/user/sizes/medium.txt', new TextEncoder().encode('x'.repeat(50)));
      // Large file: 200 bytes
      vfs.writeFile('/home/user/sizes/large.txt', new TextEncoder().encode('y'.repeat(200)));
      // Empty subdir
      await runner.run('mkdir -p /home/user/sizes/emptydir');
    });

    it('-size +100c finds files larger than 100 bytes', async () => {
      const result = await runner.run("find /home/user/sizes -type f -size +100c | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('/home/user/sizes/large.txt\n');
    });

    it('-size -10c finds files smaller than 10 bytes', async () => {
      const result = await runner.run("find /home/user/sizes -type f -size -10c | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/sizes/empty.txt\n' +
        '/home/user/sizes/small.txt\n'
      );
    });

    it('-empty finds empty files and directories', async () => {
      const result = await runner.run('find /home/user/sizes -empty | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/sizes/empty.txt\n' +
        '/home/user/sizes/emptydir\n'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Logical operators
  // ---------------------------------------------------------------------------
  describe('logical operators', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/logic');
      vfs.writeFile('/home/user/logic/alpha.c', new TextEncoder().encode('a'));
      vfs.writeFile('/home/user/logic/beta.h', new TextEncoder().encode('b'));
      vfs.writeFile('/home/user/logic/gamma.c', new TextEncoder().encode('c'));
      vfs.writeFile('/home/user/logic/delta.txt', new TextEncoder().encode('d'));
      vfs.writeFile('/home/user/logic/epsilon.h', new TextEncoder().encode('e'));
    });

    it('implicit AND between -type and -name', async () => {
      const result = await runner.run("find /home/user/logic -type f -name '*.h' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/logic/beta.h\n' +
        '/home/user/logic/epsilon.h\n'
      );
    });

    it('-or between two -name predicates', async () => {
      const result = await runner.run("find /home/user/logic -name '*.c' -or -name '*.h' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/logic/alpha.c\n' +
        '/home/user/logic/beta.h\n' +
        '/home/user/logic/epsilon.h\n' +
        '/home/user/logic/gamma.c\n'
      );
    });

    it('-not negation excludes matching entries', async () => {
      const result = await runner.run("find /home/user/logic -type f -not -name '*.c' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/logic/beta.h\n' +
        '/home/user/logic/delta.txt\n' +
        '/home/user/logic/epsilon.h\n'
      );
    });

    it('! negation syntax (alternative to -not)', async () => {
      const result = await runner.run("find /home/user/logic -type f ! -name '*.h' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/logic/alpha.c\n' +
        '/home/user/logic/delta.txt\n' +
        '/home/user/logic/gamma.c\n'
      );
    });

    it('grouped expression with \\( \\) for precedence', async () => {
      // Find .c or .h files only (using grouping to override default precedence)
      const result = await runner.run("find /home/user/logic -type f '(' -name '*.c' -or -name '*.h' ')' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/logic/alpha.c\n' +
        '/home/user/logic/beta.h\n' +
        '/home/user/logic/epsilon.h\n' +
        '/home/user/logic/gamma.c\n'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  describe('actions', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/act/sub');
      vfs.writeFile('/home/user/act/hello.txt', new TextEncoder().encode('hello world'));
      vfs.writeFile('/home/user/act/sub/bye.txt', new TextEncoder().encode('goodbye'));
    });

    it('-print is the default action', async () => {
      const result = await runner.run('find /home/user/act -type f -print | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/act/hello.txt\n' +
        '/home/user/act/sub/bye.txt\n'
      );
    });

    it('-exec with echo {} \\;', async () => {
      const result = await runner.run("find /home/user/act -type f -exec echo '{}' ';' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/act/hello.txt\n' +
        '/home/user/act/sub/bye.txt\n'
      );
    });

    it('-exec cat {} \\; reads file contents', async () => {
      const result = await runner.run("find /home/user/act -maxdepth 1 -type f -exec cat '{}' ';'");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello world');
    });

    it('-delete removes matched files', async () => {
      // Delete only .txt files in sub/
      await runner.run("find /home/user/act/sub -type f -name '*.txt' -delete");
      // Verify file is gone
      const result = await runner.run('find /home/user/act -type f | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('/home/user/act/hello.txt\n');
    });
  });

  // ---------------------------------------------------------------------------
  // Path matching
  // ---------------------------------------------------------------------------
  describe('path matching', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/web/src/components /home/user/web/src/utils /home/user/web/dist');
      vfs.writeFile('/home/user/web/src/components/App.js', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/web/src/utils/helper.js', new TextEncoder().encode(''));
      vfs.writeFile('/home/user/web/dist/bundle.js', new TextEncoder().encode(''));
    });

    it('-path matches against full path with wildcard', async () => {
      const result = await runner.run("find /home/user/web -path '*/src/*' -type f | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/web/src/components/App.js\n' +
        '/home/user/web/src/utils/helper.js\n'
      );
    });

    it('-not -path excludes matching paths', async () => {
      const result = await runner.run("find /home/user/web -type f -not -path '*/dist/*' | sort");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/web/src/components/App.js\n' +
        '/home/user/web/src/utils/helper.js\n'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple start paths
  // ---------------------------------------------------------------------------
  describe('multiple start paths', () => {
    beforeEach(async () => {
      await runner.run('mkdir -p /home/user/alpha /home/user/beta');
      vfs.writeFile('/home/user/alpha/one.txt', new TextEncoder().encode('1'));
      vfs.writeFile('/home/user/beta/two.txt', new TextEncoder().encode('2'));
    });

    it('find with two directory arguments', async () => {
      const result = await runner.run('find /home/user/alpha /home/user/beta -type f | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/alpha/one.txt\n' +
        '/home/user/beta/two.txt\n'
      );
    });

    it('find with absolute paths searches both trees', async () => {
      await runner.run('mkdir -p /home/user/alpha/sub');
      vfs.writeFile('/home/user/alpha/sub/nested.txt', new TextEncoder().encode('n'));
      const result = await runner.run('find /home/user/alpha /home/user/beta | sort');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(
        '/home/user/alpha\n' +
        '/home/user/alpha/one.txt\n' +
        '/home/user/alpha/sub\n' +
        '/home/user/alpha/sub/nested.txt\n' +
        '/home/user/beta\n' +
        '/home/user/beta/two.txt\n'
      );
    });
  });
});
