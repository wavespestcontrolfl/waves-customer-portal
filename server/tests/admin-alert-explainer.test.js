// The bell's "What to do" (GATE_ALERT_EXPLAINER, services/admin-alert-explainer.js): a model answer becomes a short
// summary only in the shape the bell shows, a summary is kept for the text it was written from and served again only
// for that text, a stamped who decides the fixer, a failed read falls back to the alert's own words without saving,
// and the bell list carries names and saved summaries only for the admin role while the gate is on. The database
// side (the version fence, the names) is admin-alert-explainer-db.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  getAdminNotificationForExplainer: jest.fn(),
  saveAdminExplainer: jest.fn(async () => 1),
  safeErrorSummary: jest.fn((err) => (err && err.code) || 'error'),
}));
jest.mock('../services/admin-alert-customer', () => ({ customersForAlerts: jest.fn(async () => new Map()) }));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));

const NotificationService = require('../services/notification-service');
const { customersForAlerts } = require('../services/admin-alert-customer');
const { dispatchWithFallback } = require('../services/llm/call');
const MODELS = require('../config/models');
const explainer = require('../services/admin-alert-explainer');

const { parseExplainer, promptText, fallbackExplainer } = explainer._private;

const ID = '00000000-0000-4000-8000-0000000000e1';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const VERSION = 'a'.repeat(32);
const answer = { happened: 'Jane Doe accepted a quarterly pest plan, but her schedule has 5 visits instead of 4.', steps: ['Open Jane Doe\'s schedule.', 'Remove the extra visit.'], fixer: 'you' };

const row = (over = {}) => ({
  id: ID,
  category: 'alert',
  title: 'Accepted recurring plan needs schedule review',
  body: 'The accepted pest control plan calls for quarterly service (4 applications).',
  detail: 'The accepted pest control plan calls for quarterly service (4 applications). The linked schedule has 5 working/completed applications.',
  link: `/admin/customers?customerId=${CUSTOMER_ID}`,
  metadata: { customer_id: CUSTOMER_ID },
  created_at: '2026-11-02T11:40:00Z',
  explainer: null,
  version: VERSION,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  explainer._private.recentFailures.clear();
  delete process.env.GATE_ALERT_EXPLAINER;
  delete process.env.GATE_ALERT_CUSTOMER_LINE;
  customersForAlerts.mockResolvedValue(new Map([[ID, { id: CUSTOMER_ID, name: 'Jane Doe' }]]));
  dispatchWithFallback.mockResolvedValue({ ok: true, json: answer, provider: 'anthropic', model: 'routine-model' });
});

describe('parseExplainer', () => {
  test('keeps the three parts the bell shows, tidied: emoji gone, empty steps dropped, at most three steps', () => {
    expect(parseExplainer({
      happened: '  Two estimates point at   the wrong property. 🙂 ',
      steps: ['Nothing for you: Claude can fix this.', '', 'Claude relinks both estimates.', 'Step three.', 'Step four.'],
      fixer: 'claude',
    })).toEqual({
      happened: 'Two estimates point at the wrong property.',
      steps: ['Nothing for you: Claude can fix this.', 'Claude relinks both estimates.', 'Step three.'],
      fixer: 'claude',
    });
  });

  test('a long part is cut at a word, never past its limit', () => {
    const parsed = parseExplainer({ happened: 'word '.repeat(200), steps: ['step '.repeat(100)], fixer: 'you' });
    expect(parsed.happened.length).toBeLessThanOrEqual(300);
    expect(parsed.steps[0].length).toBeLessThanOrEqual(160);
    expect(parsed.steps[0].endsWith('…')).toBe(true);
  });

  test.each([
    ['no happened', { steps: ['Open it.'], fixer: 'you' }],
    ['no steps', { happened: 'Something.', steps: [], fixer: 'you' }],
    ['only empty steps', { happened: 'Something.', steps: ['  '], fixer: 'you' }],
    ['an unknown fixer', { happened: 'Something.', steps: ['Open it.'], fixer: 'virginia' }],
    ['not an object', 'Something happened.'],
  ])('%s is not a summary', (_label, json) => {
    expect(parseExplainer(json)).toBeNull();
  });
});

