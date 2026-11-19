// @vitest-environment jsdom
import React from 'react';
import { PortalReadProvider, READ_TIMEOUT_MS } from '../hooks/usePortalRead';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeState = vi.hoisted(() => ({ enabled: false, platform: 'web' }));
vi.mock('../native/platform', () => ({
  isNativeApp: () => nativeState.enabled,
  nativePlatform: () => nativeState.platform,
}));
vi.mock('../native/nativeFile', async (importOriginal) => ({
  ...await importOriginal(),
  saveBlobNative: vi.fn(async () => true),
}));

vi.stubEnv('VITE_API_URL', 'https://api.example.test/api');

const completeTracker = (serviceSummary) => ({
  id: 'visit-1', currentStep: 7, state: 'complete', completedAt: '2026-11-18T15:00:00Z',
  steps: Array.from({ length: 7 }, (_, index) => ({ completedAt: index === 6 ? '2026-11-18T15:00:00Z' : null })),
  customerLocation: null, trackUrl: null, office: null, rainChance: null, stopsAhead: null, routeProgress: null,
  techApprox: null, etaSource: null, technician: { name: 'Sam Rivera', initials: 'SR' },
  service: { type: 'Quarterly Pest Control', date: '2026-11-18', windowStart: '09:00:00', windowEnd: '11:00:00' },
  etaMinutes: null, liveNotes: [], serviceSummary, techPosition: null,
});

let todayTracker; let todayPropertyScope;
vi.mock('../utils/api', () => ({
  default: new Proxy({
    getTodayTracker: vi.fn(async () => ({ tracker: todayTracker, propertyScope: todayPropertyScope })),
    getActiveTracker: vi.fn(),
    getPropertyPreferences: vi.fn(async () => ({ preferences: {} })),
    getWeather: vi.fn(async () => null),
    request: vi.fn(async () => ({})),
    fetchRaw: vi.fn(),
  }, {
    get: (target, prop) => {
      if (typeof prop !== 'string') return target[prop];
      if (!(prop in target)) target[prop] = vi.fn(() => new Promise(() => {}));
      return target[prop];
    },
  }),
}));

