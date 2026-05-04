/**
 * Conformance tests for jq — adapted from the official jq test suite.
 * Source: https://github.com/jqlang/jq/blob/master/tests/jq.test
 *
 * Tests basic filters, field access, array/object ops, string functions,
 * type operations, map/select, format strings, and conditionals.
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

const TOOLS = ['cat', 'echo', 'printf', 'jq', 'true', 'false'];

function wasmName(tool: string): string {
  if (tool === 'true') return 'true-cmd.wasm';
  if (tool === 'false') return 'false-cmd.wasm';
  return `${tool}.wasm`;
}

// SKIPPED: hand-built ProcessManager bypasses Sandbox.registerTools.
// Re-enable after migrating to Sandbox.create — alongside the
// Python+pkg refactor.
describe.skip('jq conformance (official test suite)', () => {
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

  function writeFile(path: string, content: string) {
    vfs.writeFile(path, new TextEncoder().encode(content));
  }

  /** Run jq -c with given program against input JSON file */
  async function jq(program: string, input: string): Promise<string> {
    writeFile('/tmp/input.json', input + '\n');
    const escaped = program.replace(/'/g, "'\\''");
    const r = await runner.run(`jq -c '${escaped}' /tmp/input.json`);
    expect(r.exitCode).toBe(0);
    return r.stdout.trimEnd();
  }

  // ---------------------------------------------------------------------------
  // Official test suite: Literals and value tests
  // Source: jq.test lines 7-30
  // ---------------------------------------------------------------------------
  describe('literals (official)', () => {
    it('true', async () => expect(await jq('true', 'null')).toBe('true'));
    it('false', async () => expect(await jq('false', 'null')).toBe('false'));
    it('null', async () => expect(await jq('null', '42')).toBe('null'));
    it('1', async () => expect(await jq('1', 'null')).toBe('1'));
    it('{}', async () => expect(await jq('{}', 'null')).toBe('{}'));
    it('[]', async () => expect(await jq('[]', 'null')).toBe('[]'));
    it('{a: 1}', async () => expect(await jq('{a: 1}', 'null')).toBe('{"a":1}'));
  });

  // ---------------------------------------------------------------------------
  // Official test suite: Identity and field access
  // Source: jq.test lines 120-160
  // ---------------------------------------------------------------------------
  describe('field access (official)', () => {
    it('. identity', async () => expect(await jq('.', '{"a":1}')).toBe('{"a":1}'));
    it('.foo', async () => expect(await jq('.foo', '{"foo": 42, "bar": 43}')).toBe('42'));
    it('.foo | .bar', async () => expect(await jq('.foo | .bar', '{"foo": {"bar": 42}}')).toBe('42'));
    it('.foo.bar', async () => expect(await jq('.foo.bar', '{"foo": {"bar": 42}}')).toBe('42'));
    it('.foo_bar', async () => expect(await jq('.foo_bar', '{"foo_bar": 2}')).toBe('2'));
    it('.["foo"].bar', async () => expect(await jq('.["foo"].bar', '{"foo": {"bar": 42}}')).toBe('42'));
  });

  // ---------------------------------------------------------------------------
  // Official test suite: Array construction and iteration
  // Source: jq.test lines 50-90
  // ---------------------------------------------------------------------------
  describe('arrays (official)', () => {
    it('[.]', async () => expect(await jq('[.]', '1')).toBe('[1]'));
    it('[[2]]', async () => expect(await jq('[[2]]', 'null')).toBe('[[2]]'));
    it('[{}]', async () => expect(await jq('[{}]', 'null')).toBe('[{}]'));
    it('[.[]]', async () => expect(await jq('[.[]]', '[1,2,3]')).toBe('[1,2,3]'));
    it('[range(0;10)]', async () => expect(await jq('[range(0;10)]', 'null')).toBe('[0,1,2,3,4,5,6,7,8,9]'));
    it('[(.,1),((.,.[]),(2,3))]', async () => {
      expect(await jq('[(.,1),((.,.[]),(2,3))]', '["a","b"]')).toBe('[["a","b"],1,["a","b"],"a","b",2,3]');
    });
    it('[first(range(.)), last(range(.))]', async () => {
      expect(await jq('[first(range(.)), last(range(.))]', '5')).toBe('[0,4]');
    });
  });

  // ---------------------------------------------------------------------------
  // Array and object builtins
  // ---------------------------------------------------------------------------
  describe('builtins', () => {
    it('length on array', async () => expect(await jq('length', '[1,2,3]')).toBe('3'));
    it('length on string', async () => expect(await jq('length', '"hello"')).toBe('5'));
    it('length on object', async () => expect(await jq('length', '{"a":1,"b":2}')).toBe('2'));
    it('keys', async () => expect(await jq('keys', '{"b":2,"a":1}')).toBe('["a","b"]'));
    it('values', async () => expect(await jq('values', '{"a":1,"b":2}')).toBe('[1,2]'));
    it('type string', async () => expect(await jq('type', '"hello"')).toBe('"string"'));
    it('type number', async () => expect(await jq('type', '42')).toBe('"number"'));
    it('type array', async () => expect(await jq('type', '[1]')).toBe('"array"'));
    it('type object', async () => expect(await jq('type', '{}')).toBe('"object"'));
    it('type bool', async () => expect(await jq('type', 'true')).toBe('"boolean"'));
    it('type null', async () => expect(await jq('type', 'null')).toBe('"null"'));
    it('add numbers', async () => expect(await jq('add', '[1,2,3]')).toBe('6'));
    it('add strings', async () => expect(await jq('add', '["a","b","c"]')).toBe('"abc"'));
    it('reverse', async () => expect(await jq('reverse', '[1,2,3]')).toBe('[3,2,1]'));
    it('unique', async () => expect(await jq('unique', '[1,2,1,3,2]')).toBe('[1,2,3]'));
    it('flatten', async () => expect(await jq('flatten', '[[1,[2]],3]')).toBe('[1,2,3]'));
    it('min', async () => expect(await jq('min', '[3,1,2]')).toBe('1'));
    it('max', async () => expect(await jq('max', '[3,1,2]')).toBe('3'));
    it('contains', async () => expect(await jq('contains([2])', '[1,2,3]')).toBe('true'));
    it('to_entries', async () => expect(await jq('to_entries', '{"a":1}')).toBe('[{"key":"a","value":1}]'));
    it('from_entries', async () => expect(await jq('from_entries', '[{"key":"a","value":1}]')).toBe('{"a":1}'));
  });

  // ---------------------------------------------------------------------------
  // String functions
  // ---------------------------------------------------------------------------
  describe('string functions', () => {
    it('ascii_downcase', async () => expect(await jq('ascii_downcase', '"HELLO"')).toBe('"hello"'));
    it('ascii_upcase', async () => expect(await jq('ascii_upcase', '"hello"')).toBe('"HELLO"'));
    it('tostring', async () => expect(await jq('tostring', '42')).toBe('"42"'));
    it('tonumber', async () => expect(await jq('tonumber', '"42"')).toBe('42'));
    it('split', async () => expect(await jq('split(",")', '"a,b,c"')).toBe('["a","b","c"]'));
    it('join', async () => expect(await jq('join(",")', '["a","b","c"]')).toBe('"a,b,c"'));
    it('ltrimstr', async () => expect(await jq('ltrimstr("he")', '"hello"')).toBe('"llo"'));
    it('rtrimstr', async () => expect(await jq('rtrimstr("lo")', '"hello"')).toBe('"hel"'));
    it('startswith', async () => expect(await jq('startswith("he")', '"hello"')).toBe('true'));
    it('endswith', async () => expect(await jq('endswith("lo")', '"hello"')).toBe('true'));
    it('length of string', async () => expect(await jq('length', '"abc123"')).toBe('6'));
    it('explode/implode roundtrip', async () => expect(await jq('explode | implode', '"abc"')).toBe('"abc"'));
  });

  // ---------------------------------------------------------------------------
  // Official test suite: Format strings
  // Source: jq.test lines 40-60
  // ---------------------------------------------------------------------------
  describe('format strings (official)', () => {
    it('@base64 encode', async () => expect(await jq('@base64', '"hello"')).toBe('"aGVsbG8="'));
    it('@base64d decode', async () => expect(await jq('@base64d', '"aGVsbG8="')).toBe('"hello"'));
    it('@tsv', async () => expect(await jq('@tsv', '["a","b","c"]')).toBe('"a\\tb\\tc"'));
    it('@json', async () => expect(await jq('@json', '[1,2]')).toBe('"[1,2]"'));
  });

  // ---------------------------------------------------------------------------
  // Map, select, and higher-order
  // ---------------------------------------------------------------------------
  describe('map and select', () => {
    it('map(. + 1)', async () => expect(await jq('map(. + 1)', '[1,2,3]')).toBe('[2,3,4]'));
    it('map(. * 2)', async () => expect(await jq('map(. * 2)', '[1,2,3]')).toBe('[2,4,6]'));
    it('select(. > 2)', async () => expect(await jq('[.[] | select(. > 2)]', '[1,2,3,4,5]')).toBe('[3,4,5]'));
    it('map(select(. != null))', async () => expect(await jq('map(select(. != null))', '[1,null,2,null,3]')).toBe('[1,2,3]'));
    it('group_by(.a)', async () => {
      expect(await jq('group_by(.a)', '[{"a":1},{"a":2},{"a":1}]')).toBe('[[{"a":1},{"a":1}],[{"a":2}]]');
    });
    it('sort_by(.a)', async () => {
      expect(await jq('sort_by(.a)', '[{"a":3},{"a":1},{"a":2}]')).toBe('[{"a":1},{"a":2},{"a":3}]');
    });
    it('unique_by(.a)', async () => {
      expect(await jq('unique_by(.a)', '[{"a":1,"b":2},{"a":1,"b":3},{"a":2}]')).toBe('[{"a":1,"b":2},{"a":2}]');
    });
    it('min_by(.a)', async () => {
      expect(await jq('min_by(.a)', '[{"a":3},{"a":1},{"a":2}]')).toBe('{"a":1}');
    });
    it('max_by(.a)', async () => {
      expect(await jq('max_by(.a)', '[{"a":3},{"a":1},{"a":2}]')).toBe('{"a":3}');
    });
  });

  // ---------------------------------------------------------------------------
  // Arithmetic and comparison
  // ---------------------------------------------------------------------------
  describe('arithmetic and comparison', () => {
    it('addition', async () => expect(await jq('. + 1', '41')).toBe('42'));
    it('subtraction', async () => expect(await jq('. - 1', '43')).toBe('42'));
    it('multiplication', async () => expect(await jq('. * 2', '21')).toBe('42'));
    it('division', async () => expect(await jq('. / 2', '84')).toBe('42'));
    it('modulo', async () => expect(await jq('. % 5', '42')).toBe('2'));
    it('equality', async () => expect(await jq('. == 42', '42')).toBe('true'));
    it('inequality', async () => expect(await jq('. != 42', '41')).toBe('true'));
    it('less than', async () => expect(await jq('. < 42', '41')).toBe('true'));
    it('greater than', async () => expect(await jq('. > 42', '43')).toBe('true'));
    it('not', async () => expect(await jq('not', 'true')).toBe('false'));
    it('and', async () => expect(await jq('true and false', 'null')).toBe('false'));
    it('or', async () => expect(await jq('true or false', 'null')).toBe('true'));
  });

  // ---------------------------------------------------------------------------
  // Official test suite: tojson/fromjson
  // Source: jq.test line 112
  // ---------------------------------------------------------------------------
  describe('json conversion (official)', () => {
    it('[.[]|tojson|fromjson]', async () => {
      expect(await jq('[.[]|tojson|fromjson]', '["foo", 1, ["a", 1]]')).toBe('["foo",1,["a",1]]');
    });
  });

  // ---------------------------------------------------------------------------
  // Official test suite: join
  // Source: jq.test
  // ---------------------------------------------------------------------------
  describe('join (official)', () => {
    it('[.[]|join("a")]', async () => {
      expect(await jq('[.[]|join("a")]', '[["one","two","three"],["four"]]')).toBe('["oneatwoathree","four"]');
    });
    it('empty string join', async () => {
      expect(await jq('join("")', '["a","b","c"]')).toBe('"abc"');
    });
  });

  // ---------------------------------------------------------------------------
  // Official test suite: first/last
  // Source: jq.test
  // ---------------------------------------------------------------------------
  describe('first/last (official)', () => {
    it('first', async () => expect(await jq('first(.[])', '[1,2,3]')).toBe('1'));
    it('last', async () => expect(await jq('last(.[])', '[1,2,3]')).toBe('3'));
    it('[first(range(.)), last(range(.))] on 1', async () => {
      expect(await jq('[first(range(.)), last(range(.))]', '1')).toBe('[0,0]');
    });
  });

  // ---------------------------------------------------------------------------
  // Pipe and composition
  // ---------------------------------------------------------------------------
  describe('pipes and composition', () => {
    it('pipe chain', async () => expect(await jq('.a | . + 1', '{"a":41}')).toBe('42'));
    it('nested access', async () => expect(await jq('.a.b.c', '{"a":{"b":{"c":42}}}')).toBe('42'));
    it('array iteration with pipe', async () => {
      expect(await jq('[.[] | . * 2]', '[1,2,3]')).toBe('[2,4,6]');
    });
    it('object value extraction', async () => {
      expect(await jq('.n', '{"n":"Alice","a":30}')).toBe('"Alice"');
    });
  });

  // ---------------------------------------------------------------------------
  // Math functions
  // ---------------------------------------------------------------------------
  describe('math', () => {
    it('floor', async () => expect(await jq('floor', '3.7')).toBe('3'));
    it('ceil', async () => expect(await jq('ceil', '3.2')).toBe('4'));
    it('round', async () => expect(await jq('round', '3.5')).toBe('4'));
    it('fabs', async () => expect(await jq('fabs', '-3.5')).toBe('3.5'));
  });

  // ---------------------------------------------------------------------------
  // Practical patterns
  // ---------------------------------------------------------------------------
  describe('practical patterns', () => {
    it('filter numbers', async () => {
      expect(await jq('[.[] | select(. > 3)]', '[1,2,3,4,5]')).toBe('[4,5]');
    });
    it('extract field from array of objects', async () => {
      expect(await jq('[.[] | .name]', '[{"name":"a"},{"name":"b"}]')).toBe('["a","b"]');
    });
    it('count items', async () => expect(await jq('[.[] | select(. > 3)] | length', '[1,2,3,4,5]')).toBe('2'));
    it('nested object access', async () => {
      expect(await jq('.data.items | length', '{"data":{"items":[1,2,3]}}')).toBe('3');
    });
    it('transform array of objects', async () => {
      expect(await jq('map({(.name): .value})', '[{"name":"a","value":1},{"name":"b","value":2}]'))
        .toBe('[{"a":1},{"b":2}]');
    });
    it('with_entries filter', async () => {
      expect(await jq('with_entries(select(.value > 1))', '{"a":1,"b":2,"c":3}'))
        .toBe('{"b":2,"c":3}');
    });
  });
});
