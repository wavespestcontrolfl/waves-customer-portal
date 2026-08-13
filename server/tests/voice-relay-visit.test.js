/**
 * Voice-relay Phase D — get_today_eta + get_service_report.
 *
 * What these lock down:
 *   - today-ETA fires ONLY on a same-ET-day appointment (scheduled_date is a
 *     DATE; the predicate is an exact etDateString() equality, never a naive
 *     UTC window), and reads window_start/window_end the way the customer
 *     surfaces do, with appointment_reminders.appointment_time as the fallback
 *   - en-route is a READ-ONLY peek at the tracker lifecycle columns, and a
 *     terminal operational status outranks a stale track_state
 *   - looked-up refs get existence only (no window, no live tech position)
 *   - get_service_report is matched-caller only, honours the typedReportDelivery
 *     suppression predicate, speaks PARSER-APPROVED note copy only
 *     (technicianReportCustomerCopy, then customerSafeServiceNotes), and takes
 *     re-entry wording ONLY from the shaping helper (never composed, never
 *     "safe")
 *   - "per application" never "per visit"
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({
  CONTACT_MATCH_PHONE_COLS: ['phone'],
  summarizePriorCall: jest.fn(),
}));
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../services/project-types', () => ({ customerSafeServiceNotes: jest.fn((n) => (n ? `SAFE:${n}` : null)) }));
jest.mock('../services/pricing-engine', () => ({ generateEstimate: jest.fn() }));
// The re-entry shaping helper — the ONLY source of re-entry wording.
jest.mock('../services/service-report/reentry', () => ({ buildReentryContext: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  return { ...actual, etDateString: jest.fn(() => '2026-08-12') };
});

const db = require('../models/db');
const { etDateString } = require('../utils/datetime-et');
const { customerSafeServiceNotes } = require('../services/project-types');
const { buildReentryContext } = require('../services/service-report/reentry');
const { generateEstimate } = require('../services/pricing-engine');

const relayVisit = require('../services/voice-agent/relay-visit');
const { activeTools, executeTool } = require('../services/voice-agent/relay-tools');
const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');

const CUSTOMER_ID = 'c-1111';
const TODAY = '2026-08-12';

function makeBuilder(rows) {
  const b = {};
  // orderByRaw: live visits sort ahead of terminal same-day history.
  const chain = ['whereNull', 'whereIn', 'whereNotIn', 'whereNotNull', 'orderBy', 'orderByRaw', 'select', 'limit',
    'whereRaw', 'orWhereRaw', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'whereNot', 'join', 'leftJoin'];
  for (const m of chain) b[m] = jest.fn(() => b);
  b.where = jest.fn(function whereImpl(arg) { if (typeof arg === 'function') arg.call(b, b); return b; });
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.update = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.del = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  return b;
}

let builders;
function primeDb(tables = {}) {
  builders = {};
  for (const [t, rows] of Object.entries(tables)) builders[t] = makeBuilder(rows);
  db.mockImplementation((table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  });
}

function assertNoWrites() {
  for (const b of Object.values(builders || {})) {
    expect(b.insert).not.toHaveBeenCalled();
    expect(b.update).not.toHaveBeenCalled();
    expect(b.del).not.toHaveBeenCalled();
  }
}

const TOKEN_LEAK_RE = /\/pay\/|\/receipt\/|reservice|https?:\/\/|[A-Za-z0-9_-]{20,}/;

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
  etDateString.mockReturnValue(TODAY);
  customerSafeServiceNotes.mockImplementation((n) => (n ? `SAFE:${n}` : null));
  buildReentryContext.mockResolvedValue(null);
  primeDb();
});

const VISIT_TODAY = {
  id: 'ss-1', status: 'confirmed', service_type: 'Pest Control',
  window_start: '09:00:00', window_end: '11:00:00',
  track_state: 'scheduled', en_route_at: null, arrived_at: null, customer_confirmed: true,
};

describe('get_today_eta', () => {
  test('registers with the context set and refuses when the gate is off', async () => {
    expect(activeTools().map((t) => t.name)).toContain('get_today_eta');
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    expect(activeTools().map((t) => t.name)).not.toContain('get_today_eta');
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/not available/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('same-ET-day predicate is an exact scheduled_date equality on today', async () => {
    primeDb({ scheduled_services: [VISIT_TODAY] });
    await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    const b = builders.scheduled_services;
    expect(b.where).toHaveBeenCalledWith('scheduled_date', TODAY);
    expect(b.whereNotIn).toHaveBeenCalledWith('status', ['cancelled', 'rescheduled']);
    assertNoWrites();
  });

  test('no visit today → says so and forbids inventing a time (even with visits on other days)', async () => {
    primeDb({ scheduled_services: [] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/No appointment on the schedule for this account today/i);
    expect(out).toMatch(/Do NOT guess/i);
    expect(out).not.toMatch(/EN ROUTE|window is/i);
  });

  test('the spoken window is window_start + 2h (arrivalWindowRange), spoken', async () => {
    primeDb({ scheduled_services: [VISIT_TODAY] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toContain('9 AM to 11 AM');
    expect(out).toContain('Pest Control');
    expect(out).toMatch(/has not started toward the property yet/i);
    expect(out).toMatch(/never invent a more precise ETA/i);
  });

  // ⭐ window_end IS NOT AN ARRIVAL WINDOW. It carries the service's duration
  // (a 4-hour termite job, a 30-minute callback) and drives scheduling/overlap;
  // AGENTS.md pins customer-facing arrival copy to window_start + 120 min via
  // the shared arrivalWindowRange(), so the phone cannot drift from the
  // reminders and the track page.
  test('a long service does NOT get its duration read out as the arrival window', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, window_start: '09:00:00', window_end: '15:00:00' }] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toContain('9 AM to 11 AM'); // start + 2h, not the 3 PM end
    expect(out).not.toContain('3 PM');
  });

  // ⭐ appointment_time IS A TIMESTAMP. pg returns the column as a Date, and
  // the clock parser only reads "HH:MM…" strings — so the production fallback
  // always produced null and the caller heard "no time window is set". The
  // stamp is normalized to its AMERICA/NEW_YORK wall clock and spoken as the
  // same start-plus-two-hours arrival window every other surface promises.
  test('no window on the row → falls back to the reminder TIMESTAMP as an ET arrival window', async () => {
    primeDb({
      scheduled_services: [{ ...VISIT_TODAY, window_start: null, window_end: null }],
      // 17:30Z = 13:30 ET on this date (EDT) — a real timestamptz value.
      appointment_reminders: [{ appointment_time: new Date('2026-08-12T17:30:00Z') }],
    });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toContain('1:30 PM'); // ET wall clock, never host TZ / UTC
    expect(out).toContain('3:30 PM'); // …and the +120min window, not a bare start
    expect(builders.appointment_reminders.where).toHaveBeenCalledWith({ scheduled_service_id: 'ss-1', cancelled: false });
  });

  test('a legacy time-only reminder value still speaks (and still gets the window)', async () => {
    primeDb({
      scheduled_services: [{ ...VISIT_TODAY, window_start: null, window_end: null }],
      appointment_reminders: [{ appointment_time: '13:30:00' }],
    });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toContain('1:30 PM');
    expect(out).toContain('3:30 PM');
  });

  test('en_route track_state → announces the tech is on the way (read-only peek)', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, track_state: 'en_route', en_route_at: '2026-08-12T13:05:00Z' }] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/EN ROUTE/);
    assertNoWrites();
  });

  // 'on_site' was in the on-property set and is not a value the column holds —
  // a dead branch. An unknown value must fall through to the honest default.
  test('an unknown track_state falls through to "no live arrival time"', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, status: 'scheduled', track_state: 'on_site' }] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/has not started toward the property yet/i);
    expect(out).not.toMatch(/already at the property/i);
  });

  test('on_property → already at the property', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, track_state: 'on_property' }] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/already at the property/i);
  });

  // ⭐ THE REAL ENUM IS scheduled | en_route | on_property | complete. 'complete'
  // was unhandled — so in the completion window, before the operational status
  // catches up, the agent told a caller whose technician had just FINISHED that
  // he "has not started toward the property yet".
  test('track_state complete → says the visit is finished, never "has not started"', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, status: 'scheduled', track_state: 'complete' }] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/finished the visit/i);
    expect(out).not.toMatch(/has not started/i);
    expect(out).not.toMatch(/EN ROUTE/i);
  });

  test('terminal status outranks a STALE track_state — a completed visit is never "on the way"', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, status: 'completed', track_state: 'en_route' }] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/already marked complete/i);
    expect(out).not.toMatch(/EN ROUTE|on the way/i);
  });

  // PHYSICAL SECURITY: an unverified voice must not learn whether a technician
  // will be at that address today — not even yes/no. The refusal is BYTE
  // IDENTICAL whether or not a visit exists, and the row is never read, so the
  // refusal itself carries no signal.
  test('looked-up ref → NOTHING, not even that a visit exists (no schedule read at all)', async () => {
    primeDb({ scheduled_services: [{ ...VISIT_TODAY, track_state: 'en_route' }] });
    const ctx = { customerId: 'c-other', customerTier: 'full', callerAttested: true, resolveLookupRef: (r) => (String(r).toUpperCase() === 'C1' ? 'c-9001' : null) };
    const withVisit = await executeTool('get_today_eta', { customer_ref: 'C1' }, ctx);
    expect(withVisit).not.toMatch(/There IS a visit/i);
    expect(withVisit).toMatch(/Do NOT say whether a visit is or is not on today's schedule/i);
    expect(withVisit).not.toContain('9 AM');
    expect(withVisit).not.toMatch(/EN ROUTE/i);
    expect(db).not.toHaveBeenCalled();

    jest.clearAllMocks();
    primeDb({ scheduled_services: [] });
    const withoutVisit = await executeTool('get_today_eta', { customer_ref: 'C1' }, ctx);
    expect(withoutVisit).toBe(withVisit); // no oracle: identical either way
    expect(db).not.toHaveBeenCalled();
  });

  // FAIL CLOSED: an ANI match with no tier on the session ctx is 'redacted'.
  test('matched caller with NO customerTier on the ctx → redacted (defaults never fail open)', async () => {
    primeDb({ scheduled_services: [VISIT_TODAY] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID });
    expect(out).toMatch(/only available for the account the caller's own phone number matches/i);
    expect(db).not.toHaveBeenCalled();
  });

  // A contact-slot ANI match (spouse/tenant/PRIOR OCCUPANT) recognises the
  // account but authenticates nobody — today's schedule stays shut.
  test('contact-slot match (tier redacted) → today\'s schedule is refused', async () => {
    primeDb({ scheduled_services: [VISIT_TODAY] });
    const out = await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'redacted' });
    expect(out).toMatch(/Do NOT say whether a visit is or is not on today's schedule/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('contact-slot match (tier redacted) → get_service_report is refused outright', async () => {
    primeDb({ service_records: [] });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'redacted' });
    expect(out).toMatch(/only available for the account whose own phone number/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('unmatched caller with no ref → refused, no schedule read', async () => {
    const out = await executeTool('get_today_eta', {}, { customerId: null });
    expect(out).toMatch(/No customer account matches/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('speakClock handles TIME strings, 24h, and noon/midnight', () => {
    expect(relayVisit.speakClock('09:00:00')).toBe('9 AM');
    expect(relayVisit.speakClock('13:30:00')).toBe('1:30 PM');
    expect(relayVisit.speakClock('12:00:00')).toBe('12 PM');
    expect(relayVisit.speakClock('00:15:00')).toBe('12:15 AM');
    expect(relayVisit.speakClock('')).toBeNull();
  });
});

// Free-form INTERNAL notes — the realistic default. This is exactly what
// AGENTS.md means by raw technician_notes ("access codes, billing notes"), and
// technicianReportCustomerCopy parses it to null, so none of it is speakable.
const RECORD = {
  id: 'sr-1', service_date: '2026-07-31', service_type: 'Pest Control',
  technician_notes: 'knocked down webs on the lanai', structured_notes: null, status: 'completed',
};
// The REVIEWED two-section draft the technician edits and approves at
// completion — the one sanctioned source of customer note copy
// (services/service-report/technician-report-copy.js, the same parse that feeds
// the written report's summary slot).
const REVIEWED_REPORT_NOTES = [
  'WHAT WE DID',
  'We treated the exterior perimeter and knocked down webs on the lanai.',
  'WHAT WE FOUND',
  'Light ant activity along the kitchen slab and no other concerns.',
].join('\n');

describe('get_service_report', () => {
  test('matched caller → findings, applications, customer-safe note; per APPLICATION wording', async () => {
    primeDb({
      service_records: [RECORD],
      service_findings: [{ category: 'activity', severity: 'low', title: 'Ant activity at the kitchen slab', detail: 'Small trail along the baseboard', recommendation: 'Keep the area dry for a week' }],
      service_products: [{ product_name: 'Termidor SC', application_area: 'exterior perimeter', application_method: 'spray', targets: JSON.stringify(['ants', 'spiders']) }],
    });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toContain('Friday July 31');
    expect(out).toContain('Ant activity at the kitchen slab');
    expect(out).toContain('Keep the area dry for a week');
    expect(out).toContain('Termidor SC');
    expect(out).toContain('ants, spiders');
    // ⭐ RAW technician_notes NEVER EGRESS ON A REPORT PATH (AGENTS.md; owner
    // ruling 2026-07-16 recorded in report-data.js's `legacy` block). This
    // fixture's notes are free-form internal text, so the reviewed parse
    // returns null and NOTHING of them is spoken. customerSafeServiceNotes
    // alone is not that parse — it only scrubs the WDO inspection fee and
    // returns an ordinary visit's notes verbatim.
    expect(out).not.toContain('knocked down webs');
    expect(out).not.toContain('SAFE:');
    expect(out).not.toMatch(/report summary/i);
    // Owner rule + compliance:
    expect(out).toContain('Products used on this application');
    expect(out).not.toMatch(/per visit/i);
    expect(out).toMatch(/never tell a caller an area or product is "safe"/);
    expect(out).not.toMatch(TOKEN_LEAK_RE);
    assertNoWrites();
  });

  test('the REVIEWED two-section draft IS speakable, and still goes through the fee scrub', async () => {
    primeDb({ service_records: [{ ...RECORD, technician_notes: REVIEWED_REPORT_NOTES }] });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    // The parse joins the two reviewed lines into one customer-ready body, and
    // the WDO inspection-fee scrub still runs on top of it (SAFE: prefix).
    expect(out).toContain('The technician\'s reviewed report summary: SAFE:We treated the exterior perimeter');
    expect(out).toContain('Light ant activity along the kitchen slab');
    // The section HEADERS are never spoken — the parse strips them.
    expect(out).not.toContain('WHAT WE DID');
    expect(customerSafeServiceNotes).toHaveBeenCalledWith(
      expect.not.stringContaining('WHAT WE DID'), expect.anything(),
    );
  });

  test('an internal note APPENDED to the reviewed draft rejects the whole parse — nothing is spoken', async () => {
    primeDb({
      service_records: [{
        ...RECORD,
        technician_notes: `${REVIEWED_REPORT_NOTES}\nGate code 4417, bill the office`,
      }],
    });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).not.toContain('4417');
    expect(out).not.toMatch(/report summary/i);
    expect(out).not.toContain('We treated the exterior perimeter');
  });

  // ⭐ A FIXED RE-ENTRY TIME IS NEVER SPOKEN. buildReentrySummary renders
  // "<area> ready at 4:30 PM" for pending targets — banned customer copy
  // (AGENTS.md: "never a fixed re-entry/drying minute figure — the idiom is
  // 'safe once dry' + technician confirms timing"). The written report carrying
  // it is a remediation backlog; speaking it would EXTEND the banned class.
  test('a timestamped re-entry summary is replaced by the approved idiom, never quoted', async () => {
    primeDb({ service_records: [RECORD] });
    buildReentryContext.mockResolvedValue({ customerSummary: 'Exterior ready at 4:30 PM.' });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(buildReentryContext).toHaveBeenCalled();
    expect(out).not.toContain('4:30 PM');
    expect(out).toMatch(/ready to use once they are dry/i);
    expect(out).toMatch(/technician confirms timing/i);
  });

  // The pending-target branch (structured targets, not the rendered string).
  test('pending targets get the approved idiom without consulting the rendered summary', async () => {
    primeDb({ service_records: [RECORD] });
    buildReentryContext.mockResolvedValue({
      customerSummary: 'Lawn ready at 10:45 AM.',
      targets: [{ label: 'Lawn', readyAt: new Date(Date.now() + 60 * 60 * 1000).toISOString() }],
    });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).not.toContain('10:45');
    expect(out).toMatch(/ready to use once they are dry/i);
  });

  // A summary with NO time in it is the shaping helper's own approved wording
  // and is still spoken verbatim.
  test('an already-ready summary carries no time and IS quoted verbatim', async () => {
    primeDb({ service_records: [RECORD] });
    buildReentryContext.mockResolvedValue({ customerSummary: 'Treated areas are ready for normal use.' });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toContain('"Treated areas are ready for normal use."');
  });

  test('no re-entry context → no re-entry sentence is composed at all', async () => {
    primeDb({ service_records: [RECORD] });
    buildReentryContext.mockResolvedValue(null);
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).not.toMatch(/Re-entry guidance/);
    expect(out).not.toMatch(/ready for normal use|until dry/i);
  });

  test('typedReportDelivery other than auto_send suppresses ALL detail', async () => {
    primeDb({
      service_records: [{ ...RECORD, structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }) }],
      service_findings: [{ title: 'internal finding', detail: 'do not disclose' }],
      service_products: [{ product_name: 'Secret Product' }],
    });
    const out = await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(out).toMatch(/not released for customer delivery/i);
    expect(out).not.toContain('internal finding');
    expect(out).not.toContain('Secret Product');
    expect(out).toMatch(/Do NOT describe findings or products/);
  });

  test('a visit_date pins the record; an unknown date reports nothing on file', async () => {
    primeDb({ service_records: [] });
    const out = await executeTool('get_service_report', { visit_date: '2026-01-02' }, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(builders.service_records.where).toHaveBeenCalledWith('service_date', '2026-01-02');
    expect(out).toMatch(/No completed visit on file for that date/i);
  });

  test('looked-up ref → refused (more detail than the redacted tier allows)', async () => {
    const ctx = { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true, resolveLookupRef: () => 'c-9001' };
    const out = await executeTool('get_service_report', { customer_ref: 'C1' }, ctx);
    expect(out).toMatch(/only available for the account the caller's own phone number matches/i);
    expect(db).not.toHaveBeenCalled();
  });

  // ⭐ THE SPLIT TIER (owner ruling 2026-08-12). What a technician found inside
  // somebody's home is one of the four reads a spoofed caller ID must not buy —
  // it needs the carrier's attestation-A vouch. Today's ETA deliberately does
  // NOT (it is the call driver, and demanding attestation would make her useless
  // to most real customers), so both halves are pinned together here.
  test('full tier WITHOUT attestation-A → report withheld, ETA still answered', async () => {
    const unattested = { customerId: CUSTOMER_ID, customerTier: 'full' };
    const report = await executeTool('get_service_report', {}, unattested);
    expect(report).toMatch(/not available on this call/i);
    expect(db).not.toHaveBeenCalled();
    const eta = await executeTool('get_today_eta', {}, unattested);
    expect(eta).not.toMatch(/not available on this call/i);
  });

  test('unmatched caller → refused, nothing described', async () => {
    const out = await executeTool('get_service_report', {}, { customerId: null });
    expect(out).toMatch(/No customer account matches/i);
    expect(out).toMatch(/Do NOT describe any visit/);
    expect(db).not.toHaveBeenCalled();
  });

  test('neither tool ever calls the pricing engine', async () => {
    primeDb({ scheduled_services: [VISIT_TODAY], service_records: [RECORD] });
    await executeTool('get_today_eta', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    await executeTool('get_service_report', {}, { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true });
    expect(generateEstimate).not.toHaveBeenCalled();
  });
});

describe('Prompt', () => {
  test('gate-on prompt covers the tech-ETA and visit-report rules with per-application wording', () => {
    const p = buildBasePrompt(true);
    expect(p).toContain('get_today_eta');
    expect(p).toContain('get_service_report');
    expect(p).toMatch(/never invent a tighter ETA/i);
    expect(p).toMatch(/PER\n?\s*APPLICATION/);
    expect(p).toContain('never "per visit"');
  });
});
