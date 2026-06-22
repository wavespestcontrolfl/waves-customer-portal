const { fillCitationForm, _internals } = require('../services/seo/browser-form-filler');

// Fake Playwright page/browser that records actions and serves canned screenshots.
// failFillSel: a selector whose fill() throws (fail-closed pre-submit path).
// failClickSel: a selector whose click() throws (submit not actionable).
// ctxOpts: captures newContext(options); wsLog: records routeWebSocket patterns;
// clickOptsLog: records [selector, options] for clicks that pass options.
// submitReq: {method,url,nav} — a synthetic request fired THROUGH the real route guard
// when the submit is clicked, so submitDispatched/submitAborted get exercised offline.
function fakeBrowser(actionsLog, { landedUrl = 'https://x.com/add', failFillSel = null, failClickSel = null, ctxOpts = null, wsLog = null, clickOptsLog = null, submitReq = null } = {}) {
  let routeHandler = null;
  const fireSubmitReq = async () => {
    if (!submitReq || !routeHandler) return;
    const req = {
      url: () => submitReq.url,
      method: () => submitReq.method || 'POST',
      isNavigationRequest: () => !!submitReq.nav,
      frame: () => ({ parentFrame: () => null }),
    };
    await routeHandler({ request: () => req, abort: async () => {}, continue: async () => {} });
  };
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {},
    url: () => landedUrl,
    screenshot: async () => Buffer.from('png'),
    fill: async (sel, val) => { if (sel === failFillSel) throw new Error('selector not found'); actionsLog.push(['fill', sel, val]); },
    selectOption: async (sel, val) => actionsLog.push(['select', sel, val]),
    check: async (sel) => actionsLog.push(['check', sel]),
    click: async (sel, opts) => { if (sel === failClickSel) throw new Error('element not actionable'); if (clickOptsLog && opts) clickOptsLog.push([sel, opts]); actionsLog.push(['click', sel]); await fireSubmitReq(); },
  };
  const ctx = { newPage: async () => page, route: async (_p, handler) => { routeHandler = handler; } };
  if (wsLog) ctx.routeWebSocket = async (pattern) => { wsLog.push(pattern); };
  return { newContext: async (opts) => { if (ctxOpts) Object.assign(ctxOpts, opts || {}); return ctx; }, close: async () => {} };
}
// Fake Claude: first call (plan) then second call (verify).
function fakeAnthropic(planObj, verifyObj) {
  let n = 0;
  return { messages: { create: async () => { n += 1; return { content: [{ text: JSON.stringify(n === 1 ? planObj : verifyObj) }] }; } } };
}
const nap = { business_name: 'Waves Pest Control', website: 'https://wavespestcontrol.com', email: 'contact@wavespestcontrol.com', phone: '(941) 318-7612', address: { street: 'x', city: 'Bradenton', state: 'FL', zip: '34211' }, category: 'Pest Control', description: 'desc' };
// Default injected deps: a stub DNS resolver returns a public IP so we never hit the
// network, plus whatever launchBrowser/anthropic the test supplies.
const deps = (over = {}) => ({ resolveHostIps: async () => ['203.0.113.10'], ...over });

