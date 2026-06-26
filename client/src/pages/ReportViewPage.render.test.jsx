// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import legacyLawnReport from './__fixtures__/legacy-lawn-report.json';

// Full-render guard for the legacy lawn service report (reportVersion
// service_report_v1, serviceLine lawn, reportV2 null — i.e. LAWN_REPORT_V2 off,
// which is the live production layout). A regression here previously shipped:
// the early "V2 lead" block was gated on isLawnReport instead of isV2LeadLayout,
// so a legacy lawn report rendered Products Applied + Visit Timeline twice (and
// duplicated their DOM ids). These tests pin the single-render behavior.

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

describe('ReportViewPage — legacy lawn layout (reportV2 off)', () => {
  it('renders Products Applied and Visit Timeline exactly once', async () => {
    const { container } = renderReport(legacyLawnReport);
    await screen.findByText('Visit Summary');

    expect(container.querySelectorAll('#products-applied')).toHaveLength(1);
    expect(container.querySelectorAll('#service-timeline')).toHaveLength(1);
    expect(container.querySelectorAll('#map')).toHaveLength(1);
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
