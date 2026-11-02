// "Send to Claude" (GATE_ALERT_SEND_TO_CLAUDE, services/admin-alert-send-to-claude.js): customer contact is never sent,
// a row is sent only at the version the bell served, the stamp names the customer from the record and carries the
// summary the owner saw, a refresh keeps a sent row in Claude's queue only while it is open (admin-alert-routing.js
// keepSentToClaude), and the bell list marks a row sendable only while both gates are on. The database side (the fenced
// write, the refresh, the list) is admin-alert-send-to-claude-db.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() }));
jest.mock('../services/notification-service', () => ({
  getAdminNotificationForExplainer: jest.fn(),
  getAdminNotificationState: jest.fn(),
  markAdminSentToClaude: jest.fn(async () => 1),
  safeErrorSummary: jest.fn((err) => (err && err.code) || 'error'),
}));
jest.mock('../services/admin-alert-customer', () => ({ customersForAlerts: jest.fn(async () => new Map()) }));

const NotificationService = require('../services/notification-service');
const { customersForAlerts } = require('../services/admin-alert-customer');
const { sendAdminAlertToClaude, sendRefusal, sentPatch } = require('../services/admin-alert-send-to-claude');
const { keepSentToClaude, SENT_TO_CLAUDE_CLASS } = require('../services/admin-alert-routing');
const { withExplainerFields } = require('../services/admin-alert-explainer');

const ID = '00000000-0000-4000-8000-0000000000f1';
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000c1';
const VERSION = 'a'.repeat(32);
const SUMMARY = { happened: 'Two estimates point at the wrong property.', steps: ['Nothing for you: Claude can fix this.'], fixer: 'claude' };

const row = (over = {}) => ({
  id: ID,
  category: 'system',
  title: 'Estimator data canary: county parser regression',
  body: 'The county parser failed on 3 of 5 sample addresses.',
  detail: null,
  link: '/admin/estimates',
  metadata: { severity: 'needs-you', who: 'person' },
  created_at: '2026-11-02T11:40:00Z',
  done_at: null,
  explainer: { v: 1, version: VERSION, ...SUMMARY },
  version: VERSION,
  ...over,
});