describe('fillCitationForm', () => {
  test('blocked (account/captcha/payment) → fail-closed, no actions executed', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, blocked: 'captcha', actions: [] }),
    }));
    expect(r.outcome).toBe('blocked_captcha');
    expect(log).toHaveLength(0); // never filled anything
  });

  test('free form → fills, submits, confirms → placed+pending; live_url NEVER stored (verifier reconciles)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#name', value: 'Waves' }, { action: 'submit', selector: '#go' }] },
        { success: true, pending: false, live_url: 'https://x.com/biz/waves' },
      ),
    }));
    expect(r.outcome).toBe('placed');
    expect(r.pending).toBe(true);
    expect(r.liveUrl).toBeNull();                      // model URL never stored (verifier fetch would follow redirects → SSRF)
    expect(r.notes).toContain('claimed:https://x.com/biz/waves'); // kept only as a non-fetched evidence note
    expect(log).toContainEqual(['fill', '#name', 'Waves']);
  });

  test('P1: an OFF-host claimed live_url is not even kept in the note', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: true, pending: false, live_url: 'http://169.254.169.254/latest/meta-data/' },
      ),
    }));
    expect(r.outcome).toBe('placed');
    expect(r.liveUrl).toBeNull();
    expect(r.pending).toBe(true);
    expect(r.notes || '').not.toContain('169.254'); // off-host URL not surfaced anywhere
  });

  test('P1: a failed pre-submit field action ABORTS before submit (fail-closed, never submitted)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log, { failFillSel: '#name' }),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#name', value: 'Waves' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('field_action_failed');
    expect(log.find((a) => a[0] === 'click')).toBeUndefined(); // submit never clicked
  });

  test('P1: unconfirmed BUT a submit request reached the pinned host → placed+pending, NOT retryable', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log, { submitReq: { method: 'POST', url: 'https://x.com/submit' } }), // on-host POST = evidence it landed
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: false, pending: false, rejected: false, live_url: null }, // unconfirmed
      ),
    }));
    expect(r.outcome).toBe('placed'); // network evidence the POST reached the host → never auto-retry (no dup)
    expect(r.pending).toBe(true);
    expect(log).toContainEqual(['click', '#go']);
  });

  test('P1: submit clicked but NO submission request observed + unconfirmed → no_submit_evidence (retryable, not stranded as placed)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log), // no submitReq → no request reached the host (no-op/next-step button)
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: false, pending: false, rejected: false, live_url: null },
      ),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_submit_evidence');
  });

  test('P2: an off-host submit request → submit_blocked (nothing reached the directory)', async () => {
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([], { submitReq: { method: 'POST', url: 'https://evil.example/submit' } }), // POST goes off-host → aborted
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: false, pending: false, rejected: false, live_url: null },
      ),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('submit_blocked');
  });

  test('P2: a STRING "true" from the verifier is NOT treated as confirmed (strict booleans only)', async () => {
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([]), // no submit request dispatched
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: 'true', pending: 'false', rejected: 'false', live_url: null }, // strings, not booleans
      ),
    }));
    // "true" !== true → not confirmed, and nothing reached the host → must NOT be placed
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_submit_evidence');
  });

  test('P2: a clear post-submit REJECTION page → submit_rejected, not placed (verifier won’t poll a phantom)', async () => {
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([], { submitReq: { method: 'POST', url: 'https://x.com/submit' } }),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: false, pending: false, rejected: true, live_url: null }, // directory showed a validation/error page
      ),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('submit_rejected');
  });

  test('P1: a post-submit verification THROW with a dispatched submit still yields placed+pending (never retryable)', async () => {
    const log = [];
    let n = 0;
    // plan returns on call 1; the verify call (2) throws → must NOT become a retryable failure
    const anthropic = { messages: { create: async () => { n += 1; if (n === 1) return { content: [{ text: JSON.stringify({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }) }] }; throw new Error('anthropic 500'); } } };
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({ launchBrowser: async () => fakeBrowser(log, { submitReq: { method: 'POST', url: 'https://x.com/submit' } }), anthropic }));
    expect(r.outcome).toBe('placed');
    expect(r.pending).toBe(true);
    expect(log).toContainEqual(['click', '#go']); // the submit DID happen → never retry
  });

  test('P1: the submit click is dispatched with noWaitAfter (nav errors can’t make it retryable)', async () => {
    const clickOptsLog = [];
    await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([], { clickOptsLog }),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    const submitClick = clickOptsLog.find((c) => c[0] === '#go');
    expect(submitClick).toBeDefined();
    expect(submitClick[1]).toMatchObject({ noWaitAfter: true });
  });

  test('P1: a non-actionable submit button (click throws pre-dispatch) → submit_failed (retryable, nothing sent)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log, { failClickSel: '#go' }),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('submit_failed');
    expect(log).toContainEqual(['fill', '#n', 'W']); // fields filled, but submit never dispatched
  });

  test('P2: a pre-submit field action missing its selector → fail-closed (not submitted)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('field_action_failed');
    expect(log.find((a) => a[0] === 'click')).toBeUndefined(); // never submitted
  });

  test('P1: blocks service workers + arms a websocket egress guard (channels route() cannot cover)', async () => {
    const ctxOpts = {}; const wsLog = [];
    await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([], { ctxOpts, wsLog }),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    expect(ctxOpts.serviceWorkers).toBe('block');
    expect(wsLog).toContain('**/*'); // WebSocket routing armed
  });

  test('P1: an IPv6 pinned host is bracketed in --host-resolver-rules', async () => {
    let rules = null;
    await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, {
      resolveHostIps: async () => ['2606:4700:4700::1111'],
      launchBrowser: async (opts) => { rules = opts && opts.hostResolverRules; return fakeBrowser([]); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    });
    expect(rules).toContain('[2606:4700:4700::1111]');
  });

  test('prefers an IPv4 address for the pin when both v4 and v6 resolve', async () => {
    let rules = null;
    await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, {
      resolveHostIps: async () => ['2606:4700:4700::1111', '203.0.113.7'],
      launchBrowser: async (opts) => { rules = opts && opts.hostResolverRules; return fakeBrowser([]); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    });
    expect(rules).toContain('MAP x.com 203.0.113.7');
    expect(rules).not.toContain('[');
  });

  test('P2: pins the ACTUAL navigated host (www) to its OWN IP, not just the apex', async () => {
    let rules = null;
    await fillCitationForm({ submitUrl: 'https://www.x.com/add', nap, expectedHost: 'x.com' }, {
      resolveHostIps: async (h) => (h === 'www.x.com' ? ['203.0.113.8'] : ['203.0.113.7']),
      launchBrowser: async (opts) => { rules = opts && opts.hostResolverRules; return fakeBrowser([]); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    });
    expect(rules).toContain('MAP www.x.com 203.0.113.8'); // navigated host pinned to its own record
    expect(rules).toContain('MAP x.com 203.0.113.7');
  });

  test('P2: navigated host that does not resolve public → host_not_public, never launches', async () => {
    let launched = false;
    const r = await fillCitationForm({ submitUrl: 'https://www.x.com/add', nap, expectedHost: 'x.com' }, {
      resolveHostIps: async (h) => (h === 'www.x.com' ? [] : ['203.0.113.7']), // the host we'd navigate to has no public record
      launchBrowser: async () => { launched = true; return fakeBrowser([]); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [] }, {}),
    });
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('host_not_public');
    expect(launched).toBe(false);
  });

  test('P1: a planning LLM-call failure → llm_error (run-level; the runner aborts the batch, no attempt burned)', async () => {
    const anthropic = { messages: { create: async () => { throw new Error('anthropic 503'); } } }; // plan call throws
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([]),
      anthropic,
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('llm_error');
  });

  test('P1: a browser launch failure → no_browser (run-level; the runner aborts the batch)', async () => {
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => { throw new Error("Executable doesn't exist; run npx playwright install"); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [] }, {}),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_browser');
  });

  test('P1: a plan containing an unexpected action type (click) → plan_invalid, fail-closed (nothing filled/submitted)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'click', selector: 'button.btn-primary' }, { action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: true, pending: false, live_url: 'https://x.com/ok' },
      ),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('plan_invalid');
    expect(log).toHaveLength(0); // rejected before any action
  });

  test('P1: plan with no single final submit → failed up front, nothing filled', async () => {
    const log = [];
    // two submits → ambiguous; reject before touching the page
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'submit', selector: '#a' }, { action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#b' }] }, {}),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_submit');
    expect(log).toHaveLength(0); // rejected before any fill
  });

  test('a plan with a file upload (or any non-vocab action) → plan_invalid, never submitted', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'upload', selector: '#logo', file: 'logo' }, { action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: true, live_url: null },
      ),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('plan_invalid');
    expect(log).toHaveLength(0);
  });

  test('P1: a plan with blocked omitted/false (not null) + actions → plan_invalid, never fills (fail-closed)', async () => {
    const log = [];
    const omitted = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    expect(omitted.outcome).toBe('failed');
    expect(omitted.errorCode).toBe('plan_invalid');
    const falsey = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser([]),
      anthropic: fakeAnthropic({ form_present: true, blocked: false, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }, { success: true }),
    }));
    expect(falsey.errorCode).toBe('plan_invalid');
    expect(log).toHaveLength(0);
  });

  test('no submit action in plan → failed (never half-submits silently)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }] }, {}),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_submit');
  });

  test('no LLM client → failed (no blind submission)', async () => {
    const prev = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r = await fillCitationForm({ submitUrl: 'https://x.com', nap, expectedHost: 'x.com' }, deps({ launchBrowser: async () => fakeBrowser([]) }));
    expect(r.outcome).toBe('failed');
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });

  test('missing expectedHost → failed (browser is pinned + egress-locked to it)', async () => {
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap }, deps({
      launchBrowser: async () => fakeBrowser([]),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [] }),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_expected_host');
  });

  test('host that does not resolve to a public IP → failed, browser never launched', async () => {
    let launched = false;
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, {
      resolveHostIps: async () => [], // private/unresolvable → fail closed
      launchBrowser: async () => { launched = true; return fakeBrowser([]); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [] }),
    });
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('host_not_public');
    expect(launched).toBe(false);
  });

  test('off-host redirect → failed, before any model call or fill', async () => {
    const log = [];
    let called = 0;
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log, { landedUrl: 'https://evil.example/add' }),
      anthropic: { messages: { create: async () => { called += 1; return { content: [{ text: '{}' }] }; } } },
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('offsite_redirect');
    expect(called).toBe(0); // never sent a screenshot to the model
    expect(log).toHaveLength(0);
  });

  test('only fill/select/check/submit are allowed actions (no click/upload)', () => {
    expect([..._internals.ALLOWED_ACTIONS].sort()).toEqual(['check', 'fill', 'select', 'submit']);
  });
});

