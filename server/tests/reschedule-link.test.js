/**
 * buildRescheduleLink's dead-link guard (plan C3/C6, 2026-09-28): a visit
 * that is otherwise self-serviceable but already starts inside the
 * self-serve MOVE notice window would 409 on /reschedule/:token, so the
 * builder must not mint (or hand back) a link for it — see the module's own
 * header comment for the full contract. Every OTHER refusal (no token,
 * grouped/frozen visit, unconfirmed dispatch-owned pending) has its own
 * coverage in reschedule-public.test.js; this file is scoped to the new
 * move-window behavior plus its previewOnly exemption, and to pinning that
 * the confirmation/24h reminder sends (appointment-reminders.js) carry the
 * guard's clause through unchanged (plan: "no logic change" there).
 */

const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const mockShortenOrPassthrough = jest.fn().mockResolvedValue('https://portal.test/l/fresh12345');
const mockExistingShortUrlFor = jest.fn().mockResolvedValue(null);
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: (...a) => mockShortenOrPassthrough(...a),
  existingShortUrlFor: (...a) => mockExistingShortUrlFor(...a),
  shortLinkBaseUrl: () => 'https://portal.test',
}));

// Only needed for the appointment-reminders wiring describe block below —
// harmless for the buildRescheduleLink-direct tests above it, which never
// touch these modules.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/customer-contact', () => ({
  getAppointmentContacts: jest.fn(() => []),
  isServiceContactRole: jest.fn(() => false),
  firstNameFrom: (name) => (name || '').split(' ')[0] || null,
  PREFS_UNAVAILABLE: Object.freeze({ __prefsUnavailable: true }),
}));
jest.mock('../services/appointment-email', () => ({
  sendAppointmentConfirmationEmail: jest.fn(async () => ({ ok: true })),
  sendAppointmentReminderEmail: jest.fn(async () => ({ ok: true })),
  sendTechEnRouteEmail: jest.fn(async () => ({ ok: true })),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({})) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), gateEnvValue: jest.fn(() => false) }));

const { buildRescheduleLink } = require('../services/reschedule-link');

// 2026-05-06T13:00:00Z = 9:00 AM ET (EDT, UTC-4) — matches the plan's own
// "09:00 booking of today's 10:00 visit" scenario.
const NOW = new Date('2026-05-06T13:00:00.000Z');

function svcRow(overrides = {}) {
  return {
    id: 'svc-1', customer_id: 'cust-1', reschedule_token: 'a'.repeat(64),
    source_action: null, status: 'confirmed', customer_confirmed: true, visit_id: null,
    ...overrides,
  };
}

// A real knex `.first('a', 'b')` returns ONLY the requested columns — a
// fixture-wide mockResolvedValue(row) would silently hand back fields the
// builder never actually selected, hiding exactly the bug the Claude
// fallback auditor caught in round 1 (window_end missing from the select
// list). This filters to the columns the call site actually asks for.
function mockSvc(row) {
  mockDb.mockImplementation(() => ({
    where: jest.fn().mockReturnThis(),
    first: jest.fn((...cols) => Promise.resolve(
      cols.length ? Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]])) : row,
    )),
  }));
}

