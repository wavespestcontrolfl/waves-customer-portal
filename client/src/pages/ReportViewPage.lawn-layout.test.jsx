// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import ServiceReportDocument from './ServiceReportDocument';
import spotOn from './__fixtures__/lawn-layout/spot-on.json';
import spotOff from './__fixtures__/lawn-layout/spot-off.json';
import granularOn from './__fixtures__/lawn-layout/granular-on.json';
import cleanOn from './__fixtures__/lawn-layout/clean-on.json';
import cleanOff from './__fixtures__/lawn-layout/clean-off.json';
import granularOff from './__fixtures__/lawn-layout/granular-off.json';
import tree from './__fixtures__/tree-shrub-report-v2.json';

// GATE_LAWN_REPORT_LAYOUT: the live lawn report in the phone order. The payloads are saved synthetic
// lawn reports built by scripts/generate-lawn-report-layout-fixtures.js with the real server builders
// (the watering banner, the v6 copy, the lead); the "-on" files carry the key the server adds while the
// gate is live. Without the key the page is exactly what it was.

const clone = (value) => structuredClone(value);

function renderReport(payload, search = '', token = 'tok') {
  window.history.pushState({}, '', `/report/${token}${search}`);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={[`/report/${token}`]}>
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
    expect(card).toHaveTextContent('Exterior ready at 11:41 AM.');
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

  it('the plan-only fallback (upcoming-visits gate off): the date prints once, in Your plan, not again under Next visit', async () => {
    const payload = clone(spotOn);
    delete payload.upcomingVisitsCard;
    payload.nextAppointment = { serviceType: 'Lawn Care', scheduledDate: '2026-10-23' };
    const { container } = renderReport(payload, '', 'tok-planonly');
    await waitForReport();
    expect(text(container)).toContain('Your next Lawn Care visit is Fri, Oct 23.');
    expect(text(container)).not.toContain('Friday, October 23');
    cleanup();
    payload.nextAppointment = { serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-23' };
    const second = renderReport(payload, '', 'tok-planonly-pest');
    await waitForReport();
    expect(text(second.container)).toContain('Friday, October 23');
  });

  it('a clean visit with no irrigation schedule on file shows the setup invitation and still says there is nothing to do', async () => {
    const payload = clone(cleanOn);
    payload.reportV2.lead.yourPart = [];
    payload.reportV2.water = { ...payload.reportV2.water, scheduleOnFile: false, irrigationInches: null, weekPlan: null, coverageWatch: false };
    const { container } = renderReport(payload, '', 'tok-cta');
    await waitForReport();
    expect(text(container)).toContain('Add your watering schedule');
    expect(screen.getByTestId('lawn-your-part')).toHaveTextContent('Nothing for you to do after this visit.');
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

describe('gate on: nothing the standard page shows is lost', () => {
  const eventNames = () => globalThis.fetch.mock.calls
    .filter(([url]) => String(url).includes('/events'))
    .map(([, init]) => JSON.parse(init.body).eventName);

  it('keeps the screened four-section technician report in the Visit Summary, whole, beside the lead\'s applied sentence', async () => {
    const payload = clone(spotOn);
    const sections = [
      { key: 'found', title: 'What we found', paragraphs: ['Thin turf along the driveway edge.'] },
      { key: 'did', title: 'What we did and why', paragraphs: ['Today we applied azoxystrobin and propiconazole to the spot.'] },
      { key: 'expect', title: 'What to expect', paragraphs: ['The edge should hold steady.'] },
      { key: 'whatsNext', title: 'What\u2019s next', paragraphs: ['We will recheck the edge.'] },
    ];
    payload.summarySource = 'technician_report';
    payload.reportSections = sections;
    payload.summary = sections.map((section) => section.paragraphs.join(' ')).join(' ');
    expect(payload.reportV2.lead.applied).toBeTruthy();
    const { container } = renderReport(payload);
    await waitForReport();
    const summary = container.querySelector('#visit-summary');
    expect(summary).not.toBeNull();
    expect(summary.querySelector('[data-report-sections]')).not.toBeNull();
    ['What we found', 'What we did and why', 'What to expect', 'What\u2019s next'].forEach((title) => expect(summary).toHaveTextContent(title));
    expect(summary).toHaveTextContent('Today we applied azoxystrobin and propiconazole to the spot.');
  });

  it('prints approved service highlights (technician photos, captions, locations) in the photos and findings group', async () => {
    const payload = clone(spotOn);
    payload.proofMoments = [{ id: 'm1', mediaUrl: 'https://example.test/edge.jpg', mediaType: 'image', tagLabel: 'Driveway edge', locationArea: 'Front yard', customerCaption: 'The thin strip before treatment.' }];
    const { container } = renderReport(payload);
    await waitForReport();
    const highlights = container.querySelector('#service-highlights');
    expect(highlights).not.toBeNull();
    expect(highlights).toHaveTextContent('Driveway edge');
    expect(highlights).toHaveTextContent('Front yard');
    expect(highlights).toHaveTextContent('The thin strip before treatment.');
    const at = (needle) => text(container).indexOf(needle);
    expect(at('Priority findings')).toBeLessThan(at('Service Highlights'));
    expect(at('Service Highlights')).toBeLessThan(at('Overall Lawn Status'));
  });

  it('records the re-entry timer view once for timed content, and not for a condition-only card', async () => {
    renderReport(clone(spotOn), '', 'tok-timed');
    await waitForReport();
    await waitFor(() => expect(eventNames()).toContain('reentry_timer_viewed'));
    expect(eventNames().filter((name) => name === 'reentry_timer_viewed')).toHaveLength(1);
    cleanup();
    renderReport(clone(granularOn), '', 'tok-condition');
    await waitForReport();
    await waitFor(() => expect(eventNames()).toContain('service_report_viewed'));
    expect(eventNames()).not.toContain('reentry_timer_viewed');
  });

  it('keeps the Poison Control note outside the collapsed products block, and labels a poison-only slot as Poison Control', async () => {
    const { container } = renderReport(clone(spotOn), '', 'tok-products');
    await waitForReport();
    const notes = [...container.querySelectorAll('[data-testid="poison-control-note"]')];
    expect(notes.some((note) => !note.closest('details'))).toBe(true);
    cleanup();
    const poisonOnly = clone(spotOn);
    poisonOnly.applications = [];
    poisonOnly.applicationMade = true;
    const second = renderReport(poisonOnly, '', 'tok-poison');
    await waitForReport();
    expect(second.container.querySelector('details.lawn-layout-products')).toBeNull();
    const section = second.container.querySelector('#poison-control');
    expect(section).not.toBeNull();
    expect(section.closest('details')).toBeNull();
    expect(section).toHaveTextContent('Poison Control');
    expect(text(second.container)).not.toContain('Products Applied');
  });

  it('prints no products block at all when the standard page prints none', async () => {
    const payload = clone(spotOn);
    payload.applications = [];
    payload.applicationMade = false;
    const { container } = renderReport(payload, '', 'tok-none');
    await waitForReport();
    expect(container.querySelector('details.lawn-layout-products')).toBeNull();
    expect(container.querySelector('#poison-control')).toBeNull();
    expect(text(container)).not.toContain('Products Applied');
  });

  it('labels the moved comparison block with the prior visit\'s day, as the lead card does', async () => {
    const payload = clone(spotOn);
    payload.reportV2.lead.sinceLast = { priorDate: '2026-10-02', lines: ['Last visit we applied a feeding.'] };
    renderReport(payload, '', 'tok-since');
    await waitForReport();
    expect(screen.getByTestId('lawn-since-last')).toHaveTextContent('Since your last visit, Oct 2');
  });

  it('drops the lead\'s date when the upcoming card (all service lines, no merge) lists that lawn visit, and keeps it when only a pest visit is listed', async () => {
    const payload = clone(spotOn);
    delete payload.planSummary;
    payload.upcomingVisitsCard = { visits: [
      { serviceType: 'Quarterly Pest Control', scheduledDate: '2026-10-20' },
      { serviceType: 'Lawn Care Treatment Program', scheduledDate: '2026-10-23' },
    ] };
    const { container } = renderReport(payload, '', 'tok-up1');
    await waitForReport();
    expect(text(container)).toContain('Your upcoming visits');
    expect(text(container)).not.toContain('Friday, October 23');
    cleanup();
    payload.upcomingVisitsCard.visits.pop();
    const second = renderReport(payload, '', 'tok-up2');
    await waitForReport();
    expect(text(second.container)).toContain('Friday, October 23');
  });

  it('re-evaluates the banner rules when the banner expires, with no refresh', async () => {
    const payload = clone(spotOn);
    const [line] = payload.reportV2.banner.lines;
    payload.reportV2.banner.expiresAt = '2026-10-09T15:10:00.001Z';
    payload.reportV2.insights[0].customerAction = line;
    const { container } = renderReport(payload, '', 'tok-expiry');
    await waitForReport();
    expect(container.querySelector('.lawn-layout-banner')).not.toBeNull();
    expect(text(container)).not.toContain(`Your next step: ${line}`);
    act(() => { vi.setSystemTime(new Date('2026-10-09T15:12:00Z')); });
    await waitFor(() => expect(container.querySelector('.lawn-layout-banner')).toBeNull(), { timeout: 3000 });
    expect(screen.getByTestId('lawn-watering-banner-ended')).toBeInTheDocument();
    expect(text(container)).toContain(`Your next step: ${line}`);
  });

  it('never claims "nothing to do" while a later section carries an instruction', async () => {
    const quiet = clone(cleanOn);
    quiet.reportV2.lead.yourPart = [];
    const first = renderReport(quiet, '', 'tok-quiet');
    await waitForReport();
    expect(screen.getByTestId('lawn-your-part')).toHaveTextContent('Nothing for you to do after this visit.');
    first.unmount();
    const withRec = clone(quiet);
    withRec.recommendations = ['Trim the hedge back from the sprinkler head by the driveway.'];
    const second = renderReport(withRec, '', 'tok-rec');
    await waitForReport();
    expect(screen.queryByTestId('lawn-your-part')).toBeNull();
    expect(text(second.container)).not.toContain('Nothing for you to do');
    expect(text(second.container)).toContain('Trim the hedge back from the sprinkler head by the driveway.');
    second.unmount();
    const withStep = clone(quiet);
    withStep.reportV2.insights = [{ priority: 1, status: 'watch', category: 'coverage', headline: 'Thin edge', whatWeSaw: 'x', customerAction: 'Check the zone by the fence.' }];
    const third = renderReport(withStep, '', 'tok-step');
    await waitForReport();
    expect(screen.queryByTestId('lawn-your-part')).toBeNull();
    expect(text(third.container)).toContain('Check the zone by the fence.');
  });
});

describe('gate on: the call block, the recorded findings and the review card tell the truth about their position', () => {
  const eventBodies = () => globalThis.fetch.mock.calls
    .filter(([url]) => String(url).includes('/events'))
    .map(([, init]) => JSON.parse(init.body));

  it('a visit with no application prints only the damage line, with the number alone; a treated visit prints both lines', async () => {
    const none = clone(spotOn);
    none.applications = [];
    none.applicationMade = false;
    renderReport(none, '', 'tok-call-none');
    await waitForReport();
    const block = screen.getByTestId('lawn-when-to-call');
    expect(block).toHaveTextContent('Call or text us if you see new damage in your lawn.');
    expect(block).not.toHaveTextContent('the area we treated');
    expect(screen.getByTestId('lawn-when-to-call-phone')).toHaveAttribute('href', 'tel:+19412975749');
    expect(screen.getByTestId('lawn-when-to-call-phone')).toHaveTextContent('(941) 297-5749');
    cleanup();
    renderReport(clone(spotOn), '', 'tok-call-treated');
    await waitForReport();
    const treated = screen.getByTestId('lawn-when-to-call');
    expect(treated).toHaveTextContent('Call or text us at (941) 297-5749 if the area we treated gets worse.');
    expect(treated).toHaveTextContent('Call or text us if you see new damage in your lawn.');
    expect(screen.queryByTestId('lawn-when-to-call-phone')).toBeNull();
  });

  it('an unknown application verdict keeps the treatment line', async () => {
    const unknown = clone(spotOn);
    unknown.applications = [];
    unknown.applicationMade = null;
    renderReport(unknown, '', 'tok-call-unknown');
    await waitForReport();
    expect(screen.getByTestId('lawn-when-to-call')).toHaveTextContent('if the area we treated gets worse');
  });

  it('prints the recorded findings list inside the labeled Visit Summary card', async () => {
    const payload = clone(spotOn);
    payload.protocol = { structuredObservations: ['Thin turf along the driveway edge'], structuredObservationsProvenance: 'completion_form_snapshot' };
    const { container } = renderReport(payload, '', 'tok-recorded');
    await waitForReport();
    const lists = [...container.querySelectorAll('ul[aria-label="Recorded lawn findings"]')];
    expect(lists).toHaveLength(1);
    expect(lists[0]).toHaveTextContent('Thin turf along the driveway edge');
    expect(lists[0].closest('#visit-summary')).not.toBeNull();
    expect(lists[0].closest('#visit-summary').querySelector('h2')).toHaveTextContent('Visit Summary');
  });

  it('the review card reports the layout\'s own placement, not "top"', async () => {
    const { container } = renderReport(clone(spotOn), '', 'tok-review-layout');
    await waitForReport();
    const card = container.querySelector('[data-section^="review-request-"]');
    expect(card.getAttribute('data-section')).toBe('review-request-lawn-layout');
    expect(card.className).toContain('review-request-card-lawn-layout');
    expect(card.className).not.toContain('review-request-card-top');
    fireEvent.click(card.querySelector('a.review-cta'));
    const click = eventBodies().find((body) => body.eventName === 'review_request_clicked');
    expect(click.metadata.placement).toBe('lawn-layout');
    cleanup();
    const standard = renderReport(clone(spotOff), '', 'tok-review-standard');
    await waitForReport();
    expect(standard.container.querySelector('[data-section="review-request-top"]')).not.toBeNull();
  });
});

describe('the re-entry timer-view event, state by state (standard card vs the lawn layout)', () => {
  // Standard ReentryReadinessCard: renders whenever a re-entry context exists and sends the event unless the
  // context is a frozen condition. Layout Your part card: sends it when it RENDERS timed readiness content
  // (a row for timed targets); the one state it differs in is "all ready, no advisory", where it renders no
  // re-entry row at all, so nothing was seen and nothing is recorded.
  const sent = async (payload, token) => {
    renderReport(payload, '', token);
    await waitForReport();
    await waitFor(() => expect(globalThis.fetch.mock.calls.some(([url]) => String(url).includes('/events'))).toBe(true));
    const names = globalThis.fetch.mock.calls.filter(([url]) => String(url).includes('/events')).map(([, init]) => JSON.parse(init.body).eventName);
    cleanup();
    return names.includes('reentry_timer_viewed');
  };
  const ready = (base, advisory) => {
    const payload = clone(base);
    if (advisory) payload.dynamicContext.reentry.petAdvisory = 'Keep pets off treated turf until it is fully dry.';
    return payload;
  };

  it('pending timer: the standard card sends it, the layout sends it', async () => {
    expect(await sent(clone(spotOff), 'tok-st-pending')).toBe(true);
    expect(await sent(clone(spotOn), 'tok-ly-pending')).toBe(true);
  });

  it('all ready WITH a pet advisory: the standard card sends it, the layout (which renders the advisory row) sends it', async () => {
    expect(await sent(ready(cleanOff, true), 'tok-st-readyadv')).toBe(true);
    expect(await sent(ready(cleanOn, true), 'tok-ly-readyadv')).toBe(true);
  });

  it('all ready WITHOUT an advisory: the standard card sends it (it renders "Ready now"), the layout does not (it renders no re-entry row)', async () => {
    expect(await sent(ready(cleanOff, false), 'tok-st-readynone')).toBe(true);
    expect(await sent(ready(cleanOn, false), 'tok-ly-readynone')).toBe(false);
  });

  it('frozen condition: neither the standard card nor the layout sends it', async () => {
    expect(await sent(clone(granularOff), 'tok-st-cond')).toBe(false);
    expect(await sent(clone(granularOn), 'tok-ly-cond')).toBe(false);
  });
});

describe('the banner dedupe follows what the banner prints, on screen and in print', () => {
  it('after expiry the repeats come back; while the page is printing the banner prints its lines again and the dedupe returns', async () => {
    const payload = clone(spotOn);
    const [line] = payload.reportV2.banner.lines;
    payload.reportV2.banner.expiresAt = '2026-10-09T15:10:00.001Z';
    payload.reportV2.insights[0].customerAction = line;
    const { container } = renderReport(payload, '', 'tok-print-expiry');
    await waitForReport();
    expect(container.querySelector('.lawn-layout-banner')).not.toBeNull();
    act(() => { vi.setSystemTime(new Date('2026-10-09T15:12:00Z')); });
    await waitFor(() => expect(container.querySelector('.lawn-layout-banner')).toBeNull(), { timeout: 3000 });
    expect(screen.getByTestId('lawn-watering-banner-ended')).toBeInTheDocument();
    expect(text(container)).toContain(`Your next step: ${line}`);
    // the browser's print pass: the banner prints its lines (not the ended note) ...
    act(() => { window.dispatchEvent(new Event('beforeprint')); });
    await waitFor(() => expect(screen.queryByTestId('lawn-watering-banner-ended')).toBeNull());
    expect(screen.getByTestId('lawn-watering-banner-heading')).toHaveTextContent(line);
    // ... and the layout drops the same instruction from the finding, so it prints once
    expect(container.querySelector('.lawn-layout-banner')).not.toBeNull();
    expect(text(container)).not.toContain(`Your next step: ${line}`);
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
