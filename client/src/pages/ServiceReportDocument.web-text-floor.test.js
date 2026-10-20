import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// GATE_REPORT_SIMPLE_WEB: the report link shows this print document on screen,
// scaled by one web zoom. The brand gate skips this file because the PDF keeps
// print sizes, so this guard holds the screen side of the owner's rule
// (sheet 2026-09-03: nothing under 14px on a customer screen) for the
// document's own text. Text drawn inside the generated treatment-map image
// scales with the picture, as in the PDF; the zone letters it shows are
// spelled out in the legend under the map, which this floor covers.
const source = fs.readFileSync(path.resolve(process.cwd(), 'src/pages/ServiceReportDocument.jsx'), 'utf8');
const zoom = Number(source.match(/\.is-web \.doc-page \{ zoom: ([\d.]+); \}/)?.[1]);

describe('service report web view text floor', () => {
  it('scales the smallest document text to at least 14px on screen', () => {
    const sizes = [
      ...[...source.matchAll(/fontSize: ([\d.]+)/g)].map((m) => Number(m[1])),
      ...[...source.matchAll(/font-size: ([\d.]+)px/g)].map((m) => Number(m[1])),
    ].filter((n) => n > 0); // fontSize: 0 hides a text node; it is not read
    expect(zoom).toBeGreaterThan(1);
    expect(sizes.length).toBeGreaterThan(20);
    expect(Math.min(...sizes) * zoom).toBeGreaterThanOrEqual(14);
  });

  it('stacks the layout wherever the zoomed page is narrower than 640px', () => {
    // A media query sees the unzoomed viewport: a breakpoint left at 640 with
    // a larger zoom keeps the three-column grid in too little width.
    const breakpoints = [...source.matchAll(/@media \(max-width: (\d+)px\)/g)].map((m) => Number(m[1]));
    expect(breakpoints).toHaveLength(1);
    expect(breakpoints[0]).toBeGreaterThanOrEqual(Math.floor(640 * zoom));
  });
});
