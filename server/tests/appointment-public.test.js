/**
 * Customer appointment page — state gating, the calendar file's RFC 5545
 * shape, and the link-first SMS bodies' GSM-7 / segment budget.
 */

const mockDb = jest.fn();
mockDb.schema = { hasTable: jest.fn(async () => true) };
jest.mock('../models/db', () => mockDb);
jest.mock('../services/weather-forecast', () => ({
  getDailyRainOutlookBounded: jest.fn().mockResolvedValue(null),
}));
jest.mock('../services/tech-photo', () => ({
  resolveTechPhotoUrl: jest.fn().mockResolvedValue(null),
}));

const appointmentRouter = require('../routes/appointment-public');
const {
  pageState, confirmRaceVerdict, icsEscape, icsFold, STORM_NOTE_MIN_CHANCE,
  ARRIVAL_PROMISE_MINUTES, arrivalWindowLabel,
} = appointmentRouter._test;
const { ARRIVAL_WINDOW_MINUTES, arrivalWindowRange, formatSmsTimeRange } = require('../utils/sms-time-format');
const { smsLineFor } = require('../services/appointment-link');
const { TEMPLATES } = require('../models/migrations/20260801000010_appointment_page_sms_templates')._test;
const { detectEncoding, countSegments } = require('../services/messaging/segment-counter');

// Fixed "now": 2026-08-01 12:00 ET (16:00 UTC, EDT).
const NOW = new Date('2026-08-01T16:00:00.000Z');

describe('appointment page state', () => {
  test('terminal and live statuses each get their own customer-safe state', () => {
    expect(pageState({ status: 'completed', scheduled_date: '2026-08-05' }, NOW).state).toBe('completed');
    expect(pageState({ status: 'cancelled', scheduled_date: '2026-08-05' }, NOW).state).toBe('cancelled');
    expect(pageState({ status: 'canceled', scheduled_date: '2026-08-05' }, NOW).state).toBe('cancelled');
    expect(pageState({ status: 'en_route', scheduled_date: '2026-08-01' }, NOW).state).toBe('in_progress');
    expect(pageState({ status: 'on_site', scheduled_date: '2026-08-01' }, NOW).state).toBe('in_progress');
    expect(pageState({ status: 'no_show', scheduled_date: '2026-08-05' }, NOW).state).toBe('not_available');
    expect(pageState({ status: 'skipped', scheduled_date: '2026-08-05' }, NOW).state).toBe('not_available');
  });

  test('future pending/confirmed visits render the full card', () => {
    for (const status of ['pending', 'confirmed']) {
      expect(pageState({ status, scheduled_date: '2026-08-05', window_start: '09:00:00' }, NOW).state)
        .toBe('upcoming');
    }
  });

  test('a rescheduled row is a pending-rebook marker, never a live booking', () => {
    // The customer-portal request path keeps the OLD date/window on the row
    // while staff pick the replacement — rendering it as upcoming (or
    // serving its calendar file) would present a slot nobody will honor.
    expect(pageState({ status: 'rescheduled', scheduled_date: '2026-08-05', window_start: '09:00:00' }, NOW))
      .toEqual({ state: 'pending_rebook' });
  });

  test('a visit is past only after the QUOTED 2-hour arrival window, not the job block', () => {
    // 9:00 start -> promise runs to 11:00; at 12:00 ET it is past.
    expect(pageState({
      status: 'confirmed', scheduled_date: '2026-08-01', window_start: '09:00:00', window_end: '10:00:00',
    }, NOW).state).toBe('past');
    // 10:30 start -> promise runs to 12:30; at 12:00 ET the tech may still
    // legitimately arrive, so the card stays live.
    expect(pageState({
      status: 'confirmed', scheduled_date: '2026-08-01', window_start: '10:30:00', window_end: '11:00:00',
    }, NOW).state).toBe('upcoming');
    // Later today is plainly upcoming.
    expect(pageState({
      status: 'confirmed', scheduled_date: '2026-08-01', window_start: '15:00:00',
    }, NOW).state).toBe('upcoming');
  });

  test('the arrival range is the canonical helper, not a second implementation', () => {
    // AGENTS.md pins customer-facing arrival copy to arrivalWindowRange();
    // the page previously recomputed start+120 in the client, where the
    // formatting and the malformed-input handling could drift from the
    // reminders quoting the same window.
    expect(ARRIVAL_PROMISE_MINUTES).toBe(ARRIVAL_WINDOW_MINUTES);
    expect(arrivalWindowLabel('09:00')).toBe(formatSmsTimeRange(arrivalWindowRange('09:00')));
    expect(arrivalWindowLabel('09:00')).toBe('9:00 AM - 11:00 AM');
    expect(arrivalWindowLabel('13:30')).toBe('1:30 PM - 3:30 PM');
    // Wraps midnight the same way the canonical helper does.
    expect(arrivalWindowLabel('23:00')).toBe('11:00 PM - 1:00 AM');
    // Missing/malformed starts yield null, so the card omits the line
    // entirely rather than rendering a half-built range.
    for (const bad of [null, '', 'soon', '25:00']) {
      expect(arrivalWindowLabel(bad)).toBeNull();
    }
  });

  test('a windowless visit stays live until the end of its day', () => {
    expect(pageState({ status: 'pending', scheduled_date: '2026-08-01' }, NOW).state).toBe('upcoming');
    expect(pageState({ status: 'pending', scheduled_date: '2026-07-31' }, NOW).state).toBe('past');
  });
});

