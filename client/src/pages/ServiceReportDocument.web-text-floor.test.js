import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// GATE_REPORT_SIMPLE_WEB: the report link shows this print document on screen,
// scaled by one web zoom. The brand gate skips this file because the PDF keeps
// print sizes, so this guard holds the screen side of the owner's rule
// (sheet 2026-09-03: nothing under 14px on a customer screen): a new size
// smaller than the rest would put that text under 14px on the web view.
const source = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/ServiceReportDocument.jsx'), 'utf8');

describe('service report web view text floor', () => {
  it('scales the smallest text in the document to at least 14px on screen', () => {
    const zoom = Number(source.match(/\.is-web \.doc-page \{ zoom: ([\d.]+); \}/)?.[1]);
    const sizes = [
      ...[...source.matchAll(/fontSize: ([\d.]+)/g)].map((m) => Number(m[1])),
      ...[...source.matchAll(/font-size: ([\d.]+)px/g)].map((m) => Number(m[1])),
    ].filter((n) => n > 0); // fontSize: 0 hides a text node; it is not read
    expect(zoom).toBeGreaterThan(1);
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes) * zoom).toBeGreaterThanOrEqual(14);
  });
});
