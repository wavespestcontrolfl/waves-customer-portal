const { fillCitationForm, _internals } = require('../services/seo/browser-form-filler');

// Fake Playwright page/browser that records actions and serves canned screenshots.
// failFillSel: a selector whose fill() throws (fail-closed pre-submit path).
// failClickSel: a selector whose click() throws (submit not actionable).
// ctxOpts: captures newContext(options); wsLog: records routeWebSocket patterns;
// clickOptsLog: records [selector, options] for clicks that pass options.
function fakeBrowser(actionsLog, { landedUrl = 'https://x.com/add', failFillSel = null, failClickSel = null, ctxOpts = null, wsLog = null, clickOptsLog = null } = {}) {
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {},
    url: () => landedUrl,
    screenshot: async () => Buffer.from('png'),
    fill: async (sel, val) => { if (sel === failFillSel) throw new Error('selector not found'); actionsLog.push(['fill', sel, val]); },
    selectOption: async (sel, val) => actionsLog.push(['select', sel, val]),
    check: async (sel) => actionsLog.push(['check', sel]),
    click: async (sel, opts) => { if (sel === failClickSel) throw new Error('element not actionable'); if (clickOptsLog && opts) clickOptsLog.push([sel, opts]); actionsLog.push(['click', sel]); },
  };
  const ctx = { newPage: async () => page, route: async () => {} };
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

  test('P1: submit clicked but confirmation UNRECOGNIZED → placed+pending, NOT retryable failed', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: false, pending: false, live_url: null }, // unconfirmed
      ),
    }));
    expect(r.outcome).toBe('placed'); // once submit is clicked we never auto-retry (would risk a duplicate)
    expect(r.pending).toBe(true);
    expect(r.notes).toContain('unconfirmed');
    expect(log).toContainEqual(['click', '#go']); // submit did happen
  });

  test('P1: a post-submit verification THROW still yields placed+pending (never falls to retryable failed)', async () => {
    const log = [];
    let n = 0;
    // plan returns on call 1; the verify call (2) throws → must NOT become a retryable failure
    const anthropic = { messages: { create: async () => { n += 1; if (n === 1) return { content: [{ text: JSON.stringify({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] }) }] }; throw new Error('anthropic 500'); } } };
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({ launchBrowser: async () => fakeBrowser(log), anthropic }));
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

  test('P1: a browser launch failure → no_browser (run-level; the runner aborts the batch)', async () => {
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => { throw new Error("Executable doesn't exist; run npx playwright install"); },
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [] }, {}),
    }));
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_browser');
  });

  test('P1: model-emitted clicks are never executed (only fill/select/check + final submit)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'click', selector: 'button.btn-primary' }, { action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: true, pending: false, live_url: 'https://x.com/ok' },
      ),
    }));
    expect(r.outcome).toBe('placed');
    expect(log.find((a) => a[1] === 'button.btn-primary')).toBeUndefined(); // arbitrary click never fired
    expect(log).toContainEqual(['fill', '#n', 'W']);
    expect(log).toContainEqual(['click', '#go']); // only the explicit final submit pressed a button
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

  test('ignores non-allowlisted action types (e.g. upload) the model might emit', async () => {
    const log = [];
    await fillCitationForm({ submitUrl: 'https://x.com/add', nap, expectedHost: 'x.com' }, deps({
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'upload', selector: '#logo', file: 'logo' }, { action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: true, live_url: null },
      ),
    }));
    expect(log.find((a) => a[0] === 'upload')).toBeUndefined(); // upload never executed
    expect(log).toContainEqual(['fill', '#n', 'W']);
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

describe('requestAllowed (egress lock — pinned host only)', () => {
  const { requestAllowed } = _internals;
  test('allows the pinned apex host', () => {
    expect(requestAllowed({ url: 'https://x.com/add', expectedHost: 'x.com' })).toBe(true);
  });
  test('allows www of the pinned host (pinned to the same IP)', () => {
    expect(requestAllowed({ url: 'https://www.x.com/add', expectedHost: 'x.com' })).toBe(true);
  });
  test('blocks any off-host request (no off-host sub-resources → no exfil channel)', () => {
    expect(requestAllowed({ url: 'https://cdn.other.com/a.css', expectedHost: 'x.com' })).toBe(false);
    expect(requestAllowed({ url: 'https://evil.example/x', expectedHost: 'x.com' })).toBe(false);
  });
  test('blocks an unpinned sub-domain (only apex/www are pinned)', () => {
    expect(requestAllowed({ url: 'https://listings.x.com/biz', expectedHost: 'x.com' })).toBe(false);
  });
  test('blocks a look-alike host that merely ends with the string', () => {
    expect(requestAllowed({ url: 'https://notx.com/add', expectedHost: 'x.com' })).toBe(false);
  });
  test('blocks localhost / metadata IP-literal hosts', () => {
    expect(requestAllowed({ url: 'http://169.254.169.254/latest/meta-data/', expectedHost: 'x.com' })).toBe(false);
    expect(requestAllowed({ url: 'http://localhost:8080/x', expectedHost: 'x.com' })).toBe(false);
  });
  test('blocks garbage / empty urls', () => {
    expect(requestAllowed({ url: 'not a url', expectedHost: 'x.com' })).toBe(false);
    expect(requestAllowed({ url: '', expectedHost: 'x.com' })).toBe(false);
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
  test('empty host → []', async () => {
    expect(await resolvePublicIps('')).toEqual([]);
  });
});
