const { fillCitationForm, _internals } = require('../services/seo/browser-form-filler');

// Fake Playwright page/browser that records actions and serves canned screenshots.
function fakeBrowser(actionsLog) {
  const page = {
    goto: async () => {}, waitForTimeout: async () => {}, waitForLoadState: async () => {},
    screenshot: async () => Buffer.from('png'),
    fill: async (sel, val) => actionsLog.push(['fill', sel, val]),
    selectOption: async (sel, val) => actionsLog.push(['select', sel, val]),
    check: async (sel) => actionsLog.push(['check', sel]),
    click: async (sel) => actionsLog.push(['click', sel]),
  };
  const ctx = { newPage: async () => page };
  return { newContext: async () => ctx, close: async () => {} };
}
// Fake Claude: first call (plan) then second call (verify).
function fakeAnthropic(planObj, verifyObj) {
  let n = 0;
  return { messages: { create: async () => { n += 1; return { content: [{ text: JSON.stringify(n === 1 ? planObj : verifyObj) }] }; } } };
}
const nap = { business_name: 'Waves Pest Control', website: 'https://wavespestcontrol.com', email: 'contact@wavespestcontrol.com', phone: '(941) 318-7612', address: { street: 'x', city: 'Bradenton', state: 'FL', zip: '34211' }, category: 'Pest Control', description: 'desc' };

describe('fillCitationForm', () => {
  test('blocked (account/captcha/payment) → fail-closed, no actions executed', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap }, {
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, blocked: 'captcha', actions: [] }),
    });
    expect(r.outcome).toBe('blocked_captcha');
    expect(log).toHaveLength(0); // never filled anything
  });

  test('free form → fills allowed actions, submits, confirms → placed', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap }, {
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#name', value: 'Waves' }, { action: 'submit', selector: '#go' }] },
        { success: true, pending: false, live_url: 'https://x.com/biz/waves' },
      ),
    });
    expect(r.outcome).toBe('placed');
    expect(r.liveUrl).toBe('https://x.com/biz/waves');
    expect(log).toContainEqual(['fill', '#name', 'Waves']);
  });

  test('ignores non-allowlisted action types (e.g. upload) the model might emit', async () => {
    const log = [];
    await fillCitationForm({ submitUrl: 'https://x.com/add', nap }, {
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic(
        { form_present: true, blocked: null, actions: [{ action: 'upload', selector: '#logo', file: 'logo' }, { action: 'fill', selector: '#n', value: 'W' }, { action: 'submit', selector: '#go' }] },
        { success: true, live_url: null },
      ),
    });
    expect(log.find((a) => a[0] === 'upload')).toBeUndefined(); // upload never executed
    expect(log).toContainEqual(['fill', '#n', 'W']);
  });

  test('no submit action in plan → failed (never half-submits silently)', async () => {
    const log = [];
    const r = await fillCitationForm({ submitUrl: 'https://x.com/add', nap }, {
      launchBrowser: async () => fakeBrowser(log),
      anthropic: fakeAnthropic({ form_present: true, blocked: null, actions: [{ action: 'fill', selector: '#n', value: 'W' }] }, {}),
    });
    expect(r.outcome).toBe('failed');
    expect(r.errorCode).toBe('no_submit');
  });

  test('no LLM client → failed (no blind submission)', async () => {
    const prev = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
    const r = await fillCitationForm({ submitUrl: 'https://x.com', nap }, { launchBrowser: async () => fakeBrowser([]) });
    expect(r.outcome).toBe('failed');
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  });

  test('only fill/select/check/click/submit are allowed actions', () => {
    expect([..._internals.ALLOWED_ACTIONS].sort()).toEqual(['check', 'click', 'fill', 'select', 'submit']);
  });
});