describe('promptText', () => {
  test('carries the alert\'s words and the customer\'s name, and names the page without its ids', () => {
    const text = promptText(row(), { id: CUSTOMER_ID, name: 'Jane Doe' });
    expect(text).toContain('Headline: Accepted recurring plan needs schedule review');
    expect(text).toContain('The linked schedule has 5 working/completed applications.');
    expect(text).toContain('Customer: Jane Doe');
    expect(text).toContain('Page it opens: /admin/customers');
    expect(text).not.toContain(CUSTOMER_ID);
    expect(text).toContain('Raised: Mon, Nov 2 at 6:40 AM');
  });

  test('masks phone numbers, emails and street addresses in the alert\'s words, keeping its line breaks', () => {
    const text = promptText(row({
      title: 'Comms — call back 941-555-0123',
      body: 'Wrote from jane.doe@example.com about 421 Spring Ave.',
      detail: 'First line.\nCall 941-555-0123 or jane.doe@example.com.',
    }), { id: CUSTOMER_ID, name: 'Jane Doe' });
    expect(text).not.toMatch(/555-0123|jane\.doe@example\.com|421 Spring Ave/);
    expect(text).toContain('***0123');
    expect(text).toContain('[address]');
    expect(text).toContain('First line.\nCall');
    expect(text).toContain('Customer: Jane Doe');
  });

  test('says when no customer is named, and passes a stamped who as the answer to give', () => {
    const text = promptText(row({ metadata: { who: 'claude', area: 'System' } }), null);
    expect(text).toContain('Customer: none named');
    expect(text).toContain('Kind: alert, area System');
    expect(text).toContain('answer fixer "claude"');
  });
});

describe('explainAdminAlert', () => {
  test('a row out of scope or gone answers 404 and asks no model', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(null);
    expect(await explainer.explainAdminAlert(ID, { role: 'admin' })).toEqual({ status: 404, body: { error: 'not_found' } });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('a summary saved for this text is served again without a model call', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row({ explainer: { v: 1, version: VERSION, ...answer } }));
    expect(await explainer.explainAdminAlert(ID, { role: 'admin', technicianId: 'admin-1' })).toEqual({
      status: 200, body: { explainer: answer, customer: { id: CUSTOMER_ID, name: 'Jane Doe' }, version: VERSION },
    });
    expect(NotificationService.getAdminNotificationForExplainer).toHaveBeenCalledWith(ID, { role: 'admin', technicianId: 'admin-1' });
    expect(dispatchWithFallback).not.toHaveBeenCalled();
    expect(NotificationService.saveAdminExplainer).not.toHaveBeenCalled();
  });

  test('a summary of older text is written again on the routine lane and saved for the text shown now', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row({ explainer: { v: 1, version: 'b'.repeat(32), ...answer } }));
    const result = await explainer.explainAdminAlert(ID, { role: 'admin' });
    expect(result).toEqual({ status: 200, body: { explainer: answer, customer: { id: CUSTOMER_ID, name: 'Jane Doe' }, version: VERSION } });
    const [policy, payload, options] = dispatchWithFallback.mock.calls[0];
    expect(policy).toBe(MODELS.TEXT_POLICIES.routineAnswer);
    expect(payload).toEqual(expect.objectContaining({ laneId: 'alert_explainer', jsonMode: true, maxTokens: 700 }));
    expect(payload.text).toContain('Customer: Jane Doe');
    expect(options.validate({ json: { happened: 'x' } })).toBe('invalid_explainer');
    expect(options.validate({ json: answer })).toBeNull();
    expect(NotificationService.saveAdminExplainer).toHaveBeenCalledWith(ID, VERSION, expect.objectContaining({
      v: 1, version: VERSION, ...answer, provider: 'anthropic', model: 'routine-model',
    }));
  });

  test('a who the emitter stamped decides the fixer, whatever the model said', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row({ metadata: { who: 'person' } }));
    dispatchWithFallback.mockResolvedValue({ ok: true, json: { ...answer, fixer: 'claude' } });
    const result = await explainer.explainAdminAlert(ID, { role: 'admin' });
    expect(result.body.explainer.fixer).toBe('you');
  });

  test.each([
    ['both providers fail', () => dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' })],
    ['the dispatcher throws', () => dispatchWithFallback.mockRejectedValue(new Error('network'))],
  ])('%s: the alert\'s own words come back marked as a fallback, and nothing is saved', async (_label, arrange) => {
    arrange();
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row());
    const result = await explainer.explainAdminAlert(ID, { role: 'admin' });
    expect(result).toEqual({
      status: 200,
      body: {
        explainer: {
          happened: 'The accepted pest control plan calls for quarterly service (4 applications).',
          steps: ['Tap the alert to open the record it is about.'],
          fixer: 'you',
          fallback: true,
        },
        customer: { id: CUSTOMER_ID, name: 'Jane Doe' },
        version: VERSION,
      },
    });
    expect(NotificationService.saveAdminExplainer).not.toHaveBeenCalled();
  });

  test('a save the version fence refused (the text changed during the call) still names the text it was written for', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row());
    NotificationService.saveAdminExplainer.mockResolvedValueOnce(0);
    expect((await explainer.explainAdminAlert(ID, { role: 'admin' })).body).toEqual(expect.objectContaining({ explainer: answer, version: VERSION }));
  });

  test('a failed save logs only the error code, never the database message that carries the summary', async () => {
    const logger = require('../services/logger');
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row());
    NotificationService.saveAdminExplainer.mockRejectedValueOnce(Object.assign(new Error('insert into notifications ... "Jane Doe accepted a plan"'), { code: '57014' }));
    expect((await explainer.explainAdminAlert(ID, { role: 'admin' })).body.explainer).toEqual(answer);
    expect(logger.warn).toHaveBeenCalledWith('[alert-explainer] summary not saved: 57014');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Jane Doe');
  });

  test('a failed write is not tried again for a minute: opens in that minute get the alert\'s own words at once', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row());
    dispatchWithFallback.mockResolvedValue({ ok: false, reason: 'all_providers_failed' });
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    expect((await explainer.explainAdminAlert(ID, { role: 'admin' })).body.explainer.fallback).toBe(true);
    clock.mockReturnValue(start + explainer._private.FAILURE_COOLDOWN_MS - 1);
    expect((await explainer.explainAdminAlert(ID, { role: 'admin' })).body.explainer.fallback).toBe(true);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(start + explainer._private.FAILURE_COOLDOWN_MS);
    dispatchWithFallback.mockResolvedValue({ ok: true, json: answer });
    expect((await explainer.explainAdminAlert(ID, { role: 'admin' })).body.explainer).toEqual(answer);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(2);
    clock.mockRestore();
  });

  test('two opens of the same alert at once share one model call', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row());
    let release;
    dispatchWithFallback.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ ok: true, json: answer }); }));
    const first = explainer.explainAdminAlert(ID, { role: 'admin' });
    const second = explainer.explainAdminAlert(ID, { role: 'admin' });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.body.explainer).toEqual(answer);
    expect(b.body.explainer).toEqual(answer);
    expect(dispatchWithFallback).toHaveBeenCalledTimes(1);
    expect(NotificationService.saveAdminExplainer).toHaveBeenCalledTimes(1);
  });
});

