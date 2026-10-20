// @vitest-environment jsdom
// GATE_REPORT_CLEANUP_1020, client side: rate basis, the technician paragraph that adds
// nothing, photo cards that fit the photo, and the trouble-spot line. Every check runs with the
// payload key on and off: off prints exactly what the document printed before. Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import ServiceReportDocument from './ServiceReportDocument';
import { rateWithBasis, techTextBeyondSummary, isTroubleSpotPhoto } from './serviceReportCleanup';

afterEach(() => cleanup());

const SUMMARY = 'Today we applied a feeding with a weed barrier, which fits the fall season. Results build gradually.';
const app = (over = {}) => ({
  id: 'app-1',
  product: { name: 'Test Granular Feed 18-0-10', epa_reg: '1-2', active_ingredient: 'Test AI' },
  methodLabel: 'Granular broadcast',
  zone_ids: [],
  rate: '4.040',
  rateUnit: 'lb',
  areaValue: '4500',
  areaUnit: 'sqft',
  totalAmount: '18.180',
  amountUnit: 'lb',
  ...over,
});
const data = (over = {}) => ({
  serviceRecordId: '00000000-0000-4000-8000-000000000003',
  serviceDate: '2026-10-20T00:00:00.000Z',
  serviceDisplayName: 'Lawn Care Service',
  serviceLine: 'lawn',
  technicianName: 'Test T.',
  customerName: 'Test Customer',
  serviceAddress: '1 Test Way, Testville, FL 00000',
  applicationMade: true,
  typedReport: { todaysResult: { headline: SUMMARY, body: '' }, findings: [], nextStepChips: [] },
  applications: [app()],
  zones: [],
  photos: [],
  reportV2: { snapshot: { overallScore: 86, statusHeadline: 'Looking great' }, lead: {} },
  ...over,
});
const text = (d, token = 'tok-c') => render(<ServiceReportDocument data={d} token={token} />).container.textContent;

describe('rate basis (item 5)', () => {
  it('prints the basis a stored rate is per when the key is on, and the old rate when it is off', () => {
    expect(text(data({ reportCleanup: true }))).toContain('4.04 lb per 1,000 sq ft');
    cleanup();
    const off = text(data());
    expect(off).toContain('4.04 lb');
    expect(off).not.toContain('per 1,000 sq ft');
  });

  it('reads the basis out of a per-area or per-gallon unit, and prints the old rate when it does not know one', () => {
    expect(rateWithBasis({ rateUnit: 'oz/1000sf' }, '0.2')).toBe('0.2 oz per 1,000 sq ft');
    expect(rateWithBasis({ rateUnit: 'fl_oz/gal' }, '1')).toBe('1 fl oz per gal');
    expect(rateWithBasis({ rateUnit: 'lb/acre' }, '2')).toBe('2 lb per acre');
    expect(rateWithBasis({ rateUnit: 'gal', areaUnit: 'sqft' }, '1')).toBe('1 gal per 1,000 sq ft');
    expect(rateWithBasis({ rateUnit: 'ml/inch dbh' }, '3')).toBe('3 ml per inch of trunk width');
    // bare unit with no square-foot area, a count unit, an unknown basis: no guess
    expect(rateWithBasis({ rateUnit: 'oz' }, '1')).toBeNull();
    expect(rateWithBasis({ rateUnit: 'oz', areaUnit: 'linear_ft' }, '1')).toBeNull();
    expect(rateWithBasis({ rateUnit: 'each', areaUnit: 'sqft' }, '1')).toBeNull();
    expect(rateWithBasis({ rateUnit: 'oz/zzz' }, '1')).toBeNull();
    expect(rateWithBasis({ rateUnit: '' }, '1')).toBeNull();
  });

  it('keeps the old rate for a row with no known basis, key on', () => {
    const t = text(data({ reportCleanup: true, applications: [app({ areaUnit: null, areaValue: null })] }));
    expect(t).toContain('4.04 lb');
    expect(t).not.toContain('per 1,000 sq ft');
  });
});

