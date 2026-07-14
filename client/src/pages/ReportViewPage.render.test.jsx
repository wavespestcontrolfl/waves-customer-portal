// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';
import lawnReportV2 from './__fixtures__/lawn-report-v2.json';
import mosquitoReportV2 from './__fixtures__/mosquito-report-v2.json';

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

describe('ReportViewPage — Mosquito Report V2 (flag-gated dashboard)', () => {
  it('renders the dashboard and suppresses the legacy summary, meter, and coverage map', async () => {
    const { container } = renderReport(mosquitoReportV2);
    // Hero status from the mosquitoReportV2 payload.
    await screen.findByText('One step recommended');

    // The dashboard owns the summary slot — the legacy Visit Summary paragraph
    // must not render alongside it, and the anchor exists exactly once.
    expect(screen.queryByText('Visit Summary')).toBeNull();
    expect(container.querySelectorAll('#visit-summary')).toHaveLength(1);
    // Habitat map + next step + outlook cards render. ("Standing water"
    // legitimately appears twice: the SVG node label and its legend row.)
    expect(await screen.findAllByText('Standing water')).toHaveLength(2);
    await screen.findByText('Tip and toss standing water once a week');
    await screen.findByText('Mosquito outlook for July');
    // The hero carries the pressure reading; the standalone meter and the
    // lettered coverage map are suppressed (the habitat diagram replaces it).
    expect(container.querySelectorAll('#map')).toHaveLength(0);
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
