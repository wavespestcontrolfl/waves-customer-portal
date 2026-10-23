// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportPreviewPage } from './ReportViewPage';
import lawnReportV2 from './__fixtures__/lawn-report-v2.json';

// Admin report preview (/admin/report-preview/:serviceId): the report for a visit
// that is NOT completed. Pins: it reads the admin endpoint with the staff JWT (no
// token route), shows the not-sent banner, and makes no token-keyed call at all.

const SERVICE_ID = '11111111-2222-4333-8444-555555555555';

function renderPreview(response) {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init) => {
    calls.push({ url: String(url), method: init?.method || 'GET', headers: init?.headers });
    return response;
  }));
  render(
    <MemoryRouter initialEntries={[`/admin/report-preview/${SERVICE_ID}`]}>
      <Routes><Route path="/admin/report-preview/:serviceId" element={<ReportPreviewPage />} /></Routes>
    </MemoryRouter>,
  );
  return calls;
}

beforeEach(() => {
  const store = { waves_admin_token: 'admin-jwt' };
  vi.stubGlobal('localStorage', {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value); },
    removeItem: (key) => { delete store[key]; },
    clear: () => {},
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ReportViewPage — admin preview', () => {
  it('loads the admin endpoint with the staff JWT, shows the banner, and posts nothing', async () => {
    const calls = renderPreview({
      ok: true, status: 200,
      json: async () => ({ ...lawnReportV2, preview: true, token: null, pdfUrl: null, mapSvgUrl: null }),
    });
    expect(await screen.findByText(/Preview — not sent to the customer/)).toBeInTheDocument();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    expect(calls[0].url).toMatch(new RegExp(`/admin/report-preview/${SERVICE_ID}/data$`));
    expect(calls[0].headers).toEqual({ Authorization: 'Bearer admin-jwt' });
    // No /reports/<token> call of any kind, and nothing was POSTed (events, ask, referral-link).
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(calls.filter((c) => /\/reports\//.test(c.url))).toEqual([]);
  });

  it('renders Reschedule as a disabled control, never a link into the live customer flow', async () => {
    renderPreview({
      ok: true, status: 200,
      json: async () => ({
        ...lawnReportV2, preview: true, token: null, pdfUrl: null, mapSvgUrl: null,
        upcomingVisitsCard: { merged: true, visits: [{ serviceType: 'Lawn Care Treatment', scheduledDate: '2099-11-10', windowStart: '08:00:00', rescheduleUrl: null, reschedulePreview: true }] },
      }),
    });
    const control = await screen.findByText('Reschedule');
    expect(control.tagName).toBe('SPAN');
    expect(control).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link', { name: /reschedule/i })).toBeNull();
  });

  it('says why there is no preview when the visit is already completed', async () => {
    renderPreview({ ok: false, status: 409, json: async () => ({ error: 'This visit is already completed. Open its real report instead.' }) });
    expect(await screen.findByText(/already completed/i)).toBeInTheDocument();
    expect(screen.getByText(/Preview — not sent to the customer/)).toBeInTheDocument();
  });
});
