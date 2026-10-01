// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';
import lawnReportV2 from './__fixtures__/lawn-report-v2.json';
import mosquitoReportV2 from './__fixtures__/mosquito-report-v2.json';
import termiteReportV2 from './__fixtures__/termite-report-v2.json';
import pestReportV2 from './__fixtures__/pest-report-v2.json';
import treeShrubReportV2 from './__fixtures__/tree-shrub-report-v2.json';

// Full-render guards for the lawn service report. V2 is THE lawn report
// (owner ruling 2026-07-09, LAWN_REPORT_V2 flag retired): the server builds
// reportV2 for every lawn visit with a tech-confirmed linked assessment. The
// legacy layout (reportV2 null) survives ONLY as the fallback for historical
// tokens whose visits predate the assessment flow — those permanent SMS/email
// links must keep rendering lawn content. A regression here previously
// shipped: the early "V2 lead" block was gated on isLawnReport instead of
// isV2LeadLayout, so a legacy lawn report rendered Products Applied + Visit
// Timeline twice (and duplicated their DOM ids).

function renderReport(payload) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })),
  );
  return render(
    <MemoryRouter initialEntries={['/report/test-legacy-lawn']}>
      <Routes>
        <Route path="/report/:token" element={<ReportViewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  // jsdom in this runner ships without a usable localStorage; the page reads a
  // staff token from it on mount.
  const store = {};
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => { Object.keys(store).forEach((key) => delete store[key]); },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ReportViewPage — temporary load failures', () => {
  it('does not tell the customer a valid report is missing and offers retry', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ error: 'unavailable' }) }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/report/valid-token']}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText(/couldn.t load that service report/i)).toBeInTheDocument();
    expect(screen.queryByText(/report not found/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('ReportViewPage — recap SMS anchor (#visit-recap)', () => {
  // The recap SMS links /report/:token#visit-recap, but the card only exists
  // after /data resolves — the browser's native fragment scroll runs against
  // the loading skeleton and lands nowhere. The page re-runs the scroll in a
  // post-load effect; these tests pin that.
  let scrollSpy;

  beforeEach(() => {
    scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    window.location.hash = '#visit-recap';
  });

  afterEach(() => {
    window.location.hash = '';
    delete Element.prototype.scrollIntoView;
  });

  it('scrolls to the recap card once the report has rendered', async () => {
    renderReport({ ...legacyLawnReport, recap: { ready: true } });
    await screen.findByText('Visit Summary');

    // The anchor effect flushes after the commit findByText resolves on (then
    // re-runs on a 250ms interval) — wait on the observable scroll, not the
    // commit, or slow runners lose the race (first CI run failed exactly here).
    await waitFor(() => expect(scrollSpy).toHaveBeenCalled());
    const target = scrollSpy.mock.instances?.[0] || scrollSpy.mock.contexts?.[0];
    expect(target?.id).toBe('visit-recap');
  });

  it('stays at the top when the recap card never renders', async () => {
    renderReport(legacyLawnReport); // no recap payload → card absent
    await screen.findByText('Visit Summary');

    expect(scrollSpy).not.toHaveBeenCalled();
  });
});

describe('ReportViewPage — Lawn Report V2 (the lawn report)', () => {
  it('renders the V2 dashboard and not the legacy assessment layout', async () => {
    const { container } = renderReport(lawnReportV2);
    // Snapshot hero headline from the reportV2 payload.
    await screen.findByText('Stable — watching thin areas');

    // Legacy lawn-assessment DOM must not render alongside V2.
    expect(container.querySelector('.lawn-trend-chart')).toBeNull();
    expect(container.querySelector('.lawn-assessment-layout-no-trend')).toBeNull();
    // Shared sections still render exactly once in the V2 lead layout.
    expect(container.querySelectorAll('#products-applied')).toHaveLength(1);
    expect(container.querySelectorAll('#service-timeline')).toHaveLength(1);
  });

  it('the watering banner renders once, directly under the visit status card', async () => {
    const banner = { state: 'hold', lines: ['Skip your turf watering until Thu 3 PM.', 'That gives today’s treatment time to work.'], expiresAt: '2999-01-01T00:00:00.000Z' };
    const { container } = renderReport({ ...lawnReportV2, reportV2: { ...lawnReportV2.reportV2, banner } });
    await screen.findByText('Stable — watching thin areas');
    expect(screen.getAllByTestId('lawn-watering-banner')).toHaveLength(1);
    const status = container.querySelector('#service-status');
    const card = screen.getByTestId('lawn-watering-banner').closest('[data-glass="card"]');
    expect(status.nextElementSibling).toBe(card);
    // Same 16px rhythm as the report sections, never flush against the status card.
    expect(card.style.marginTop).toBe('16px');
  });
});

describe('ReportViewPage — Termite Report V2 (bait-station dashboard)', () => {
  it('renders the station dashboard and suppresses the generic summary, hero-owned tiles, products, and standalone map', async () => {
    const { container } = renderReport(termiteReportV2);
    // Headline from the termiteReportV2 payload — in the header status cell
    // AND the dashboard hero (the header prints the short label, never the
    // full body).
    const headlines = await screen.findAllByText('Termite activity observed at 2 stations');
    expect(headlines).toHaveLength(2);
    expect(container.querySelector('.smart-status-result').textContent).toBe('Termite activity observed at 2 stations');
    // Station checks are monitoring, not application — the work cell never
    // says "product applied".
    expect(screen.getByText('12 of 14 stations inspected · 3 stations serviced')).toBeInTheDocument();
    expect(screen.queryByText(/product applied/)).toBeNull();

    // The dashboard owns the summary slot — no legacy Visit Summary, no
    // typed Today's Result card (its required next step moves into the
    // dashboard below).
    expect(screen.queryByText('Visit Summary')).toBeNull();
    expect(container.querySelectorAll('#visit-summary')).toHaveLength(1);
    expect(container.querySelector('#todays-result')).toBeNull();
    // Station checks are monitoring, not application (owner 2026-08-29).
    expect(container.querySelector('#products-applied')).toBeNull();
    expect(screen.queryByText('Products Applied')).toBeNull();
    // Exceptions first: the activity + inaccessible stations, nothing else,
    // and no per-station "serviced" claim (servicing is a visit-level fact).
    const needsAttention = (await screen.findByText('Needs attention')).closest('section');
    // (the map legend also says "Termite activity observed" once — scope to the card)
    expect(within(needsAttention).getAllByText('Termite activity observed')).toHaveLength(2);
    expect(within(needsAttention).getAllByText('Could not be accessed this visit')).toHaveLength(2);
    expect(within(needsAttention).queryByText(/serviced today/i)).toBeNull();
    // 7 clean pins + 3 serviced pins: only the clean ones support "no activity"
    expect(within(needsAttention).getByText('7 other stations checked — no activity observed · 3 stations serviced this visit')).toBeInTheDocument();
    // Station map rides inside the dashboard exactly once.
    expect(container.querySelectorAll('#station-map')).toHaveLength(1);
    // The tech's required next-step commitment survives the typed card swap.
    const whatsNext = (await screen.findByText('What happens next')).closest('section');
    expect(within(whatsNext).getByText(/Recheck active stations sooner/)).toBeInTheDocument();
    // Typed findings the dashboard does not render still print; the
    // hero-owned count/status tiles do not.
    const typed = container.querySelector('#typed-findings');
    expect(typed).not.toBeNull();
    expect(within(typed).getByText('Station condition issues')).toBeInTheDocument();
    expect(within(typed).getByText('Activity signs observed')).toBeInTheDocument();
    expect(within(typed).queryByText('Stations checked')).toBeNull();
    expect(within(typed).queryByText('Bait consumption')).toBeNull();
    // Program card: SAME-LINE next monitoring visit + warranty line; ACTIVE
    // badge rides the bond; CTA lands on My Plan (where the bond card lives).
    const nextVisit = (await screen.findByText('Next monitoring visit')).closest('section');
    expect(within(nextVisit).getByText(/Termite Bait Station Service · Mon, Nov 16/)).toBeInTheDocument();
    expect(within(nextVisit).getByText(/Renews Mar 14, 2027/)).toBeInTheDocument();
    expect(within(nextVisit).getByText('ACTIVE')).toBeInTheDocument();
    // TermiteBondCard is mounted by the portal's DocumentsTab
    expect(within(nextVisit).getByRole('link', { name: /View termite protection plan/ })).toHaveAttribute('href', '/?tab=documents');
    // Tech's top recommendation is highlighted in "Your one move" and still
    // listed in full (as a chip) in the typed record.
    const oneMove = (await screen.findByText('Your one move')).closest('section');
    expect(within(oneMove).getByText('Pull mulch back from foundation')).toBeInTheDocument();
    expect(within(typed).getByText('Pull mulch back from foundation')).toBeInTheDocument();
  });

  it('keeps Products Applied for a real termiticide recorded on the bait visit, never for the cartridge check', async () => {
    const withFoam = JSON.parse(JSON.stringify(termiteReportV2));
    // The completion panel defaults methodless termite products to
    // station_check and persists it — identity decides, not the method.
    withFoam.applications.push({
      id: 'app-foam', method: 'station_check', methodInferred: false, totalAmount: '2', amountUnit: 'fl_oz',
      product: { name: 'Termidor Foam', category: 'termiticide', epa_reg: '7969-XXX', active_ingredient: 'Fipronil' },
    });
    const { container } = renderReport(withFoam);
    await screen.findAllByText('Termite activity observed at 2 stations');
    const products = container.querySelector('#products-applied');
    expect(products).not.toBeNull();
    expect(within(products).getAllByText(/Termidor Foam/).length).toBeGreaterThan(0);
    expect(within(products).queryByText(/Trelona/)).toBeNull();
    // the work cell names the supplemental treatment beside the station work
    expect(screen.getByText('12 of 14 stations inspected · 3 stations serviced · 1 product applied')).toBeInTheDocument();
  });

  it('carries the tech-reviewed narrative in the hero (the one summary surface)', async () => {
    const narrated = JSON.parse(JSON.stringify(termiteReportV2));
    narrated.termiteReportV2.aiSummary = { headline: null, body: 'Stations 6 and 10 showed fresh feeding; both cartridges were replaced.' };
    const { container } = renderReport(narrated);
    await screen.findAllByText('Termite activity observed at 2 stations');
    const hero = container.querySelector('#visit-summary');
    expect(within(hero).getByText(/both cartridges were replaced/)).toBeInTheDocument();
    expect(screen.queryByText('Visit Summary')).toBeNull();
    expect(container.querySelector('#todays-result')).toBeNull();
  });

  it('suppresses the standalone activity gauge and prints the cross-visit trend in the hero', async () => {
    const trending = JSON.parse(JSON.stringify(termiteReportV2));
    // production trendWord (trendWordForScores) already carries the interval
    trending.activity = { score: 4, label: 'Termite Activity', levelWord: 'high', trend: 'up', trendWord: 'increased since the last visit', isBaseline: false };
    const { container } = renderReport(trending);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(container.querySelector('#activity')).toBeNull();
    const hero = container.querySelector('#visit-summary');
    expect(within(hero).getByText('Termite activity has increased since the last visit.')).toBeInTheDocument();
    // bait condition rides the hero metrics (the typed card drops it)
    expect(within(hero).getByText('Bait condition')).toBeInTheDocument();
    expect(within(hero).getByText('Moderate feeding')).toBeInTheDocument();
  });

  it('suppresses the gauge trend when the status was reconciled away from the frozen activity select', async () => {
    const escalated = JSON.parse(JSON.stringify(termiteReportV2));
    escalated.activity = { score: 0, label: 'Termite Activity', levelWord: 'none', trend: 'stable', trendWord: 'about the same as the last visit', isBaseline: false };
    escalated.termiteReportV2.statusReconciled = true;
    const { container } = renderReport(escalated);
    await screen.findAllByText('Termite activity observed at 2 stations');
    const hero = container.querySelector('#visit-summary');
    expect(within(hero).queryByText(/about the same as the last visit/)).toBeNull();
  });

  it('the visit-history current row restates the reconciled V2 headline, not the frozen snapshot headline', async () => {
    const history = JSON.parse(JSON.stringify(termiteReportV2));
    history.typedVisitTimeline = { visits: [
      { serviceRecordId: 'prev', serviceDate: '2026-05-27', headline: 'No termite activity observed', isCurrent: false },
      { serviceRecordId: 'cur', serviceDate: '2026-08-27', headline: 'No termite activity observed', isCurrent: true },
    ] };
    const { container } = renderReport(history);
    await screen.findAllByText('Termite activity observed at 2 stations');
    const card = container.querySelector('#typed-visit-timeline');
    expect(card).not.toBeNull();
    expect(within(card).getAllByText('Termite activity observed at 2 stations')).toHaveLength(1);
    expect(within(card).getAllByText('No termite activity observed')).toHaveLength(1);
  });

  it('companion source (combined pest + termite visit): the primary keeps its cards, the bait companion block is owned by the dashboard', async () => {
    const combined = JSON.parse(JSON.stringify(termiteReportV2));
    combined.serviceLine = 'pest';
    combined.termiteReportV2.source = 'companion';
    combined.typedReport = {
      type: 'cockroach', reportTypeLabel: 'Cockroach Service', visitSequence: 1,
      todaysResult: { headline: 'Roach activity was light today.', body: 'We treated the kitchen and baths.', nextStep: 'Keep counters dry overnight.' },
      findings: [{ fieldKey: 'rooms_treated', customerLabel: 'Rooms treated', customerValueLabel: 'Kitchen, baths' }],
    };
    combined.companionReports = [{
      type: 'termite_bait_station', reportTypeLabel: 'Termite Bait Station Inspection', visitSequence: 3, internalOnly: false,
      todaysResult: { headline: 'Termite activity was high today.', body: 'Companion typed body.', nextStep: 'Recheck active stations sooner.' },
      findings: [
        { fieldKey: 'stations_checked', customerLabel: 'Stations checked', customerValueLabel: '12' },
        { fieldKey: 'station_issues', customerLabel: 'Station condition issues', customerValueLabel: 'Station obstructed' },
      ],
    }];
    // the PRIMARY (roach) gauge trends up; the bait companion's gauge is
    // baseline — the termite hero must read the companion's, never the roach's
    combined.activity = { score: 4, label: 'Roach Activity', levelWord: 'high', trend: 'up', trendWord: 'increased since the last visit', isBaseline: false };
    combined.companionReports[0].activity = { score: 1, label: 'Termite Activity', levelWord: 'low', trend: null, trendWord: null, isBaseline: true };
    // one real perimeter product + the Trelona cartridge check: the header
    // counts the product only (the section below lists the product only)
    combined.applications.push({ id: 'app-perim', method: 'perimeter_spray', totalAmount: '1', amountUnit: 'gal', product: { name: 'Demand CS', category: 'insecticide', epa_reg: '100-1066', active_ingredient: 'Lambda-cyhalothrin' } });
    const { container } = renderReport(combined);
    // dashboard mounts once, under its OWN anchor (the pest block owns #visit-summary)
    await screen.findByText('Termite activity observed at 2 stations', { selector: 'h2' });
    expect(screen.getByText(/^1 product applied/)).toBeInTheDocument();
    expect(screen.queryByText(/2 products applied/)).toBeNull();
    expect(container.querySelectorAll('#visit-summary')).toHaveLength(1);
    const hero = container.querySelector('#termite-visit-summary');
    expect(hero).not.toBeNull();
    expect(within(hero).getByText('Baseline recorded today — trend starts next visit.')).toBeInTheDocument();
    expect(within(hero).queryByText(/increased since the last visit/)).toBeNull();
    // the primary's own gauge still renders; the companion's does not
    expect(container.querySelector('#activity')).not.toBeNull();
    expect(container.querySelector('#companion-termite_bait_station-activity')).toBeNull();
    // the PRIMARY (roach) Today's Result and header status stay
    expect(container.querySelector('#todays-result')).not.toBeNull();
    expect(screen.getByText('Roach activity was light today')).toBeInTheDocument();
    expect(container.querySelector('.smart-status-result').textContent).not.toMatch(/Termite activity observed/);
    // the bait companion's typed Today's Result is replaced; its
    // non-dashboard fields still print, the hero-owned count tile does not
    expect(container.querySelector('#companion-termite_bait_station-todays-result')).toBeNull();
    expect(screen.queryByText('Termite activity was high today')).toBeNull();
    const companionFindings = container.querySelector('#companion-termite_bait_station-findings');
    expect(within(companionFindings).getByText('Station condition issues')).toBeInTheDocument();
    expect(within(companionFindings).queryByText('Stations checked')).toBeNull();
  });

  it('a next monitoring visit without a bond shows the card but no protection-plan link (nothing to view)', async () => {
    const noBond = JSON.parse(JSON.stringify(termiteReportV2));
    noBond.termiteBonds = [];
    renderReport(noBond);
    await screen.findAllByText('Termite activity observed at 2 stations');
    const card = (await screen.findByText('Next monitoring visit')).closest('section');
    expect(within(card).queryByText('ACTIVE')).toBeNull();
    expect(within(card).queryByRole('link', { name: /View termite protection plan/ })).toBeNull();
  });

  it('never labels a cross-line appointment as the next monitoring visit, and no ACTIVE badge without a bond', async () => {
    const crossLine = JSON.parse(JSON.stringify(termiteReportV2));
    // Builder scoped nextVisit to null (next appointment was another line);
    // the top-level fallback still carries the pest visit.
    crossLine.termiteReportV2.nextVisit = null;
    crossLine.nextAppointment = { scheduledDate: '2026-09-02', windowStart: '09:00', serviceType: 'Pest Control (Quarterly)' };
    crossLine.termiteBonds = [];
    renderReport(crossLine);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(screen.queryByText('Next monitoring visit')).toBeNull();
    expect(screen.queryByText('Your termite protection')).toBeNull();
    expect(screen.queryByText('ACTIVE')).toBeNull();
  });

  it('on-file pins (no status) read as not checked, never as "checked — no activity"', async () => {
    const onFile = JSON.parse(JSON.stringify(termiteReportV2));
    onFile.stationMap.stations = onFile.stationMap.stations.map((st) => ({ ...st, status: null }));
    renderReport(onFile);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(screen.getByText('14 stations on file — not checked this visit')).toBeInTheDocument();
    expect(screen.queryByText(/checked — no activity observed/)).toBeNull();
  });

  it('a checked SUBSET of the network (12 clean rows, total 14) never says "All 12 checked"', async () => {
    const subset = JSON.parse(JSON.stringify(termiteReportV2));
    subset.stationMap.stations = subset.stationMap.stations.slice(0, 12).map((st) => ({ ...st, status: 'ok' }));
    subset.stationMap.summary = { total: 14, checked: 12, activity: 0, serviced: 0, inaccessible: 0 };
    renderReport(subset);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(screen.getByText('12 stations checked — no activity observed')).toBeInTheDocument();
    expect(screen.queryByText(/All 12/)).toBeNull();
  });

  it('a partial sync (checked + on-file, no exceptions) never says "All N checked"', async () => {
    const mixed = JSON.parse(JSON.stringify(termiteReportV2));
    mixed.stationMap.stations = mixed.stationMap.stations.map((st, i) => ({ ...st, status: i < 4 ? 'ok' : null }));
    renderReport(mixed);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(screen.getByText('4 stations checked — no activity observed · 10 stations on file — not checked this visit')).toBeInTheDocument();
    expect(screen.queryByText(/All 4/)).toBeNull();
  });

  it('a non-termite program map (rodent pins) is never drawn inside the termite dashboard — but the primary rodent map still mounts on its own', async () => {
    const rodentMap = JSON.parse(JSON.stringify(termiteReportV2));
    rodentMap.stationMap.program = 'rodent';
    const { container } = renderReport(rodentMap);
    await screen.findAllByText('Termite activity observed at 2 stations');
    const maps = container.querySelectorAll('#station-map');
    expect(maps).toHaveLength(1);
    expect(container.querySelector('#visit-summary #station-map')).toBeNull();
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('a partial station sync suppresses the map and per-station rows behind an honest note', async () => {
    const partial = JSON.parse(JSON.stringify(termiteReportV2));
    partial.termiteReportV2.stationSyncPartial = true;
    const { container } = renderReport(partial);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(container.querySelector('#station-map')).toBeNull();
    expect(screen.queryByText('Needs attention')).toBeNull();
    expect(screen.queryByText(/View all stations/)).toBeNull();
    expect(screen.getByText(/did not match your technician/)).toBeInTheDocument();
  });

  it('the work cell keeps a non-numeric "Performed" serviced metric as count-neutral wording', async () => {
    const performed = JSON.parse(JSON.stringify(termiteReportV2));
    performed.termiteReportV2.metrics = performed.termiteReportV2.metrics.map((m) => (m.label === 'Stations serviced' ? { ...m, value: 'Performed' } : m));
    renderReport(performed);
    await screen.findAllByText('Termite activity observed at 2 stations');
    expect(screen.getByText('12 of 14 stations inspected · bait service performed')).toBeInTheDocument();
  });

  it('hides Needs attention on a clean visit', async () => {
    const clean = JSON.parse(JSON.stringify(termiteReportV2));
    clean.stationMap.stations = clean.stationMap.stations.map((st) => ({ ...st, status: 'ok' }));
    clean.termiteReportV2.status = { key: 'protected', tone: 'good', label: 'No termite activity observed' };
    renderReport(clean);
    await screen.findAllByText('No termite activity observed');
    expect(screen.queryByText('Needs attention')).toBeNull();
  });

  it('termite visit without the payload keeps the legacy layout', async () => {
    const { termiteReportV2: _omit, ...gatedOff } = termiteReportV2;
    renderReport(gatedOff);
    await screen.findByText('Visit Summary');
  });

  it('gated-off (legacy layout): a cartridge-only visit lists no Products Applied and counts none — same rule as the header', async () => {
    const { termiteReportV2: _omit, ...gatedOff } = JSON.parse(JSON.stringify(termiteReportV2));
    const { container } = renderReport(gatedOff);
    await screen.findByText('Visit Summary');
    expect(container.querySelector('#products-applied')).toBeNull();
    expect(screen.queryByText(/product applied/)).toBeNull();
    // Poison Control rides Products Applied — a cartridge check carries none.
    expect(container.querySelector('a[href="tel:+18002221222"]')).toBeNull();
  });
});

describe('ReportViewPage — Mosquito Report V2 (flag-gated dashboard)', () => {
  it('renders the dashboard and suppresses the legacy summary, meter, and coverage map', async () => {
    const { container } = renderReport(mosquitoReportV2);
    // Hero status from the mosquitoReportV2 payload.
    await screen.findByText('One step recommended');

    // The dashboard owns the summary slot — the legacy Visit Summary paragraph
    // must not render alongside it, and the anchor exists exactly once.
    expect(screen.queryByText('Visit Summary')).toBeNull();
    expect(container.querySelectorAll('#visit-summary')).toHaveLength(1);
    // Next step + outlook cards render. The "Where we protected" habitat
    // diagram is retired (owner 2026-08-27) — no habitat legend rows.
    expect(screen.queryByText('Where we protected')).toBeNull();
    await screen.findByText('Tip and toss standing water once a week');
    await screen.findByText('Mosquito outlook for July');
    // The hero carries the pressure reading (standalone meter suppressed);
    // the lettered coverage card STAYS for mosquito — it is the
    // where-we-treated picture now that the habitat diagram is gone.
    expect(container.querySelectorAll('#map')).toHaveLength(1);
  });

  it('mosquito visit without the payload keeps the legacy layout', async () => {
    const { mosquitoReportV2: _omit, ...gatedOff } = mosquitoReportV2;
    renderReport(gatedOff);
    await screen.findByText('Visit Summary');
  });

  it('rating submit refreshes the pressure pill from the recalculated response', async () => {
    // Insufficient reading: no score pill, rating picker only. The POST
    // returns a recalculated pestPressure the hero must surface (the
    // standalone PestPressureCard that used to own this is suppressed).
    const insufficient = JSON.parse(JSON.stringify(mosquitoReportV2));
    insufficient.mosquitoReportV2.supportingMetric = {
      kind: 'pressure', score: null, max: 5, label: null, trend: null,
      caption: 'Mosquito pressure',
      rating: { question: 'How much mosquito activity have you noticed?' },
      submittedRating: null,
    };
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (opts && opts.method === 'POST' && String(url).includes('pest-pressure/client-rating')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pestPressure: { displayScore: '2.4', maxScore: 5, label: 'Moderate', trend: 'stable' }, submittedRating: 2 }),
        };
      }
      return { ok: true, status: 200, json: async () => insufficient };
    }));
    render(
      <MemoryRouter initialEntries={['/report/test-mosquito-v2']}>
        <Routes>
          <Route path="/report/:token" element={<ReportViewPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByText('How much mosquito activity have you noticed?');
    expect(screen.queryByText('2.4')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Rating 2 of 5' }));
    await screen.findByText('Thanks — your input helps us calibrate your protection plan.');
    await screen.findByText('2.4');
    await screen.findByText(/Moderate/); // renders as "· Moderate" beside the score
  });
});

describe('ReportViewPage — typed pest reports compose Pest V2 WITH the ActivityCard', () => {
  it('omits the retired schematic even when an older payload still includes defense rows', async () => {
    renderReport({ ...pestReportV2, pestTraceOrNothing: false });
    await screen.findByText('Today’s protection status');
    expect(screen.queryByText('Where we protected')).toBeNull();
    expect(screen.queryByText('Light ant trailing noted near the garage door seal.')).toBeNull();
    expect(screen.queryByText('No active entry finding was documented.')).toBeNull();
  });

  const PEST_V2 = {
    status: { key: 'protected', label: 'Protected', tone: 'good' },
    statusSummary: 'Your property is in a strong position after this visit.',
    supportingMetric: null, // server withholds the hero pill on typed visits
    defense: null,
    primaryMove: null,
    bugFiles: [],
    aiSummary: null,
    forecast: null,
  };
  const ACTIVITY = {
    indicatorKey: 'bed_bug_activity',
    label: 'Bed Bug Activity',
    score: 1,
    maxScore: 5,
    levelWord: 'Very low activity',
    trend: 'improving',
    trendWord: 'decreased since the last visit',
    isBaseline: false,
    history: [
      { serviceRecordId: 'v1', serviceDate: '2026-06-12', score: 4, levelWord: 'High activity', isCurrent: false },
      { serviceRecordId: 'v3', serviceDate: '2026-07-10', score: 1, levelWord: 'Very low activity', isCurrent: true },
    ],
    progress: {
      baselineScore: 4, baselineLevelWord: 'High activity', baselineDate: '2026-06-12', currentScore: 1, visits: 3,
    },
  };

  function typedPestPayload(overrides = {}) {
    const payload = {
      ...legacyLawnReport,
      serviceLine: 'pest',
      serviceLineDisplay: 'Bed bug service',
      serviceDisplayName: 'Bed Bug Treatment (Follow-up)',
      typedReport: { type: 'bed_bug', todaysResult: { headline: 'Follow-up complete.' } },
      activity: ACTIVITY,
      pestReportV2: PEST_V2,
      ...overrides,
    };
    delete payload.lawnAssessment;
    delete payload.lawnProgramOverview;
    delete payload.reportV2;
    return payload;
  }

  it('renders the dashboard AND the gauge/chart/progress chip (owner ruling 2026-07-14)', async () => {
    renderReport(typedPestPayload({ conditions: { temp_f: 84, rain_24h_in: 0.18 } }));
    await screen.findByText('Today’s protection status');
    await screen.findByText('Bed Bug Activity');
    await screen.findByText(/Down from 4\/5 at your first visit \(Jun 12\)/);
    expect(screen.getByText('24 Hr Rainfall')).toBeInTheDocument();
    expect(screen.queryByText('Rain last 24 hr')).toBeNull();
  });

  it('recurring pest with Pest V2 still suppresses the standalone pressure card', async () => {
    renderReport(typedPestPayload({
      typedReport: null,
      activity: null,
      pestPressure: { displayScore: '1.4', score: 1.4, maxScore: 5, label: 'Low', showOnCustomerReport: true, enabled: true },
    }));
    await screen.findByText('Today’s protection status');
    expect(screen.queryByText('Bed Bug Activity')).toBeNull();
    expect(document.querySelector('[data-section="activity"]')).toBeNull();
  });

  // GATE_TYPED_REPORT_NARRATIVE: with Pest V2 suppressing the legacy Visit
  // Summary section, the Today's Result card is the report's one summary
  // surface — the typed narrative takes its body there, and ONLY there.
  it('typed narrative replaces the Today’s Result body when Pest V2 owns the summary slot', async () => {
    const NARRATIVE = 'Bed bug activity was very low today, and we inspected the mattress encasements and monitors installed at your last visit.';
    const TEMPLATE = 'We completed the scheduled follow-up inspection today.';
    renderReport(typedPestPayload({
      summary: NARRATIVE,
      summarySource: 'typed_narrative',
      typedReport: { type: 'bed_bug', todaysResult: { headline: 'Follow-up complete.', body: TEMPLATE } },
    }));
    await screen.findByText(NARRATIVE);
    expect(screen.queryByText(TEMPLATE)).toBeNull();
  });

  it('a fallback override that leads with the headline is de-duplicated under the h2', async () => {
    const TAIL = 'We inspected the mattress encasements and monitors installed at your last visit.';
    renderReport(typedPestPayload({
      summary: `Follow-up complete. ${TAIL}`,
      summarySource: 'typed_narrative',
      typedReport: { type: 'bed_bug', todaysResult: { headline: 'Follow-up complete.', body: 'Template body.' } },
    }));
    await screen.findByText(TAIL); // body renders WITHOUT the leading headline
    expect(screen.getAllByText(/Follow-up complete/)).toHaveLength(1); // the h2 only
  });

  it('without Pest V2 the bed-bug narrative owns the single summary surface (owner 2026-07-31)', async () => {
    const NARRATIVE = 'Bed bug activity was very low today, and we inspected the mattress encasements and monitors installed at your last visit.';
    const TEMPLATE = 'We completed the scheduled follow-up inspection today.';
    renderReport(typedPestPayload({
      pestReportV2: null,
      summary: NARRATIVE,
      summarySource: 'typed_narrative',
      typedReport: { type: 'bed_bug', todaysResult: { headline: 'Follow-up complete.', body: TEMPLATE } },
    }));
    // The narrative rides the Today's Result card as the report's ONE summary —
    // the legacy Visit Summary card and the ratified template body both yield.
    await screen.findByText(NARRATIVE);
    expect(screen.queryByText('Visit Summary')).toBeNull();
    expect(screen.queryByText(TEMPLATE)).toBeNull();
  });

  it('without Pest V2 a non-bed-bug typed narrative still renders in Visit Summary (bed-bug-only override)', async () => {
    const NARRATIVE = 'Roach activity was very low today, and we serviced the monitors placed at your last visit.';
    const TEMPLATE = 'We completed the scheduled follow-up inspection today.';
    renderReport(typedPestPayload({
      pestReportV2: null,
      summary: NARRATIVE,
      summarySource: 'typed_narrative',
      typedReport: { type: 'cockroach', todaysResult: { headline: 'Follow-up complete.', body: TEMPLATE } },
    }));
    await screen.findByText('Visit Summary');
    await screen.findByText(NARRATIVE);
    await screen.findByText(TEMPLATE); // the card keeps its ratified copy
  });

  // Accepted technician-report copy on a non-V2 layout: the snapshot bakes
  // the prose into the Today's Result body (bodySource stamped) AND report-data
  // promotes the same prose to data.summary — the legacy Visit Summary must
  // fall back to its deterministic framing line, not repeat the paragraph
  // (codex r69 #3420).
  it('without Pest V2 an accepted technician report renders once — Visit Summary keeps the framing line', async () => {
    const PROSE = 'We completed the palm injection treatment today and treated all four palms along the drive.';
    renderReport(typedPestPayload({
      pestReportV2: null,
      summary: PROSE,
      summarySource: 'technician_report',
      typedReport: {
        type: 'palm_injection',
        todaysResult: {
          headline: 'Palm Injection Treatment completed today',
          body: `${PROSE} Continue watering as usual.`,
          bodySource: 'technician_report',
        },
      },
    }));
    await screen.findByText('Visit Summary');
    expect(screen.getAllByText(new RegExp(PROSE.slice(0, 40)))).toHaveLength(1); // the card only
    // neutral framing on the dedup path — never the recurring-service line
    // for a one-time specialty visit (codex r86 #3420)
    await screen.findByText('Today’s service is complete.');
    expect(screen.queryByText('Your routine service is complete.')).toBeNull();
  });

  it('a companion-carried technician report suppresses the promoted summary the same way', async () => {
    const PROSE = 'Termite bait stations were serviced today and two cartridges were replaced.';
    renderReport(typedPestPayload({
      pestReportV2: null,
      typedReport: null,
      activity: null,
      summary: PROSE,
      summarySource: 'technician_report',
      companionReports: [{
        type: 'termite_bait_station',
        reportTypeLabel: 'Termite Bait Station Service',
        todaysResult: {
          headline: 'Bait station service completed today',
          body: `${PROSE} We will recheck at your next visit.`,
          bodySource: 'technician_report',
        },
      }],
    }));
    await screen.findByText('Visit Summary');
    expect(screen.getAllByText(new RegExp(PROSE.slice(0, 40)))).toHaveLength(1); // the companion card only
    await screen.findByText('Today’s service is complete.');
  });

  it('the companion card shows the sections and opens "What’s next" with the live visit', async () => {
    const sections = [
      { key: 'whatWeFound', title: 'What we found', paragraphs: ['Station 7 had live termites.'] },
      { key: 'whatWeDid', title: 'What we did and why', paragraphs: ['We replaced the bait in station 7.'] },
      { key: 'whatToExpect', title: 'What to expect', paragraphs: ['Termite bait works slowly on purpose.'] },
      { key: 'whatsNext', title: 'What’s next', paragraphs: ['Mud tubes on walls are worth telling us about.'] },
    ];
    const body = sections.map((section) => section.paragraphs.join(' ')).join(' ');
    renderReport(typedPestPayload({
      pestReportV2: null,
      typedReport: null,
      activity: null,
      summary: body,
      summarySource: 'technician_report',
      reportSections: sections,
      nextSameServiceAppointment: { serviceType: 'Quarterly Pest Control', scheduledDate: '2026-12-09', windowStart: '09:00:00' },
      companionReports: [{
        type: 'termite_bait_station',
        reportTypeLabel: 'Termite Bait Station Service',
        todaysResult: { headline: 'Bait station service completed today', body, bodySource: 'technician_report' },
      }],
    }));
    expect(await screen.findByText('What we did and why')).toBeInTheDocument();
    expect(screen.getByText(/^Next visit: Quarterly Pest Control · /)).toBeInTheDocument();
  });
});

describe('ReportViewPage — trapping station map card (program labels)', () => {
  it('renders the trap map with capture labels for program "trapping"', async () => {
    const payload = {
      ...legacyLawnReport,
      serviceLine: 'rodent',
      serviceLineDisplay: 'Rodent control',
      serviceDisplayName: 'Rodent Trapping Visit',
      stationMap: {
        available: true,
        program: 'trapping',
        image: { url: 'https://example.test/satellite.png', width: 640, height: 340 },
        summary: { total: 2, checked: 2, activity: 1, serviced: 0, inaccessible: 0 },
        stations: [
          { id: 'st-tr1', number: 1, cx: 0.3, cy: 0.4, status: 'activity' },
          { id: 'st-tr2', number: 2, cx: 0.6, cy: 0.5, status: 'ok' },
        ],
      },
    };
    delete payload.lawnAssessment;
    delete payload.lawnProgramOverview;
    delete payload.reportV2;
    renderReport(payload);
    await screen.findByText('Rodent trap map');
    // trapping legend labels (presentation-only relabels of the shared
    // enum) — each appears in the pin's SVG title AND its legend row
    expect((await screen.findAllByText(/Capture recorded/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/Checked — no capture/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/termite activity/i)).toBeNull();
    expect(screen.queryByText(/consumption/i)).toBeNull();
    // numbers-only summary discipline with the trapping counter
    await screen.findByText(/1 with captures recorded/);
  });
});

describe('ReportViewPage — legacy lawn fallback (historical tokens, reportV2 null)', () => {
  it('renders Products Applied and Visit Timeline exactly once', async () => {
    const { container } = renderReport(legacyLawnReport);
    await screen.findByText('Visit Summary');

    expect(container.querySelectorAll('#products-applied')).toHaveLength(1);
    expect(container.querySelectorAll('#service-timeline')).toHaveLength(1);
    // The Visit Timeline now renders directly under Re-entry (owner ask
    // 2026-07-05), so #map only exists when the coverage card itself shows —
    // and lawn reports hide the per-area coverage map.
    expect(container.querySelectorAll('#map')).toHaveLength(0);
  });

  it('ends Products Applied with a tappable Poison Control line', async () => {
    const { container } = renderReport(legacyLawnReport);
    await screen.findByText('Visit Summary');

    const products = container.querySelector('#products-applied');
    const note = within(products).getByTestId('poison-control-note');
    const link = within(note).getByRole('link', { name: '1-800-222-1222' });
    expect(link).toHaveAttribute('href', 'tel:+18002221222');
    expect(note.textContent).toMatch(/names each product applied/);
    expect(container.querySelectorAll('a[href="tel:+18002221222"]')).toHaveLength(1);
    // the fixture carries no applicator number, so no applicator line
    expect(note.textContent).not.toMatch(/FDACS ID/);
  });

  it('prints the applicator FDACS ID card number in the Poison Control note', async () => {
    const { container } = renderReport({ ...legacyLawnReport, applicatorFdacsId: 'JE000001' });
    await screen.findByText('Visit Summary');
    const note = within(container.querySelector('#products-applied')).getByTestId('poison-control-note');
    expect(note.textContent).toMatch(/FDACS ID card #JE000001/);
  });

  // GATE_REPORT_PRODUCT_COPY (owner-approved 2026-09-28): the server omits
  // `product.report_copy` entirely when the gate is off or the product has
  // no approved wording — the client renders purely off that key's presence,
  // so these two payloads stand in for gate-off and gate-on.
  it('renders "How it works" / "On the label" / "Pets & kids" when the server includes report_copy', async () => {
    const withCopy = JSON.parse(JSON.stringify(legacyLawnReport));
    withCopy.applications[0].product.name = 'Taurus SC';
    withCopy.applications[0].product.report_copy = {
      how_it_works: 'Pests can’t detect it, so they walk right through the treated band.',
      // Owner ruling 2026-09-29: a rounded count + city sentence, not a
      // named pest list.
      also_labeled_for: 'Labeled for 25+ Bradenton pests',
      pets_kids: 'Keep people and pets off treated areas until the spray has dried.',
    };
    const { container } = renderReport(withCopy);
    await screen.findByText('Visit Summary');
    const card = within(container.querySelector('#products-applied')).getByRole('heading', { name: 'Taurus SC' }).closest('.applied-product-card');
    expect(within(card).getByText('How it works')).toBeInTheDocument();
    expect(within(card).getByText(/walk right through the treated band/)).toBeInTheDocument();
    expect(within(card).getByText('On the label')).toBeInTheDocument();
    expect(within(card).getByText('Labeled for 25+ Bradenton pests')).toBeInTheDocument();
    expect(within(card).getByText('Pets & kids')).toBeInTheDocument();
    expect(within(card).getByText(/Keep people and pets off treated areas/)).toBeInTheDocument();
  });

  it('never renders "On the label" when report_copy carries no also_labeled_for key (narrow products / the LESCO ruling), and renders nothing when report_copy is absent', async () => {
    const lescoCopy = JSON.parse(JSON.stringify(legacyLawnReport));
    lescoCopy.applications[0].product.name = 'LESCO 90/10 Nonionic Surfactant';
    lescoCopy.applications[0].product.report_copy = {
      how_it_works: 'A spreader added to the spray so it covers evenly and sticks to surfaces.',
      pets_kids: 'Follows the spray it’s mixed into.',
    };
    const { container } = renderReport(lescoCopy);
    await screen.findByText('Visit Summary');
    const lescoCard = within(container.querySelector('#products-applied')).getByRole('heading', { name: 'LESCO 90/10 Nonionic Surfactant' }).closest('.applied-product-card');
    expect(within(lescoCard).getByText('How it works')).toBeInTheDocument();
    expect(within(lescoCard).queryByText('On the label')).toBeNull();
    expect(within(lescoCard).getByText('Pets & kids')).toBeInTheDocument();

    // Base fixture (no report_copy on any application) — gate-off shape.
    const { container: plainContainer } = renderReport(legacyLawnReport);
    await screen.findByText('Visit Summary');
    const plainProducts = plainContainer.querySelector('#products-applied');
    expect(within(plainProducts).queryByText('How it works')).toBeNull();
    expect(within(plainProducts).queryByText('On the label')).toBeNull();
    expect(within(plainProducts).queryByText('Pets & kids')).toBeNull();
  });

  it('a bait-station check or an unknown verdict gets Poison Control but names no applicator', async () => {
    const rodentBait = { id: 'rb-2', method: 'station_check', product: { name: 'Protecta Rodent Bait Station' } };
    for (const payload of [
      { ...legacyLawnReport, applications: [rodentBait], applicationMade: false, applicatorFdacsId: 'JE000001' },
      { ...legacyLawnReport, applications: [], applicationMade: null, applicatorFdacsId: 'JE000001' },
    ]) {
      const { container, unmount } = renderReport(payload);
      await screen.findByText('Visit Summary');
      const section = container.querySelector('#poison-control');
      expect(section).not.toBeNull();
      expect(section.textContent).not.toMatch(/FDACS ID/);
      unmount();
    }
  });

  it('a productless treatment or rodent bait visit gets Poison Control on its own', async () => {
    const rodentBait = { id: 'rb-1', method: 'station_check', product: { name: 'Protecta Rodent Bait Station' } };
    for (const payload of [
      { ...legacyLawnReport, applications: [], applicationMade: true },
      { ...legacyLawnReport, applications: [rodentBait], applicationMade: false },
    ]) {
      const { container, unmount } = renderReport(payload);
      await screen.findByText('Visit Summary');
      expect(container.querySelector('#products-applied')).toBeNull();
      const section = container.querySelector('#poison-control');
      expect(section).not.toBeNull();
      expect(within(section).getByRole('link', { name: '1-800-222-1222' })).toHaveAttribute('href', 'tel:+18002221222');
      expect(section.textContent).not.toMatch(/names each product/);
      unmount();
    }
  });

  // Owner ask 2026-09-28: legacy (pre-v1) reports link to the Products &
  // Safety page too. They render LegacyReport, which never mounts the v1 footer.
  it('links legacy reports to the Products & Safety page', async () => {
    renderReport({ ...legacyLawnReport, reportVersion: undefined });
    const link = await screen.findByRole('link', { name: /see every product we use and our safety protocol/i });
    expect(link).toHaveAttribute('href', 'https://www.wavespestcontrol.com/products-and-safety/#safety-protocol');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: /download pdf/i })).toBeInTheDocument();
  });

  // Owner ask 2026-09-28: every report links to the portal login and the
  // public Products & Safety page. The safety link sits in the footer, so a
  // visit that applied nothing carries it too.
  it.each([
    ['with products applied', legacyLawnReport],
    ['with nothing applied', { ...legacyLawnReport, applications: [], applicationMade: false }],
  ])('links to the portal login and the Products & Safety page (%s)', async (_label, report) => {
    const { container } = renderReport(report);
    await screen.findByText('Visit Summary');

    expect(screen.getByRole('link', { name: /portal login/i })).toHaveAttribute('href', '/login');
    const footer = container.querySelector('footer.sr-footer');
    const safetyLink = within(footer).getByRole('link', { name: /see every product we use and our safety protocol/i });
    expect(safetyLink).toHaveAttribute('href', 'https://www.wavespestcontrol.com/products-and-safety/#safety-protocol');
    expect(safetyLink).toHaveAttribute('target', '_blank');
    expect(safetyLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('omits the lawn trend chart on a first assessment (single data point)', async () => {
    // Fixture trend has one entry — nothing to trend yet.
    const { container } = renderReport(legacyLawnReport);
    await screen.findByText('Visit Summary');

    expect(container.querySelector('.lawn-trend-chart')).toBeNull();
    expect(container.querySelector('.lawn-assessment-layout-no-trend')).not.toBeNull();
  });

  it('shows the lawn trend chart once two or more assessments exist', async () => {
    const twoPoint = {
      ...legacyLawnReport,
      lawnAssessment: {
        ...legacyLawnReport.lawnAssessment,
        trend: [
          { date: '2026-05-25T00:00:00.000Z', overallScore: 72 },
          { date: '2026-06-25T00:00:00.000Z', overallScore: 80 },
        ],
      },
    };
    const { container } = renderReport(twoPoint);
    await screen.findByText('Visit Summary');

    expect(container.querySelector('.lawn-trend-chart')).not.toBeNull();
    expect(container.querySelector('.lawn-assessment-layout-no-trend')).toBeNull();
  });
});

describe('ReportViewPage — staff-view event suppression tracks the CURRENT load', () => {
  // The suppression set is a module global and used to be append-only, so a
  // staff read poisoned the token for the rest of the SPA session. That is not
  // only an analytics gap: submitReportEvent short-circuits to a FAKE
  // { ok: true }, so the cross-sell CTA would render "Request received" while
  // writing no service_requests row — a lead silently dropped. These two run in
  // order on purpose; the second depends on the first having marked the token.
  const TOKEN = 'staff-then-customer-token';

  function renderToken(payload, { staffToken = null } = {}) {
    if (staffToken) localStorage.setItem('waves_admin_token', staffToken);
    else localStorage.removeItem('waves_admin_token');
    const posts = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(init.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      return { ok: true, status: 200, json: async () => payload };
    }));
    render(
      <MemoryRouter initialEntries={[`/report/${TOKEN}`]}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    return posts;
  }

  it('posts no events while staff is viewing', async () => {
    const posts = renderToken({ ...legacyLawnReport, staffViewer: true }, { staffToken: 'admin-jwt' });
    await screen.findByText('Visit Summary');

    await waitFor(() => expect(screen.queryByText('Visit Summary')).toBeInTheDocument());
    expect(posts).toHaveLength(0);
  });

  it('resumes posting when the same token is later loaded without staff auth', async () => {
    // Same browser, same SPA session, admin JWT gone — the payload comes back
    // with no staffViewer field at all (the server omits it for customers).
    const posts = renderToken(legacyLawnReport);
    await screen.findByText('Visit Summary');

    await waitFor(() => expect(posts.length).toBeGreaterThan(0));
    expect(posts.map((p) => p.body.eventName)).toContain('service_report_viewed');
    expect(posts[0].url).toContain(`/reports/${TOKEN}/events`);
  });

  it('a superseded staff response cannot re-suppress the load that replaced it', async () => {
    // The same bug arriving from behind: an authenticated fetch still in
    // flight when the reader navigates away, loses the JWT, and reopens the
    // token. It resolves LAST and — mutating a module global that outlives its
    // own mount — would put the suppression back on the CURRENT customer view.
    const RACE_TOKEN = 'stale-staff-response-token';
    let releaseStaff;
    const staffInFlight = new Promise((resolve) => { releaseStaff = resolve; });
    const posts = [];
    const fetchImpl = vi.fn(async (url, init) => {
      if (init && init.method === 'POST') {
        posts.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      // The staff load is the one holding an Authorization header.
      if (init && init.headers && init.headers.Authorization) {
        await staffInFlight;
        return { ok: true, status: 200, json: async () => ({ ...legacyLawnReport, staffViewer: true }) };
      }
      return { ok: true, status: 200, json: async () => legacyLawnReport };
    });
    vi.stubGlobal('fetch', fetchImpl);

    // 1. Staff opens the token; the /data fetch never settles yet.
    localStorage.setItem('waves_admin_token', 'admin-jwt');
    const staffMount = render(
      <MemoryRouter initialEntries={[`/report/${RACE_TOKEN}`]}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );

    // 2. They navigate away (effect cancelled) and the admin JWT goes.
    staffMount.unmount();
    localStorage.removeItem('waves_admin_token');

    // 3. The same token is reopened as a customer and resolves normally.
    render(
      <MemoryRouter initialEntries={[`/report/${RACE_TOKEN}`]}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findByText('Visit Summary');
    await waitFor(() => expect(posts.length).toBeGreaterThan(0));

    // 4. Only now does the abandoned staff read come back.
    releaseStaff();
    await staffInFlight;
    await waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    // 5. The live customer view must still record interactions. Share is the
    //    always-rendered tracked control in the action bar.
    const before = posts.length;
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: async () => {} } });
    fireEvent.click(screen.getByRole('button', { name: /share/i }));

    await waitFor(() => expect(posts.length).toBeGreaterThan(before));
    expect(posts.map((p) => p.eventName)).toContain('share_link_copied');
  });
});

describe('ReportViewPage — conversion cards (owner-dictated copy 2026-08-13)', () => {
  const CARD_TOKEN = 'conversion-cards-token';
  const payload = {
    ...legacyLawnReport,
    customerName: 'Casey Placeholder',
    technicianName: 'Adam',
    cityState: 'Parrish, FL',
    crossSell: {
      serviceKey: 'pest_control',
      label: 'Pest Control',
      mode: 'priced',
      relationship: 'start',
      option: { id: 'pest-quarterly', label: 'Quarterly', cadence: '4 visits per year', perVisit: 114, waveguardTier: 'silver' },
      fingerprint: 'fp-demo',
    },
    referral: { headline: 'Know someone who could use Waves?', cta: 'Send My Referral Link' },
  };

  function mountWithFetch(fetchImpl) {
    vi.stubGlobal('fetch', fetchImpl);
    return render(
      <MemoryRouter initialEntries={[`/report/${CARD_TOKEN}`]}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
  }

  const dataOnlyFetch = () => vi.fn(async (url, init) => {
    if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, status: 200, json: async () => payload };
  });

  it('renders the cross-sell as a price-free estimate request', async () => {
    const { container } = mountWithFetch(dataOnlyFetch());
    expect(await screen.findByRole('button', { name: 'Request an Estimate' })).toBeInTheDocument();
    expect(screen.getByText('Know someone who could use Waves?')).toBeInTheDocument();
    const crossSellCard = container.querySelector('[data-section="cross-sell"]');
    expect(crossSellCard.querySelector('h3')).toBeNull();
    expect(crossSellCard.textContent).not.toContain('$114');
    // Cut copy stays cut: no eyebrows, no cadence line, no fine print.
    expect(screen.queryByText(/Complete your protection/i)).toBeNull();
    expect(screen.queryByText(/applications a year/i)).toBeNull();
    expect(screen.queryByText(/No charge today/i)).toBeNull();
    // Headline-and-button-only ruling: no tier chip either, even when the
    // priced option carries a WaveGuard tier. (Class-scoped: "WaveGuard"
    // legitimately appears elsewhere on the report chrome.)
    expect(container.querySelector('.cross-sell-chip')).toBeNull();
    expect(container.querySelector('[data-section="cross-sell"]').textContent).not.toMatch(/WaveGuard/i);
  });

  it('the review ask names the technician and the customer (pest reports mount the top card)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ ...pestReportV2, customerName: 'Casey Placeholder', technicianName: 'Adam' }),
      };
    }));
    render(
      <MemoryRouter initialEntries={[`/report/${CARD_TOKEN}-review`]}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText('How did Adam do today, Casey?')).toBeInTheDocument();
    expect(screen.getByText('Rate today’s visit')).toBeInTheDocument();
  });

  it('a priced tap whose response carries estimateUrl redirects into the estimate page (click-to-estimate)', async () => {
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Reflect.deleteProperty(window, 'location');
    window.location = { ...originalLocation, assign: assignSpy, reload: vi.fn() };
    try {
      // The REAL server-composed value (uncapped audit r4 P1): the mint
      // returns a RELATIVE /estimate/:token path, which resolves against
      // the browser's actual origin — prod, preview, and dev all redirect
      // on their own host.
      const serverComposedUrl = '/estimate/tok-abc';
      mountWithFetch(vi.fn(async (url, init) => {
        if (init && init.method === 'POST') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, estimateUrl: serverComposedUrl }),
          };
        }
        return { ok: true, status: 200, json: async () => payload };
      }));
      fireEvent.click(await screen.findByRole('button', { name: 'Request an Estimate' }));
      await waitFor(() => expect(assignSpy).toHaveBeenCalledWith(`${window.location.origin}/estimate/tok-abc`));
      // The recorded-request confirmation renders BEHIND the navigation, so
      // a blocked redirect still shows durable-state copy, never a dead card.
      expect(screen.getByText(/Request received/)).toBeInTheDocument();
    } finally {
      window.location = originalLocation;
    }
  });

  it('a confirmation with NO estimateUrl (gate off / quote tap) never navigates', async () => {
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Reflect.deleteProperty(window, 'location');
    window.location = { ...originalLocation, assign: assignSpy, reload: vi.fn() };
    try {
      mountWithFetch(dataOnlyFetch());
      fireEvent.click(await screen.findByRole('button', { name: 'Request an Estimate' }));
      expect(await screen.findByText(/Request received/)).toBeInTheDocument();
      expect(assignSpy).not.toHaveBeenCalled();
    } finally {
      window.location = originalLocation;
    }
  });

  it('a non-portal estimateUrl never navigates (same-origin guard on a server-composed value)', async () => {
    const assignSpy = vi.fn();
    const originalLocation = window.location;
    Reflect.deleteProperty(window, 'location');
    window.location = { ...originalLocation, assign: assignSpy, reload: vi.fn() };
    try {
      mountWithFetch(vi.fn(async (url, init) => {
        if (init && init.method === 'POST') {
          return { ok: true, status: 200, json: async () => ({ ok: true, estimateUrl: 'https://evil.example.com/estimate/x' }) };
        }
        return { ok: true, status: 200, json: async () => payload };
      }));
      fireEvent.click(await screen.findByRole('button', { name: 'Request an Estimate' }));
      expect(await screen.findByText(/Request received/)).toBeInTheDocument();
      expect(assignSpy).not.toHaveBeenCalled();
    } finally {
      window.location = originalLocation;
    }
  });

  it('referral tap fetches the link on the TAP and reveals code + prefilled Text/Email', async () => {
    const calls = [];
    mountWithFetch(vi.fn(async (url, init) => {
      const u = String(url);
      if (u.includes('/referral-link')) {
        calls.push(u);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            code: 'WAVES-TEST01',
            link: 'https://wavespestcontrol.com/r/WAVES-TEST01',
            smsBody: 'sms body WAVES-TEST01',
            emailSubject: 'subject',
            emailBody: 'email body',
          }),
        };
      }
      if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => payload };
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send My Referral Link' }));
    expect(await screen.findByText('WAVES-TEST01')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    const text = screen.getByRole('link', { name: 'Text it' });
    const email = screen.getByRole('link', { name: 'Email it' });
    expect(text.getAttribute('href')).toBe(`sms:?&body=${encodeURIComponent('sms body WAVES-TEST01')}`);
    expect(email.getAttribute('href')).toContain('mailto:?subject=subject');
  });

  it('a failed referral-link fetch shows the retry line, never a fake module', async () => {
    mountWithFetch(vi.fn(async (url, init) => {
      if (String(url).includes('/referral-link')) return { ok: false, status: 503, json: async () => ({}) };
      if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => payload };
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send My Referral Link' }));
    expect(await screen.findByText(/didn.t go through/i)).toBeInTheDocument();
    expect(screen.queryByText(/WAVES-/)).toBeNull();
  });

  it('staff view never fetches the referral link — a QA tap must not enroll the customer', async () => {
    localStorage.setItem('waves_admin_token', 'admin-jwt');
    const referralCalls = [];
    mountWithFetch(vi.fn(async (url, init) => {
      if (String(url).includes('/referral-link')) { referralCalls.push(url); }
      if (init && init.method === 'POST') return { ok: true, status: 200, json: async () => ({ ok: true }) };
      return { ok: true, status: 200, json: async () => ({ ...payload, staffViewer: true }) };
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Send My Referral Link' }));
    expect(await screen.findByText(/Staff view/)).toBeInTheDocument();
    expect(referralCalls).toHaveLength(0);
    localStorage.removeItem('waves_admin_token');
  });
});


describe('Governed routine observations without generated report copy', () => {
  it.each([
    ['pest dashboard', pestReportV2, 'Live pest activity was visible in an inspected exterior area.', false],
    ['legacy pest summary', pestReportV2, 'Live pest activity was visible in an inspected exterior area.', true],
    ['tree dashboard', treeShrubReportV2, 'Yellow foliage was visible; the cause was not confirmed.', false],
  ])('renders exact governed observations once in the %s', async (_name, fixture, observation, legacy) => {
    const payload = structuredClone(fixture);
    payload.summary = 'The recorded visit details are available below.';
    payload.summarySource = 'deterministic';
    if (payload.pestReportV2) payload.pestReportV2.aiSummary = null;
    if (legacy) payload.pestReportV2 = null;
    payload.protocol = {
      structuredObservations: [observation, observation, 'Internal custom technician note.', 'Thin turf was visible in the inspected area.'],
    };

    renderReport(payload);

    const finding = await screen.findByText(observation);
    expect(document.getElementById('visit-summary')).toContainElement(finding);
    expect(screen.getAllByText(observation)).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Internal custom technician note.');
    expect(document.body.textContent).not.toContain('Thin turf was visible in the inspected area.');
  });

  it('renders a frozen governed label only when the server marks the completion snapshot safe', async () => {
    const frozenLabel = 'Historic inspected-soil label retained from the completed visit.';
    const privateNote = 'Private gate and access note from the technician.';
    const payload = structuredClone(treeShrubReportV2);
    payload.summary = 'The recorded visit details are available below.';
    payload.summarySource = 'deterministic';
    payload.protocol = {
      observations: [privateNote],
      structuredObservations: [frozenLabel, frozenLabel],
      structuredObservationsProvenance: 'completion_form_snapshot',
    };

    renderReport(payload);

    const finding = await screen.findByText(frozenLabel);
    expect(document.getElementById('visit-summary')).toContainElement(finding);
    expect(screen.getAllByText(frozenLabel)).toHaveLength(1);
    expect(document.body.textContent).not.toContain(privateNote);
  });

  it('does not trust a historical label without the exact server provenance marker', async () => {
    const unprovenLabel = 'Historic label from an unproven payload.';
    const payload = structuredClone(treeShrubReportV2);
    payload.summary = 'The recorded visit details are available below.';
    payload.summarySource = 'deterministic';
    payload.protocol = {
      observations: ['Private technician observation.'],
      structuredObservations: [unprovenLabel],
      structuredObservationsProvenance: 'raw_observations',
    };

    renderReport(payload);

    await screen.findByText('Visit Summary');
    expect(document.body.textContent).not.toContain(unprovenLabel);
    expect(document.body.textContent).not.toContain('Private technician observation.');
  });
});

describe('Consolidated lawn report', () => {
  it('keeps the lawn summary once and omits the separate inspection card', async () => {
    const payload = structuredClone(lawnReportV2);
    payload.reportV2.photoSummary = 'Lawn health is up 2 points since your first assessment.';
    payload.protocol = {
      structuredObservations: [
        'Leaf spotting consistent with gray leaf spot was observed. Location: Back yard.',
        'Thin turf was visible in the inspected area.',
        'Unreviewed raw technician note',
      ],
      actions: ['Tested irrigation coverage'],
    };
    renderReport(payload);
    await waitFor(() => expect(document.getElementById('visit-summary')?.textContent).toContain(payload.reportV2.photoSummary));
    const text = document.body.textContent;
    expect(text.split(payload.reportV2.photoSummary)).toHaveLength(2);
    expect(document.getElementById('lawn-field-findings')).toBeNull();
    expect(screen.getAllByText(payload.protocol.structuredObservations[0])).toHaveLength(1);
    expect(document.getElementById('visit-summary')).toContainElement(screen.getByText(payload.protocol.structuredObservations[0]));
    expect(document.getElementById('visit-summary')).toContainElement(screen.getByText(payload.protocol.structuredObservations[1]));
    expect(text).not.toContain('Unreviewed raw technician note');
    expect(text).not.toContain('Lawn Health Documentation');
    expect(text).not.toContain("Why these products were selected for today's service.");
  });

  it('keeps a callback summary for governed catalog findings and hides custom text', async () => {
    const payload = structuredClone(legacyLawnReport);
    payload.isCallback = true;
    payload.reserviceGateOn = true;
    payload.summarySource = 'technician_report';
    payload.typedReport = { todaysResult: { bodySource: 'technician_report' } };
    payload.lawnAssessment = null;
    payload.protocol = {
      structuredObservations: [
        'Standing water was visible in the lawn.',
        'Internal callback note that is not customer-safe.',
      ],
    };

    renderReport(payload);

    const finding = await screen.findByText(payload.protocol.structuredObservations[0]);
    expect(document.getElementById('visit-summary')).toContainElement(finding);
    expect(document.body.textContent).not.toContain(payload.protocol.structuredObservations[1]);
  });
});

// "Your upcoming visits" card (owner-approved 2026-09-27,
// GATE_REPORT_UPCOMING_VISITS) — regression coverage for codex round-2 P2:
// the glass theme hides EVERY .section-eyebrow outside the hero kicker
// (html[data-glass-theme] .service-report-v1 .section-eyebrow), so the
// card's title must ride a real heading element instead, the same way its
// sibling live-report cards (e.g. the companion section header) do.
describe('ReportViewPage — "Your upcoming visits" card title', () => {
  it('renders the title as a real <h2> heading, not a glass-suppressed .section-eyebrow', async () => {
    const payload = {
      ...pestReportV2,
      upcomingVisitsCard: {
        visits: [
          { serviceType: 'Lawn Care Treatment', scheduledDate: '2026-12-01', windowStart: '09:00:00' },
        ],
      },
    };
    renderReport(payload);

    const heading = await screen.findByRole('heading', { name: 'Your upcoming visits', level: 2 });
    expect(heading.tagName).toBe('H2');
    // The glass suppression rule targets .section-eyebrow specifically —
    // the title must not ALSO ride on one inside this card.
    expect(heading.closest('[data-section="upcoming-visits"]')?.querySelector('.section-eyebrow')).toBeNull();
    expect(screen.getByText('Dates and windows are subject to change')).toBeInTheDocument();
  });
});

// "Your plan" section (owner ask 2026-09-28): an active plan member's visit +
// re-service COUNTS for this year (never a price — prices only ever live on
// estimate pages, and no "at no charge" money claim), live mode only.
describe('ReportViewPage — "Your plan" section (planSummary)', () => {
  it('live mode with planSummary renders the section and the count line with the re-service clause, no money claim', async () => {
    const payload = structuredClone(legacyLawnReport);
    payload.planSummary = { year: 2026, visitsThisYear: 4, reservicesThisYear: 1 };
    const { container } = renderReport(payload);

    // A real <h2>: the glass theme hides every .section-eyebrow outside the
    // hero, so the title must not ride one (codex P2 on #5177).
    const heading = await screen.findByRole('heading', { name: 'Your plan', level: 2 });
    const section = container.querySelector('#your-plan');
    expect(section).not.toBeNull();
    expect(section.contains(heading)).toBe(true);
    expect(section.querySelector('.section-eyebrow')).toBeNull();
    expect(within(section).getByText('This year: 4 visits, including 1 re-service')).toBeInTheDocument();
    expect(within(section).queryByText(/no charge|free|\$/i)).toBeNull();
  });

  it('omits the re-service clause and keeps singular/plural correct when there are no re-services', async () => {
    const payload = structuredClone(legacyLawnReport);
    payload.planSummary = { year: 2026, visitsThisYear: 1, reservicesThisYear: 0 };
    const { container } = renderReport(payload);

    await screen.findByText('Your plan');
    const section = container.querySelector('#your-plan');
    expect(within(section).getByText('This year: 1 visit')).toBeInTheDocument();
    // Scoped to this section — the page footer separately mentions
    // WaveGuard's free re-service perk, which is unrelated copy.
    expect(within(section).queryByText(/re-service/)).toBeNull();
  });

  it('renders nothing when the payload carries no planSummary', async () => {
    const payload = structuredClone(legacyLawnReport);
    delete payload.planSummary;
    const { container } = renderReport(payload);

    await screen.findByText(payload.customerName, { exact: false });
    expect(screen.queryByText('Your plan')).toBeNull();
    expect(container.querySelector('#your-plan')).toBeNull();
  });

  it('stays hidden in pdf mode even when the payload carries planSummary (belt-and-braces — the server already strips it)', async () => {
    // `mode` reads window.location.search directly (not react-router's
    // location — MemoryRouter never touches the real jsdom location), so
    // pdf mode has to be set the same way the app itself reads it.
    const originalUrl = window.location.href;
    window.history.pushState({}, '', '/report/test-legacy-lawn?mode=pdf');
    try {
      const payload = structuredClone(legacyLawnReport);
      payload.planSummary = { year: 2026, visitsThisYear: 3, reservicesThisYear: 0 };
      const { container } = renderReport(payload);

      await screen.findByText(payload.customerName, { exact: false });
      expect(screen.queryByText('Your plan')).toBeNull();
      expect(container.querySelector('#your-plan')).toBeNull();
    } finally {
      window.history.pushState({}, '', originalUrl);
    }
  });
});

// "Near you" line (owner ask 2026-09-28, lawn only): a fixed sentence naming
// the lawn pest found most often around the customer's city, live mode only.
describe('ReportViewPage — "Near you" line (nearYou)', () => {
  it('live mode with nearYou renders the fixed sentence', async () => {
    const payload = structuredClone(legacyLawnReport);
    payload.nearYou = { city: 'Parrish', pest: 'chinch bugs' };
    const { container } = renderReport(payload);

    // A real <h2>, never a glass-hidden .section-eyebrow (codex P2 on #5177).
    const heading = await screen.findByRole('heading', { name: 'Near you', level: 2 });
    const section = container.querySelector('#near-you');
    expect(section).not.toBeNull();
    expect(section.contains(heading)).toBe(true);
    expect(section.querySelector('.section-eyebrow')).toBeNull();
    expect(within(section).getByText('Around Parrish this past month, chinch bugs were the lawn pest we found most often.')).toBeInTheDocument();
  });

  it('renders nothing when the payload carries no nearYou', async () => {
    const payload = structuredClone(legacyLawnReport);
    delete payload.nearYou;
    const { container } = renderReport(payload);

    await screen.findByText(payload.customerName, { exact: false });
    expect(container.querySelector('#near-you')).toBeNull();
  });

  it('stays hidden in pdf mode even when the payload carries nearYou (the server already strips it)', async () => {
    const originalUrl = window.location.href;
    window.history.pushState({}, '', '/report/test-legacy-lawn?mode=pdf');
    try {
      const payload = structuredClone(legacyLawnReport);
      payload.nearYou = { city: 'Parrish', pest: 'chinch bugs' };
      const { container } = renderReport(payload);

      await screen.findByText(payload.customerName, { exact: false });
      expect(container.querySelector('#near-you')).toBeNull();
    } finally {
      window.history.pushState({}, '', originalUrl);
    }
  });
});

// Ask Waves (codex P2 on #5167): a staff browser sends its portal JWT on the
// /ask request, as on the /data read, so the server can leave staff QA
// questions out of customer engagement; a customer's browser sends none.
describe('ReportViewPage — Ask Waves request carries the staff JWT only for staff', () => {
  async function askAndReadHeaders() {
    renderReport(structuredClone(pestReportV2));
    const input = await screen.findByLabelText('Ask Waves about this service report');
    fireEvent.change(input, { target: { value: 'What was applied today?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    let askCall;
    await waitFor(() => {
      askCall = globalThis.fetch.mock.calls.find(([url]) => String(url).endsWith('/ask'));
      expect(askCall).toBeTruthy();
    });
    return askCall[1].headers;
  }

  it('a staff browser sends Authorization: Bearer <portal JWT>', async () => {
    localStorage.setItem('waves_admin_token', 'staff-jwt');
    const headers = await askAndReadHeaders();
    expect(headers.Authorization).toBe('Bearer staff-jwt');
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('a customer browser sends no Authorization header', async () => {
    const headers = await askAndReadHeaders();
    expect(headers).not.toHaveProperty('Authorization');
  });
});

describe('ReportViewPage — expiring signed map links', () => {
  const withMapUrl = (url) => ({
    ...legacyLawnReport,
    treatmentMap: { ...(legacyLawnReport.treatmentMap || {}), satellite: { available: true, live: { url, width: 640, height: 340 } } },
  });

  it('refetches once when the map image cannot load (expired link), swapping in the fresh link', async () => {
    const probed = [];
    class FakeImage {
      set src(value) {
        probed.push(value);
        if (value.includes('EXPIRED')) setTimeout(() => this.onerror && this.onerror(), 0);
      }
    }
    vi.stubGlobal('Image', FakeImage);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => withMapUrl('/api/public/map-image/v1.EXPIRED.sig') })
      .mockResolvedValue({ ok: true, status: 200, json: async () => withMapUrl('/api/public/map-image/v1.FRESH.sig') });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/report/test-legacy-lawn']}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(probed.some((u) => u.includes('FRESH'))).toBe(true));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/data?mode=live'))).toHaveLength(2);
    // The fresh link loads, so nothing keeps refetching.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/data?mode=live'))).toHaveLength(2);
  });

  it('does not refetch when the map link is still good', async () => {
    class OkImage { set src(_v) { /* loads fine */ } }
    vi.stubGlobal('Image', OkImage);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => withMapUrl('/api/public/map-image/v1.GOOD.sig') }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <MemoryRouter initialEntries={['/report/test-legacy-lawn']}>
        <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
      </MemoryRouter>,
    );
    await screen.findAllByText(/./);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/data?mode=live'))).toHaveLength(1);
  });
});

describe('ReportViewPage — four-section report (writer rules)', () => {
  const sections = [
    { key: 'whatWeFound', title: 'What we found', paragraphs: ['Ghost ants were trailing along the slider track.'] },
    { key: 'whatWeDid', title: 'What we did and why', paragraphs: ['We placed bait along the counter, because ants carry it back to the colony.'] },
    { key: 'whatToExpect', title: 'What to expect', paragraphs: ['You may see a few more ants for a few days.'] },
    { key: 'whatsNext', title: 'What’s next', paragraphs: ['Let us know if they keep trailing after about 1–2 weeks.'] },
  ];
  const body = sections.map((section) => section.paragraphs.join(' ')).join(' ');
  const payload = {
    ...pestReportV2,
    pestTraceOrNothing: false,
    summary: body,
    summarySource: 'technician_report',
    reportSections: sections,
    nextSameServiceAppointment: { serviceType: 'Quarterly Pest Control', scheduledDate: '2026-12-09', windowStart: '09:00:00' },
    pestReportV2: {
      ...pestReportV2.pestReportV2,
      aiSummary: { headline: null, body },
      expectations: { whatToExpect: { lines: ['Ants that find the bait carry it back to the colony.'] } },
    },
  };

  it('the pest hero shows the sections, opens "What’s next" with the same-service visit, and drops the duplicate expectations card', async () => {
    renderReport(payload);
    expect(await screen.findByText('What we did and why')).toBeInTheDocument();
    expect(screen.getByText('We placed bait along the counter, because ants carry it back to the colony.')).toBeInTheDocument();
    expect(screen.getByText(/^Next visit: Quarterly Pest Control · /)).toBeInTheDocument();
    expect(screen.queryByText('Ants that find the bait carry it back to the colony.')).toBeNull();
  });

  it('a hero summary that is not the report keeps its paragraph and the expectations card', async () => {
    renderReport({ ...payload, pestReportV2: { ...payload.pestReportV2, aiSummary: { headline: null, body: 'Exterior perimeter treated.' } } });
    expect(await screen.findByText('Exterior perimeter treated.')).toBeInTheDocument();
    expect(screen.queryByText('What we did and why')).toBeNull();
    expect(screen.getByText('Ants that find the bait carry it back to the colony.')).toBeInTheDocument();
  });
});

describe('ReportViewPage — four-section report in the termite dashboard', () => {
  const sections = [
    { key: 'whatWeFound', title: 'What we found', paragraphs: ['Station 7 had live termites and light feeding.'] },
    { key: 'whatWeDid', title: 'What we did and why', paragraphs: ['We replaced the bait in station 7.'] },
    { key: 'whatToExpect', title: 'What to expect', paragraphs: ['Termite bait works slowly on purpose.'] },
    { key: 'whatsNext', title: 'What’s next', paragraphs: ['Mud tubes on walls are worth telling us about.'] },
  ];
  const body = sections.map((section) => section.paragraphs.join(' ')).join(' ');

  it('shows the property-scoped next visit in "What’s next" and drops the dashboard’s own label', async () => {
    renderReport({
      ...termiteReportV2,
      summary: body,
      summarySource: 'technician_report',
      reportSections: sections,
      nextSameServiceAppointment: { serviceType: 'Termite Bait Station Monitoring', scheduledDate: '2026-12-29', windowStart: '09:00:00' },
      termiteReportV2: { ...termiteReportV2.termiteReportV2, aiSummary: { headline: null, body } },
    });
    expect(await screen.findByText('What we did and why')).toBeInTheDocument();
    expect(screen.getByText(/^Next visit: Termite Bait Station Monitoring · /)).toBeInTheDocument();
    expect(screen.queryByText('Next monitoring visit')).toBeNull();
  });
});
