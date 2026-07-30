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
    // 'notes' is not a route-table subpage — deep segments collapse unless
    // they are known structure (Codex #2961 r20).
    expect(
      normalizeAdminPath('/admin/customers/8f14e45f-ceea-4671-9aa5-1c6ff2f3e9b1/notes'),
    ).toEqual({ pageKey: 'customers', path: '/admin/customers/:id/:id' });
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
  it('accepts short slugs from ?tab= and falls back to ?area=, ?view=, ?section=', () => {
    expect(safeTab('?tab=leads')).toBe('leads');
    expect(safeTab('?area=strategy')).toBe('strategy');
    expect(safeTab('?tab=Leads')).toBe('leads');
    // Customers switches subviews with ?view=, Pricing with ?section= —
    // both are rendered-subview signals, not PII (Codex r8).
    expect(safeTab('?view=health')).toBe('health');
    expect(safeTab('?section=reality')).toBe('reality');
    // Precedence: the highest-priority present key decides.
    expect(safeTab('?view=health&tab=directory')).toBe('directory');
    // Nested *Tab keys name the deepest leaf and outrank the constant
    // parent — switching protocolTab is a real subview change even though
    // ?tab=protocols never moves (Codex r11).
    expect(safeTab('?tab=protocols&protocolTab=readiness')).toBe('readiness');
    expect(safeTab('?area=base&kbTab=browse')).toBe('browse');
    expect(safeTab('?wikiTab=field')).toBe('field');
    // The shape gate still applies to nested values.
    expect(safeTab('?tab=protocols&protocolTab=8f14e45f-ceea-4671-9aa5-1c6ff2f3e9b1')).toBeNull();
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
    // A lowercased 32-hex customer-facing token starts with a letter and
    // passes the slug shape — the opaque backstop (≥20 chars AND
    // digit-bearing) rejects it, while long hyphenated route words
    // without digits stay valid (Codex #2961 r21).
    expect(safeTab('?tab=abcdef0123456789abcdef0123456789')).toBeNull();
    expect(safeTab('?tab=pricing-reality-check')).toBe('pricing-reality-check');
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

  // Beacons settle for ~800ms (5s on self-reporting pages like Settings,
  // whose lazy chunk must get a chance to refine the raw beacon) — advance
  // past the longest window to observe the send.
  const settle = () => vi.advanceTimersByTime(5100);

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

  it("a slow-loading Settings chunk still refines the raw beacon (lazy-chunk race)", () => {
    // Layout's raw beacon fires on route change; the lazy Settings chunk
    // mounts 1s later — past the 800ms redirect window but inside the
    // self-reporting window — and must still supersede into ONE row.
    trackAdminPageView({ pathname: '/admin/settings', search: '' });
    vi.advanceTimersByTime(900);
    expect(fetchMock).not.toHaveBeenCalled(); // still settling (5s window)
    trackAdminPageView({
      pathname: '/admin/settings',
      search: '?tab=general',
      authoritative: true,
    });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().tab).toBe('general');
    // The refinement CONTINUES the raw view — it must keep the raw
    // beacon's session-open 'load' even though it arrived aged.
    expect(lastBody().source).toBe('load');
  });

  it("an unmarked navigation away from an aged dwell does not inherit its 'load'", () => {
    // Cold open on a slow-loading Settings (raw beacon pending as 'load'),
    // 2s dwell, then browser Back — an UNMARKED navigation. The dwell is
    // flushed as its own 'load' row; the destination is a plain in-app
    // navigation and must not become a second "app open" (Codex #2961 r15).
    trackAdminPageView({ pathname: '/admin/settings', search: '' });
    vi.advanceTimersByTime(2000);
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first).toMatchObject({ pageKey: 'settings', source: 'load' });
    expect(lastBody()).toMatchObject({ pageKey: 'dashboard', source: 'in-app' });
  });

  it('holds the raw beacon for every self-reporting page, not just Settings', () => {
    // lawn-assessments/communications (r14) and agents/compliance (r15)
    // adopted authoritative beacons — their raw beacons must get the same
    // 5s refinement window, or a slow chunk records a duplicate untabbed
    // row before the page reports.
    for (const [pathname, tab] of [
      ['/admin/communications', 'sms'],
      ['/admin/lawn-assessments', 'funnel'],
      ['/admin/agents', 'overview'],
      ['/admin/compliance', 'dashboard'],
      ['/admin/newsletter', 'dashboard'],
      ['/admin/contracts', 'templates'],
      ['/admin/pricing-logic', 'margins'],
      ['/admin/blog', 'posts'],
      ['/admin/ppc', 'ppc-dashboard'],
      ['/admin/pipeline', 'leads'],
      ['/admin/customers', 'directory'],
      ['/admin/knowledge', 'articles'],
      ['/admin/service-library', 'catalog'],
    ]) {
      __resetAdminUsageForTests();
      fetchMock.mockClear();
      trackAdminPageView({ pathname, search: '' });
      vi.advanceTimersByTime(900); // past the 800ms redirect window
      expect(fetchMock).not.toHaveBeenCalled();
      trackAdminPageView({ pathname, search: `?tab=${tab}`, authoritative: true });
      settle();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(lastBody().tab).toBe(tab);
    }
  });

  it("an authoritative TAB-LESS beacon supersedes the raw tabbed beacon (no rendered subview)", () => {
    // Cold load of /admin/customers?view=garbage: the raw beacon carries
    // the shape-valid 'garbage' and is held under the self-reporting
    // window; the page mounts, renders NO panel, and declares that with
    // an authoritative tab-less beacon — one row, no tab (Codex #2961 r18).
    trackAdminPageView({ pathname: '/admin/customers', search: '?view=garbage' });
    vi.advanceTimersByTime(900); // past the redirect window, inside the hold
    expect(fetchMock).not.toHaveBeenCalled();
    trackAdminPageView({ pathname: '/admin/customers', search: '', authoritative: true });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().pageKey).toBe('customers');
    expect(lastBody().tab).toBeUndefined();
  });

  it('a newer authoritative leaf replaces a still-pending one (mount flash)', () => {
    // Communications mounts on its default leaf, then the #tab= hash (or a
    // sub-view) resolves in the same breath — the settled destination must
    // be the ONE row recorded, not both.
    trackAdminPageView({
      pathname: '/admin/communications',
      search: '?tab=sms',
      authoritative: true,
    });
    trackAdminPageView({
      pathname: '/admin/communications',
      search: '?tab=email-templates',
      authoritative: true,
    });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().tab).toBe('email-templates');
  });

  it('a real dwell on a self-reporting page is flushed, not swallowed, by later navigation', () => {
    trackAdminPageView({ pathname: '/admin/settings', search: '' });
    vi.advanceTimersByTime(2000); // genuine dwell, chunk never refined (edge)
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).pageKey).toBe('settings');
    expect(lastBody().pageKey).toBe('dashboard');
  });

  it('an aged pending dwell is flushed even when the destination dedupes (return-to-recent-page)', () => {
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockClear();
    // 2s genuine dwell on Settings (5s self-reporting window still open),
    // then back to the recently-counted dashboard: the dashboard dedupes,
    // but the Settings dwell must be counted, not swallowed.
    vi.advanceTimersByTime(1000);
    trackAdminPageView({ pathname: '/admin/settings', search: '' });
    vi.advanceTimersByTime(2000);
    trackAdminPageView({ pathname: '/admin/dashboard', search: '' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(lastBody().pageKey).toBe('settings');
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

  it('a DEDUPED authoritative assertion still suppresses the raw beacon (?tab=typo revisit)', () => {
    // /admin/agents logs its rendered 'overview' leaf…
    trackAdminPageView({
      pathname: '/admin/agents',
      search: '?tab=overview',
      authoritative: true,
    });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // …then, inside the dedupe window, the user follows a ?tab=typo link.
    // The page re-asserts its rendered 'overview' — deduped, already
    // counted, nothing left pending — and the layout's raw 'typo' beacon
    // must STILL be suppressed, not flushed after the self-report hold as
    // a tab that never rendered (Codex #2961 r20).
    vi.advanceTimersByTime(2000);
    trackAdminPageView({
      pathname: '/admin/agents',
      search: '?tab=overview',
      authoritative: true,
    });
    trackAdminPageView({ pathname: '/admin/agents', search: '?tab=typo' });
    settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
