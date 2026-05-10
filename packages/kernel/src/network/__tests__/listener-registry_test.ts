import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type ListenerInfo, ListenerRegistry } from "../listener-registry.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("ListenerRegistry", () => {
  it("listen returns the requested port and a handle", () => {
    const reg = new ListenerRegistry();
    const r = reg.listen({ host: "127.0.0.1", port: 8888, backlog: 16 });
    expect(r.port).toBe(8888);
    expect(r.host).toBe("127.0.0.1");
    expect(typeof r.handle).toBe("number");
  });

  it("listen with port 0 allocates a unique ephemeral port", () => {
    const reg = new ListenerRegistry();
    const a = reg.listen({ host: "127.0.0.1", port: 0, backlog: 16 });
    const b = reg.listen({ host: "127.0.0.1", port: 0, backlog: 16 });
    expect(a.port).toBeGreaterThanOrEqual(49152);
    expect(b.port).toBeGreaterThan(a.port);
  });

  it("listen on the same host:port twice fails", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 9000, backlog: 16 });
    expect(() => reg.listen({ host: "127.0.0.1", port: 9000, backlog: 16 }))
      .toThrow(/in use/i);
  });

  it("wildcard bind blocks subsequent specific bind on the same port", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "0.0.0.0", port: 9100, backlog: 16 });
    expect(() => reg.listen({ host: "127.0.0.1", port: 9100, backlog: 16 }))
      .toThrow(/in use/i);
    expect(() => reg.listen({ host: "localhost", port: 9100, backlog: 16 }))
      .toThrow(/in use/i);
  });

  it("specific bind blocks subsequent wildcard bind on the same port", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 9101, backlog: 16 });
    expect(() => reg.listen({ host: "0.0.0.0", port: 9101, backlog: 16 }))
      .toThrow(/in use/i);
  });

  it("localhost and 127.0.0.1 alias to the same listener", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "localhost", port: 7000, backlog: 16 });
    const conn = reg.connect({ host: "127.0.0.1", port: 7000 });
    expect(conn.ok).toBe(true);
    const accepted = await reg.accept(lr.handle);
    expect(accepted.localPort).toBe(7000);
  });

  it("connect to an unbound port fails", () => {
    const reg = new ListenerRegistry();
    const conn = reg.connect({ host: "127.0.0.1", port: 5555 });
    expect(conn.ok).toBe(false);
  });

  it("accept resolves when a connect happens after accept is awaited", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6000, backlog: 16 });
    const acceptPromise = reg.accept(lr.handle);
    const conn = reg.connect({ host: "127.0.0.1", port: 6000 });
    expect(conn.ok).toBe(true);
    const accepted = await acceptPromise;
    expect(accepted.localPort).toBe(6000);
    expect(accepted.peerPort).toBeGreaterThan(0);
  });

  it("accept resolves immediately if a connect happened first", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6001, backlog: 16 });
    reg.connect({ host: "127.0.0.1", port: 6001 });
    const accepted = await reg.accept(lr.handle);
    expect(accepted.localPort).toBe(6001);
  });

  it("multiple concurrent connects each get one accept", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6002, backlog: 16 });
    const c1 = reg.connect({ host: "127.0.0.1", port: 6002 });
    const c2 = reg.connect({ host: "127.0.0.1", port: 6002 });
    expect(c1.ok && c2.ok).toBe(true);
    const a1 = await reg.accept(lr.handle);
    const a2 = await reg.accept(lr.handle);
    expect(a1.socket).not.toBe(a2.socket);
  });

  it("rejects connects once the pending accept queue reaches backlog", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6004, backlog: 1 });

    const c1 = reg.connect({ host: "127.0.0.1", port: 6004 });
    expect(c1.ok).toBe(true);

    const c2 = reg.connect({ host: "127.0.0.1", port: 6004 });
    expect(c2.ok).toBe(false);
    if (!c2.ok) expect(c2.error).toMatch(/backlog/i);

    const accepted = await reg.accept(lr.handle);
    expect(accepted.localPort).toBe(6004);

    const c3 = reg.connect({ host: "127.0.0.1", port: 6004 });
    expect(c3.ok).toBe(true);
  });

  it("closeListener rejects pending accepts", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 6003, backlog: 16 });
    const acceptPromise = reg.accept(lr.handle);
    reg.closeListener(lr.handle);
    await expect(acceptPromise).rejects.toThrow(/closed/i);
  });

  it("listListeners reports current bindings", () => {
    const reg = new ListenerRegistry();
    reg.listen({ host: "127.0.0.1", port: 6010, backlog: 16 });
    reg.listen({ host: "127.0.0.1", port: 6011, backlog: 16 });
    const list = reg.listListeners();
    const ports = list.map((l: ListenerInfo) => l.port).sort();
    expect(ports).toEqual([6010, 6011]);
  });

  it("emits listen / unlisten events", () => {
    const reg = new ListenerRegistry();
    const events: Array<[string, number]> = [];
    const off = reg.on(
      "listen",
      (info: ListenerInfo) => events.push(["listen", info.port]),
    );
    const offU = reg.on(
      "unlisten",
      (info: ListenerInfo) => events.push(["unlisten", info.port]),
    );
    const lr = reg.listen({ host: "127.0.0.1", port: 6020, backlog: 16 });
    reg.closeListener(lr.handle);
    off();
    offU();
    expect(events).toEqual([["listen", 6020], ["unlisten", 6020]]);
  });
});