describe('buildRescheduleLink dead-link guard (C3/C6)', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    mockShortenOrPassthrough.mockClear();
    mockExistingShortUrlFor.mockClear();
    mockExistingShortUrlFor.mockResolvedValue(null);
  });
  afterEach(() => jest.useRealTimers());

  test('a visit starting inside the default 24h move-notice window gets no URL — the reply/call clause instead', async () => {
    // 09:00 ET booking of TODAY's 10:00 ET visit — 1 hour out, deep inside
    // the default 24h move window.
    mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '10:00:00' }));
    await expect(buildRescheduleLink('svc-1')).resolves.toEqual({
      url: null, line: 'Need a change? Reply here or call.\n\n', tooSoonToMove: true,
    });
    expect(mockShortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('a visit 25 hours out clears the window and gets a real link', async () => {
    // 09:00 ET May 6 + 25h = 10:00 ET May 7 — one hour past the 24h floor.
    mockSvc(svcRow({ scheduled_date: '2026-05-07', window_start: '10:00:00' }));
    await expect(buildRescheduleLink('svc-1')).resolves.toEqual({
      url: 'https://portal.test/l/fresh12345',
      line: 'Reschedule here: https://portal.test/l/fresh12345\n\n',
    });
  });

  test('a MISSED visit (window already passed) still gets the link — it is being rebooked, not moved off a too-soon start', async () => {
    mockSvc(svcRow({ status: 'confirmed', scheduled_date: '2026-05-05', window_start: '09:00:00', window_end: '10:00:00' }));
    await expect(buildRescheduleLink('svc-1')).resolves.toEqual({
      url: 'https://portal.test/l/fresh12345',
      line: 'Reschedule here: https://portal.test/l/fresh12345\n\n',
    });
  });

  test('a same-day visit past window_start+2h but still inside its OWN window_end is not missed — window_end must be selected or this reads as missed and wrongly mints a link (claude fallback r1 P1)', async () => {
    // NOW = 09:00 ET. window_start 06:00 + 120min = 08:00 (already passed),
    // but window_end 10:00 is still ahead of now — eligibility()'s same-day
    // rule takes max(window_end, window_start+120), so this visit is NOT
    // missed. It is also trivially inside the move-notice window (its own
    // start is in the past), so it must get the reply/call clause, never a
    // URL — reschedule-public.js's own full-row read would refuse the move.
    mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '06:00:00', window_end: '10:00:00' }));
    await expect(buildRescheduleLink('svc-1')).resolves.toEqual({
      url: null, line: 'Need a change? Reply here or call.\n\n', tooSoonToMove: true,
    });
    expect(mockShortenOrPassthrough).not.toHaveBeenCalled();
  });

  test('a shorter configured move window re-admits the 1-hour-out visit', async () => {
    const prev = process.env.SELF_SERVE_MOVE_NOTICE_HOURS;
    process.env.SELF_SERVE_MOVE_NOTICE_HOURS = '0';
    try {
      mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '10:00:00' }));
      await expect(buildRescheduleLink('svc-1')).resolves.toMatchObject({ url: 'https://portal.test/l/fresh12345' });
    } finally {
      if (prev === undefined) delete process.env.SELF_SERVE_MOVE_NOTICE_HOURS;
      else process.env.SELF_SERVE_MOVE_NOTICE_HOURS = prev;
    }
  });

  test('the BOOK notice var (SELF_SERVE_NOTICE_HOURS) has no effect on this check — the split PR 2 fixed', async () => {
    const prev = process.env.SELF_SERVE_NOTICE_HOURS;
    process.env.SELF_SERVE_NOTICE_HOURS = '1';
    try {
      // Still 1 hour out — the (unset, default-24h) MOVE window still refuses.
      mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '10:00:00' }));
      await expect(buildRescheduleLink('svc-1')).resolves.toEqual({
        url: null, line: 'Need a change? Reply here or call.\n\n', tooSoonToMove: true,
      });
    } finally {
      if (prev === undefined) delete process.env.SELF_SERVE_NOTICE_HOURS;
      else process.env.SELF_SERVE_NOTICE_HOURS = prev;
    }
  });

  test("previewOnly skips the move-window check entirely (rain-out's advisory sheet counter is a staff surface, not self-serve)", async () => {
    mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '10:00:00' }));
    const { url } = await buildRescheduleLink('svc-1', { previewOnly: true });
    // Placeholder of a fresh mint's length — never the null/no-link verdict.
    expect(url).toMatch(/\/l\/x{10}$/);
  });

  test("assumeConfirmed skips the guard entirely (round-2 P1, claude fallback): rain-out's pre-move measurement reads the OLD, about-to-be-superseded slot, so checking it against the move window would refuse a link the customer's NEW slot may not deserve", async () => {
    // The row's CURRENT scheduled_date/window_start is deep inside the
    // move-notice window — exactly what a visit being rain-out-moved off a
    // too-soon slot looks like before the move commits.
    mockSvc(svcRow({
      source_action: 'ai_call_pipeline_followup', status: 'pending', customer_confirmed: false,
      scheduled_date: '2026-05-06', window_start: '10:00:00',
    }));
    mockExistingShortUrlFor.mockResolvedValueOnce('https://portal.test/l/existing');
    await expect(buildRescheduleLink('svc-1', { reuseExisting: true, assumeConfirmed: true })).resolves.toEqual({
      url: 'https://portal.test/l/existing', line: 'Reschedule here: https://portal.test/l/existing\n\n',
    });
  });

  test('reuseExisting and a fresh mint are both refused for the same in-window visit — the dead-link check runs before either', async () => {
    mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '10:00:00' }));
    mockExistingShortUrlFor.mockResolvedValueOnce('https://portal.test/l/existing');
    await expect(buildRescheduleLink('svc-1', { reuseExisting: true })).resolves.toEqual({
      url: null, line: 'Need a change? Reply here or call.\n\n', tooSoonToMove: true,
    });
    expect(mockExistingShortUrlFor).not.toHaveBeenCalled();
  });

  test('an unconfirmed dispatch-owned pending row still refuses via its own guard first, whatever the date', async () => {
    mockSvc(svcRow({
      source_action: 'ai_call_pipeline_followup', status: 'pending', customer_confirmed: false,
      scheduled_date: '2026-05-06', window_start: '10:00:00',
    }));
    await expect(buildRescheduleLink('svc-1')).resolves.toEqual({ url: null, line: '' });
  });
});

