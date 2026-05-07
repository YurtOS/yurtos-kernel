import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createBufferTarget, createStaticTarget, createNullTarget, bufferToString } from '../fd-target.js';

describe('FdTarget', () => {
  it('buffer target accumulates data', () => {
    const target = createBufferTarget();
    target.buf.push(new TextEncoder().encode('hello'));
    target.total += 5;
    expect(bufferToString(target)).toBe('hello');
  });

  it('buffer target respects limit', () => {
    const target = createBufferTarget(3);
    const data = new TextEncoder().encode('hello');
    const toWrite = Math.min(data.length, target.limit - target.total);
    target.buf.push(data.subarray(0, toWrite));
    target.total += data.length;
    target.truncated = data.length > toWrite;
    expect(bufferToString(target)).toBe('hel');
    expect(target.truncated).toBe(true);
  });

  it('static target serves bytes with offset', () => {
    const target = createStaticTarget(new TextEncoder().encode('hello world'));
    const buf = new Uint8Array(5);
    const n = Math.min(buf.length, target.data.length - target.offset);
    buf.set(target.data.subarray(target.offset, target.offset + n));
    target.offset += n;
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe('hello');
    expect(target.offset).toBe(5);
  });

  it('static target returns 0 at EOF', () => {
    const target = createStaticTarget(new Uint8Array(0));
    const n = Math.min(5, target.data.length - target.offset);
    expect(n).toBe(0);
  });

  it('null target is created with correct type', () => {
    const target = createNullTarget();
    expect(target.type).toBe('null');
  });

  it('buffer target starts empty', () => {
    const target = createBufferTarget();
    expect(target.buf.length).toBe(0);
    expect(target.total).toBe(0);
    expect(target.truncated).toBe(false);
    expect(bufferToString(target)).toBe('');
  });

  it('buffer target with custom limit', () => {
    const target = createBufferTarget(1024);
    expect(target.limit).toBe(1024);
  });

  it('buffer target with default limit', () => {
    const target = createBufferTarget();
    expect(target.limit).toBe(Infinity);
  });

  it('bufferToString concatenates multiple chunks', () => {
    const target = createBufferTarget();
    target.buf.push(new TextEncoder().encode('hello '));
    target.buf.push(new TextEncoder().encode('world'));
    target.total += 11;
    expect(bufferToString(target)).toBe('hello world');
  });
});
