import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { createBashConformanceHarness } from './harness.ts';

describe('bash conformance harness', () => {
  it('runs commands through host-side bash dispatch and preserves env', async () => {
    const { runner, sandbox } = await createBashConformanceHarness();
    try {
      const first = await runner.run('export HARNESS_VALUE=ok');
      expect(first.exitCode).toBe(0);

      const second = await runner.run('echo "$HARNESS_VALUE"');
      expect(second.stdout).toBe('ok\n');
      expect(runner.getEnv('HARNESS_VALUE')).toBe('ok');
    } finally {
      sandbox.destroy();
    }
  });

  it.ignore('preserves command substitution stdout through host-side dispatch', async () => {
    const { runner, sandbox } = await createBashConformanceHarness();
    try {
      const result = await runner.run('echo $(echo hello)');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello\n');
    } finally {
      sandbox.destroy();
    }
  });
});
