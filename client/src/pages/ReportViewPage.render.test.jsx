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
    renderReport(typedPestPayload());
    await screen.findByText('Today’s protection status');
    await screen.findByText('Bed Bug Activity');
    await screen.findByText(/Down from 4\/5 at your first visit \(Jun 12\)/);
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

  it('renders the dictated headlines: price folded in, city from the payload', async () => {
    const { container } = mountWithFetch(dataOnlyFetch());
    expect(await screen.findByText('Keep your home in Parrish protected for just $114!')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep My Home Protected' })).toBeInTheDocument();
    expect(screen.getByText('Know someone who could use Waves?')).toBeInTheDocument();
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
      fireEvent.click(await screen.findByRole('button', { name: 'Keep My Home Protected' }));
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
      fireEvent.click(await screen.findByRole('button', { name: 'Keep My Home Protected' }));
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
      fireEvent.click(await screen.findByRole('button', { name: 'Keep My Home Protected' }));
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


describe('Consolidated lawn report', () => {
  it('keeps the lawn summary once and omits the separate inspection card', async () => {
    const payload = structuredClone(lawnReportV2);
    payload.reportV2.photoSummary = 'Lawn health is up 2 points since your first assessment.';
    payload.protocol = { structuredObservations: ['Leaf spotting consistent with gray leaf spot was observed. Location: Back yard.', 'Unreviewed raw technician note'], actions: ['Tested irrigation coverage'] };
    renderReport(payload);
    await waitFor(() => expect(document.getElementById('visit-summary')?.textContent).toContain(payload.reportV2.photoSummary));
    const text = document.body.textContent;
    expect(text.split(payload.reportV2.photoSummary)).toHaveLength(2);
    expect(document.getElementById('lawn-field-findings')).toBeNull();
    expect(screen.getAllByText(payload.protocol.structuredObservations[0])).toHaveLength(1);
    expect(document.getElementById('visit-summary')).toContainElement(screen.getByText(payload.protocol.structuredObservations[0]));
    expect(text).not.toContain('Unreviewed raw technician note');
    expect(text).not.toContain('Lawn Health Documentation');
    expect(text).not.toContain("Why these products were selected for today's service.");
  });
});