const gates = { GATE_ALERT_EXPLAINER: process.env.GATE_ALERT_EXPLAINER, GATE_ALERT_SEND_TO_CLAUDE: process.env.GATE_ALERT_SEND_TO_CLAUDE };
afterAll(() => {
  for (const [k, v] of Object.entries(gates)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

beforeEach(() => {
  jest.clearAllMocks();
  NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row());
  NotificationService.markAdminSentToClaude.mockResolvedValue(1);
  customersForAlerts.mockResolvedValue(new Map());
});

describe('sendRefusal', () => {
  test.each([
    ['a text', { category: 'inbound_sms' }],
    ['an email', { category: 'inbound_email' }],
    ['a missed call', { category: 'missed_call' }],
    ['a voicemail', { category: 'voicemail_callback' }],
    ['a new lead', { category: 'new_lead' }],
    ['a review', { category: 'review' }],
    ['a declared customer contact', { metadata: { contact: true } }],
    ['a declared follow-up we owe a customer', { metadata: { promise: true } }],
    ['the general internal alert', { metadata: { triggerKey: 'internal_admin_alert' } }],
    // Registry types whose rule declares contact or a promise, under an ordinary category: the row stores only the key.
    ['a self-booked re-service request', { category: 'schedule', metadata: { triggerKey: 'reservice_self_booked' } }],
    ['a reschedule request', { category: 'schedule', metadata: { triggerKey: 'appointment_reschedule_intent' } }],
    ['an overdue call commitment', { category: 'alert', metadata: { triggerKey: 'call_commitment_overdue' } }],
  ])('%s is customer contact and is never sent', (_label, over) => {
    expect(sendRefusal(row(over))).toBe('customer_contact');
  });

  test('every registry type that declares contact or a promise is refused under its own category', () => {
    const { TRIGGER_REGISTRY } = require('../services/notification-triggers');
    const declared = Object.entries(TRIGGER_REGISTRY).filter(([, t]) => t.rule?.contact === true || t.rule?.promise === true);
    expect(declared.length).toBeGreaterThan(0);
    for (const [key, t] of declared) expect([key, sendRefusal(row({ category: t.category, metadata: { triggerKey: key } }))]).toEqual([key, 'customer_contact']);
    // A registry fault with no such declaration can be sent.
    expect(sendRefusal(row({ metadata: { triggerKey: 'property_lookup_canary_failed' } }))).toBeNull();
  });

  test('a done row, a row already off the bell and a live alert are refused; an open bell row is not', () => {
    expect(sendRefusal(row({ done_at: '2026-11-02T12:00:00Z' }))).toBe('done');
    expect(sendRefusal(row({ metadata: { feed: 'activity', claudeQueue: SENT_TO_CLAUDE_CLASS } }))).toBe('not_in_bell');
    expect(sendRefusal({ id: 'live:overdue-invoices', category: 'billing' })).toBe('not_found');
    expect(sendRefusal(row())).toBeNull();
    // A customer-tied fault is the owner's to send: only customer contact stays with the owner.
    expect(sendRefusal(row({ category: 'schedule', metadata: { customerId: CUSTOMER_ID } }))).toBeNull();
  });
});

describe('sentPatch', () => {
  test('moves the row to Claude\'s queue and keeps its own who and severity for the record', () => {
    const patch = sentPatch(row(), { by: 'admin-1', customer: { id: CUSTOMER_ID, name: 'Jane Doe' }, summary: SUMMARY, at: new Date('2026-11-02T15:00:00Z') });
    expect(patch).toEqual({
      feed: 'activity',
      who: 'claude',
      severity: 'needs-you',
      claudeQueue: SENT_TO_CLAUDE_CLASS,
      sentToClaude: {
        at: '2026-11-02T15:00:00.000Z',
        by: 'admin-1',
        customer: { id: CUSTOMER_ID, name: 'Jane Doe' },
        summary: { happened: SUMMARY.happened, steps: SUMMARY.steps },
        was: { who: 'person', severity: 'needs-you' },
      },
    });
  });

  test('a broken row stays broken, an fyi row becomes work, and no customer or summary is null', () => {
    expect(sentPatch(row({ metadata: { severity: 'broken' } }), { by: 'a' }).severity).toBe('broken');
    const fyi = sentPatch(row({ metadata: { severity: 'fyi' } }), { by: 'a' });
    expect(fyi.severity).toBe('needs-you');
    expect(fyi.sentToClaude).toEqual(expect.objectContaining({ customer: null, summary: null, was: { who: null, severity: 'fyi' } }));
  });
});

describe('sendAdminAlertToClaude', () => {
  const send = (over = {}) => sendAdminAlertToClaude(ID, { version: VERSION, by: 'admin-1', role: 'admin', technicianId: 'admin-1', ...over });

  test('sends at the served version with the customer read from the record and the summary the owner saw', async () => {
    customersForAlerts.mockResolvedValue(new Map([[ID, { id: CUSTOMER_ID, name: 'Jane Doe' }]]));
    const out = await send();
    expect(out.status).toBe(200);
    expect(out.body).toEqual(expect.objectContaining({ sent: true }));
    expect(NotificationService.getAdminNotificationForExplainer).toHaveBeenCalledWith(ID, { role: 'admin', technicianId: 'admin-1' });
    const [id, version, patch] = NotificationService.markAdminSentToClaude.mock.calls[0];
    expect([id, version]).toEqual([ID, VERSION]);
    expect(patch.sentToClaude.customer).toEqual({ id: CUSTOMER_ID, name: 'Jane Doe' });
    expect(patch.sentToClaude.summary).toEqual({ happened: SUMMARY.happened, steps: SUMMARY.steps });
  });

  test('a summary written for other text is not carried', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValue(row({ explainer: { v: 1, version: 'b'.repeat(32), ...SUMMARY } }));
    await send();
    expect(NotificationService.markAdminSentToClaude.mock.calls[0][2].sentToClaude.summary).toBeNull();
  });

  test('a failed name read still sends, naming nobody', async () => {
    customersForAlerts.mockRejectedValue(Object.assign(new Error('boom'), { code: '57014' }));
    const out = await send();
    expect(out.status).toBe(200);
    expect(NotificationService.markAdminSentToClaude.mock.calls[0][2].sentToClaude.customer).toBeNull();
  });

  test('a missing row is 404, customer contact is 422, other text is 409; none of them writes', async () => {
    NotificationService.getAdminNotificationForExplainer.mockResolvedValueOnce(null);
    expect(await send()).toEqual({ status: 404, body: { error: 'not_found' } });
    NotificationService.getAdminNotificationForExplainer.mockResolvedValueOnce(row({ category: 'inbound_sms' }));
    expect(await send()).toEqual({ status: 422, body: { error: 'customer_contact' } });
    expect(await send({ version: 'b'.repeat(32) })).toEqual({ status: 409, body: { error: 'changed' } });
    expect(NotificationService.markAdminSentToClaude).not.toHaveBeenCalled();
  });

  test('a row that changed or closed between the read and the write is a 409 that says which', async () => {
    NotificationService.markAdminSentToClaude.mockResolvedValue(0);
    NotificationService.getAdminNotificationState.mockResolvedValueOnce({ done: true, version: VERSION });
    expect(await send()).toEqual({ status: 409, body: { error: 'done' } });
    NotificationService.getAdminNotificationState.mockResolvedValueOnce({ done: false, version: 'b'.repeat(32) });
    expect(await send()).toEqual({ status: 409, body: { error: 'changed' } });
    NotificationService.getAdminNotificationState.mockResolvedValueOnce(null);
    expect(await send()).toEqual({ status: 404, body: { error: 'not_found' } });
  });
});

describe('keepSentToClaude', () => {
  const sentMeta = { dedupeKey: 'k', ...sentPatch(row(), { by: 'admin-1' }) };

  test('an open sent row keeps the send\'s fields over a new emission; the emission\'s other fields still apply', () => {
    const emission = { dedupeKey: 'k', count: 4, feed: null, who: 'person', severity: 'needs-you' };
    expect(keepSentToClaude({ done_at: null }, sentMeta, emission)).toEqual({
      dedupeKey: 'k', count: 4, feed: 'activity', who: 'claude', severity: 'needs-you',
      claudeQueue: SENT_TO_CLAUDE_CLASS, sentToClaude: sentMeta.sentToClaude,
    });
  });

  test('a done sent row, a row routed by class, and an unsent row keep nothing', () => {
    const emission = { dedupeKey: 'k', count: 4 };
    expect(keepSentToClaude({ done_at: '2026-11-02T12:00:00Z' }, sentMeta, emission)).toBe(emission);
    expect(keepSentToClaude({ done_at: null }, { feed: 'activity', claudeQueue: 'sms-draft-canary', who: 'claude' }, emission)).toBe(emission);
    expect(keepSentToClaude({ done_at: null }, { who: 'person' }, emission)).toBe(emission);
  });
});

describe('the bell list marks a sendable row', () => {
  const listRows = () => [row(), row({ id: '00000000-0000-4000-8000-0000000000f2', category: 'inbound_sms' })];

  test('only while both gates are on, only for the admin role, never on customer contact', async () => {
    process.env.GATE_ALERT_EXPLAINER = 'true';
    process.env.GATE_ALERT_SEND_TO_CLAUDE = 'true';
    const served = await withExplainerFields(listRows(), { role: 'admin' });
    expect(served.map((r) => r.sendToClaude === true)).toEqual([true, false]);
    expect((await withExplainerFields(listRows(), { role: 'technician' })).some((r) => 'sendToClaude' in r)).toBe(false);

    process.env.GATE_ALERT_SEND_TO_CLAUDE = 'false';
    expect((await withExplainerFields(listRows(), { role: 'admin' })).some((r) => 'sendToClaude' in r)).toBe(false);
    process.env.GATE_ALERT_SEND_TO_CLAUDE = 'true';
    process.env.GATE_ALERT_EXPLAINER = 'false';
    expect((await withExplainerFields(listRows(), { role: 'admin' })).some((r) => 'sendToClaude' in r)).toBe(false);
  });
});