describe("ListenerRegistry socket I/O", () => {
  it("send delivers bytes to the peer recv", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7100, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7100 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    reg.send(c.socket, enc.encode("hello"));
    const got = await reg.recvAsync(accepted.socket, 1024);
    if (!got.ok) throw new Error("recv failed");
    expect(dec.decode(got.bytes)).toBe("hello");
  });

  it("recv returns EAGAIN when nonblocking and no data", () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7101, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7101 });
    if (!c.ok) throw new Error("connect failed");
    const r = reg.recv(c.socket, 1024, { nonblocking: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("EAGAIN");
    void lr;
  });

  it("recvAsync resolves with empty bytes when peer closes", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7102, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7102 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    const recvPromise = reg.recvAsync(accepted.socket, 1024);
    reg.closeSocket(c.socket);
    const got = await recvPromise;
    if (!got.ok) throw new Error("recv failed");
    expect(got.bytes.length).toBe(0);
  });

  it("partial recv leaves remainder for next call", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7103, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7103 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    reg.send(c.socket, enc.encode("hello world"));
    const r1 = await reg.recvAsync(accepted.socket, 5);
    const r2 = await reg.recvAsync(accepted.socket, 1024);
    if (!r1.ok || !r2.ok) throw new Error("recv failed");
    expect(dec.decode(r1.bytes)).toBe("hello");
    expect(dec.decode(r2.bytes)).toBe(" world");
  });

  it("closeSocket wakes the closer's own pending recvAsync", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7110, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7110 });
    if (!c.ok) throw new Error("connect failed");
    await reg.accept(lr.handle);
    const recvPromise = reg.recvAsync(c.socket, 1024);
    reg.closeSocket(c.socket);
    const got = await recvPromise;
    expect(got.ok).toBe(false);
  });

  it("closeListener delivers EOF to clients with unclaimed accepts", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7111, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7111 });
    if (!c.ok) throw new Error("connect failed");
    // Note: NO accept call. The connection sits in listener.pending.
    const recvPromise = reg.recvAsync(c.socket, 1024);
    reg.closeListener(lr.handle);
    const got = await recvPromise;
    if (!got.ok) throw new Error("expected EOF, got error: " + got.error);
    expect(got.bytes.length).toBe(0);
  });

  it("send to closed peer fails", async () => {
    const reg = new ListenerRegistry();
    const lr = reg.listen({ host: "127.0.0.1", port: 7104, backlog: 16 });
    const c = reg.connect({ host: "127.0.0.1", port: 7104 });
    if (!c.ok) throw new Error("connect failed");
    const accepted = await reg.accept(lr.handle);
    reg.closeSocket(accepted.socket);
    const r = reg.send(c.socket, enc.encode("x"));
    expect(r.ok).toBe(false);
  });
});