describe('From your technician (item 6)', () => {
  const tech = 'Today we applied a feeding with a weed barrier.';
  const withTech = (extra) => data({
    ...extra,
    reportV2: { snapshot: { overallScore: 86, statusHeadline: 'Looking great' }, lead: { techParagraph: tech } },
  });

  it('is hidden when the summary already says it, key on; printed as before when off', () => {
    expect(text(withTech({ reportCleanup: true }))).not.toContain('From your technician');
    cleanup();
    expect(text(withTech({}))).toContain('From your technician');
  });

  it('prints the whole paragraph word for word when any sentence is new, key on', () => {
    const full = `${tech} The back fence line was thin.`;
    const d = data({
      reportCleanup: true,
      reportV2: { snapshot: { overallScore: 86, statusHeadline: 'Looking great' }, lead: { techParagraph: full } },
    });
    render(<ServiceReportDocument data={d} token="tok-d" />);
    expect(screen.getByText(full)).toBeInTheDocument();
    expect(document.body.textContent).toContain('From your technician');
  });

  it('compares without case, quote style, punctuation or spacing', () => {
    expect(techTextBeyondSummary('TODAY we  applied a feeding — with a weed barrier!', [SUMMARY])).toBe('');
    expect(techTextBeyondSummary('It’s new here.', ['Its new here'])).toBe('');
    expect(techTextBeyondSummary('Something else entirely.', [SUMMARY])).toBe('Something else entirely.');
    expect(techTextBeyondSummary('Today we applied a feeding with a weed barrier.   Something new.', [SUMMARY])).toBe('Today we applied a feeding with a weed barrier.   Something new.');
    expect(techTextBeyondSummary('', [SUMMARY])).toBe('');
  });
});

describe('photo cards and the trouble-spot line (items 10 and 4)', () => {
  const photos = [
    { id: 'p1', url: 'https://cdn.example.com/wide.jpg', caption: 'Front yard' },
    { id: 'p2', url: 'https://cdn.example.com/spot.jpg', caption: 'Trouble spot' },
  ];
  const NOTE = 'This is a thin patch we will recheck at your next visit.';

  it('sizes the photo to its own shape, key on; the fixed 190px frame, key off', () => {
    render(<ServiceReportDocument data={data({ reportCleanup: true, photos })} token="tok-e" />);
    const on = document.querySelector('img[src="https://cdn.example.com/wide.jpg"]');
    expect(on.style.height).toBe('auto');
    expect(on.style.maxHeight).toBe('190px');
    expect(on.style.width).toBe('100%');
    cleanup();
    render(<ServiceReportDocument data={data({ photos })} token="tok-f" />);
    const off = document.querySelector('img[src="https://cdn.example.com/wide.jpg"]');
    expect(off.style.height).toBe('190px');
  });

  it('prints the server line once under the photos when a Trouble spot photo exists, key on only', () => {
    render(<ServiceReportDocument data={data({ reportCleanup: true, photos, troubleSpotNote: NOTE })} token="tok-g" />);
    expect(screen.getAllByTestId('doc-trouble-spot-note')).toHaveLength(1);
    expect(screen.getByTestId('doc-trouble-spot-note').textContent).toBe(`Trouble spot: ${NOTE}`);
    cleanup();
    expect(text(data({ photos, troubleSpotNote: NOTE }), 'tok-h')).not.toContain(NOTE);
  });

  it('prints no line when the note is empty or there is no Trouble spot photo', () => {
    expect(text(data({ reportCleanup: true, photos, troubleSpotNote: null }), 'tok-i')).not.toContain('Trouble spot:');
    cleanup();
    expect(text(data({ reportCleanup: true, photos: [photos[0]], troubleSpotNote: NOTE }), 'tok-j')).not.toContain(NOTE);
    expect(isTroubleSpotPhoto({ caption: 'Trouble spot (front)' })).toBe(true);
    expect(isTroubleSpotPhoto({ caption: 'Front yard' })).toBe(false);
  });
});
