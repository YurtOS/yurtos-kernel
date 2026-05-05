/**
 * Adversarial security tests.
 *
 * These tests validate that the sandbox's defense-in-depth measures hold up
 * against deliberately crafted adversarial inputs. They complement the
 * acceptance tests in security.test.ts by probing edge cases and bypass
 * attempts.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "node:path";
import { Sandbox } from "../sandbox.js";
import { NodeAdapter } from "../platform/node-adapter.js";

const WASM_DIR = resolve(
  import.meta.dirname!,
  "../platform/__tests__/fixtures",
);

describe("Security: adversarial inputs", () => {
  it("extension blocked by allowlist cannot be reached via pipe", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ["echo"] },
      extensions: [{
        name: "secret",
        command: async () => ({ stdout: "leaked\n", exitCode: 0 }),
      }],
    });
    const result = await sb.run("echo test | secret");
    expect(result.stdout).not.toContain("leaked");
    sb.destroy();
  });

  it("blocked tool cannot be reached via command substitution", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ["echo"] },
    });
    // When grep is blocked inside $(), it produces no stdout, so the
    // substitution yields ''. The critical property: no data is leaked.
    const result = await sb.run("echo $(grep test /etc/passwd)");
    // The grep must not produce any useful output in the substitution
    expect(result.stdout.trim()).toBe("");
    // Also verify the blocked tool directly
    const direct = await sb.run("grep test /etc/passwd");
    expect(direct.exitCode).not.toBe(0);
    expect(direct.stderr).toContain("not allowed");
    sb.destroy();
  });

  it("script file cannot run blocked commands", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ["echo", "cat"] },
    });
    sb.writeFile(
      "/tmp/evil.sh",
      new TextEncoder().encode("#!/bin/sh\ngrep secret /etc/passwd\n"),
    );
    const result = await sb.run("source /tmp/evil.sh");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not allowed");
    sb.destroy();
  });

  it("deeply nested command substitution is bounded", async () => {
    // Build a command with 60 levels of nesting, exceeding MAX_SUBSTITUTION_DEPTH (50).
    // When the depth limit is hit, inner substitutions return '' silently,
    // so 'innermost' should never appear in the output.
    let cmd = "echo innermost";
    for (let i = 0; i < 60; i++) cmd = `echo $(${cmd})`;
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    const result = await sb.run(cmd);
    // The innermost value should be swallowed by the depth limit
    expect(result.stdout).not.toContain("innermost");
    sb.destroy();
  });

  it("output truncation works under repeated writes", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { stdoutBytes: 1024 } },
    });
    // Generate a single command whose output far exceeds the 1024-byte limit
    const result = await sb.run("seq 1 5000");
    // Allow for truncation marker overhead; output should be bounded
    expect(result.stdout.length).toBeLessThan(2048);
    sb.destroy();
  });

  it("very long command is rejected", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { limits: { commandBytes: 100 } },
    });
    const result = await sb.run("echo " + "a".repeat(200));
    expect(result.exitCode).not.toBe(0);
    expect(result.errorClass).toBe("LIMIT_EXCEEDED");
    sb.destroy();
  });

  it("symlink chains are bounded", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // Create a circular symlink chain: link1 -> link2 -> link1
    const result = await sb.run(
      "ln -s /tmp/link1 /tmp/link2; ln -s /tmp/link2 /tmp/link1; cat /tmp/link1",
    );
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it("path traversal via .. is neutralized", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // Try to escape writable directories.
    // The VFS normalizes paths: /tmp/../../../etc/passwd becomes /etc/passwd
    // /etc is 0o555 (read-only), so EACCES.
    const result = await sb.run("echo evil > /tmp/../../../etc/passwd");
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it("chmod on system config file is denied", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // /etc/yurt is 0o555 — chmod on children is denied
    const result = await sb.run("chmod 777 /etc/yurt/extensions.json");
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it("write to read-only system file is denied", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // /etc/yurt/extensions.json is 0o444 — writes are denied
    const result = await sb.run("echo evil > /etc/yurt/extensions.json");
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it("creating new files in /etc/yurt is denied", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // /etc/yurt is 0o555 — creating new files is denied (previously allowed via writablePaths)
    const result = await sb.run("echo evil > /etc/yurt/backdoor.json");
    expect(result.exitCode).not.toBe(0);
    sb.destroy();
  });

  it("symlink in /tmp pointing to /bin cannot be used to write to /bin", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // Create a symlink /tmp/escape → /bin (allowed: /tmp is 0o777)
    // Then try to write through it. resolveParent follows the symlink,
    // so the write lands on /bin (0o555) → EACCES.
    await sb.run("ln -s /bin /tmp/escape");
    const result = await sb.run("echo evil > /tmp/escape/backdoor");
    expect(result.exitCode).not.toBe(0);
    // Verify /bin was not modified
    expect(() => sb.readFile("/bin/backdoor")).toThrow();
    sb.destroy();
  });

  it("rename via symlink cannot move files into system dirs", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // Create a file in /tmp and a symlink /tmp/sysdir → /bin
    await sb.run("echo payload > /tmp/payload.txt");
    await sb.run("ln -s /bin /tmp/sysdir");
    // Try to rename through the symlink — destination parent resolves to /bin (0o555)
    const result = await sb.run("mv /tmp/payload.txt /tmp/sysdir/payload.txt");
    expect(result.exitCode).not.toBe(0);
    // Original file should still exist
    const cat = await sb.run("cat /tmp/payload.txt");
    expect(cat.stdout.trim()).toBe("payload");
    sb.destroy();
  });

  it("individual file can be locked within a writable directory", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    // Create a file in /tmp (writable), then lock it via chmod 444
    await sb.run("echo secret > /tmp/locked.txt");
    await sb.run("chmod 444 /tmp/locked.txt");
    // Overwriting the locked file should fail (mode bits enforced, not cosmetic)
    const result = await sb.run("echo overwritten > /tmp/locked.txt");
    expect(result.exitCode).not.toBe(0);
    // Original content should be preserved
    const cat = await sb.run("cat /tmp/locked.txt");
    expect(cat.stdout.trim()).toBe("secret");
    sb.destroy();
  });

  it("importState cannot overwrite system config files", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });

    // Write a legitimate file so the blob is non-empty
    sb.writeFile("/tmp/legit.txt", new TextEncoder().encode("legit"));
    const blob = sb.exportState();

    // Tamper with the blob: inject an entry targeting /etc/yurt/extensions.json
    const jsonBytes = blob.subarray(12);
    const state = JSON.parse(new TextDecoder().decode(jsonBytes));
    state.files.push({
      path: "/etc/yurt/extensions.json",
      data: btoa('{"allowAll": true}'),
      type: "file",
    });

    // Re-encode with valid CRC32
    const newJson = new TextEncoder().encode(JSON.stringify(state));
    const TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      TABLE[i] = c;
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < newJson.byteLength; i++) {
      crc = TABLE[(crc ^ newJson[i]) & 0xFF] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xFFFFFFFF) >>> 0;

    const tamperedBlob = new Uint8Array(12 + newJson.byteLength);
    tamperedBlob.set([0x57, 0x53, 0x4E, 0x44], 0);
    const view = new DataView(tamperedBlob.buffer);
    view.setUint32(4, 2, true);
    view.setUint32(8, crc, true);
    tamperedBlob.set(newJson, 12);

    // Import into a fresh sandbox
    const sb2 = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
    });
    try {
      // Read the original config before import
      const originalConfig = new TextDecoder().decode(
        sb2.readFile("/etc/yurt/extensions.json"),
      );

      sb2.importState(tamperedBlob);

      // Config must be unchanged — the tampered entry was silently skipped
      const afterConfig = new TextDecoder().decode(
        sb2.readFile("/etc/yurt/extensions.json"),
      );
      expect(afterConfig).toBe(originalConfig);
      expect(afterConfig).not.toContain("allowAll");

      // The legitimate file should still have been imported
      expect(new TextDecoder().decode(sb2.readFile("/tmp/legit.txt"))).toBe(
        "legit",
      );
    } finally {
      sb2.destroy();
    }
    sb.destroy();
  });

  it("redirect-based SSRF is blocked by policy re-validation", async () => {
    const { NetworkGateway, NetworkAccessDenied } = await import(
      "../network/gateway.js"
    );

    const gw = new NetworkGateway({ allowedHosts: ["trusted.com"] });

    // Mock globalThis.fetch to simulate a redirect to AWS IMDS metadata endpoint
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data/" },
      });
    }) as typeof fetch;
    try {
      let caught = false;
      try {
        await gw.fetch("https://trusted.com/api");
      } catch (err) {
        caught = true;
        expect(err).toBeInstanceOf(NetworkAccessDenied);
        expect((err as Error).message).toContain("169.254.169.254");
      }
      expect(caught).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fork inherits allowlist restrictions", async () => {
    const sb = await Sandbox.create({
      wasmDir: WASM_DIR,
      adapter: new NodeAdapter(),
      security: { toolAllowlist: ["echo"] },
    });
    const forked = await sb.fork();
    const result = await forked.run("grep test /tmp/a");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("not allowed");
    forked.destroy();
    sb.destroy();
  });
});
