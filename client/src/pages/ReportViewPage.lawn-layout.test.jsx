// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import ServiceReportDocument from './ServiceReportDocument';
import spotOn from './__fixtures__/lawn-layout/spot-on.json';
import spotOff from './__fixtures__/lawn-layout/spot-off.json';
import granularOn from './__fixtures__/lawn-layout/granular-on.json';
import cleanOn from './__fixtures__/lawn-layout/clean-on.json';
import tree from './__fixtures__/tree-shrub-report-v2.json';

// GATE_LAWN_REPORT_LAYOUT: the live lawn report in the phone order. The payloads are saved synthetic
// lawn reports built by scripts/generate-lawn-report-layout-fixtures.js with the real server builders
// (the watering banner, the v6 copy, the lead); the "-on" files carry the key the server adds while the
// gate is live. Without the key the page is exactly what it was.

const clone = (value) => structuredClone(value);

function renderReport(payload, search = '') {
  window.history.pushState({}, '', `/report/tok${search}`);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/tok']}>
      <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
  });
  // The fixtures are a visit that finished at 10:56 AM ET on Oct 9, 2026.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T15:10:00Z'));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const waitForReport = () => screen.findByText(/This report is provided for your records/);
// The page text without its <style> blocks (their comments are not on the page).
const text = (container) => {
  const copy = container.cloneNode(true);
  copy.querySelectorAll('style').forEach((node) => node.remove());
  return copy.textContent;
};
const positions = (container, markers) => markers.map((marker) => text(container).indexOf(marker));
const count = (container, needle) => text(container).split(needle).length - 1;

describe('gate off (no lawnLayout key): the standard page', () => {
  it('keeps the timeline, the re-entry card and the watering banner above the lead, and has no layout', async () => {
    const { container } = renderReport(clone(spotOff));
    await waitForReport();
    expect(text(container)).toContain('Visit Timeline');
    expect(text(container)).toContain('Ready to Re-enter');
    expect(screen.queryByTestId('lawn-your-part')).toBeNull();
    expect(container.querySelector('.lawn-layout')).toBeNull();
    expect(screen.getByTestId('lawn-lead-region')).toBeInTheDocument();
  });

  it('a payload with the key but no lead is the standard page too', async () => {
    const payload = clone(spotOn);
    delete payload.reportV2.lead;
    const { container } = renderReport(payload);
    await waitForReport();
    expect(container.querySelector('.lawn-layout')).toBeNull();
    expect(screen.queryByTestId('lawn-your-part')).toBeNull();
  });

  it('tree & shrub and the static render never take the layout', async () => {
    const treePayload = { ...clone(tree), lawnLayout: { mowingRange: null } };
    const first = renderReport(treePayload);
    await waitForReport();
    expect(first.container.querySelector('.lawn-layout')).toBeNull();
    cleanup();
    const second = renderReport(clone(spotOn), '?mode=static');
    await waitForReport();
    expect(second.container.querySelector('.lawn-layout')).toBeNull();
    expect(screen.queryByTestId('lawn-your-part')).toBeNull();
  });
});