describe('fallbackExplainer', () => {
  test('a row with no short text uses the first sentence of its full text, then its headline', () => {
    expect(fallbackExplainer(row({ body: null, detail: 'Two links are broken. Check them.\nMore.', link: null })).happened).toBe('Two links are broken.');
    expect(fallbackExplainer(row({ body: null, detail: null, link: null }))).toEqual({
      happened: 'Accepted recurring plan needs schedule review', steps: ['Read the original text below.'], fixer: 'you', fallback: true,
    });
  });
});

describe('withExplainerFields (the bell list)', () => {
  const listed = () => [
    row({ explainer: { v: 1, version: VERSION, ...answer, provider: 'anthropic' } }),
    row({ id: '00000000-0000-4000-8000-0000000000e2', explainer: { v: 1, version: 'c'.repeat(32), ...answer } }),
  ];

  test('gate off: the stored column is dropped and nothing is added', async () => {
    const rows = await explainer.withExplainerFields(listed(), { role: 'admin' });
    rows.forEach((r) => {
      expect(r).not.toHaveProperty('explainer');
      expect(r).not.toHaveProperty('explainable');
      expect(r).not.toHaveProperty('customer');
    });
    expect(customersForAlerts).not.toHaveBeenCalled();
  });

  test('gate on, a technician: the same as off', async () => {
    process.env.GATE_ALERT_EXPLAINER = 'true';
    const rows = await explainer.withExplainerFields(listed(), { role: 'technician' });
    expect(rows.some((r) => 'explainable' in r || 'explainer' in r || 'customer' in r)).toBe(false);
  });

  test('gate on, an admin: every row is explainable, a named customer rides along, and only a summary of the text shown is served', async () => {
    process.env.GATE_ALERT_EXPLAINER = 'true';
    const [first, second] = await explainer.withExplainerFields(listed(), { role: 'admin' });
    expect(first).toEqual(expect.objectContaining({ explainable: true, customer: { id: CUSTOMER_ID, name: 'Jane Doe' }, explainer: answer }));
    expect(second.explainable).toBe(true);
    expect(second).not.toHaveProperty('explainer');
    expect(second).not.toHaveProperty('customer');
  });

  test('never marks a row sendToClaude, even with the send gate on: the list route does that for every admin row', async () => {
    process.env.GATE_ALERT_EXPLAINER = 'true';
    process.env.GATE_ALERT_SEND_TO_CLAUDE = 'true';
    try {
      const rows = await explainer.withExplainerFields(listed(), { role: 'admin' });
      expect(rows.some((r) => 'sendToClaude' in r)).toBe(false);
    } finally {
      delete process.env.GATE_ALERT_SEND_TO_CLAUDE;
    }
  });

  test('a failed name read still serves the rows', async () => {
    process.env.GATE_ALERT_EXPLAINER = 'true';
    customersForAlerts.mockRejectedValue(new Error('db down'));
    const rows = await explainer.withExplainerFields(listed(), { role: 'admin' });
    expect(rows).toHaveLength(2);
    expect(rows[0]).not.toHaveProperty('customer');
    expect(rows[0].explainable).toBe(true);
  });
});

