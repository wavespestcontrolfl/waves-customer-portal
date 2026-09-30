jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({})),
}));
jest.mock('../models/db', () => {
  const qb = () => { throw new Error('db must not be touched when loadWeek is injected'); };
  return qb;
});

const {
  runCallBookingLinkWeeklyCheck,
  _private: { composeWeeklyCheck, dedupeKeyFor, reasonLabel, SUMMARY_MAX },
} = require('../services/call-booking-link-weekly-check');

const NOW = new Date('2026-10-05T12:19:00.000Z'); // Monday 8:19 AM ET
const FRESH_JOB = { last_success_at: new Date(NOW.getTime() - 3 * 60 * 1000), consecutive_failures: 0 };

function skipped(reason, n) {
  return Array.from({ length: n }, () => ({ status: 'skipped', reason }));
}

describe('composeWeeklyCheck', () => {
  test('healthy week: sent count headline, calls checked and top two skips', () => {
    const rows = [
      { status: 'sent', reason: null }, { status: 'sent', reason: null },
      ...skipped('existing_customer', 14), ...skipped('no_lead_linkage', 5), ...skipped('quote_promised', 2),
    ];
    const out = composeWeeklyCheck({ rows, job: FRESH_JOB }, NOW);
    expect(out.headline).toBe('Booking-link texts: 2 sent this week');
    expect(out.summary).toBe('23 calls checked · top skips: existing customer 14, no lead 5');
    expect(out.problem).toBe(false);
  });

  test('no sends: "none sent this week"', () => {
    const out = composeWeeklyCheck({ rows: skipped('existing_customer', 3), job: FRESH_JOB }, NOW);
    expect(out.headline).toBe('Booking-link texts: none sent this week');
    expect(out.summary).toBe('3 calls checked · top skips: existing customer 3');
  });

  test('no calls at all', () => {
    const out = composeWeeklyCheck({ rows: [], job: FRESH_JOB }, NOW);
    expect(out.headline).toBe('Booking-link texts: none sent this week');
    expect(out.summary).toBe('No new-lead calls to check');
  });

  test('pre-activation skips are not counted', () => {
    const out = composeWeeklyCheck({ rows: [...skipped('pre_activation', 30), ...skipped('existing_customer', 1)], job: FRESH_JOB }, NOW);
    expect(out.summary).toBe('1 call checked · top skips: existing customer 1');
  });

  test('stuck sends, errors and a stale sweep make it a problem', () => {
    const rows = [
      { status: 'pending', reason: null, send_at: new Date(NOW.getTime() - 30 * 3600 * 1000).toISOString() },
      { status: 'ambiguous', reason: 'ambiguous_provider_outcome' },
      { status: 'skipped', reason: 'worker_error' },
      ...skipped('existing_customer', 4),
    ];
    const job = { last_success_at: new Date(NOW.getTime() - 3 * 3600 * 1000), consecutive_failures: 2 };
    const out = composeWeeklyCheck({ rows, job }, NOW);
    expect(out.headline).toBe('Booking-link texts need a look');
    expect(out.summary).toBe('1 stuck · 2 errors · last run 3h ago');
    expect(out.problem).toBe(true);
  });

  test('a pending send still inside 24h is not stuck', () => {
    const rows = [{ status: 'pending', reason: null, send_at: new Date(NOW.getTime() - 60 * 1000).toISOString() }];
    expect(composeWeeklyCheck({ rows, job: FRESH_JOB }, NOW).problem).toBe(false);
  });

  test('a sweep that never ran is a problem', () => {
    const out = composeWeeklyCheck({ rows: [], job: null }, NOW);
    expect(out.headline).toBe('Booking-link texts need a look');
    expect(out.summary).toBe('never ran');
  });

  test('a failing but recent sweep says the last run failed', () => {
    const out = composeWeeklyCheck({ rows: [], job: { ...FRESH_JOB, consecutive_failures: 1 } }, NOW);
    expect(out.summary).toBe('last run failed');
  });

  test('summary never exceeds the bell limit', () => {
    const rows = [
      ...skipped('triage_flag_hoa_common_area_requires_approval_and_a_very_long_reason_name', 9),
      ...skipped('another_extremely_long_reason_name_that_keeps_going_and_going_forever', 8),
    ];
    const out = composeWeeklyCheck({ rows, job: FRESH_JOB }, NOW);
    expect(out.summary.length).toBeLessThanOrEqual(SUMMARY_MAX);
  });

  test('wording carries no emoji, column names or gate names', () => {
    const out = composeWeeklyCheck({ rows: [...skipped('no_lead_linkage', 2)], job: FRESH_JOB }, NOW);
    expect(`${out.headline} ${out.summary}`).not.toMatch(/GATE_|_|[\u{1F300}-\u{1FAFF}]/u);
  });
});

describe('reasonLabel', () => {
  test('maps known reasons and falls back to spaced words', () => {
    expect(reasonLabel('sms_declined_earlier_call')).toBe('said no texts before');
    expect(reasonLabel('triage_flag_out_of_service_area')).toBe('out of service area');
    expect(reasonLabel('some_new_reason')).toBe('some new reason');
  });
});

describe('dedupeKeyFor', () => {
  test('one key per ET week', () => {
    const monday = dedupeKeyFor(NOW);
    expect(dedupeKeyFor(new Date('2026-10-07T15:00:00.000Z'))).toBe(monday);
    expect(dedupeKeyFor(new Date('2026-10-12T12:19:00.000Z'))).not.toBe(monday);
  });
});

describe('runCallBookingLinkWeeklyCheck', () => {
  test('skips when the lane is off', async () => {
    await expect(runCallBookingLinkWeeklyCheck({ gateEnabled: false })).resolves.toEqual({ skipped: 'disabled' });
  });

  test('posts every week to the owner, with the week in the item identity', async () => {
    const deliver = jest.fn(async () => ({ ok: true, channel: 'in_app' }));
    const res = await runCallBookingLinkWeeklyCheck({
      now: NOW, gateEnabled: true, deliver,
      loadWeek: async () => ({ rows: skipped('existing_customer', 2), job: FRESH_JOB }),
    });
    expect(res.sent).toBe(true);
    const args = deliver.mock.calls[0][0];
    expect(args.audience).toBe('owner');
    expect(args.headline).toBe('Booking-link texts: none sent this week');
    expect(args.summary).toBe('2 calls checked · top skips: existing customer 2');
    expect(args.dedupeKey).toBe(dedupeKeyFor(NOW));
    expect(args.itemKeys).toHaveLength(1);
    expect(args.ringOnFirstIdentity).toBe(true);
    expect(typeof args.sendEmail).toBe('function');
  });

  test('a failed query is reported, not posted', async () => {
    const deliver = jest.fn();
    const res = await runCallBookingLinkWeeklyCheck({
      now: NOW, gateEnabled: true, deliver, loadWeek: async () => { throw new Error('boom'); },
    });
    expect(res).toEqual({ skipped: 'query_failed' });
    expect(deliver).not.toHaveBeenCalled();
  });

  test('a delivery that reports not ok is an error', async () => {
    const res = await runCallBookingLinkWeeklyCheck({
      now: NOW, gateEnabled: true, deliver: async () => ({ ok: false }),
      loadWeek: async () => ({ rows: [], job: FRESH_JOB }),
    });
    expect(res.error).toBe(true);
  });
});
