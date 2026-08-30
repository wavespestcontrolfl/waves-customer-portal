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
jest.mock('../services/appointment-reminders', () => ({
  ...jest.requireActual('../services/appointment-reminders'),
  // per-row pristine label (parent + add-ons), keyed by the raw service_type
  buildServiceLabel: jest.fn(async (id, name) => ({ pest_control: 'Quarterly Pest Control', 'Lawn Fertilization': 'Lawn Fertilization' }[name] || name)),
}));

const appointmentRouter = require('../routes/appointment-public');
const {
  pageState, confirmRaceVerdict, icsEscape, icsFold, STORM_NOTE_MIN_CHANCE,
  ARRIVAL_PROMISE_MINUTES, arrivalWindowLabel, slotMatchesShown,
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

  test('confirming is pinned to the slot the customer was shown', () => {
    const row = { scheduled_date: '2026-08-05', window_start: '09:00:00' };
    // The slot on screen matches the row: confirmable.
    expect(slotMatchesShown(row, { date: '2026-08-05', windowStart: '09:00' })).toBe(true);
    // Tolerates the shapes each side actually carries — a Date column and a
    // full-precision time against the page's 'YYYY-MM-DD' / 'HH:MM'.
    expect(slotMatchesShown(
      { scheduled_date: new Date('2026-08-05T12:00:00Z'), window_start: '09:00:00' },
      { date: '2026-08-05', windowStart: '09:00:00' },
    )).toBe(true);
    // The office bulk reschedule moves date/window but LEAVES the row
    // pending, so the status guard alone would confirm a slot the customer
    // never saw. Both halves of the move must be caught.
    expect(slotMatchesShown(row, { date: '2026-08-06', windowStart: '09:00' })).toBe(false);
    expect(slotMatchesShown(row, { date: '2026-08-05', windowStart: '13:00' })).toBe(false);
    // Fails CLOSED: a confirm that can't say which slot it meant is rejected.
    expect(slotMatchesShown(row, {})).toBe(false);
    expect(slotMatchesShown(row, undefined)).toBe(false);
    expect(slotMatchesShown(row, { windowStart: '09:00' })).toBe(false);
    // A windowless visit is legitimate: null must match null, and must not
    // match a page that thinks it has a window.
    const windowless = { scheduled_date: '2026-08-05', window_start: null };
    expect(slotMatchesShown(windowless, { date: '2026-08-05', windowStart: null })).toBe(true);
    expect(slotMatchesShown(windowless, { date: '2026-08-05', windowStart: '09:00' })).toBe(false);
    expect(slotMatchesShown(row, { date: '2026-08-05', windowStart: null })).toBe(false);
  });

  test('an idempotent-success verdict is not enough — the slot must still match', () => {
    // The office moves the visit after this request's first read, then a
    // DIFFERENT surface (the logged-in portal, or this page in another tab)
    // confirms the new slot. The reread then shows confirmed +
    // customer_confirmed — 'idempotent_success' by identity — while the slot
    // is no longer the one this client is showing. Both halves are required
    // before returning success, or the stale card flips to Confirmed.
    const movedAndConfirmed = {
      status: 'confirmed',
      customer_confirmed: true,
      scheduled_date: '2026-08-09',
      window_start: '13:00:00',
    };
    const shown = { date: '2026-08-05', windowStart: '09:00' };
    expect(confirmRaceVerdict(movedAndConfirmed)).toBe('idempotent_success');
    expect(slotMatchesShown(movedAndConfirmed, shown)).toBe(false);

    // The genuine double-tap: same slot, customer's own confirm won.
    const sameSlot = {
      status: 'confirmed',
      customer_confirmed: true,
      scheduled_date: '2026-08-05',
      window_start: '09:00:00',
    };
    expect(confirmRaceVerdict(sameSlot)).toBe('idempotent_success');
    expect(slotMatchesShown(sameSlot, shown)).toBe(true);
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

  test('the confirmation quotes the arrival WINDOW, never an exact start time', () => {
    // {time} meant two different things across the three confirmation
    // senders — estimate acceptance passed an arrival RANGE into it while
    // the reminder and call paths passed an exact start, so a 9:00 booking
    // texted "at 9:00 AM" for a visit promised 9:00-11:00 (codex r9).
    const confirmation = TEMPLATES.find((t) => t.template_key === 'appointment_confirmation_v2');
    expect(confirmation.body).toContain('{window}');
    expect(confirmation.variables).toContain('window');
    expect(confirmation.body).not.toContain('{time}');
    expect(confirmation.variables).not.toContain('time');
    // Specifically the "at <exact time>" phrasing must be gone.
    expect(confirmation.body).not.toMatch(/\bat \{/);
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

describe('codex #3429 r3 P2 — dispatch-owned unreviewed bookings hide self-service actions', () => {
  const { dispatchOwnedUnreviewed } = appointmentRouter._test;

  test('unreviewed dispatch-owned pending visits are flagged', () => {
    for (const sourceAction of ['ai_call_pipeline_followup', 'ai_call_outbound_review', 'voice_agent']) {
      expect(dispatchOwnedUnreviewed({ status: 'pending', source_action: sourceAction, customer_confirmed: false })).toBe(true);
    }
  });

  test('confirmed, customer-confirmed, or ordinary visits are not flagged', () => {
    expect(dispatchOwnedUnreviewed({ status: 'confirmed', source_action: 'ai_call_pipeline_followup', customer_confirmed: false })).toBe(false);
    expect(dispatchOwnedUnreviewed({ status: 'pending', source_action: 'ai_call_pipeline_followup', customer_confirmed: true })).toBe(false);
    expect(dispatchOwnedUnreviewed({ status: 'pending', source_action: null, customer_confirmed: false })).toBe(false);
  });
});

describe('grouped visit payload (codex #3609 r10)', () => {
  test('visitServicesFor lists the live members and the VISIT start for the shared arrival promise', async () => {
    const { visitServicesFor } = appointmentRouter._test;
    mockDb.mockImplementation((table) => {
      const api = {
        where: () => api, whereNotIn: () => api, orderBy: () => api,
        select: async () => [
          { id: 'a', service_type: 'pest_control', status: 'confirmed', source_action: null, customer_confirmed: true },
          { id: 'b', service_type: 'Lawn Fertilization', status: 'pending', source_action: null, customer_confirmed: false },
        ],
        first: async () => {
          if (table === 'service_visits') return { window_start: '09:00:00' };
          // the reminder row carries the customer-facing label for member a
          if (table === 'appointment_reminders') return { service_type: 'Quarterly Pest Control' };
          return null;
        },
      };
      return api;
    });
    // each member carries its OWN pristine label (codex r15 P2) — the
    // reminder row's merged label ("A & B") is the heading, never the list
    expect(await visitServicesFor({ id: 'b', visit_id: 'v1', window_start: '10:00' }))
      .toEqual({ visit: { serviceCount: 2, membershipKey: appointmentRouter._test.membershipKeyFor([{ id: 'a' }, { id: 'b' }]), services: ['Quarterly Pest Control', 'Lawn Fertilization'], windowStart: '09:00', allConfirmed: false, anyConfirmable: true, pendingRebook: false, livePhase: null } });
    expect(require('../services/appointment-reminders').buildServiceLabel).toHaveBeenCalledWith('a', 'pest_control');
    // the REAL module exposes the helper at the top level (codex r16 P2: a _test-only export made every call throw into the raw-key fallback)
    expect(typeof jest.requireActual('../services/appointment-reminders').buildServiceLabel).toBe('function');
    expect(await visitServicesFor({ id: 'x', visit_id: null })).toEqual({});
  });
});

describe('grouped confirm + calendar guards (codex #3609 r12)', () => {
  const { confirmedRowStillShown, calendarWindowStart } = appointmentRouter._test;
  const shown = { date: '2026-08-05', windowStart: '09:00' };
  const svc = { id: 'b', visit_id: 'v1' };

  test('the locked re-read must still be a confirmed member of the visit AT THE SHOWN SLOT', () => {
    const cur = { visit_id: 'v1', status: 'confirmed', customer_confirmed: false, scheduled_date: '2026-08-05', window_start: '09:00:00' };
    // staff-confirmed at the shown slot fans out (P2): who confirmed the row is irrelevant once the slot is proven
    expect(confirmedRowStillShown(cur, svc, shown)).toBe(true);
    expect(confirmedRowStillShown({ ...cur, customer_confirmed: true }, svc, shown)).toBe(true);
    // moved to a new date/window after the pre-lock check (P1) → CHANGED, never a sibling fan-out
    expect(confirmedRowStillShown({ ...cur, scheduled_date: '2026-08-06' }, svc, shown)).toBe(false);
    expect(confirmedRowStillShown({ ...cur, window_start: '11:00:00' }, svc, shown)).toBe(false);
    // split out of the visit, un-confirmed, or gone
    expect(confirmedRowStillShown({ ...cur, visit_id: 'v2' }, svc, shown)).toBe(false);
    expect(confirmedRowStillShown({ ...cur, status: 'pending' }, svc, shown)).toBe(false);
    expect(confirmedRowStillShown(null, svc, shown)).toBe(false);
    // a missing client slot fails closed like slotMatchesShown
    expect(confirmedRowStillShown(cur, svc, {})).toBe(false);
  });

  test('the calendar file starts at the VISIT start when grouped, the row start otherwise', () => {
    expect(calendarWindowStart({ window_start: '10:00:00' }, { visit: { windowStart: '09:00' } })).toBe('09:00');
    expect(calendarWindowStart({ window_start: '10:00:00' }, {})).toBe('10:00');
    expect(calendarWindowStart({ window_start: '10:00:00' }, { visit: { windowStart: null } })).toBe('10:00');
  });
});

describe('grouped calendar identity + locked anchor read (codex #3609 r13)', () => {
  const { calendarUid, calendarSummaryLabel, readConfirmedAnchorLocked } = appointmentRouter._test;

  test('one UID per grouped STOP (any member link), the row UID when ungrouped', () => {
    const grouped = { visit: { serviceCount: 2, services: ['Pest Control', 'Lawn Fertilization'] } };
    expect(calendarUid({ id: 'a', visit_id: 'v1' }, grouped)).toBe('visit-group-v1');
    expect(calendarUid({ id: 'b', visit_id: 'v1' }, grouped)).toBe('visit-group-v1');
    expect(calendarUid({ id: 'a', visit_id: null }, {})).toBe('visit-a');
    expect(calendarUid({ id: 'a', visit_id: 'v1' }, {})).toBe('visit-a'); // lookup failed ⇒ row identity, never a half-built group key
  });

  test('the shared event names EVERY service at the stop, deduped; a lone service keeps its own label', () => {
    expect(calendarSummaryLabel('Pest Control', { visit: { services: ['Pest Control', 'Lawn Fertilization'] } })).toBe('Pest Control + Lawn Fertilization');
    expect(calendarSummaryLabel('Pest Control', { visit: { services: ['Pest Control', 'Pest Control'] } })).toBe('Pest Control');
    expect(calendarSummaryLabel('Pest Control', { visit: { services: ['Pest Control'] } })).toBe('Pest Control');
    expect(calendarSummaryLabel('Pest Control', {})).toBe('Pest Control');
  });

  test('the already-confirmed anchor is re-read FOR UPDATE with the slot/membership projection (P2)', async () => {
    const ops = [];
    const api = {
      where: (w) => { ops.push(['where', w]); return api; },
      forUpdate: () => { ops.push(['forUpdate']); return api; },
      first: async (...cols) => { ops.push(['first', cols]); return { status: 'confirmed' }; },
    };
    const trx = jest.fn(() => api);
    expect(await readConfirmedAnchorLocked(trx, { id: 'a' })).toEqual({ status: 'confirmed' });
    expect(trx).toHaveBeenCalledWith('scheduled_services');
    expect(ops).toEqual([
      ['where', { id: 'a' }],
      ['forUpdate'],
      ['first', ['visit_id', 'status', 'customer_confirmed', 'scheduled_date', 'window_start']],
    ]);
  });
});

describe('lone-member visit keeps the confirm race verdict (local codex audit)', () => {
  const { confirmGroupedOrSolo } = appointmentRouter._test;
  const shown = { date: '2026-08-05', windowStart: '09:00' };
  const svc = { id: 'a', visit_id: 'v1' };
  const anchor = { visit_id: 'v1', status: 'confirmed', customer_confirmed: false, scheduled_date: '2026-08-05', window_start: '09:00:00' };
  // scheduled_services call order: anchor FOR UPDATE read → openMembers select → sibling FOR UPDATE select → update → openMembers (aggregate)
  const fakeTrx = ({ members, pendingSiblings = [], after = null }) => {
    const log = [];
    let ss = 0;
    const trx = jest.fn((table) => {
      const call = table === 'scheduled_services' ? ss++ : -1;
      const api = {
        where: () => api, whereNot: () => api, whereNotIn: () => api, forUpdate: () => api,
        first: async () => anchor,
        select: async () => (call === 2 ? pendingSiblings : (call >= 4 && after ? after : members)),
        update: async (v) => { log.push(['update', table, v]); return 1; },
        insert: async (v) => { log.push(['insert', table, v]); },
      };
      return api;
    });
    trx.fn = { now: () => 'now()' };
    trx.__log = log;
    return trx;
  };

  test('one live member ⇒ solo with the locked row, no sibling write; two ⇒ fan-out (when the page showed two)', async () => {
    let trx = fakeTrx({ members: [{ id: 'a' }] });
    expect(await confirmGroupedOrSolo(trx, svc, shown)).toEqual({ outcome: 'solo', row: anchor, confirmed: true });
    expect(trx.__log).toEqual([]);
    const AB = appointmentRouter._test.membershipKeyFor([{ id: 'a' }, { id: 'b' }]);
    trx = fakeTrx({ members: [{ id: 'a' }, { id: 'b' }], pendingSiblings: [{ id: 'b', status: 'pending', source_action: null, customer_confirmed: false }], after: [{ id: 'a', status: 'confirmed' }, { id: 'b', status: 'confirmed' }] });
    expect(await confirmGroupedOrSolo(trx, svc, { ...shown, membershipKey: AB })).toEqual({ outcome: 'fanned', row: anchor, confirmed: true });
    expect(trx.__log.map((l) => l[0])).toEqual(['update', 'insert']);
    expect(trx.__log[0][2]).toMatchObject({ status: 'confirmed', customer_confirmed: true });
    // a dispatch-owned sibling stays pending ⇒ the response reports the visit NOT confirmed (codex r17 P2)
    trx = fakeTrx({ members: [{ id: 'a' }, { id: 'b' }], pendingSiblings: [{ id: 'b', status: 'pending', source_action: 'call_followup', customer_confirmed: false }], after: [{ id: 'a', status: 'confirmed' }, { id: 'b', status: 'pending' }] });
    const res = await confirmGroupedOrSolo(trx, svc, { ...shown, membershipKey: AB });
    expect(res.outcome).toBe('fanned');
    expect(res.confirmed).toBe(false);
  });

  test('the live member SET must be the one the page showed (membershipKey, local codex audit): a grouped stop behind a solo page, a swapped sibling, or a dropped sibling reloads', async () => {
    const { membersMatchShown, membershipKeyFor } = appointmentRouter._test;
    const AB = membershipKeyFor([{ id: 'a' }, { id: 'b' }]);
    expect(AB).toMatch(/^[0-9a-f]{16}$/);
    expect(membershipKeyFor([{ id: 'b' }, { id: 'a' }])).toBe(AB); // order-free
    expect(membershipKeyFor([{ id: 'a' }])).toBe(null);            // solo page carries no key
    expect(membershipKeyFor([{ id: 'a' }, { id: 'c' }])).not.toBe(AB);
    // bound to placement (local audit): the same ids at another slot is a different appointment
    const placed = membershipKeyFor([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00:00' }, { id: 'b', scheduled_date: '2026-08-05', window_start: '10:00:00' }]);
    expect(membershipKeyFor([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00' }, { id: 'b', scheduled_date: '2026-08-05', window_start: '10:00' }])).toBe(placed);
    expect(membershipKeyFor([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00' }, { id: 'b', scheduled_date: '2026-08-05', window_start: '11:00' }])).not.toBe(placed);
    expect(membershipKeyFor([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00' }, { id: 'b', scheduled_date: '2026-08-06', window_start: '10:00' }])).not.toBe(placed);
    // page showed ONE (no key) but the stop has two ⇒ CHANGED, never a hidden fan-out
    let trx = fakeTrx({ members: [{ id: 'a' }, { id: 'b' }], pendingSiblings: [{ id: 'b', status: 'pending', source_action: null, customer_confirmed: false }] });
    await expect(confirmGroupedOrSolo(trx, svc, shown)).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
    expect(trx.__log).toEqual([]);
    // direct calls: the member read is the FIRST scheduled_services query
    const membersTrx = (members) => { const api = { where: () => api, whereNotIn: () => api, forUpdate: jest.fn(() => api), select: async () => members }; const t = jest.fn(() => api); t.__api = api; return t; };
    // same COUNT, different member (A+B shown, A+C live) ⇒ CHANGED
    await expect(membersMatchShown(membersTrx([{ id: 'a' }, { id: 'c' }]), svc, { membershipKey: AB })).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
    // page showed two but a sibling was cancelled since ⇒ CHANGED; garbage key ⇒ CHANGED
    await expect(membersMatchShown(membersTrx([{ id: 'a' }]), svc, { membershipKey: AB })).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
    await expect(membersMatchShown(membersTrx([{ id: 'a' }, { id: 'b' }]), svc, { membershipKey: 'nope' })).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
    // matches ⇒ the live members come back; an ungrouped row never queries
    const okTrx = membersTrx([{ id: 'a' }, { id: 'b' }]);
    expect((await membersMatchShown(okTrx, svc, { membershipKey: AB })).map((m) => m.id)).toEqual(['a', 'b']);
    expect(okTrx.__api.forUpdate).toHaveBeenCalled(); // the whole live set is locked while the key is proven (codex r18)
    trx = membersTrx([]);
    expect(await membersMatchShown(trx, { id: 'a', visit_id: null }, { membershipKey: null })).toEqual([]);
    expect(trx).not.toHaveBeenCalled();
  });

  test('a member awaiting its replacement slot makes the whole stop pendingRebook (local audit)', async () => {
    const { visitServicesFor } = appointmentRouter._test;
    mockDb.mockImplementation((table) => {
      const api = {
        where: () => api, whereNotIn: () => api, orderBy: () => api,
        select: async () => [
          { id: 'a', service_type: 'pest_control', status: 'confirmed', source_action: null, customer_confirmed: true },
          { id: 'b', service_type: 'Lawn Fertilization', status: 'rescheduled', source_action: null, customer_confirmed: false },
        ],
        first: async () => (table === 'service_visits' ? { window_start: '09:00:00' } : null),
      };
      return api;
    });
    const out = await visitServicesFor({ id: 'a', visit_id: 'v1' });
    expect(out.visit.pendingRebook).toBe(true);
    expect(out.visit.anyConfirmable).toBe(false);
  });

  test('members that no longer share one stop fail closed — on the page (visitUnknown) and under the confirm locks (CHANGED) (local audit)', async () => {
    const { visitServicesFor, membersOneStop, membersMatchShown, membershipKeyFor } = appointmentRouter._test;
    expect(membersOneStop([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '10:00' }, { id: 'b', scheduled_date: '2026-08-05', window_start: '10:00', window_end: '11:00' }])).toBe(true);
    expect(membersOneStop([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '10:00' }, { id: 'b', scheduled_date: '2026-08-06', window_start: '10:00', window_end: '11:00' }])).toBe(false); // split dates
    expect(membersOneStop([{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '10:00' }, { id: 'b', scheduled_date: '2026-08-05', window_start: '13:00', window_end: '14:00' }])).toBe(false); // disconnected windows
    // page: mixed dates ⇒ visitUnknown (never a grouped payload over a date the customer did not see)
    mockDb.mockImplementation((table) => {
      const api = {
        where: () => api, whereNotIn: () => api, orderBy: () => api,
        select: async () => [
          { id: 'a', service_type: 'pest_control', status: 'confirmed', source_action: null, customer_confirmed: true, scheduled_date: '2026-08-05', window_start: '09:00:00', window_end: '10:00:00' },
          { id: 'b', service_type: 'Lawn Fertilization', status: 'pending', source_action: null, customer_confirmed: false, scheduled_date: '2026-08-06', window_start: '09:00:00', window_end: '10:00:00' },
        ],
        first: async () => (table === 'service_visits' ? { window_start: '09:00:00' } : null),
      };
      return api;
    });
    expect(await visitServicesFor({ id: 'a', visit_id: 'v1' })).toEqual({ visitUnknown: true });
    // confirm: the key can match a drifted set only if the page was built from it — the invariant is repeated under the locks anyway
    const drifted = [{ id: 'a', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '10:00' }, { id: 'b', scheduled_date: '2026-08-05', window_start: '13:00', window_end: '14:00' }];
    const api = { where: () => api, whereNotIn: () => api, forUpdate: () => api, select: async () => drifted };
    await expect(membersMatchShown(jest.fn(() => api), { id: 'a', visit_id: 'v1' }, { membershipKey: membershipKeyFor(drifted) })).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
  });

  test('a member already underway makes the stop underway: livePhase aggregates en_route/on_site and the confirm refuses (local audit)', async () => {
    const { visitServicesFor, membersMatchShown, membershipKeyFor } = appointmentRouter._test;
    mockDb.mockImplementation((table) => {
      const api = {
        where: () => api, whereNotIn: () => api, orderBy: () => api,
        select: async () => [
          { id: 'a', service_type: 'pest_control', status: 'confirmed', source_action: null, customer_confirmed: true, scheduled_date: '2026-08-05', window_start: '09:00:00', window_end: '11:00:00' },
          { id: 'b', service_type: 'Lawn Fertilization', status: 'on_site', source_action: null, customer_confirmed: false, scheduled_date: '2026-08-05', window_start: '10:00:00', window_end: '12:00:00' },
        ],
        first: async () => (table === 'service_visits' ? { window_start: '09:00:00' } : null),
      };
      return api;
    });
    const out = await visitServicesFor({ id: 'a', visit_id: 'v1' });
    expect(out.visit.livePhase).toBe('on_site');
    const live = [{ id: 'a', status: 'confirmed', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '11:00' }, { id: 'b', status: 'en_route', scheduled_date: '2026-08-05', window_start: '10:00', window_end: '12:00' }];
    const api = { where: () => api, whereNotIn: () => api, forUpdate: () => api, select: async () => live };
    await expect(membersMatchShown(jest.fn(() => api), { id: 'a', visit_id: 'v1' }, { membershipKey: membershipKeyFor(live) })).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
  });

  test('an unreadable member lookup fails closed: visitUnknown, never an ungrouped payload', async () => {
    const { visitServicesFor } = appointmentRouter._test;
    mockDb.mockImplementation(() => ({ where: () => ({ whereNotIn: () => ({ orderBy: () => ({ select: async () => { throw new Error('db down'); } }) }) }) }));
    expect(await visitServicesFor({ id: 'a', visit_id: 'v1' })).toEqual({ visitUnknown: true });
  });

  test('a lost-race grouped confirm re-proves the membership key and reports the aggregate under the stop lock (local audit)', async () => {
    const { groupedAggregateUnderLock, membershipKeyFor } = appointmentRouter._test;
    const members = (bStatus) => [{ id: 'a', status: 'confirmed', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '11:00' }, { id: 'b', status: bStatus, scheduled_date: '2026-08-05', window_start: '10:00', window_end: '12:00' }];
    const wire = (live) => {
      const api = {
        where: () => api, whereNotIn: () => api, forUpdate: () => api,
        first: async () => ({ property_id: 'p1', customer_id: 'c1', scheduled_date: '2026-08-05' }), // lockStopForRow peek + verify
        select: async () => live,
      };
      const trx = jest.fn(() => api);
      trx.raw = jest.fn(async () => ({ rows: [] }));
      mockDb.transaction = jest.fn(async (fn) => fn(trx));
      return trx;
    };
    const key = membershipKeyFor(members('pending'));
    let trx = wire(members('pending'));
    expect(await groupedAggregateUnderLock(svc, { ...shown, membershipKey: key })).toEqual({ ok: true, confirmed: false });
    expect(trx.raw).toHaveBeenCalled(); // the stop advisory lock was taken
    trx = wire(members('confirmed'));
    expect(await groupedAggregateUnderLock(svc, { ...shown, membershipKey: membershipKeyFor(members('confirmed')) })).toEqual({ ok: true, confirmed: true });
    // membership changed (that is what made the CAS miss) ⇒ not ok ⇒ CHANGED
    wire([{ id: 'a', status: 'confirmed', scheduled_date: '2026-08-05', window_start: '09:00', window_end: '11:00' }, { id: 'c', status: 'pending', scheduled_date: '2026-08-05', window_start: '10:00', window_end: '12:00' }]);
    expect(await groupedAggregateUnderLock(svc, { ...shown, membershipKey: key })).toEqual({ ok: false, confirmed: null });
  });

  test('the anchor must still be at the shown slot either way', async () => {
    const trx = fakeTrx({ members: [{ id: 'a' }] });
    await expect(confirmGroupedOrSolo(trx, svc, { date: '2026-08-06', windowStart: '09:00' })).rejects.toMatchObject({ code: 'VISIT_STOP_MOVED' });
  });
});
