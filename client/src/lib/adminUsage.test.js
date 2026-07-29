// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  normalizeAdminPath,
  safeTab,
  markUsageSource,
  trackAdminPageView,
  __resetAdminUsageForTests,
} from './adminUsage';

describe('normalizeAdminPath', () => {
  it('maps top-level admin pages to their page key', () => {
    expect(normalizeAdminPath('/admin/dispatch')).toEqual({
      pageKey: 'dispatch',
      path: '/admin/dispatch',
    });
  });

  it('treats bare /admin as the dashboard', () => {
    expect(normalizeAdminPath('/admin')).toEqual({
      pageKey: 'dashboard',
      path: '/admin',
    });
  });

  it('strips uuid, numeric, and opaque-token segments to :id', () => {
    expect(
      normalizeAdminPath('/admin/customers/8f14e45f-ceea-4671-9aa5-1c6ff2f3e9b1/notes'),
    ).toEqual({ pageKey: 'customers', path: '/admin/customers/:id/notes' });
    expect(normalizeAdminPath('/admin/estimates/12345/proposal')).toEqual({
      pageKey: 'estimates',
      path: '/admin/estimates/:id/proposal',
    });
    expect(
      normalizeAdminPath('/admin/contracts/aVeryLongOpaqueToken_1234567890'),
    ).toEqual({ pageKey: 'contracts', path: '/admin/contracts/:id' });
  });

  it('keeps long hyphenated route words — they are structure, not opaque tokens', () => {
    expect(normalizeAdminPath('/admin/pricing-reality-check')).toEqual({
      pageKey: 'pricing-reality-check',
      path: '/admin/pricing-reality-check',
    });
  });

  it('collapses record slugs after entity routes but keeps their static subpages', () => {
    expect(normalizeAdminPath('/admin/customers/acme')).toEqual({
      pageKey: 'customers',
      path: '/admin/customers/:id',
    });
    expect(normalizeAdminPath('/admin/customers/John_Smith')).toEqual({
      pageKey: 'customers',
      path: '/admin/customers/:id',
    });
    // customers/duplicates is a real page (App.jsx), not a record slug.
    expect(normalizeAdminPath('/admin/customers/duplicates')).toEqual({
      pageKey: 'customers',
      path: '/admin/customers/duplicates',
    });
  });

  it('returns null off /admin and for non-slug first segments', () => {
    expect(normalizeAdminPath('/tech/protocols')).toBeNull();
    expect(normalizeAdminPath('/administrator')).toBeNull();
  });

  it('canonicalizes the underscore design-system routes to a trackable slug', () => {
    expect(normalizeAdminPath('/admin/_design-system')).toEqual({
      pageKey: 'design-system',
      path: '/admin/design-system',
    });
    expect(normalizeAdminPath('/admin/_design-system/flags')).toEqual({
      pageKey: 'design-system',
      path: '/admin/design-system/flags',
    });
  });
});

describe('safeTab', () => {
  it('accepts short slugs from ?tab= and falls back to ?area=', () => {
    expect(safeTab('?tab=leads')).toBe('leads');
    expect(safeTab('?area=strategy')).toBe('strategy');
    expect(safeTab('?tab=Leads')).toBe('leads');
    // Hyphenated Settings leaf keys are valid tab slugs (Codex r3 claimed
    // otherwise — encode the counterexamples).
    expect(safeTab('?tab=service-reports')).toBe('service-reports');
    expect(safeTab('?tab=blackout-days')).toBe('blackout-days');
    expect(safeTab('?tab=kpi-targets')).toBe('kpi-targets');
    expect(safeTab('?tab=operating-costs')).toBe('operating-costs');
  });

  it('drops anything that is not a short slug', () => {
    expect(safeTab('?tab=some search text')).toBeNull();
    expect(safeTab('?tab=8f14e45f-ceea-4671-9aa5-1c6ff2f3e9b1')).toBeNull();
    expect(safeTab('?source_name=Google%20LSA')).toBeNull();
    expect(safeTab('')).toBeNull();
    // Identifier-shaped values are not tabs: digits-only (phone numbers)
    // and underscore names never occur as tab slugs in this app.
    expect(safeTab('?tab=5551234567')).toBeNull();
    expect(safeTab('?tab=john_smith')).toBeNull();
  });
});