describe('withExplainerFields, GATE_ALERT_CUSTOMER_LINE (the customer line without the AI summary)', () => {
  const listed = () => [
    row({ explainer: { v: 1, version: VERSION, ...answer, provider: 'anthropic' } }),
    row({ id: '00000000-0000-4000-8000-0000000000e2' }),
  ];
  afterEach(() => { delete process.env.GATE_ALERT_CUSTOMER_LINE; });

  test('explainer on: unchanged, the full shape, whatever the line gate says', async () => {
    process.env.GATE_ALERT_EXPLAINER = 'true';
    const withoutLine = await explainer.withExplainerFields(listed(), { role: 'admin' });
    process.env.GATE_ALERT_CUSTOMER_LINE = 'true';
    const withLine = await explainer.withExplainerFields(listed(), { role: 'admin' });
    expect(withLine).toEqual(withoutLine);
    expect(withLine[0]).toEqual(expect.objectContaining({ explainable: true, customer: { id: CUSTOMER_ID, name: 'Jane Doe' }, explainer: answer }));
  });

  test('explainer off, line on, admin: only `customer` is added, never explainable or explainer', async () => {
    process.env.GATE_ALERT_CUSTOMER_LINE = 'true';
    const rows = await explainer.withExplainerFields(listed(), { role: 'admin' });
    expect(customersForAlerts).toHaveBeenCalledTimes(1);
    expect(rows[0]).toEqual({ ...listed()[0], explainer: undefined, customer: { id: CUSTOMER_ID, name: 'Jane Doe' } });
    rows.forEach((r) => {
      expect(r).not.toHaveProperty('explainable');
      expect(r).not.toHaveProperty('explainer');
    });
    // The second row names nobody (the fake knows only the first id): served bare, no customer key.
    expect(rows[1]).not.toHaveProperty('customer');
    expect(dispatchWithFallback).not.toHaveBeenCalled();
  });

  test('both off: byte-identical to the bare rows, and no name read', async () => {
    const rows = await explainer.withExplainerFields(listed(), { role: 'admin' });
    expect(rows).toEqual(listed().map(({ explainer: _s, ...r }) => r));
    expect(customersForAlerts).not.toHaveBeenCalled();
  });

  test('line on, not an admin: the same as off', async () => {
    process.env.GATE_ALERT_CUSTOMER_LINE = 'true';
    for (const role of ['technician', undefined]) {
      const rows = await explainer.withExplainerFields(listed(), { role });
      expect(rows.some((r) => 'explainable' in r || 'explainer' in r || 'customer' in r)).toBe(false);
    }
    expect(customersForAlerts).not.toHaveBeenCalled();
  });

  test('line on, a failed name read: the rows are served bare, nothing throws', async () => {
    process.env.GATE_ALERT_CUSTOMER_LINE = 'true';
    customersForAlerts.mockRejectedValue(new Error('db down'));
    const rows = await explainer.withExplainerFields(listed(), { role: 'admin' });
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => 'customer' in r || 'explainable' in r)).toBe(false);
  });

  test('line on, no rows: no name read', async () => {
    process.env.GATE_ALERT_CUSTOMER_LINE = 'true';
    expect(await explainer.withExplainerFields([], { role: 'admin' })).toEqual([]);
    expect(customersForAlerts).not.toHaveBeenCalled();
  });
});