// The confirmation and 24h reminder call sites (appointment-reminders.js)
// make no logic change (plan §3.C) — they just pass buildRescheduleLink's
// `line` into the SAME {reschedule_line} template slot every other sender
// already uses. reschedule-link.js is deliberately left UNMOCKED here (the
// only difference from the mock list appointment-notification-channels.test
// uses) so this exercises the real chokepoint end to end; the synthetic
// getTemplate body stands in for the DB-backed sms_templates row — its
// exact copy is unrelated to this PR.
describe('confirmation + 24h reminder bodies carry the guard\'s clause, not a URL, inside the window', () => {
  const smsTemplatesRouter = require('../routes/admin-sms-templates');
  const { renderAppointmentPageTemplate } = require('../services/appointment-reminders');

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    mockShortenOrPassthrough.mockClear();
    mockExistingShortUrlFor.mockClear();
    mockExistingShortUrlFor.mockResolvedValue(null);
    smsTemplatesRouter.getTemplate.mockImplementation(async (_key, vars) => (
      'Hi {first_name}! Your {service_type} visit. {reschedule_line}'.replace(/\{(\w+)\}/g, (_m, k) => vars[k] ?? '')
    ));
  });
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.GATE_APPOINTMENT_PAGE;
  });

  test('appointment_confirmation body drops the URL and shows the reply/call line for a visit inside the window', async () => {
    mockSvc(svcRow({ scheduled_date: '2026-05-06', window_start: '10:00:00' }));
    const reschedule = await buildRescheduleLink('svc-1', { customerId: 'cust-1' });
    const body = await renderAppointmentPageTemplate(
      'appointment_confirmation', async () => ({}),
      { first_name: 'Ada', service_type: 'Quarterly Pest Control', reschedule_line: reschedule.line },
    );
    expect(body).toContain('Need a change? Reply here or call.');
    expect(body).not.toMatch(/https?:\/\//);
  });

  test('reminder_24h body carries the real link for a visit outside the window', async () => {
    mockSvc(svcRow({ scheduled_date: '2026-05-07', window_start: '10:00:00' }));
    const reschedule = await buildRescheduleLink('svc-1', { customerId: 'cust-1' });
    const body = await renderAppointmentPageTemplate(
      'reminder_24h', async () => ({}),
      { first_name: 'Ada', service_type: 'Quarterly Pest Control', reschedule_line: reschedule.line },
    );
    expect(body).toContain('Reschedule here: https://portal.test/l/fresh12345');
  });
});