describe('trackAdminPageView', () => {
  let fetchMock;

  beforeEach(() => {
    vi.useFakeTimers();
    __resetAdminUsageForTests();
    fetchMock = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('waves_admin_token', 'tok');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    localStorage.clear();
  });

  // Beacons settle for ~800ms so redirect chains collapse — flush the timer
  // to observe the send.
  const settle = () => vi.advanceTimersByTime(900);

  function lastBody() {
    const [, opts] = fetchMock.mock.calls.at(-1);
    return JSON.parse(opts.body);
  }

  it('posts a normalized page view with the load source first', () => {
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    expect(fetchMock).not.toHaveBeenCalled(); // still settling
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/admin\/usage\/track$/);
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(lastBody()).toEqual({
      pageKey: 'dashboard',
      path: '/admin/dashboard',
      source: 'load',
    });
  });

  it('attributes the view to a marked nav control, then falls back to in-app', () => {
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    markUsageSource('sidebar');
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=board' });
    settle();
    expect(lastBody()).toEqual({
      pageKey: 'dispatch',
      path: '/admin/dispatch',
      tab: 'board',
      source: 'sidebar',
    });
    trackAdminPageView({ pathname: '/admin/customers', search: '' });
    settle();
    expect(lastBody().source).toBe('in-app');
  });

  it('collapses an instant redirect into one row that keeps the real source', () => {
    // Sidebar "Schedule" → /admin/schedule → ScheduleRedirect →
    // /admin/dispatch?tab=schedule. One row, for the landing page, sidebar-attributed.
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    fetchMock.mockClear();
    markUsageSource('sidebar');
    trackAdminPageView({ pathname: '/admin/schedule', search: '' });
    vi.advanceTimersByTime(50); // redirect lands well inside the settle window
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=schedule' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody()).toEqual({
      pageKey: 'dispatch',
      path: '/admin/dispatch',
      tab: 'schedule',
      source: 'sidebar',
    });
  });

  it('drops a pending redirect hop when the chain lands on an already-counted view', () => {
    // Arrive at dispatch?tab=schedule normally; the view is counted.
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=schedule' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    // Re-tap the active Schedule nav item 10s later: the legacy
    // /admin/schedule hop queues, then the redirect returns to the
    // already-counted view inside the dedupe window. Nothing new may send —
    // especially not the phantom /admin/schedule row.
    vi.advanceTimersByTime(10000);
    markUsageSource('sidebar');
    trackAdminPageView({ pathname: '/admin/schedule', search: '' });
    vi.advanceTimersByTime(50);
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=schedule' });
    settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resets tracking state when the signed-in identity changes', () => {
    trackAdminPageView({ pathname: '/admin/dispatch', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Same page, same 30s window — but a DIFFERENT staff member signed in
    // on this shared browser. Their first view must send (fresh session,
    // 'load'), under their own token.
    localStorage.setItem('waves_admin_token', 'tok-b');
    trackAdminPageView({ pathname: '/admin/dispatch', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, opts] = fetchMock.mock.calls.at(-1);
    expect(opts.headers.Authorization).toBe('Bearer tok-b');
    expect(lastBody().source).toBe('load');
  });

  it("drops the previous identity's still-settling beacon instead of misattributing it", () => {
    trackAdminPageView({ pathname: '/admin/invoices', search: '' }); // A, still pending
    localStorage.setItem('waves_admin_token', 'tok-b');
    trackAdminPageView({ pathname: '/admin/dispatch', search: '' }); // B signs in
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().pageKey).toBe('dispatch');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer tok-b');
  });

  it('a tab-less beacon never downgrades a pending tabbed beacon for the same page', () => {
    // Query-less Settings open: the page's mount effect records the rendered
    // leaf FIRST (child effects run before parent effects), then the layout
    // queues its coarse tab-less view — one row, leaf + source kept.
    markUsageSource('sidebar');
    trackAdminPageView({ pathname: '/admin/settings', search: '?tab=general' });
    trackAdminPageView({ pathname: '/admin/settings', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody()).toEqual({
      pageKey: 'settings',
      path: '/admin/settings',
      tab: 'general',
      source: 'sidebar',
    });
  });

  it('flushes the pending beacon on pagehide so the last view is not lost', () => {
    trackAdminPageView({ pathname: '/admin/invoices', search: '' });
    expect(fetchMock).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().pageKey).toBe('invoices');
  });

  it('drops a queued beacon whose token changed before flush (cross-tab switch)', () => {
    trackAdminPageView({ pathname: '/admin/invoices', search: '' });
    // Another tab switches accounts — no track() call happens here before
    // the settle timer fires. The queued view must not send under the new
    // token.
    localStorage.setItem('waves_admin_token', 'tok-b');
    settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an authoritative page beacon is not overridden by the layout's raw URL beacon", () => {
    // /admin/settings?tab=typo: the page renders its validated 'general'
    // fallback and records it authoritatively; the layout's raw 'typo'
    // beacon for the same page must not replace it.
    markUsageSource('sidebar');
    trackAdminPageView({
      pathname: '/admin/settings',
      search: '?tab=general',
      authoritative: true,
    });
    trackAdminPageView({ pathname: '/admin/settings', search: '?tab=typo' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody()).toEqual({
      pageKey: 'settings',
      path: '/admin/settings',
      tab: 'general',
      source: 'sidebar',
    });
  });

  it('dedupes identical consecutive views (StrictMode double-fire)', () => {
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=board' });
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=board' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // A tab switch on the same page is a distinct view.
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=schedule' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Returning to an already-sent identical view inside the window is dropped.
    trackAdminPageView({ pathname: '/admin/dispatch', search: '?tab=schedule' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never fires without an auth token or off /admin', () => {
    localStorage.removeItem('waves_admin_token');
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    localStorage.setItem('waves_admin_token', 'tok');
    trackAdminPageView({ pathname: '/book', search: '' });
    settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops PII-bearing query params instead of sending them', () => {
    trackAdminPageView({
      pathname: '/admin/leads',
      search: '?source_name=Google%20LSA&from=2026-07-01',
    });
    settle();
    const body = lastBody();
    expect(body.tab).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Google');
  });
});
