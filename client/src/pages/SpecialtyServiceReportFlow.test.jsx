// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ReportViewPage from './ReportViewPage';
import ServiceReportDocument from './ServiceReportDocument';
import {
  SPECIALTY_INSPECTION_REPORT_FIXTURE,
  SPECIALTY_SERVICE_REPORT_FIXTURES,
} from './__fixtures__/specialty-service-report-fixtures';

beforeEach(() => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderWeb(payload) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })));
  return render(
    <MemoryRouter initialEntries={['/report/synthetic-specialty']}>
      <Routes><Route path="/report/:token" element={<ReportViewPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('synthetic specialty completion → customer report contract', () => {
  test.each(SPECIALTY_SERVICE_REPORT_FIXTURES)(
    '$name keeps its selected area, finding, and protocol in both web and PDF output',
    async ({ name, area, finding, action, payload }) => {
      const web = renderWeb(payload);
      await waitFor(() => expect(web.container.textContent).toContain(name));
      expect(web.container.textContent).toContain(area);
      expect(web.container.textContent.toLowerCase()).toContain(finding.toLowerCase());
      expect(web.container.textContent.toLowerCase()).toContain(action.toLowerCase());
      expect(web.container.textContent).not.toMatch(/\[(?:Found|Protocol)\]/);
      web.unmount();

      const pdf = render(<ServiceReportDocument data={payload} token="synthetic-specialty" />);
      expect(pdf.container.textContent).toContain(name);
      expect(pdf.container.textContent).toContain(area);
      expect(pdf.container.textContent.toLowerCase()).toContain(finding.toLowerCase());
      expect(pdf.container.textContent.toLowerCase()).toContain(action.toLowerCase());
      expect(pdf.container.textContent).not.toMatch(/\[(?:Found|Protocol)\]/);
    },
  );

  test('the synthetic lane contains no protected compliance, bond, or membership report', () => {
    const names = SPECIALTY_SERVICE_REPORT_FIXTURES.map(({ name }) => name).join(' ');
    expect(names).not.toMatch(/WDO|pre[- ]?treatment|pre[- ]?slab|termite bond|WaveGuard membership/i);
  });

  test('inspection-only visits remain inspection-only on web and PDF', async () => {
    const { payload } = SPECIALTY_INSPECTION_REPORT_FIXTURE;
    const web = renderWeb(payload);
    await waitFor(() => expect(web.container.textContent).toContain('No treatment was applied during this visit.'));
    expect(web.container.textContent).toContain('Conditions at visit');
    expect(web.container.textContent).toContain('Visit weather');
    expect(web.container.textContent).not.toContain('Conditions at application');
    expect(web.container.textContent).not.toContain('suitable for treatment');
    expect(web.container.querySelector('#products-applied')).toBeNull();
    web.unmount();

    const pdf = render(<ServiceReportDocument data={payload} token="synthetic-inspection" />);
    expect(pdf.container.textContent).toContain('No treatment was applied during this visit.');
    expect(pdf.container.querySelector('#products-applied')).toBeNull();
  });

  test('a productless treatment action still uses application-condition labeling', async () => {
    const base = SPECIALTY_SERVICE_REPORT_FIXTURES.find(({ key }) => key === 'bee_wasp_removal').payload;
    const payload = { ...base, applications: [], applicationMade: true };
    const web = renderWeb(payload);
    await waitFor(() => expect(web.container.textContent).toContain('Yellowjacket Removal'));
    expect(web.container.textContent).toContain('Conditions at application');
    expect(web.container.textContent).not.toContain('Conditions at visit');
  });
});
