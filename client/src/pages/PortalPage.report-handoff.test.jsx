// @vitest-environment jsdom
import React from 'react';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({ enabled: false }));
vi.mock('../native/platform', () => ({
  isNativeApp: () => nativeState.enabled,
  nativePlatform: () => (nativeState.enabled ? 'ios' : 'web'),
}));

const completeTracker = (serviceSummary) => ({
  id: 'visit-1', currentStep: 7, state: 'complete', completedAt: '2026-11-18T15:00:00Z',
  steps: Array.from({ length: 7 }, (_, index) => ({ completedAt: index === 6 ? '2026-11-18T15:00:00Z' : null })),
  customerLocation: null, trackUrl: null, office: null, rainChance: null, stopsAhead: null, routeProgress: null,
  techApprox: null, etaSource: null, technician: { name: 'Sam Rivera', initials: 'SR' },
  service: { type: 'Quarterly Pest Control', date: '2026-11-18', windowStart: '09:00:00', windowEnd: '11:00:00' },
  etaMinutes: null, liveNotes: [], serviceSummary, techPosition: null,
});

let todayTracker;
vi.mock('../utils/api', () => ({
  default: {
    getTodayTracker: vi.fn(async () => ({ tracker: todayTracker, propertyScope: undefined })),
    getActiveTracker: vi.fn(),
    getPropertyPreferences: vi.fn(async () => ({ preferences: {} })),
    getWeather: vi.fn(async () => null),
    request: vi.fn(async () => ({})),
    fetchRaw: vi.fn(),
  },
}));

let ServiceTracker; let api;
const BrowserURL = globalThis.URL;
beforeEach(async () => {
  nativeState.enabled = false;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL = vi.fn(() => 'blob:report-preview');
    static revokeObjectURL = vi.fn();
  });
  ({ ServiceTracker } = await import('./PortalPage'));
  ({ default: api } = await import('../utils/api'));
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('completed visit report handoff on Home', () => {
  it('shows the reviewed closeout and opens the exact published report in one tap', async () => {
    todayTracker = completeTracker({
      customerSummary: 'Sam checked the lanai entry and treated the exterior.',
      reportUrl: '/report/report-1', reportPdfUrl: '/api/reports/report-1', reportPending: false,
    });
    render(<ServiceTracker />);
    expect(await screen.findByText('Sam checked the lanai entry and treated the exterior.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "View today's report" })).toHaveAttribute('href', '/report/report-1?source=portal_home');
  });

  it('refreshes a completion whose report row has not committed yet', async () => {
    todayTracker = completeTracker({ reportPending: true });
    api.getActiveTracker.mockResolvedValue({
      tracker: completeTracker({ customerSummary: null, reportUrl: '/report/report-2', reportPdfUrl: null, reportPending: false }),
      propertyScope: undefined,
    });
    render(<ServiceTracker />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check for report' }));
    await waitFor(() => expect(api.getActiveTracker).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('link', { name: "View today's report" })).toHaveAttribute('href', '/report/report-2?source=portal_home');
  });

  it('does not offer a pending-report retry when report access was withheld', async () => {
    todayTracker = completeTracker({ reportPending: true, reportWithheld: true });
    render(<ServiceTracker />);
    expect(await screen.findByText('Service summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check for report' })).not.toBeInTheDocument();
  });

  it('previews an authenticated PDF fallback inside the native shell', async () => {
    nativeState.enabled = true;
    todayTracker = completeTracker({ reportUrl: null, reportPdfUrl: '/api/documents/service-report/record-1', reportPending: false });
    api.fetchRaw.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['report'], { type: 'application/pdf' }),
    });
    render(<ServiceTracker />);
    fireEvent.click(await screen.findByRole('button', { name: "View today's report" }));
    expect(await screen.findByRole('dialog', { name: 'Service report' })).toBeInTheDocument();
    expect(api.fetchRaw).toHaveBeenCalledWith(expect.stringContaining('/api/documents/service-report/record-1'));
  });
});