let ServiceTracker; let DashboardTab; let api; let saveBlobNative;
const BrowserURL = globalThis.URL;
beforeEach(async () => {
  nativeState.enabled = false;
  nativeState.platform = 'web';
  todayPropertyScope = undefined;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('scrollTo', vi.fn());
  vi.stubGlobal('URL', class extends BrowserURL {
    static createObjectURL = vi.fn(() => 'blob:report-preview');
    static revokeObjectURL = vi.fn();
  });
  ({ ServiceTracker, DashboardTab } = await import('./PortalPage'));
  ({ default: api } = await import('../utils/api'));
  ({ saveBlobNative } = await import('../native/nativeFile'));
  vi.clearAllMocks();
  api.getNextService.mockResolvedValue({ next: null });
  api.getServices.mockResolvedValue({ services: [] });
  api.getGoogleReviewCard.mockResolvedValue({ card: null });
  api.getPropertyPreferences.mockResolvedValue({ preferences: {} });
  api.getWeather.mockResolvedValue(null);
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

  it('keeps a published tracker report inside the native app and Close restores Home', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'ios';
    todayTracker = completeTracker({
      customerSummary: 'Reviewed closeout.',
      reportUrl: '/report/report-native', reportPdfUrl: '/api/reports/report-native', reportPending: false,
    });
    render(<ServiceTracker />);
    fireEvent.click(await screen.findByRole('button', { name: "View today's report" }));
    const dialog = screen.getByRole('dialog', { name: 'Visit Report — Quarterly Pest Control' });
    expect(dialog.querySelector('iframe')).toHaveAttribute('src', '/report/report-native?source=portal_home');
    expect(screen.getByText('Service complete')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: "View today's report" })).toBeInTheDocument();
    expect(api.fetchRaw).not.toHaveBeenCalled();
  });

  it('closes an open tracker report when a portal refresh withdraws contact access', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'ios';
    todayTracker = completeTracker({
      customerSummary: 'Reviewed closeout.',
      reportUrl: '/report/report-native', reportPdfUrl: '/api/reports/report-native', reportPending: false,
    });
    render(<PortalReadProvider enabled><ServiceTracker /></PortalReadProvider>);
    fireEvent.click(await screen.findByRole('button', { name: "View today's report" }));
    expect(screen.getByRole('dialog', { name: 'Visit Report — Quarterly Pest Control' })).toBeInTheDocument();

    todayTracker = completeTracker({
      customerSummary: null, reportUrl: null, reportPdfUrl: null,
      reportPending: false, reportWithheld: true,
    });
    fireEvent(window, new Event('online'));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByText('Reviewed closeout.')).not.toBeInTheDocument();
    expect(screen.queryByText('Service summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "View today's report" })).not.toBeInTheDocument();
  });

  it('adopts a replacement visit and clears a missing visit on portal refresh', async () => {
    todayTracker = completeTracker({ customerSummary: 'First visit.', reportUrl: '/report/first' });
    render(<PortalReadProvider enabled><ServiceTracker /></PortalReadProvider>);
    expect(await screen.findByText('First visit.')).toBeInTheDocument();
    todayTracker = { ...completeTracker({ customerSummary: 'Second visit.', reportUrl: '/report/second' }), id: 'visit-2' };
    fireEvent(window, new Event('online'));
    expect(await screen.findByText('Second visit.')).toBeInTheDocument();
    expect(screen.queryByText('First visit.')).not.toBeInTheDocument();
    todayTracker = null;
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(screen.queryByText('Service complete')).not.toBeInTheDocument());
  });

  it.each([401, 403, 500])('withdraws the completed tracker report when portal revalidation fails (%s)', async status => {
    todayTracker = completeTracker({
      customerSummary: 'Contact-visible closeout.',
      reportUrl: '/report/contact-report', reportPdfUrl: null, reportPending: false,
    });
    render(<PortalReadProvider enabled><ServiceTracker /></PortalReadProvider>);
    expect(await screen.findByText('Contact-visible closeout.')).toBeInTheDocument();
    api.getTodayTracker.mockRejectedValueOnce(Object.assign(new Error('Denied'), { status }));

    fireEvent(window, new Event('online'));

    await waitFor(() => expect(screen.queryByText('Contact-visible closeout.')).not.toBeInTheDocument());
    expect(screen.queryByText('Service summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: "View today's report" })).not.toBeInTheDocument();
  });

  it('withdraws a ready tracker report when portal revalidation times out and ignores the late success', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'ios';
    todayTracker = completeTracker({
      customerSummary: 'Time-sensitive closeout.',
      reportUrl: '/report/timed-report', reportPdfUrl: null, reportPending: false,
    });
    render(<PortalReadProvider enabled><ServiceTracker /></PortalReadProvider>);
    fireEvent.click(await screen.findByRole('button', { name: "View today's report" }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    let finishLateRequest;
    api.getTodayTracker.mockImplementationOnce(() => new Promise(resolve => { finishLateRequest = resolve; }));
    vi.useFakeTimers();
    try {
      fireEvent(window, new Event('online'));
      expect(api.getTodayTracker).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(screen.queryByText('Time-sensitive closeout.')).not.toBeInTheDocument();
      expect(screen.queryByText('Service summary')).not.toBeInTheDocument();

      await act(async () => {
        finishLateRequest({ tracker: completeTracker({
          customerSummary: 'Late success must stay hidden.',
          reportUrl: '/report/late-success', reportPdfUrl: null, reportPending: false,
        }) });
      });
      expect(screen.queryByText('Late success must stay hidden.')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: "View today's report" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refreshes a completion whose report row has not committed yet', async () => {
    todayTracker = completeTracker({ reportPending: true });
    render(<ServiceTracker />);
    const check = await screen.findByRole('button', { name: 'Check for report' });
    todayTracker = completeTracker({ customerSummary: null, reportUrl: '/report/report-2', reportPdfUrl: null, reportPending: false });
    fireEvent.click(check);
    await waitFor(() => expect(api.getTodayTracker).toHaveBeenCalledTimes(2));
    expect(api.getActiveTracker).not.toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: "View today's report" })).toHaveAttribute('href', '/report/report-2?source=portal_home');
  });

  it.each([
    ['a different completed stop', completeTracker({ reportUrl: '/report/wrong-stop' }), 'visit-2'],
    ['no visit', null, null],
  ])('keeps the pending stop on screen when today returns %s', async (_label, nextTracker, replacementId) => {
    todayTracker = completeTracker({ reportPending: true });
    render(<ServiceTracker />);
    const check = await screen.findByRole('button', { name: 'Check for report' });
    todayTracker = nextTracker && { ...nextTracker, id: replacementId };
    fireEvent.click(check);
    await waitFor(() => expect(api.getTodayTracker).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('button', { name: 'Check for report' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: "View today's report" })).not.toBeInTheDocument();
    expect(screen.getByText('Service summary')).toBeInTheDocument();
  });

  it('lets the customer retry a stalled report check and ignores the expired response', async () => {
    todayTracker = completeTracker({ reportPending: true });
    render(<ServiceTracker />);
    const check = await screen.findByRole('button', { name: 'Check for report' });
    let finishOldRequest;
    api.getTodayTracker.mockImplementationOnce(() => new Promise((resolve) => { finishOldRequest = resolve; }));
    vi.useFakeTimers();
    try {
      fireEvent.click(check);
      expect(check).toBeDisabled();
      await act(async () => { await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS); });
      expect(check).toBeEnabled();
      await act(async () => { finishOldRequest({ tracker: completeTracker({ reportUrl: '/report/expired' }) }); });
      expect(screen.queryByRole('link', { name: "View today's report" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the pending stop immediately when the server echoes another property, even if picker refresh fails', async () => {
    const refreshProperties = vi.fn(() => Promise.reject(new Error('picker refresh failed')));
    const shownProperty = { id: 'customer-1:pb', key: 'customer-1:pb', customerId: 'customer-1', propertyId: 'pb', isPrimaryProperty: false };
    todayTracker = completeTracker({ reportPending: true });
    todayPropertyScope = { enabled: true, propertyId: 'pb', closed: false };
    render(<ServiceTracker currentEntry={shownProperty} savedScope onSavedScopeUnavailable={refreshProperties} />);
    const check = await screen.findByRole('button', { name: 'Check for report' });
    todayPropertyScope = { enabled: true, propertyId: 'pa', closed: false };
    fireEvent.click(check);
    await waitFor(() => expect(refreshProperties).toHaveBeenCalledTimes(1));
    expect(screen.queryByText('Service summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check for report' })).not.toBeInTheDocument();
  });

  it('does not offer a pending-report retry when report access was withheld', async () => {
    todayTracker = completeTracker({ reportPending: true, reportWithheld: true });
    render(<ServiceTracker />);
    expect(await screen.findByText('Service complete')).toBeInTheDocument();
    expect(screen.queryByText('Service summary')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check for report' })).not.toBeInTheDocument();
  });

  it('previews an authenticated PDF fallback inside the native shell', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'ios';
    todayTracker = completeTracker({ reportUrl: null, reportPdfUrl: '/api/documents/service-report/record-1', reportPending: false });
    api.fetchRaw.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['report'], { type: 'application/pdf' }),
    });
    render(<ServiceTracker />);
    fireEvent.click(await screen.findByRole('button', { name: "View today's report" }));
    expect(await screen.findByRole('dialog', { name: 'Service report' })).toBeInTheDocument();
    expect(api.fetchRaw).toHaveBeenCalledWith('https://api.example.test/api/documents/service-report/record-1');
    expect(saveBlobNative).not.toHaveBeenCalled();
  });

  it('downloads the tracker PDF through the Android share/save path instead of an iframe', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'android';
    todayTracker = completeTracker({ reportUrl: null, reportPdfUrl: '/api/documents/service-report/record-android', reportPending: false });
    api.fetchRaw.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['report'], { type: 'application/pdf' }),
    });
    render(<ServiceTracker />);
    fireEvent.click(await screen.findByRole('button', { name: "View today's report" }));
    await waitFor(() => expect(saveBlobNative).toHaveBeenCalledTimes(1));
    expect(api.fetchRaw).toHaveBeenCalledWith('https://api.example.test/api/documents/service-report/record-android');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('last-visit report handoff on Home', () => {
  const customer = { id: 'customer-1', firstName: 'Pat', lastName: 'Customer', property: {} };

  function renderDashboardReport(reportPdfUrl, reportUrl = null) {
    api.getServices.mockResolvedValue({
      services: [{
        id: 'last-record', date: '2026-11-17', type: 'Quarterly Pest Control',
        reportUrl, reportPdfUrl, reportAvailable: true,
      }],
    });
    return render(<DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} />);
  }

  it('keeps a published Last Visit report inside Android and Close restores Home', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'android';
    renderDashboardReport('/api/reports/last-published', '/report/last-published');
    fireEvent.click(await screen.findByRole('button', { name: 'View service report' }));
    const dialog = screen.getByRole('dialog', { name: 'Visit Report — Quarterly Pest Control' });
    expect(dialog.querySelector('iframe')).toHaveAttribute('src', '/report/last-published?source=portal_home');
    expect(screen.getByText('Last Visit')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View service report' })).toBeInTheDocument();
    expect(api.fetchRaw).not.toHaveBeenCalled();
    expect(saveBlobNative).not.toHaveBeenCalled();
  });

  it('closes an open native report when the refreshed visit withholds it', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'ios';
    const visit = { id: 'last-record', date: '2026-11-17', type: 'Quarterly Pest Control' };
    api.getServices.mockResolvedValue({ services: [{ ...visit, reportUrl: '/report/last', reportAvailable: true }] });
    render(<PortalReadProvider enabled><DashboardTab customer={customer} onSwitchTab={() => {}} onOpenPlanService={() => {}} /></PortalReadProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'View service report' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    api.getServices.mockResolvedValue({ services: [{ ...visit, reportAvailable: false }] });
    fireEvent(window, new Event('online'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'View service report' })).not.toBeInTheDocument();
  });

  it('resolves the configured API origin and previews the last-visit PDF on iOS', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'ios';
    api.fetchRaw.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['report'], { type: 'application/pdf' }),
    });
    renderDashboardReport('/api/documents/service-report/last-record');
    fireEvent.click(await screen.findByRole('button', { name: 'View service report' }));
    expect(await screen.findByRole('dialog', { name: 'Service report' })).toBeInTheDocument();
    expect(api.fetchRaw).toHaveBeenCalledWith('https://api.example.test/api/documents/service-report/last-record');
    expect(saveBlobNative).not.toHaveBeenCalled();
  });

  it('downloads the last-visit PDF through the Android share/save path instead of an iframe', async () => {
    nativeState.enabled = true;
    nativeState.platform = 'android';
    api.fetchRaw.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/pdf' },
      blob: async () => new Blob(['report'], { type: 'application/pdf' }),
    });
    renderDashboardReport('/api/documents/service-report/last-android');
    fireEvent.click(await screen.findByRole('button', { name: 'View service report' }));
    await waitFor(() => expect(saveBlobNative).toHaveBeenCalledTimes(1));
    expect(api.fetchRaw).toHaveBeenCalledWith('https://api.example.test/api/documents/service-report/last-android');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
