/**
 * Conformance tests for rg — ripgrep-like recursive code search.
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

const enc = (s: string) => new TextEncoder().encode(s);

describe('rg conformance', () => {
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

    // Create test file tree
    await runner.run('mkdir -p /home/user/project/src /home/user/project/tests /home/user/project/docs /home/user/project/target/debug');
    vfs.writeFile('/home/user/project/src/main.rs', enc('fn main() {\n    println!("hello");\n}\n'));
    vfs.writeFile('/home/user/project/src/lib.rs', enc('pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n'));
    vfs.writeFile('/home/user/project/src/util.py', enc('def hello():\n    print("hello world")\n\ndef goodbye():\n    print("goodbye")\n'));
    vfs.writeFile('/home/user/project/tests/test_main.rs', enc('#[test]\nfn test_add() {\n    assert_eq!(add(1, 2), 3);\n}\n'));
    vfs.writeFile('/home/user/project/docs/README.md', enc('# My Project\n\nThis is a hello world project.\n'));
    vfs.writeFile('/home/user/project/.gitignore', enc('target/\n*.tmp\n'));
    vfs.writeFile('/home/user/project/.hidden_config', enc('secret=hello\n'));
    vfs.writeFile('/home/user/project/Cargo.toml', enc('[package]\nname = "hello"\n'));
    vfs.writeFile('/home/user/project/target/debug/output.tmp', enc('compiled output\n'));
  });

  // ---------------------------------------------------------------------------
  // Basic matching
  // ---------------------------------------------------------------------------
  describe('basic matching', () => {
    it('matches literal string in single file', async () => {
      const r = await runner.run('rg hello /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('println!("hello")');
    });

    it('matches regex pattern', async () => {
      const r = await runner.run('rg "fn \\w+" /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('fn main');
    });

    it('shows line numbers by default', async () => {
      const r = await runner.run('rg hello /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toMatch(/^\d+:/m);
    });

    it('exit code 1 when no match', async () => {
      const r = await runner.run('rg nonexistent /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('');
    });

    it('exit code 2 on invalid regex', async () => {
      const r = await runner.run('rg "[invalid" /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(2);
    });

    it('reads from stdin', async () => {
      const r = await runner.run('echo "hello world" | rg hello');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
    });
  });

  // ---------------------------------------------------------------------------
  // Recursive search
  // ---------------------------------------------------------------------------
  describe('recursive search', () => {
    it('searches directories recursively by default', async () => {
      const r = await runner.run('rg hello /home/user/project');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('src/main.rs');
      expect(r.stdout).toContain('src/util.py');
      expect(r.stdout).toContain('docs/README.md');
      // Should NOT include hidden files by default
      expect(r.stdout).not.toContain('.hidden_config');
    });

    it('skips hidden files unless --hidden', async () => {
      const r = await runner.run('rg --hidden hello /home/user/project');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('.hidden_config');
    });

    it('respects --max-depth', async () => {
      // Create a deeper nested file
      await runner.run('mkdir -p /home/user/project/src/deep');
      vfs.writeFile('/home/user/project/src/deep/nested.rs', enc('fn hello() {}\n'));
      const r = await runner.run('rg --max-depth 0 hello /home/user/project');
      expect(r.exitCode).toBe(0);
      // max-depth 0: only files directly in the starting dir
      expect(r.stdout).not.toContain('src/');
      expect(r.stdout).not.toContain('docs/');
      expect(r.stdout).toContain('Cargo.toml');

      // max-depth 1 should include src/ files but not src/deep/
      const r2 = await runner.run('rg --max-depth 1 hello /home/user/project');
      expect(r2.exitCode).toBe(0);
      expect(r2.stdout).toContain('src/main.rs');
      expect(r2.stdout).not.toContain('src/deep/');
    });
  });

  // ---------------------------------------------------------------------------
  // File type filtering
  // ---------------------------------------------------------------------------
  describe('file type filtering', () => {
    it('-t py filters to Python files', async () => {
      const r = await runner.run('rg -t py hello /home/user/project');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('util.py');
      expect(r.stdout).not.toContain('main.rs');
    });

    it('-T py excludes Python files', async () => {
      const r = await runner.run('rg -T py hello /home/user/project');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('util.py');
    });

    it('--type-list prints known types', async () => {
      const r = await runner.run('rg --type-list');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('py:');
      expect(r.stdout).toContain('rs:');
      expect(r.stdout).toContain('js:');
    });
  });

  // ---------------------------------------------------------------------------
  // Glob filtering
  // ---------------------------------------------------------------------------
  describe('glob filtering', () => {
    it('-g filters by glob pattern', async () => {
      const r = await runner.run("rg -g '*.rs' fn /home/user/project");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('main.rs');
      expect(r.stdout).not.toContain('util.py');
    });

    it('-g with negation excludes files', async () => {
      const r = await runner.run("rg -g '!*.md' hello /home/user/project");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('README.md');
    });
  });

  // ---------------------------------------------------------------------------
  // Case sensitivity
  // ---------------------------------------------------------------------------
  describe('case sensitivity', () => {
    it('smart case: lowercase pattern is case-insensitive', async () => {
      // "hello" should match "hello" in the files
      const r = await runner.run('rg hello /home/user/project/docs/README.md');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
    });

    it('smart case: mixed case pattern is case-sensitive', async () => {
      // "Hello" should NOT match "hello" (lowercase in files)
      const r = await runner.run('rg Hello /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(1);
    });

    it('-i forces case-insensitive', async () => {
      const r = await runner.run('rg -i HELLO /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
    });

    it('-s forces case-sensitive', async () => {
      const r = await runner.run('rg -s hello /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Output flags
  // ---------------------------------------------------------------------------
  describe('output flags', () => {
    it('-l prints only filenames', async () => {
      const r = await runner.run('rg -l hello /home/user/project');
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.trim().split('\n');
      // Each line should be a file path, no colons (line numbers)
      for (const line of lines) {
        expect(line).not.toMatch(/:\d+:/);
      }
    });

    it('-c prints match counts', async () => {
      const r = await runner.run('rg -c hello /home/user/project/src/util.py');
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toMatch(/\d+/);
    });

    it('-v inverts match', async () => {
      const r = await runner.run('rg -v hello /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).not.toContain('hello');
    });

    it('-F treats pattern as fixed string', async () => {
      const r = await runner.run('rg -F "fn main()" /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('fn main()');
    });

    it('-w matches whole words', async () => {
      const r = await runner.run('rg -w add /home/user/project/src/lib.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('fn add');
    });

    it('-N suppresses line numbers', async () => {
      const r = await runner.run('rg -N hello /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      // Should not have line_number: prefix
      expect(r.stdout).not.toMatch(/^\d+:/m);
    });

    it('--max-count limits matches per file', async () => {
      const r = await runner.run('rg --max-count 1 hello /home/user/project/src/util.py');
      expect(r.exitCode).toBe(0);
      const matchLines = r.stdout.trim().split('\n').filter((l: string) => l.includes('hello'));
      expect(matchLines.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Context lines
  // ---------------------------------------------------------------------------
  describe('context lines', () => {
    it('-A shows lines after match', async () => {
      const r = await runner.run('rg -A 1 "fn main" /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('fn main()');
      expect(r.stdout).toContain('println!');
    });

    it('-B shows lines before match', async () => {
      const r = await runner.run('rg -B 1 "a \\+ b" /home/user/project/src/lib.rs');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('a + b');
      expect(r.stdout).toContain('fn add');
    });

    it('-C shows lines before and after', async () => {
      const r = await runner.run('rg -C 1 println /home/user/project/src/main.rs');
      expect(r.exitCode).toBe(0);
      // Should have context around the println line
      const lines = r.stdout.trim().split('\n');
      expect(lines.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Gitignore
  // ---------------------------------------------------------------------------
  describe('gitignore', () => {
    it('respects .gitignore by default', async () => {
      // .gitignore has "target/" and "*.tmp"
      const r = await runner.run('rg output /home/user/project');
      expect(r.exitCode).toBe(1); // target/debug/output.tmp should be ignored
    });

    it('--no-ignore searches ignored files', async () => {
      const r = await runner.run('rg --no-ignore output /home/user/project');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('output.tmp');
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles empty files', async () => {
      vfs.writeFile('/home/user/project/empty.txt', enc(''));
      const r = await runner.run('rg hello /home/user/project/empty.txt');
      expect(r.exitCode).toBe(1);
    });

    it('searches current directory with no path arg', async () => {
      const r = await runner.run('cd /home/user/project && rg "fn main"');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('main.rs');
    });

    it('handles multiple paths', async () => {
      const r = await runner.run('rg hello /home/user/project/src/main.rs /home/user/project/docs/README.md');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('main.rs');
      expect(r.stdout).toContain('README.md');
    });

    it('pipes output to other tools', async () => {
      const r = await runner.run('rg -l hello /home/user/project | sort');
      expect(r.exitCode).toBe(0);
    });

    it('-- stops flag parsing', async () => {
      // Search for the literal pattern "-i" which won't match anything
      const r = await runner.run('rg -- -i /home/user/project/src/lib.rs');
      // Should not error - just won't match
      expect(r.exitCode).toBeLessThanOrEqual(1);
    });
  });
});