describe('requestAllowed (egress lock — EXACTLY the pinned host set)', () => {
  const { requestAllowed } = _internals;
  const both = new Set(['x.com', 'www.x.com']); // apex + www both pinned
  const apexOnly = new Set(['x.com']);          // www could NOT be pinned
  test('allows an exact pinned host (apex or www when both pinned)', () => {
    expect(requestAllowed({ url: 'https://x.com/add', allowedHosts: both })).toBe(true);
    expect(requestAllowed({ url: 'https://www.x.com/add', allowedHosts: both })).toBe(true);
  });
  test('P0: blocks an UNPINNED sibling even on the same registrable domain', () => {
    // www not in the pin set → must be refused (else Chromium would do its own lookup → rebinding)
    expect(requestAllowed({ url: 'https://www.x.com/add', allowedHosts: apexOnly })).toBe(false);
  });
  test('blocks any off-host request (no off-host sub-resources → no exfil channel)', () => {
    expect(requestAllowed({ url: 'https://cdn.other.com/a.css', allowedHosts: both })).toBe(false);
    expect(requestAllowed({ url: 'https://evil.example/x', allowedHosts: both })).toBe(false);
  });
  test('blocks an unpinned sub-domain and a look-alike host', () => {
    expect(requestAllowed({ url: 'https://listings.x.com/biz', allowedHosts: both })).toBe(false);
    expect(requestAllowed({ url: 'https://notx.com/add', allowedHosts: both })).toBe(false);
  });
  test('blocks localhost / metadata IP-literal hosts', () => {
    expect(requestAllowed({ url: 'http://169.254.169.254/latest/meta-data/', allowedHosts: both })).toBe(false);
    expect(requestAllowed({ url: 'http://localhost:8080/x', allowedHosts: both })).toBe(false);
  });
  test('blocks garbage / empty urls and a missing pin set', () => {
    expect(requestAllowed({ url: 'not a url', allowedHosts: both })).toBe(false);
    expect(requestAllowed({ url: '', allowedHosts: both })).toBe(false);
    expect(requestAllowed({ url: 'https://x.com/add', allowedHosts: null })).toBe(false);
  });
});

