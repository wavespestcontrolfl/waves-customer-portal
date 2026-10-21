// @vitest-environment jsdom
// GATE_REPORT_WEB_SLIDER, customer side: the then-and-now slider on the simple web lawn report.
// The control must work by keyboard, touch and mouse (a native range input), mark each photo with its
// visit day, and appear only on the web view with the payload key. Synthetic data only.
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import LawnBeforeAfterSlider, { sliderDayLabel, usableSliderPairs } from './LawnBeforeAfterSlider';
import ServiceReportDocument from '../../pages/ServiceReportDocument';

afterEach(() => cleanup());

const pair = (key = 'front', label = 'Front yard') => ({
  key, label,
  before: { url: `https://signed.test/${key}-before.jpg`, date: '2026-09-20' },
  after: { url: `https://signed.test/${key}-after.jpg`, date: '2026-10-21' },
});
const SLIDER = { pairs: [pair('front', 'Front yard'), pair('back', 'Back yard')] };

describe('LawnBeforeAfterSlider', () => {
  it('shows one labelled slider per pair with both visit days and both photos', () => {
    render(<LawnBeforeAfterSlider slider={SLIDER} header={<h2>Then and now</h2>} />);
    expect(screen.getAllByTestId('lawn-slider-pair')).toHaveLength(2);
    expect(screen.getByAltText('Front yard, last visit').getAttribute('src')).toBe('https://signed.test/front-before.jpg');
    expect(screen.getByAltText('Front yard, this visit').getAttribute('src')).toBe('https://signed.test/front-after.jpg');
    const tags = Array.from(document.querySelectorAll('.lbas-tag')).map((el) => el.textContent);
    expect(tags).toEqual(['Last visitSep 20', 'This visitOct 21', 'Last visitSep 20', 'This visitOct 21']);
  });

  it('is a keyboard and touch operable range: labelled, starts at the middle, and moves the reveal', () => {
    render(<LawnBeforeAfterSlider slider={{ pairs: [pair()] }} />);
    const input = screen.getByRole('slider', { name: 'Compare the front yard at the last visit and at this visit' });
    expect(input.value).toBe('50');
    expect(input.getAttribute('aria-valuetext')).toBe('Last visit photo shown across 50 percent of the width');
    const before = screen.getByAltText('Front yard, last visit');
    expect(before.style.clipPath).toBe('inset(0 50% 0 0)');
    fireEvent.change(input, { target: { value: '80' } });
    expect(input.value).toBe('80');
    expect(input.getAttribute('aria-valuetext')).toBe('Last visit photo shown across 80 percent of the width');
    expect(before.style.clipPath).toBe('inset(0 20% 0 0)');
    fireEvent.change(input, { target: { value: '0' } });
    expect(before.style.clipPath).toBe('inset(0 100% 0 0)');
    // The control is natively focusable, never a div with handlers.
    expect(input.tagName).toBe('INPUT');
    expect(input.getAttribute('type')).toBe('range');
  });

  it('a photo that fails to load takes its pair out; the card goes when no pair is left', () => {
    render(<LawnBeforeAfterSlider slider={SLIDER} />);
    fireEvent.error(screen.getByAltText('Front yard, this visit'));
    expect(screen.getAllByTestId('lawn-slider-pair')).toHaveLength(1);
    fireEvent.error(screen.getByAltText('Back yard, last visit'));
    expect(screen.queryByTestId('lawn-slider')).toBeNull();
  });

  it('renders nothing for a missing, empty or half-built payload', () => {
    for (const slider of [undefined, null, {}, { pairs: [] }, { pairs: [{ key: 'front', label: 'Front yard', before: { url: 'x' } }] }]) {
      const { container } = render(<LawnBeforeAfterSlider slider={slider} />);
      expect(container.innerHTML).toBe('');
      cleanup();
    }
    expect(usableSliderPairs({ pairs: [pair(), { key: 'bad' }] })).toHaveLength(1);
  });

  it('reads calendar days without a timezone shift', () => {
    expect(sliderDayLabel('2026-10-01')).toBe('Oct 1');
    expect(sliderDayLabel('2026-12-31')).toBe('Dec 31');
    expect(sliderDayLabel('2026-13-01')).toBe('');
    expect(sliderDayLabel(null)).toBe('');
  });

  it('keeps every font size at or above the print floor the web zoom turns into 14px', () => {
    // check:portal-brand skips this file (it draws inside the document's zoom), so the screen floor is held here.
    const read = (rel) => fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
    const zoom = Number(read('src/pages/ServiceReportDocument.jsx').match(/\.is-web \.doc-page \{ zoom: ([\d.]+); \}/)?.[1]);
    const source = read('src/components/report/LawnBeforeAfterSlider.jsx');
    const sizes = [
      ...[...source.matchAll(/fontSize: ([\d.]+)/g)].map((m) => Number(m[1])),
      ...[...source.matchAll(/font-size:([\d.]+)px/g)].map((m) => Number(m[1])),
    ];
    expect(zoom).toBeGreaterThan(1);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...sizes) * zoom).toBeGreaterThanOrEqual(14);
  });
});

describe('the slider inside the report document', () => {
  const doc = (over = {}, web = true) => render(
    <ServiceReportDocument
      data={{
        serviceRecordId: '00000000-0000-4000-8000-000000000003',
        serviceDate: '2026-10-21T00:00:00.000Z',
        serviceDisplayName: 'Lawn Care Service',
        serviceLine: 'lawn',
        technicianName: 'Test T.',
        customerName: 'Test Customer',
        applications: [],
        zones: [],
        photos: [],
        reportV2: { snapshot: { overallScore: 86 }, lead: {} },
        ...over,
      }}
      token="tok-slider"
      web={web}
    />,
  ).container;

  it('web view with the payload key shows "Then and now" before the photos', () => {
    const c = doc({ lawnSlider: SLIDER });
    expect(c.querySelector('[data-testid="lawn-slider"]')).not.toBeNull();
    expect(c.textContent).toContain('Then and now');
  });

  it('no key, or the PDF view of the same payload: no slider', () => {
    expect(doc().querySelector('[data-testid="lawn-slider"]')).toBeNull();
    cleanup();
    expect(doc({ lawnSlider: SLIDER }, false).querySelector('[data-testid="lawn-slider"]')).toBeNull();
  });
});
