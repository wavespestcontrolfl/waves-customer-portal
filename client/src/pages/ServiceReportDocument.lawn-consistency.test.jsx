// @vitest-environment jsdom
// The lawn PDF document and the web report print the same reconciled copy:
// the watering sentences, and the clean-visit "No lawn issues" row. Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';
import { LawnLeadCard } from '../components/report/lawnV2/LawnReportV2';
import LawnReportV2Section from '../components/report/lawnV2/LawnReportV2Section';

afterEach(() => cleanup());

const CONFIRM = 'Confirm the product watering directions with your technician before changing irrigation.';
const AFTER_TODAY = 'Today’s application is recorded as requiring water-in. Confirm the directions with your technician before changing irrigation.';
const NO_ISSUES = 'No lawn issues observed this visit';

const SNAPSHOT = {
  overallScore: 86, status: 'watch', statusHeadline: 'Stable — watching a few stress areas', customerAction: CONFIRM,
};
const WATCH_INSIGHT = {
  category: 'damage', status: 'watch', priority: 1, headline: 'A few stress patterns to monitor',
  whatWeSaw: 'Some stress patterns in the turf that we want to keep an eye on.',
};
const CLEAN_FINDING = {
  id: 'f1', category: 'no_activity', severity: 'info', title: NO_ISSUES,
  detail: 'Turf areas inspected during this visit did not show conditions requiring a corrective finding.',
};

const lawnData = (over = {}) => ({
  serviceRecordId: '00000000-0000-4000-8000-000000000002',
  serviceDate: '2026-10-05T00:00:00.000Z',
  serviceDisplayName: 'Lawn Care Service',
  serviceLine: 'lawn',
  technicianName: 'Test T.',
  customerName: 'Test Customer',
  serviceAddress: '1 Test Way, Testville, FL 00000',
  applicationMade: true,
  applications: [],
  zones: [],
  photos: [],
  findings: [],
  dynamicContext: {
    reentry: {
      customerSummary: 'Exterior ready at 7:03 AM.',
      targets: [{ key: 'exterior', label: 'Exterior', durationMin: 30, readyAt: '2026-10-05T11:03:56.943Z' }],
      petAdvisory: 'Keep pets and family off treated turf until it dries.',
      irrigationReadyAt: '2026-10-06T10:33:56.943Z',
    },
  },
  reportV2: {
    snapshot: SNAPSHOT,
    lead: { headline: SNAPSHOT.statusHeadline, yourPart: [CONFIRM] },
    insights: [WATCH_INSIGHT],
    aftercare: { watering: AFTER_TODAY, reentry: null },
    water: { status: 'unknown', confidence: 'low', explanation: CONFIRM, scheduleOnFile: false },
    banner: null,
  },
  ...over,
});

// The watering sentences a surface prints: each known sentence it carries, plus
// any "Hold irrigation until ..." line (textContent has no spacing between blocks).
const wateringSentences = (text) => new Set([
  ...[CONFIRM, AFTER_TODAY].filter((sentence) => text.includes(sentence)),
  ...(text.match(/Hold irrigation until[^.]*\./g) || []),
]);

describe('lawn PDF and web read the same watering lines', () => {
  it('the PDF prints no hold-irrigation line the reconciled report does not carry, and its watering set equals the web\'s', () => {
    const data = lawnData();
    const pdf = render(<ServiceReportDocument data={data} token="tok-b1" />).container.textContent;
    cleanup();
    const v2 = data.reportV2;
    const web = render(
      <>
        <LawnLeadCard lead={v2.lead} snapshot={v2.snapshot} />
        <LawnReportV2Section data={v2} />
      </>,
    ).container.textContent;
    expect(pdf).not.toMatch(/Hold irrigation until/);
    expect(web).not.toMatch(/Hold irrigation until/);
    const pdfSet = wateringSentences(pdf);
    expect(pdfSet.size).toBeGreaterThan(0);
    expect([...pdfSet].sort()).toEqual([...wateringSentences(web)].sort());
  });

  it('a lawn report without the V2 payload keeps the advisory hold-irrigation line', () => {
    const data = lawnData({ reportV2: null });
    expect(render(<ServiceReportDocument data={data} token="tok-b2" />).container.textContent).toMatch(/Hold irrigation until/);
  });
});

describe('lawn PDF "No lawn issues" row', () => {
  const text = (data, token) => render(<ServiceReportDocument data={data} token={token} />).container.textContent;

  it('is left out when a watch item or stress pattern is on the report', () => {
    expect(text(lawnData({ findings: [CLEAN_FINDING] }), 'tok-c1')).not.toContain(NO_ISSUES);
  });

  it('is left out when another finding is recorded', () => {
    const other = { id: 'f2', category: 'conducive_condition', severity: 'low', title: 'Thin turf at the edge', detail: 'Thinning along the edge.' };
    const data = lawnData({ findings: [CLEAN_FINDING, other], reportV2: { ...lawnData().reportV2, insights: [], snapshot: { ...SNAPSHOT, status: 'healthy' } } });
    const out = text(data, 'tok-c2');
    expect(out).not.toContain(NO_ISSUES);
    expect(out).toContain('Thin turf at the edge');
  });

  it('is still printed on a truly clean visit', () => {
    const data = lawnData({ findings: [CLEAN_FINDING], reportV2: { ...lawnData().reportV2, insights: [], snapshot: { ...SNAPSHOT, status: 'healthy' } } });
    expect(text(data, 'tok-c3')).toContain(NO_ISSUES);
  });
});

describe('tree & shrub PDF "No issues" row', () => {
  const TS_NO_ISSUES = 'No tree or shrub issues observed this visit';
  const tsFinding = { id: 'f3', category: 'no_activity', severity: 'info', title: TS_NO_ISSUES, detail: 'Inspected tree and shrub areas did not show conditions requiring a corrective finding.' };
  const tsData = (insights, status) => lawnData({
    serviceLine: 'tree_shrub',
    findings: [tsFinding],
    reportV2: { snapshot: { overallScore: 80, statusHeadline: 'Landscape check', status }, insights },
  });
  const text = (data, token) => render(<ServiceReportDocument data={data} token={token} />).container.textContent;

  it('is left out beside an urgent insight', () => {
    const urgent = { category: 'pest', status: 'urgent', priority: 1, headline: 'Action needed', whatWeSaw: 'Heavy scale on the ficus.' };
    expect(text(tsData([urgent], 'needs_attention'), 'tok-t1')).not.toContain(TS_NO_ISSUES);
    cleanup();
    expect(text(tsData([urgent], 'healthy'), 'tok-t2')).not.toContain(TS_NO_ISSUES);
  });

  it('is still printed on a clean tree & shrub visit', () => {
    const clear = { category: 'overall', status: 'stable', priority: 9, headline: 'Plants look steady', whatWeSaw: 'No problems seen.' };
    expect(text(tsData([clear], 'stable'), 'tok-t3')).toContain(TS_NO_ISSUES);
  });

  it('a pest report keeps its per-zone no_activity row beside activity elsewhere', () => {
    const data = lawnData({
      serviceLine: 'pest', reportV2: null,
      findings: [
        { id: 'p1', title: 'Ant activity at the exterior', category: 'pest_activity', severity: 'info', detail: 'Trails along the back slab.' },
        { id: 'p2', title: 'No entry points found', category: 'no_activity', severity: 'info', detail: 'Garage checked, nothing found.' },
      ],
    });
    expect(text(data, 'tok-p1')).toContain('No entry points found');
  });
});