describe('resolvePublicIps (DNS pin source, fail-closed)', () => {
  const { resolvePublicIps } = _internals;
  test('returns a public IP literal as-is', async () => {
    expect(await resolvePublicIps('8.8.8.8')).toEqual(['8.8.8.8']);
  });
  test('rejects a private/loopback IP literal → []', async () => {
    expect(await resolvePublicIps('127.0.0.1')).toEqual([]);
    expect(await resolvePublicIps('169.254.169.254')).toEqual([]);
    expect(await resolvePublicIps('10.0.0.5')).toEqual([]);
  });
  test('P2: rejects non-global special-use ranges (benchmark/TEST-NET/multicast/reserved), not just RFC1918', async () => {
    expect(await resolvePublicIps('198.18.0.1')).toEqual([]);   // 198.18/15 benchmark
    expect(await resolvePublicIps('198.51.100.7')).toEqual([]); // TEST-NET-2
    expect(await resolvePublicIps('203.0.113.7')).toEqual([]);  // TEST-NET-3
    expect(await resolvePublicIps('192.0.2.7')).toEqual([]);    // TEST-NET-1
    expect(await resolvePublicIps('224.0.0.1')).toEqual([]);    // multicast
    expect(await resolvePublicIps('240.0.0.1')).toEqual([]);    // reserved
    expect(await resolvePublicIps('1.1.1.1')).toEqual(['1.1.1.1']); // genuinely global → kept
  });
  test('P1: rejects IPv4-translating/tunneling IPv6 prefixes (NAT64/6to4/Teredo embed an IPv4)', async () => {
    expect(await resolvePublicIps('64:ff9b::a9fe:a9fe')).toEqual([]);   // NAT64 embedding 169.254.169.254
    expect(await resolvePublicIps('2002:c0a8:0101::')).toEqual([]);     // 6to4 embedding 192.168.1.1
    expect(await resolvePublicIps('2001:0:abcd::')).toEqual([]);        // Teredo
    expect(await resolvePublicIps('2606:4700:4700::1111')).toEqual(['2606:4700:4700::1111']); // genuine global IPv6 → kept
  });
  test('empty host → []', async () => {
    expect(await resolvePublicIps('')).toEqual([]);
  });
});