describe('gate on: the phone order', () => {
  it('prints the sections in the order: done, next visit, your part, what we did, photos and findings, score, what to expect, when to call, water, rate us, products', async () => {
    const { container } = renderReport(clone(spotOn));
    await waitForReport();
    const markers = [
      "Today's result", 'Your plan', 'Your part', 'What we applied today', 'Lawn photos', 'Priority findings',
      'Overall Lawn Status', 'What to expect', 'When to call us', 'Water This Week', 'Ideal range', 'How did Alex do today', 'Products Applied',
    ];
    const at = positions(container, markers);
    at.forEach((index, i) => expect(index, markers[i]).toBeGreaterThan(-1));
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('hides the timeline, the re-entry card, the Weather call block and the watering banner above the lead', async () => {
    const { container } = renderReport(clone(spotOn));
    await waitForReport();
    expect(text(container)).not.toContain('Visit Timeline');
    expect(text(container)).not.toContain('Ready to Re-enter');
    expect(screen.queryByTestId('lawn-lead-region')).toBeNull();
    const wrapper = container.querySelector('.lawn-layout');
    expect(wrapper).not.toBeNull();
    expect(wrapper.querySelector('style').textContent).toMatch(/\.lawn-layout \.hero-conditions \{ display: none; \}/);
  });

  it('Your part: the re-entry line, the watering instruction once, and the label mow hold, with no invented hold', async () => {
    const { container } = renderReport(clone(spotOn));
    await waitForReport();
    const card = screen.getByTestId('lawn-your-part');
    expect(card).toHaveTextContent('Walking on the lawn');
    expect(card).toHaveTextContent('Lawn areas ready at 4:30 PM.');
    expect(card).toHaveTextContent('Keep pets off treated turf until it is fully dry.');
    expect(card).toHaveTextContent('Skip your turf watering until today’s treatment has dried.');
    expect(card).toHaveTextContent('Mowing: hold off until Sat 11 AM');
    expect(screen.getAllByTestId('lawn-watering-banner')).toHaveLength(1);
    expect(card).not.toHaveTextContent('Nothing for you to do');
    cleanup();
    const noHold = clone(spotOn);
    delete noHold.reportV2.banner.mowHold;
    renderReport(noHold);
    await waitForReport();
    expect(screen.getByTestId('lawn-your-part')).not.toHaveTextContent(/Mowing/);
    expect(container).toBeTruthy();
  });

  it('Your part reads a frozen re-entry condition as given (no clock), beside the water-in amount and the setup link', async () => {
    renderReport(clone(granularOn));
    await waitForReport();
    const card = screen.getByTestId('lawn-your-part');
    expect(card).toHaveTextContent('Ready to walk on once today’s treatment has dried and, after you water it in, the grass is dry again');
    expect(card).toHaveTextContent('Keep people and pets off the lawn until then.');
    expect(card).toHaveTextContent('Water in today’s treatment with about ½ inch by Sat 10 AM.');
    expect(screen.getByTestId('lawn-watering-banner-setup')).toBeInTheDocument();
  });

  it('a visit with nothing for the customer to do says so in one fixed sentence', async () => {
    renderReport(clone(cleanOn));
    await waitForReport();
    const card = screen.getByTestId('lawn-your-part');
    expect(card).toHaveTextContent('Nothing for you to do after this visit.');
    expect(screen.queryByTestId('lawn-watering-banner')).toBeNull();
  });

  it('prints each fact once, and never drops a distinct instruction', async () => {
    const payload = clone(spotOn);
    const [line, second] = payload.reportV2.banner.lines;
    // a finding step that mixes the banner's own sentences with a distinct one keeps the distinct one
    payload.reportV2.insights[1].customerAction = `${line} ${second} Fix the broken head on the shaded side zone.`;
    // the paragraph's applied sentence lists only what the lead's applied sentence says
    payload.reportV2.lead.techParagraph = 'Our technician saw thin turf in the front yard. Today we applied azoxystrobin and propiconazole.';
    const { container } = renderReport(payload);
    await waitForReport();
    // the banner's own heading is the one place the instruction prints
    expect(screen.getAllByText(line)).toHaveLength(1);
    expect(text(container)).toContain('Fix the broken head on the shaded side zone.');
    expect(text(container)).not.toContain(second.replace(/\.$/, '') + '. Fix');
    // the finding's own distinct step is untouched
    expect(text(container)).toContain('Check that the sprinkler zone by the driveway reaches the edge evenly.');
    expect(screen.getByTestId('lawn-lead-tech')).toHaveTextContent('Our technician saw thin turf in the front yard.');
    expect(screen.getByTestId('lawn-lead-tech')).not.toHaveTextContent('Today we applied');
    expect(count(container, 'What we applied today')).toBe(1);
  });

  it('an applied sentence the lead does not fully say stays in the technician paragraph', async () => {
    const payload = clone(spotOn);
    payload.reportV2.lead.techParagraph = 'Today we applied a disease control product.';
    renderReport(payload);
    await waitForReport();
    expect(screen.getByTestId('lawn-lead-tech')).toHaveTextContent('Today we applied a disease control product.');
  });

  it('the Watching line that only repeats the findings is dropped', async () => {
    const payload = clone(spotOn);
    payload.reportV2.lead.watching = 'We are also keeping an eye on thin areas.';
    renderReport(payload);
    await waitForReport();
    expect(screen.queryByTestId('lawn-lead-watching')).toBeNull();
  });

  it('the score and the products start collapsed and open on a tap', async () => {
    const { container } = renderReport(clone(spotOn));
    await waitForReport();
    const details = [...container.querySelectorAll('details.lawn-layout-collapse')];
    expect(details.map((d) => d.className.includes('lawn-layout-score') || d.className.includes('lawn-layout-products'))).toEqual([true, true]);
    details.forEach((d) => expect(d.open).toBe(false));
    expect(screen.getByTestId('lawn-layout-score')).toHaveTextContent('Score details');
  });

  it('the mowing line comes from the server table row: printed with no gauge, absent with a gauge or an unlisted grass', async () => {
    renderReport(clone(granularOn));
    await waitForReport();
    expect(screen.getByTestId('lawn-mowing-line')).toHaveTextContent('Mowing height for your St. Augustine lawn: 3.5 to 4 inches.');
    cleanup();
    const unlisted = clone(granularOn);
    unlisted.lawnLayout.mowingRange = null;
    renderReport(unlisted);
    await waitForReport();
    expect(screen.queryByTestId('lawn-mowing-line')).toBeNull();
    cleanup();
    renderReport(clone(spotOn));
    await waitForReport();
    expect(screen.queryByTestId('lawn-mowing-line')).toBeNull();
    expect(screen.getByText('Ideal range')).toBeInTheDocument();
  });

  it('When to call: the fixed sentences with the office number the report already prints', async () => {
    renderReport(clone(spotOn));
    await waitForReport();
    const block = screen.getByTestId('lawn-when-to-call');
    expect(block).toHaveTextContent('Call or text us at (941) 297-5749 if the area we treated gets worse.');
    expect(block).toHaveTextContent('Call or text us if you see new damage in your lawn.');
  });

  it('the Visit Summary paragraph stays; only an applied sentence the lead says in full is left out of it', async () => {
    const { container } = renderReport(clone(spotOn));
    await waitForReport();
    expect(container.querySelector('#visit-summary')).not.toBeNull();
    expect(container.querySelector('#visit-summary')).toHaveTextContent('We visited today and treated your front, back, and side yards');
    cleanup();
    const covered = clone(spotOn);
    covered.summary = 'Today we applied azoxystrobin and propiconazole. The photos read as thin turf in the front yard.';
    renderReport(covered);
    await waitForReport();
    expect(document.querySelector('#visit-summary')).toHaveTextContent('The photos read as thin turf in the front yard.');
    expect(document.querySelector('#visit-summary')).not.toHaveTextContent('Today we applied');
    cleanup();
    const seasonal = clone(spotOn);
    seasonal.summary = 'Today we applied azoxystrobin and propiconazole, which fits the fall season.';
    renderReport(seasonal);
    await waitForReport();
    expect(document.querySelector('#visit-summary')).toHaveTextContent('which fits the fall season');
  });

  it('the lead\'s next-visit date is dropped only when Your plan prints that lawn visit', async () => {
    const { container } = renderReport(clone(spotOn));
    await waitForReport();
    expect(text(container)).toContain('Lawn Care · Fri, Oct 23');
    expect(text(container)).not.toContain('Friday, October 23');
    cleanup();
    const pestOnly = clone(spotOn);
    pestOnly.upcomingVisitsCard.visits[0].serviceType = 'Quarterly Pest Control';
    const second = renderReport(pestOnly);
    await waitForReport();
    expect(text(second.container)).toContain('Friday, October 23');
    cleanup();
    const empty = clone(spotOn);
    empty.upcomingVisitsCard = { visits: [], merged: true };
    const third = renderReport(empty);
    await waitForReport();
    expect(text(third.container)).toContain('Friday, October 23');
  });

  it('a finished re-entry keeps its pet advisory in Your part', async () => {
    const payload = clone(cleanOn);
    payload.dynamicContext.reentry.petAdvisory = 'Keep pets off treated turf until it is fully dry.';
    renderReport(payload);
    await waitForReport();
    expect(screen.getByTestId('lawn-your-part')).toHaveTextContent('Keep pets off treated turf until it is fully dry.');
    expect(screen.getByTestId('lawn-your-part')).not.toHaveTextContent('Nothing for you to do');
  });
});

describe('the PDF document', () => {
  const doc = (extra = {}) => ({
    serviceRecordId: '00000000-0000-4000-8000-000000000003',
    serviceDate: '2026-10-08T00:00:00.000Z',
    serviceDisplayName: 'Lawn Care',
    serviceLine: 'lawn',
    technicianName: 'Adam',
    customerName: 'Test Customer',
    serviceAddress: '123 Main St, Bradenton, FL 34209',
    ...extra,
  });

  it('prints the same document with or without the layout key', () => {
    const off = render(<ServiceReportDocument data={doc()} token="tok123" />).container.innerHTML;
    cleanup();
    const on = render(<ServiceReportDocument data={doc({ lawnLayout: { mowingRange: null } })} token="tok123" />).container.innerHTML;
    expect(on).toBe(off);
  });
});

describe('the shared fixtures', () => {
  it('the "-on" payloads are the "-off" payloads plus the key', () => {
    const { lawnLayout, ...rest } = clone(spotOn);
    expect(lawnLayout).toBeDefined();
    expect(rest).toEqual(clone(spotOff));
  });
});