describe('calendar file', () => {
  test('escapes the RFC 5545 special characters', () => {
    expect(icsEscape('Pest Control; interior, exterior')).toBe('Pest Control\\; interior\\, exterior');
    expect(icsEscape('line one\nline two')).toBe('line one\\nline two');
    expect(icsEscape('back\\slash')).toBe('back\\\\slash');
  });

  test('folds long content lines to the 75-octet limit with continuation spaces', () => {
    const long = `DESCRIPTION:${'x'.repeat(200)}`;
    const folded = icsFold(long);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    expect(Buffer.byteLength(physical[0], 'utf8')).toBeLessThanOrEqual(75);
    for (const line of physical.slice(1)) {
      expect(line.startsWith(' ')).toBe(true);
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    // Unfolding (drop each continuation's single leading space) restores
    // the original content exactly — the property that makes a folded line
    // safe to emit.
    const unfolded = physical[0] + physical.slice(1).map((l) => l.slice(1)).join('');
    expect(unfolded).toBe(long);
  });

  test('short lines are left alone', () => {
    expect(icsFold('VERSION:2.0')).toBe('VERSION:2.0');
  });
});

describe('appointment link clause', () => {
  test('renders a clause with a trailing blank line, and collapses to empty without a URL', () => {
    expect(smsLineFor('https://wavespestcontrol.com/l/a81xk'))
      .toBe('Everything about your visit: https://wavespestcontrol.com/l/a81xk\n\n');
    expect(smsLineFor('https://x.test/l/a', 'View and confirm your appointment'))
      .toBe('View and confirm your appointment: https://x.test/l/a\n\n');
    expect(smsLineFor(null)).toBe('');
    expect(smsLineFor('')).toBe('');
  });
});

describe('link-first SMS bodies', () => {
  test('every seeded body is GSM-7 — a single non-GSM char would double the segment bill', () => {
    for (const tpl of TEMPLATES) {
      expect(detectEncoding(tpl.body).encoding).toBe('GSM_7');
    }
  });

  test('a representative render of each body fits 2 segments', () => {
    const link = 'https://wavespestcontrol.com/l/a81xk';
    const filled = {
      first_name: 'Riley',
      service_type: 'quarterly pest control',
      time: '9:00 AM',
      // The spoken arrival range the reminder body states outright
      // (spokenArrivalWindow — same shape both senders pass).
      window: 'between 9:00 AM and 11:00 AM',
      day: 'Sunday',
      date: 'Aug 2',
      appointment_line: `Everything about your visit: ${link}\n\n`,
      // The overwhelmingly common case: no card hold on the visit.
      card_hold_policy_line: '',
    };
    for (const tpl of TEMPLATES) {
      const rendered = tpl.body.replace(/\{(\w+)\}/g, (m, key) => (key in filled ? filled[key] : m));
      expect(rendered).not.toMatch(/\{\w+\}/); // every placeholder resolved
      expect(detectEncoding(rendered).encoding).toBe('GSM_7');
      expect(countSegments(rendered).segmentCount).toBeLessThanOrEqual(2);
    }
  });

  test('the 24h body still carries the card-hold fee disclosure placeholder', () => {
    const reminder = TEMPLATES.find((t) => t.template_key === 'reminder_24h_v2');
    expect(reminder.body).toContain('{card_hold_policy_line}');
    expect(reminder.variables).toContain('card_hold_policy_line');
  });
});

describe('storm note threshold', () => {
  test('matches the heavy-rain tier the booking chips use', () => {
    expect(STORM_NOTE_MIN_CHANCE).toBe(50);
  });
});

describe('confirm guards (codex r1)', () => {
  const { buildAppointmentLink } = require('../services/appointment-link');
  const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../services/call-booking-source-actions');

  test('pageState carries the in_progress phase so the page can say arrived vs on the way', () => {
    expect(pageState({ status: 'en_route', scheduled_date: '2026-08-01', window_start: '13:00' }, NOW))
      .toEqual({ state: 'in_progress', phase: 'en_route' });
    expect(pageState({ status: 'on_site', scheduled_date: '2026-08-01', window_start: '13:00' }, NOW))
      .toEqual({ state: 'in_progress', phase: 'on_site' });
  });

  test('link minting is a no-op while GATE_APPOINTMENT_PAGE is off', async () => {
    // Gate off (default): the page 404s and the v2 body never renders, so
    // minting a never-expiring short code for every legacy reminder would
    // be pure table growth (codex P2).
    const prev = process.env.GATE_APPOINTMENT_PAGE;
    delete process.env.GATE_APPOINTMENT_PAGE;
    try {
      const out = await buildAppointmentLink('svc-1', { customerId: 'c-1' });
      expect(out).toEqual({ url: null, line: '' });
      // and, critically, no DB read/insert happened on the gated path
      expect(mockDb).not.toHaveBeenCalledWith('short_codes');
    } finally {
      if (prev !== undefined) process.env.GATE_APPOINTMENT_PAGE = prev;
    }
  });

  test('dispatch-owned pending source actions are the shared invariant list', () => {
    // The public confirm route and GET `confirmable` flag both key on this
    // list — pin its members so a rename breaks loudly here.
    expect(DISPATCH_OWNED_PENDING_SOURCE_ACTIONS).toEqual(
      expect.arrayContaining(['ai_call_pipeline_followup', 'ai_call_outbound_review'])
    );
  });
});

describe('appointment link idempotent minting', () => {
  test('an existing appointment code is reused instead of minting a new row', async () => {
    // The page URL is deterministic per visit token, so one short code
    // serves every message about the visit — and an eagerly rendered body
    // whose SMS leg never runs (email-preference paths) costs at most one
    // reused row, never an orphan per render (codex r5).
    const { existingShortUrlFor } = require('../services/short-url');
    const calls = [];
    mockDb.mockImplementation((table) => {
      calls.push(table);
      const api = {
        where: () => api,
        orderBy: () => api,
        first: async () => (table === 'short_codes' ? { code: 'abc12' } : null),
      };
      return api;
    });
    const url = await existingShortUrlFor({ kind: 'appointment', entityType: 'scheduled_services', entityId: 'svc-1' });
    expect(url).toMatch(/\/l\/abc12$/);
    expect(calls).toContain('short_codes');
  });

  test('missing inputs and lookup misses return null (mint proceeds)', async () => {
    const { existingShortUrlFor } = require('../services/short-url');
    expect(await existingShortUrlFor({ kind: 'appointment', entityType: 'scheduled_services', entityId: null })).toBe(null);
    mockDb.mockImplementation(() => {
      const api = { where: () => api, orderBy: () => api, first: async () => null };
      return api;
    });
    expect(await existingShortUrlFor({ kind: 'appointment', entityType: 'scheduled_services', entityId: 'svc-2' })).toBe(null);
  });
});


describe('confirm race verdict (codex r6)', () => {
  test('a duplicate CUSTOMER confirm is the documented double-submit success', () => {
    // This route, the logged-in route, and self-booking all write the pair.
    expect(confirmRaceVerdict({ status: 'confirmed', customer_confirmed: true })).toBe('idempotent_success');
  });

  test('a system write that stamps confirmed WITHOUT customer_confirmed reloads as CHANGED', () => {
    // SmartRebooker stamps a rescheduled visit's NEW slot 'confirmed'
    // without customer_confirmed — the customer must see the new slot,
    // not a stale "confirmed" for the old one.
    expect(confirmRaceVerdict({ status: 'confirmed', customer_confirmed: false })).toBe('changed');
    expect(confirmRaceVerdict({ status: 'cancelled', customer_confirmed: false })).toBe('changed');
    expect(confirmRaceVerdict(null)).toBe('changed');
  });
});

describe('pre-update idempotency uses the same verdict (codex r7)', () => {
  test('a system-confirmed row (rebooker) is CHANGED even before the update attempt', () => {
    // SmartRebooker can commit between the page GET and the confirm POST,
    // stamping the NEW slot confirmed without customer_confirmed. The
    // early-return branch must not bless the client's stale slot.
    expect(confirmRaceVerdict({ status: 'confirmed', customer_confirmed: false })).toBe('changed');
    expect(confirmRaceVerdict({ status: 'confirmed', customer_confirmed: true })).toBe('idempotent_success');
  });
});
