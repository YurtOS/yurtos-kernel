/**
 * Conformance tests for the sips (Scriptable Image Processing System) WASM binary.
 *
 * Exercises the full stack: shell → ProcessManager → WASI → sips.wasm → pil-rust-core.
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

// Minimal 4×4 RGBA PNG (136 bytes) — no EXIF, clean output from pil-rust-core
const TEST_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAT0lEQVR4AQFEALv/AP4hBP//AAD/' +
  '/wAA//8AAP8A9CQF/7gFB/+kCQn/nwoK/wD4FgP/egwN/1QREf9jEBD/APkVA/+9Bwf/tgcH/7QI' +
  'CP8CfB1c8mneJgAAAABJRU5ErkJggg==';

const TOOLS = ['cat', 'echo', 'sips', 'ls'];

function wasmName(tool: string): string {
  return `${tool}.wasm`;
}

function b64decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

describe('sips conformance', () => {
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
      syncSpawn: (cmd, args, env, stdin, cwd) =>
        mgr.spawnSync(cmd, args, env, stdin, cwd),
    });

    // Write test image into VFS
    vfs.writeFile('/home/user/test.png', b64decode(TEST_PNG_B64));
  });

  // -----------------------------------------------------------------------
  // Query properties
  // -----------------------------------------------------------------------

  describe('property queries', () => {
    it('-g pixelWidth returns width', async () => {
      const r = await runner.run('sips -g pixelWidth /home/user/test.png');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('pixelWidth: 4');
    });

    it('-g pixelHeight returns height', async () => {
      const r = await runner.run('sips -g pixelHeight /home/user/test.png');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('pixelHeight: 4');
    });

    it('-g hasAlpha detects alpha channel', async () => {
      const r = await runner.run('sips -g hasAlpha /home/user/test.png');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hasAlpha: true');
    });

    it('-g all shows all properties', async () => {
      const r = await runner.run('sips -g all /home/user/test.png');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('pixelWidth: 4');
      expect(r.stdout).toContain('pixelHeight: 4');
      expect(r.stdout).toContain('space: RGB');
      expect(r.stdout).toContain('bitsPerSample: 8');
    });

    it('multiple -g flags query multiple properties', async () => {
      const r = await runner.run(
        'sips -g pixelWidth -g pixelHeight /home/user/test.png',
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('pixelWidth: 4');
      expect(r.stdout).toContain('pixelHeight: 4');
    });
  });

  // -----------------------------------------------------------------------
  // Resize
  // -----------------------------------------------------------------------

  describe('resize', () => {
    it('-z resizes to exact dimensions', async () => {
      const r = await runner.run(
        'sips -z 8 16 /home/user/test.png -o /home/user/resized.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/resized.png');
      expect(q.stdout).toContain('pixelWidth: 16');
      expect(q.stdout).toContain('pixelHeight: 8');
    });

    it('-Z resizes to fit max dimension', async () => {
      // 4x4 image, max 2 → 2x2
      const r = await runner.run(
        'sips -Z 2 /home/user/test.png -o /home/user/maxed.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/maxed.png');
      expect(q.stdout).toContain('pixelWidth: 2');
      expect(q.stdout).toContain('pixelHeight: 2');
    });

    it('--resampleWidth preserves aspect ratio', async () => {
      const r = await runner.run(
        'sips --resampleWidth 8 /home/user/test.png -o /home/user/rw.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/rw.png');
      expect(q.stdout).toContain('pixelWidth: 8');
      expect(q.stdout).toContain('pixelHeight: 8');
    });

    it('--resampleHeight preserves aspect ratio', async () => {
      const r = await runner.run(
        'sips --resampleHeight 8 /home/user/test.png -o /home/user/rh.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelHeight /home/user/rh.png');
      expect(q.stdout).toContain('pixelHeight: 8');
    });
  });

  // -----------------------------------------------------------------------
  // Rotate & flip
  // -----------------------------------------------------------------------

  describe('rotate and flip', () => {
    it('-r 90 rotates 90° (swaps dimensions on non-square)', async () => {
      // Create a non-square image: 8×4
      await runner.run(
        'sips -z 4 8 /home/user/test.png -o /home/user/rect.png',
      );
      const r = await runner.run(
        'sips -r 90 /home/user/rect.png -o /home/user/rot.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/rot.png');
      expect(q.stdout).toContain('pixelWidth: 4');
      expect(q.stdout).toContain('pixelHeight: 8');
    });

    it('-f horizontal flips without changing dimensions', async () => {
      const r = await runner.run(
        'sips -f horizontal /home/user/test.png -o /home/user/flipped.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/flipped.png');
      expect(q.stdout).toContain('pixelWidth: 4');
      expect(q.stdout).toContain('pixelHeight: 4');
    });

    it('-f vertical flips without changing dimensions', async () => {
      const r = await runner.run(
        'sips -f vertical /home/user/test.png -o /home/user/vflipped.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/vflipped.png');
      expect(q.stdout).toContain('pixelWidth: 4');
      expect(q.stdout).toContain('pixelHeight: 4');
    });
  });

  // -----------------------------------------------------------------------
  // Crop
  // -----------------------------------------------------------------------

  describe('crop', () => {
    it('-c crops to height × width', async () => {
      // First make a bigger image to crop
      await runner.run(
        'sips -z 16 16 /home/user/test.png -o /home/user/big.png',
      );
      const r = await runner.run(
        'sips -c 8 8 /home/user/big.png -o /home/user/cropped.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/cropped.png');
      expect(q.stdout).toContain('pixelWidth: 8');
      expect(q.stdout).toContain('pixelHeight: 8');
    });

    it('-c with --cropOffset offsets the crop origin', async () => {
      await runner.run(
        'sips -z 16 16 /home/user/test.png -o /home/user/big.png',
      );
      const r = await runner.run(
        'sips -c 4 4 --cropOffset 4 4 /home/user/big.png -o /home/user/off.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/off.png');
      expect(q.stdout).toContain('pixelWidth: 4');
      expect(q.stdout).toContain('pixelHeight: 4');
    });
  });

  // -----------------------------------------------------------------------
  // Pad
  // -----------------------------------------------------------------------

  describe('pad', () => {
    it('-p pads to target dimensions', async () => {
      const r = await runner.run(
        'sips -p 8 8 /home/user/test.png -o /home/user/padded.png',
      );
      expect(r.exitCode).toBe(0);

      const q = await runner.run('sips -g pixelWidth -g pixelHeight /home/user/padded.png');
      expect(q.stdout).toContain('pixelWidth: 8');
      expect(q.stdout).toContain('pixelHeight: 8');
    });
  });

  // -----------------------------------------------------------------------
  // Format conversion
  // -----------------------------------------------------------------------

  describe('format conversion', () => {
    it('-s format jpeg converts PNG to JPEG', async () => {
      const r = await runner.run(
        'sips -s format jpeg /home/user/test.png -o /home/user/out.jpg',
      );
      expect(r.exitCode).toBe(0);

      // Verify the output is actually JPEG by checking magic bytes
      const data = vfs.readFile('/home/user/out.jpg');
      expect(data[0]).toBe(0xff);
      expect(data[1]).toBe(0xd8); // JPEG SOI marker
    });

    it('-s format bmp converts PNG to BMP', async () => {
      const r = await runner.run(
        'sips -s format bmp /home/user/test.png -o /home/user/out.bmp',
      );
      expect(r.exitCode).toBe(0);

      const data = vfs.readFile('/home/user/out.bmp');
      expect(data[0]).toBe(0x42); // 'B'
      expect(data[1]).toBe(0x4d); // 'M'
    });

    it('output extension infers format when no -s format', async () => {
      const r = await runner.run(
        'sips -z 4 4 /home/user/test.png -o /home/user/out.jpg',
      );
      expect(r.exitCode).toBe(0);

      const data = vfs.readFile('/home/user/out.jpg');
      expect(data[0]).toBe(0xff);
      expect(data[1]).toBe(0xd8);
    });
  });

  // -----------------------------------------------------------------------
  // In-place modification
  // -----------------------------------------------------------------------

  describe('in-place modification', () => {
    it('overwrites input when no -o specified', async () => {
      const before = vfs.readFile('/home/user/test.png');
      const r = await runner.run('sips -z 2 2 /home/user/test.png');
      expect(r.exitCode).toBe(0);

      const after = vfs.readFile('/home/user/test.png');
      // Size should differ after resize
      expect(after.length).not.toBe(before.length);

      const q = await runner.run('sips -g pixelWidth /home/user/test.png');
      expect(q.stdout).toContain('pixelWidth: 2');
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe('error handling', () => {
    it('fails on missing file', async () => {
      const r = await runner.run('sips -g all /home/user/nope.png');
      expect(r.exitCode).not.toBe(0);
    });

    it('fails with no arguments', async () => {
      const r = await runner.run('sips');
      expect(r.exitCode).not.toBe(0);
    });

    it('fails with unknown option', async () => {
      const r = await runner.run('sips --bogus /home/user/test.png');
      expect(r.exitCode).not.toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Help
  // -----------------------------------------------------------------------

  describe('help', () => {
    it('--help prints usage', async () => {
      const r = await runner.run('sips --help');
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toContain('Scriptable Image Processing System');
      expect(r.stderr).toContain('-z');
      expect(r.stderr).toContain('--rotate');
    });
  });
});
