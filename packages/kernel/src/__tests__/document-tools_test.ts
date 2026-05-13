import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { resolve } from 'node:path';
import { Sandbox } from '../sandbox.js';
import { NodeAdapter } from '../platform/node-adapter.js';

const WASM_DIR = resolve(import.meta.dirname!, '../platform/__tests__/fixtures');

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function buildPdf(pageCount: number, title?: string): Uint8Array {
  const objects: Array<[number, string]> = [];
  const pageIds: number[] = [];

  objects.push([1, '<< /Type /Catalog /Pages 2 0 R >>']);

  let nextId = 3;
  for (let i = 0; i < pageCount; i++) {
    pageIds.push(nextId++);
  }

  const kids = pageIds.map((id) => `${id} 0 R`).join(' ');
  objects.push([2, `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`]);

  for (const pageId of pageIds) {
    objects.push([pageId, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>']);
  }

  if (title) {
    const escaped = title.replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
    objects.push([nextId++, `<< /Title (${escaped}) /Producer (yurt-test) >>`]);
  }

  let pdf = '%PDF-1.4\n';
  const offsets = new Map<number, number>();

  for (const [id, body] of objects) {
    offsets.set(id, pdf.length);
    pdf += `${id} 0 obj\n${body}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${nextId}\n`;
  pdf += '0000000000 65535 f \n';
  for (let id = 1; id < nextId; id++) {
    const offset = offsets.get(id) ?? 0;
    pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`;
  }

  pdf += 'trailer\n';
  pdf += `<< /Size ${nextId} /Root 1 0 R`;
  if (title) {
    pdf += ` /Info ${nextId - 1} 0 R`;
  }
  pdf += ' >>\n';
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return encode(pdf);
}

describe('document tools', { sanitizeResources: false, sanitizeOps: false }, () => {
  let sandbox: Sandbox;

  afterEach(() => {
    sandbox?.destroy();
  });

  it('pdfinfo reports title and page count', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/sample.pdf', buildPdf(2, 'Spec Fixture'));

    const result = await sandbox.run('pdfinfo /tmp/sample.pdf');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Title: Spec Fixture');
    expect(result.stdout).toContain('Pages: 2');
    expect(result.stdout).toContain('PDF version: 1.4');
  });

  it('pdfinfo --help exposes the expected real-tool usage shape', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const result = await sandbox.run('pdfinfo --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: pdfinfo [options] PDF-file');
    expect(result.stdout).toContain('-box');
    expect(result.stdout).toContain('-meta');
    expect(result.stdout).toContain('-opw <password>');
  });

  it('pdfinfo -meta prints metadata-oriented output', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/meta.pdf', buildPdf(1, 'Meta Fixture'));

    const result = await sandbox.run('pdfinfo -meta /tmp/meta.pdf');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Title');
    expect(result.stdout).toContain('Meta Fixture');
  });

  it('pdfinfo keeps the first positional argument as the input file', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/positional.pdf', buildPdf(1, 'Positional Fixture'));

    const result = await sandbox.run('pdfinfo /tmp/positional.pdf -box');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('File name: positional.pdf');
    expect(result.stdout).not.toContain('MediaBox');
  });

  it('pdfinfo reports invalid page-range values clearly', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/invalid-range.pdf', buildPdf(1, 'Invalid Range Fixture'));

    const result = await sandbox.run('pdfinfo -f nope /tmp/invalid-range.pdf');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("option '-f' requires a valid number");
  });

  it('pdfunite merges PDFs in order', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/a.pdf', buildPdf(1, 'A'));
    sandbox.writeFile('/tmp/b.pdf', buildPdf(2, 'B'));

    const merge = await sandbox.run('pdfunite /tmp/a.pdf /tmp/b.pdf /tmp/out.pdf');
    expect(merge.exitCode).toBe(0);

    const info = await sandbox.run('pdfinfo /tmp/out.pdf');
    expect(info.exitCode).toBe(0);
    expect(info.stdout).toContain('Pages: 3');
  });

  it('pdfunite rejects invalid arity with a usage-style error', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/one.pdf', buildPdf(1, 'Only One'));

    const result = await sandbox.run('pdfunite /tmp/one.pdf /tmp/out.pdf');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('at least two input PDFs');
  });

  it('pdfseparate extracts each page into its own file', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/three.pdf', buildPdf(3, 'Three Pages'));

    const split = await sandbox.run('pdfseparate -f 2 -l 3 /tmp/three.pdf /tmp/page-%d.pdf');
    expect(split.exitCode).toBe(0);

    const page2 = await sandbox.run('pdfinfo /tmp/page-2.pdf');
    const page3 = await sandbox.run('pdfinfo /tmp/page-3.pdf');
    expect(page2.stdout).toContain('Pages: 1');
    expect(page3.stdout).toContain('Pages: 1');
  });

  it('pdfseparate rejects patterns without %d', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/three.pdf', buildPdf(3, 'Three Pages'));

    const result = await sandbox.run('pdfseparate /tmp/three.pdf /tmp/page.pdf');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('output pattern must contain %d');
  });

  it('csv2xlsx creates a workbook and xlsx2csv round-trips it', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.csv', encode('name,value\nalpha,1\nbeta,2\n'));

    const create = await sandbox.run("csv2xlsx -i /tmp/data.csv /tmp/out.xlsx Sheet1");
    expect(create.exitCode).toBe(0);

    const count = await sandbox.run('xlsx2csv -count /tmp/out.xlsx');
    expect(count.exitCode).toBe(0);
    expect(count.stdout.trim()).toBe('1');

    const sheets = await sandbox.run('xlsx2csv -sheets /tmp/out.xlsx');
    expect(sheets.exitCode).toBe(0);
    expect(sheets.stdout.trim()).toBe('Sheet1');

    const csv = await sandbox.run('xlsx2csv /tmp/out.xlsx Sheet1');
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout).toBe('name,value\nalpha,1\nbeta,2\n');
  });

  it('xlsx2csv --help exposes the expected compatibility flags', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const result = await sandbox.run('xlsx2csv -help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: xlsx2csv [OPTIONS] EXCEL_WORKBOOK_NAME [SHEET_NAME]');
    expect(result.stdout).toContain('-N, -sheets');
    expect(result.stdout).toContain('-c, -count');
    expect(result.stdout).toContain('-o, -output <path>');
  });

  it('xlsx2csv defaults to the first worksheet when no name is supplied', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/default.csv', encode('x,y\n1,2\n'));

    const create = await sandbox.run('csv2xlsx -i /tmp/default.csv /tmp/default.xlsx FirstSheet');
    expect(create.exitCode).toBe(0);

    const result = await sandbox.run('xlsx2csv /tmp/default.xlsx');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('x,y\n1,2\n');
  });

  it('xlsx2csv -nl appends a newline when writing to stdout', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/stdout-nl.csv', encode('a,b\n1,2\n'));

    const create = await sandbox.run('csv2xlsx -i /tmp/stdout-nl.csv /tmp/stdout-nl.xlsx Sheet1');
    expect(create.exitCode).toBe(0);

    const result = await sandbox.run('xlsx2csv -nl /tmp/stdout-nl.xlsx Sheet1');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('a,b\n1,2\n\n');
  });

  it('csv2xlsx accepts stdin input', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const create = await sandbox.run("printf 'c1,c2\\nleft,right\\n' | csv2xlsx /tmp/stdin.xlsx SheetStdin");
    expect(create.exitCode).toBe(0);

    const csv = await sandbox.run('xlsx2csv /tmp/stdin.xlsx SheetStdin');
    expect(csv.exitCode).toBe(0);
    expect(csv.stdout).toBe('c1,c2\nleft,right\n');
  });

  it('csv2xlsx --help exposes the expected compatibility shape', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });

    const result = await sandbox.run('csv2xlsx --help');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage: csv2xlsx [-i CSV] WORKBOOK_PATH WORKSHEET_NAME');
    expect(result.stdout).toContain('-i <path>');
  });

  it('csv2xlsx fails when worksheet name is missing', async () => {
    sandbox = await Sandbox.create({ wasmDir: WASM_DIR, adapter: new NodeAdapter() });
    sandbox.writeFile('/tmp/data.csv', encode('only\nrow\n'));

    const result = await sandbox.run('csv2xlsx -i /tmp/data.csv /tmp/missing.xlsx');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('expected WORKBOOK_PATH and WORKSHEET_NAME');
  });
});
