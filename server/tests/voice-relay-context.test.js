/**
 * Voice-relay Phase 2 "context" — caller recognition + read-only account/pricing
 * tools, dark behind VOICE_RELAY_CONTEXT_ENABLED (fail-closed).
 *
 * Matrix (per the owner's ruling):
 *   - gate off  → no context tools registered, prompt byte-identical, no DB touch
 *   - unknown   → no KNOWN CALLER block, account tools refuse
 *   - ambiguous → 2+ customers share the number ⇒ treated exactly as unknown
 *   - matched   → block present, tools return data
 *   - get_pricing → engine values ONLY (generateEstimate — the estimator's read
 *     path), says what's missing rather than guessing
 *   - no context tool ever performs a write
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
// The canonical identity column set + prior-call summary come FROM the call
// pipeline (named production exports) — mirror its real column set here.
jest.mock('../services/call-recording-processor', () => ({
  CONTACT_MATCH_PHONE_COLS: ['phone', 'service_contact_phone', 'service_contact2_phone', 'service_contact3_phone'],
  summarizePriorCall: jest.fn(),
}));
jest.mock('../services/waveguard-existing-services', () => ({ loadOwnedRecurringServiceKeys: jest.fn() }));
jest.mock('../services/open-balance', () => ({ openBalanceSummary: jest.fn() }));
jest.mock('../services/project-types', () => ({ customerSafeServiceNotes: jest.fn((notes) => (notes ? `SAFE:${notes}` : null)) }));
// ⭐ THE PARSER-APPROVED COPY GATE. Speaking a visit's notes is a report path,
// and AGENTS.md allows only technicianReportCustomerCopy's reviewed parse
// through it (customerSafeServiceNotes is a fee scrub, not that parse). Mocked
// as an approving parse so the scrub assertions below still read naturally; the
// REJECTING case (an unreviewed note) has its own test.
jest.mock('../services/service-report/technician-report-copy', () => ({
  technicianReportCustomerCopy: jest.fn((notes) => (notes ? { body: String(notes) } : null)),
}));
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../utils/service-normalizer', () => ({ normalizeServiceType: jest.fn((v) => v) }));
jest.mock('../services/pricing-engine', () => ({ generateEstimate: jest.fn() }));

const db = require('../models/db');
const { summarizePriorCall } = require('../services/call-recording-processor');
const { loadOwnedRecurringServiceKeys } = require('../services/waveguard-existing-services');
const { openBalanceSummary } = require('../services/open-balance');
const { generateEstimate } = require('../services/pricing-engine');

const relayContext = require('../services/voice-agent/relay-context');
const { TOOLS, CONTEXT_TOOLS, activeTools, executeTool } = require('../services/voice-agent/relay-tools');
const { SYSTEM_PROMPT, buildBasePrompt, PRICE_LINE_NO_CONTEXT } = require('../services/voice-agent/relay-conversation');

// Synthetic fixtures only — 555 numbers, no real customer data (repo P0).
const FROM = '+19415550142';
// The WS setup frame is unverified input; the SIGNATURE-VERIFIED /voice webhook's
// call_log row is what proves this CallSid is a real inbound call from that number.
const CALL_SID = 'CA-relay-1';
// `created_at` is NOT decoration: the relay only accepts a call_log row that is
// CURRENT (replay bound in verifyInboundCaller), so it is stamped relative to
// now, never a literal date.
const VERIFIED_CALL_ROW = { twilio_call_sid: CALL_SID, from_phone: FROM, direction: 'inbound', metadata: JSON.stringify({ stir_verstat: 'TN-Validation-Passed-A' }), created_at: new Date() };
// `phone` is the ONE authenticating column. A fixture without it is a
// contact-slot recognition and fails closed to the redacted tier.
const CUSTOMER = { id: 'c-1111', first_name: 'Pat', member_since: '2023-04-01T00:00:00Z', pipeline_stage: 'active_customer', phone: FROM };
// Same account reached because the ANI sits in a service-contact slot — a
// spouse, a tenant, or a PRIOR OCCUPANT of the property.
const CONTACT_SLOT_CUSTOMER = { id: 'c-1111', first_name: 'Pat', member_since: '2023-04-01T00:00:00Z', pipeline_stage: 'active_customer', phone: '+19415559999', service_contact2_phone: FROM };

// Chainable knex-builder stub: every chain method returns the builder, the
// builder is thenable (resolves `rows`), `.first()` resolves rows[0]. Write
// verbs exist only as spies so "no writes" is provable.
function makeBuilder(rows, { claimRows = null } = {}) {
  const b = {};
  const chain = ['whereNull', 'whereIn', 'orderBy', 'select', 'limit', 'offset', 'whereRaw', 'orWhereRaw', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'whereNot'];
  for (const m of chain) b[m] = jest.fn(() => b);
  b.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(b, b); return b; });
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  // ⭐ THE ONE WRITE THIS LANE MAKES ON THE READ PATH: the single-use CallSid
  // claim, burned atomically on the call's own signature-verified call_log row
  // (`metadata.relay_session_claimed_at`). It is the recognition boundary, not
  // an account write — so only the call_log builder may update, it must be
  // exactly that jsonb_set, and every other table still explodes.
  b.update = claimRows
    ? jest.fn((payload) => {
        const sql = String((payload && payload.metadata && payload.metadata.__raw) || (payload && payload.metadata) || '');
        if (!sql.includes('relay_session_claimed_at')) throw new Error('WRITE ATTEMPTED');
        b._claimed = true;
        return { returning: jest.fn(() => Promise.resolve(claimRows())) };
      })
    : jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  b.del = jest.fn(() => { throw new Error('WRITE ATTEMPTED'); });
  return b;
}

let builders;
function primeDb({
  customers = [], scheduled = [], records = [], callLog = [VERIFIED_CALL_ROW],
  // What the atomic claim returns: one row = this session won it, [] = the
  // CallSid was already claimed (a replay, possibly on another instance).
  claimRows = () => [{ id: 'cl-1' }],
} = {}) {
  builders = {
    customers: makeBuilder(customers),
    scheduled_services: makeBuilder(scheduled),
    service_records: makeBuilder(records),
    call_log: makeBuilder(callLog, { claimRows }),
  };
  db.mockImplementation((table) => {
    if (!builders[table]) builders[table] = makeBuilder([]);
    return builders[table];
  });
  // The claim's jsonb_set expression rides through db.raw.
  db.raw = jest.fn((sql) => ({ __raw: sql }));
}

// No ACCOUNT write anywhere. The single-use CallSid claim on call_log is the
// one exception and is asserted on its own terms (it is the recognition
// boundary, not data): every other builder must be untouched, and call_log may
// only ever have taken the claim.
function assertNoWrites() {
  for (const [table, b] of Object.entries(builders || {})) {
    expect(b.insert).not.toHaveBeenCalled();
    expect(b.del).not.toHaveBeenCalled();
    if (table !== 'call_log') expect(b.update).not.toHaveBeenCalled();
  }
}

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  primeDb();
  loadOwnedRecurringServiceKeys.mockResolvedValue([]);
  openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
  summarizePriorCall.mockResolvedValue(null);
});

describe('GATE OFF (default) — everything dark, fail-closed', () => {
  test('no context tools registered', () => {
    expect(relayContext.isContextEnabled()).toBe(false);
    expect(activeTools()).toEqual(TOOLS);
    expect(activeTools().map((t) => t.name)).not.toEqual(expect.arrayContaining(['get_account_overview']));
  });

  test('base prompt is byte-identical to Phase 1 (incl. the CANNOT-quote-prices line)', () => {
    expect(buildBasePrompt(false)).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).toContain(PRICE_LINE_NO_CONTEXT); // pins the replace target
    expect(SYSTEM_PROMPT).not.toContain('KNOWN CALLER');
    expect(SYSTEM_PROMPT).not.toContain('get_pricing');
  });

  test('resolveCallerContext returns null WITHOUT touching the DB', async () => {
    expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('context tools refuse even with a customerId in ctx (defense in depth), no DB touch', async () => {
    for (const name of ['get_account_overview', 'get_service_history', 'get_pricing', 'lookup_customer']) {
      const out = await executeTool(name, { service: 'pest_control', home_sqft: 2000 }, { customerId: 'c-1111' });
      expect(out).toMatch(/not available/i);
    }
    expect(db).not.toHaveBeenCalled();
    expect(generateEstimate).not.toHaveBeenCalled();
  });
});

describe('GATE ON — caller recognition', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('context tools register alongside the Phase 0/1 tools', () => {
    const names = activeTools().map((t) => t.name).sort();
    expect(names).toEqual(['capture_lead', 'find_slots', 'get_account_overview', 'get_availability',
      'get_call_history', 'get_invoice_history', 'get_message_history', 'get_open_estimates',
      'get_pricing', 'get_service_history', 'get_service_report', 'get_services_catalog',
      'get_today_eta', 'lookup_customer', 'request_reservice']);
    expect(CONTEXT_TOOLS.every((t) => t.input_schema)).toBe(true);
  });

  test('gate-on prompt swaps the price line for the get_pricing rule + persona + trust boundary', () => {
    const p = buildBasePrompt(true);
    expect(p).not.toContain('You CANNOT quote prices');
    expect(p).toContain('get_pricing tool');
    expect(p).toContain('Never negotiate');
    expect(p).toContain('your name is Sandy');
    expect(p).toContain('never claim to be human');
    expect(p).toContain('ACCOUNT ACCESS RULES');
    expect(p).toContain("Verify, don't recite");
    // Phase B: lookup + confirm-don't-recite for non-matching voices, and
    // pricing declared public.
    expect(p).toContain('lookup_customer');
    expect(p).toContain("confirm-don't-recite");
    expect(p).toContain('Pricing is public website information');
    // Phase E: clock-based callback expectations, the re-service lane for
    // existing customers, the hot-lead escalation, and capture-don't-act
    // contact preferences all ride the SAME gate.
    expect(p).toContain('TIME AND CALLBACK PROMISES');
    expect(p).toContain('THE PROBLEM CAME BACK');
    expect(p).toContain('URGENT CALLS');
    expect(p).toContain('IF THEY TELL YOU HOW TO CONTACT THEM');
    expect(p).toContain('never starts an appointment before 8:00 AM Eastern');
    // Everything BEFORE the price line is untouched.
    expect(p).toContain('ONLY state appointment times that a tool actually returned');
  });

  test('VOICE_AGENT_NAME overrides the persona name', () => {
    process.env.VOICE_AGENT_NAME = 'Marge';
    try {
      expect(buildBasePrompt(true)).toContain('your name is Marge');
    } finally {
      delete process.env.VOICE_AGENT_NAME;
    }
  });

  test('unknown caller → null (no block), matcher queried all 4 canonical columns', async () => {
    primeDb({ customers: [] });
    expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    const custQ = builders.customers;
    expect(custQ.whereNull).toHaveBeenCalledWith('deleted_at');
    const cols = custQ.orWhereRaw.mock.calls.map(([sql]) => sql);
    expect(cols).toHaveLength(4);
    expect(cols.join(' ')).toMatch(/phone/);
    expect(cols.join(' ')).toMatch(/service_contact_phone/);
    expect(cols.join(' ')).toMatch(/service_contact2_phone/);
    expect(cols.join(' ')).toMatch(/service_contact3_phone/);
    // 10-digit key, never the raw E.164
    for (const [, params] of custQ.orWhereRaw.mock.calls) expect(params).toEqual(['9415550142']);
    expect(custQ.limit).toHaveBeenCalledWith(2);
  });

  test('AMBIGUOUS — 2 customers share the number → treated exactly as unknown', async () => {
    primeDb({ customers: [CUSTOMER, { ...CUSTOMER, id: 'c-2222', first_name: 'Sam' }] });
    expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
  });

  test('blocked/short caller id → null without a DB query', async () => {
    for (const bad of ['', null, 'anonymous', '+1941555']) {
      expect(await relayContext.resolveCallerContext(bad, { callSid: CALL_SID })).toBeNull();
    }
    expect(db).not.toHaveBeenCalled();
  });

  // ⭐ THE WS SETUP FRAME IS NOT EVIDENCE OF A PHONE CALL. `from` arrives in an
  // unverified frame on a socket guarded only by a static secret in a URL query
  // param (which Twilio logs). A leaked key would otherwise let anyone declare
  // any caller ID and read that account. The cross-check is the call_log row the
  // SIGNATURE-VERIFIED /voice webhook wrote.
  test('no call_log row for this CallSid → UNKNOWN caller, no account read, call not failed', async () => {
    primeDb({ customers: [CUSTOMER], callLog: [] });
    expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
    expect(openBalanceSummary).not.toHaveBeenCalled();
  });

  test('declared `from` that does not match the call_log row → UNKNOWN caller', async () => {
    primeDb({
      customers: [CUSTOMER],
      callLog: [{ ...VERIFIED_CALL_ROW, from_phone: '+19415557777' }],
    });
    expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
  });

  test('no callSid at all (sandbox / TwiML-Bin path) → UNKNOWN caller, no DB touch', async () => {
    primeDb({ customers: [CUSTOMER] });
    expect(await relayContext.resolveCallerContext(FROM)).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('an OUTBOUND call_log row never verifies an inbound relay session', async () => {
    primeDb({ customers: [CUSTOMER], callLog: [{ ...VERIFIED_CALL_ROW, direction: 'outbound' }] });
    expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
  });

  test('verifyInboundCaller fails CLOSED on a DB error and surfaces the attestation on success', async () => {
    primeDb({ callLog: [] });
    builders.call_log.first = jest.fn(() => Promise.reject(new Error('pool exhausted')));
    expect(await relayContext.verifyInboundCaller({ callSid: CALL_SID, from: FROM }))
      .toEqual({ verified: false, reason: 'error' });

    primeDb({});
    // STIR/SHAKEN attestation is surfaced for measurement; gating the FULL tier
    // on attestation A is a documented follow-up, not implemented here.
    expect(await relayContext.verifyInboundCaller({ callSid: CALL_SID, from: FROM }))
      .toEqual({ verified: true, attestation: 'TN-Validation-Passed-A' });
  });

  // ⭐ A call_log ROW IS PERMANENT; A CALL IS NOT. Matching one only proves the
  // pair was real once — so whoever holds the leaked WS key could otherwise
  // replay an old CallSid forever.
  describe('replay bounds on the verified CallSid', () => {
    test('a call_log row older than the freshness window does not verify', async () => {
      const stale = { ...VERIFIED_CALL_ROW, created_at: new Date(Date.now() - 60 * 60 * 1000) };
      primeDb({ customers: [CUSTOMER], callLog: [stale] });
      expect(await relayContext.verifyInboundCaller({ callSid: CALL_SID, from: FROM }))
        .toEqual({ verified: false, reason: 'call_not_current' });
      expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    });

    test('a row with no created_at at all fails closed', async () => {
      primeDb({ customers: [CUSTOMER], callLog: [{ ...VERIFIED_CALL_ROW, created_at: null }] });
      expect(await relayContext.verifyInboundCaller({ callSid: CALL_SID, from: FROM }))
        .toEqual({ verified: false, reason: 'call_not_current' });
    });

    // The claim is a single atomic UPDATE on the call's own row — one caller
    // gets a row back, every replay gets zero — so it holds across instances
    // and restarts, which an in-process Map never did.
    test('the claim is won once and lost thereafter, in shared storage', async () => {
      primeDb({ customers: [CUSTOMER] }); // claim returns a row
      expect(await relayContext.beginRelaySessionClaim(CALL_SID)).toBe(true);
      const update = builders.call_log.update;
      expect(update).toHaveBeenCalledTimes(1);
      expect(String(update.mock.calls[0][0].metadata.__raw)).toContain('jsonb_set');

      primeDb({ customers: [CUSTOMER], claimRows: () => [] }); // already claimed
      expect(await relayContext.beginRelaySessionClaim(CALL_SID)).toBe(false);
      // A blank CallSid never claims anything, and never touches the DB.
      expect(await relayContext.beginRelaySessionClaim('')).toBe(false);
    });

    test('a replayed CallSid resolves to NO caller context', async () => {
      primeDb({ customers: [CUSTOMER], claimRows: () => [] });
      expect(await relayContext.verifyInboundCaller({ callSid: CALL_SID, from: FROM }))
        .toEqual({ verified: false, reason: 'call_sid_already_claimed' });
      expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    });

    test('a claim that cannot be proven fails CLOSED', async () => {
      primeDb({ customers: [CUSTOMER] });
      builders.call_log.update = jest.fn(() => { throw new Error('pool exhausted'); });
      expect(await relayContext.beginRelaySessionClaim(CALL_SID)).toBe(false);
    });
  });

  // ⭐ THE ANTI-SPOOFING LEVER. A signature-verified webhook proves Twilio sent
  // this ANI, not that the caller owns it. VOICE_RELAY_REQUIRE_ATTESTATION is
  // the owner's switch for demanding the carrier vouch for it; OFF by default
  // because most genuine calls carry no attestation at all.
  describe('VOICE_RELAY_REQUIRE_ATTESTATION', () => {
    afterEach(() => { delete process.env.VOICE_RELAY_REQUIRE_ATTESTATION; });

    test('off (default): an unattested call is still recognised — today\'s behaviour', async () => {
      primeDb({
        customers: [CUSTOMER],
        callLog: [{ ...VERIFIED_CALL_ROW, metadata: JSON.stringify({ stir_verstat: 'No-TN-Validation' }) }],
      });
      const ctx = await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID });
      expect(ctx && ctx.customer.id).toBe(CUSTOMER.id);
    });

    test('on: an unattested call is a stranger — no recognition, no account reads', async () => {
      process.env.VOICE_RELAY_REQUIRE_ATTESTATION = 'true';
      primeDb({
        customers: [CUSTOMER],
        callLog: [{ ...VERIFIED_CALL_ROW, metadata: JSON.stringify({ stir_verstat: 'TN-Validation-Failed-C' }) }],
      });
      expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID })).toBeNull();
    });

    test('on: a carrier-vouched attestation-A call is recognised normally', async () => {
      process.env.VOICE_RELAY_REQUIRE_ATTESTATION = 'true';
      primeDb({ customers: [CUSTOMER], callLog: [VERIFIED_CALL_ROW] });
      const ctx = await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID });
      expect(ctx && ctx.customer.id).toBe(CUSTOMER.id);
    });

    // ⭐ AND THE SESSION FLAG FOLLOWS THE RULING. lookup_customer is the one
    // tool that does not need a matched customer id, so "no recognition and no
    // account reads" only holds if the verified flag the session hands the
    // tools is false too.
    test('on: a demoted call reports NOT verified to the session (no lookup either)', async () => {
      process.env.VOICE_RELAY_REQUIRE_ATTESTATION = 'true';
      primeDb({
        customers: [CUSTOMER],
        callLog: [{ ...VERIFIED_CALL_ROW, metadata: JSON.stringify({ stir_verstat: 'No-TN-Validation' }) }],
      });
      const seen = [];
      expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID, onVerified: (ok) => seen.push(ok) }))
        .toBeNull();
      expect(seen).toEqual([false]);
    });

    test('off: a verified-but-unmatched caller still reports verified (lookup stays open)', async () => {
      primeDb({ customers: [] }); // real call, number not on file
      const seen = [];
      expect(await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID, onVerified: (ok) => seen.push(ok) }))
        .toBeNull();
      expect(seen).toEqual([true]);
    });

    test('only a PASSED-A counts — a passed B or C does not', () => {
      expect(relayContext.isFullAttestation('TN-Validation-Passed-A')).toBe(true);
      expect(relayContext.isFullAttestation('A')).toBe(true);
      expect(relayContext.isFullAttestation('TN-Validation-Passed-B')).toBe(false);
      expect(relayContext.isFullAttestation('TN-Validation-Failed-A')).toBe(false);
      expect(relayContext.isFullAttestation('No-TN-Validation')).toBe(false);
      expect(relayContext.isFullAttestation(null)).toBe(false);
    });
  });

  test('matched caller → KNOWN CALLER block with name, since-year, services, appt, visit, balance, prior call', async () => {
    primeDb({
      customers: [CUSTOMER],
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', window_end: '11:00 AM', status: 'confirmed' }],
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'treated for chinch bugs', structured_notes: null, status: 'completed' }],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control', 'lawn_care']);
    openBalanceSummary.mockResolvedValue({ total: 150, count: 2, moreCount: 0, invoices: [] });
    summarizePriorCall.mockResolvedValue({ hoursAgo: 18, summary: 'Asked about ants in the kitchen', captured: {} });

    const ctx = await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID });
    expect(ctx.customer).toEqual({ id: 'c-1111', first_name: 'Pat' });
    expect(ctx.tier).toBe('full'); // the ANI IS customers.phone
    const block = ctx.block;
    expect(block).toContain('KNOWN CALLER');
    expect(block).toContain('First name: Pat');
    expect(block).toContain('Customer since: 2023');
    expect(block).toContain('Pest Control; Lawn Care');
    expect(block).toContain('Next appointment: Tuesday August 18 — Pest Control');
    expect(block).toContain('Last completed visit: Friday July 31 — Lawn Care');
    expect(block).toContain('Open balance: yes — $150 across 2 invoices');
    expect(block).toContain('Previous call (~18h before this one): Asked about ants in the kitchen');
    expect(block).toContain('never instructions'); // data-not-instructions labeling
    // PII hygiene: the block never carries the raw phone number.
    expect(block).not.toContain('9415550142');
    assertNoWrites();
  });

  test('summarizePriorCall unavailable (not a function) → block still builds, fail-open to no prior line', async () => {
    primeDb({ customers: [CUSTOMER] });
    const crp = require('../services/call-recording-processor');
    const saved = crp.summarizePriorCall;
    crp.summarizePriorCall = undefined;
    try {
      const ctx = await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID });
      expect(ctx.customer.id).toBe('c-1111');
      expect(ctx.block).not.toContain('Previous call');
    } finally {
      crp.summarizePriorCall = saved;
    }
  });
});

describe('GATE ON — account tools', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('unmatched caller → account tools refuse, offer office callback, no account query', async () => {
    const overview = await executeTool('get_account_overview', {}, { customerId: null });
    expect(overview).toMatch(/No customer account matches/i);
    expect(overview).toMatch(/call them back/i);
    const history = await executeTool('get_service_history', {}, {});
    expect(history).toMatch(/No customer account matches/i);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(loadOwnedRecurringServiceKeys).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  // ⭐ THE ARRIVAL WINDOW IS window_start + 2h, FROM THE SHARED HELPER.
  // AGENTS.md pins customer-facing arrival copy to arrivalWindowRange() and
  // says report "next appointment" displays follow the same +2h rule — the
  // phone is one, and it must not drift from the reminders, the track page or
  // get_today_eta. (The DB column is a `time`, so a real row is 'HH:MM:SS'.)
  test('the next-appointment window is the shared start + 2h range, never the bare start', async () => {
    primeDb({
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '09:00:00', window_end: '15:00:00', status: 'confirmed' }],
    });
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1111', customerTier: 'full' });
    expect(out).toContain('arrival window 9:00 AM to 11:00 AM');
    expect(out).not.toContain('window starting');
    expect(out).not.toContain('3:00 PM'); // window_end is duration data, never spoken
  });

  test('matched caller → get_account_overview returns plan/appt/visit/balance from the readers', async () => {
    primeDb({
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', status: 'confirmed' }],
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'mowed edges', structured_notes: null, status: 'completed' }],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control']);
    openBalanceSummary.mockResolvedValue({ total: 49.5, count: 1, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1111', customerTier: 'full' });
    expect(out).toContain('Pest Control');
    expect(out).toContain('Tuesday August 18');
    expect(out).toContain('Friday July 31');
    expect(out).toContain('$49.50');
    assertNoWrites();
  });

  // FAIL CLOSED: every tier default is 'redacted'. A session ctx with no tier
  // — or a contact-slot recognition — gets the redacted view, never the
  // balance AMOUNT or the appointment window.
  test('matched caller with NO customerTier → redacted overview (no amount, no window)', async () => {
    primeDb({
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', status: 'confirmed' }],
      records: [],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control']);
    openBalanceSummary.mockResolvedValue({ total: 49.5, count: 1, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1111' });
    expect(out).not.toContain('$49.50');
    expect(out).not.toContain('window starting');
    expect(out).toMatch(/Do NOT state or estimate the amount/i);
  });

  test('the exported helpers themselves default to redacted (no option passed)', async () => {
    primeDb({ scheduled: [], records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'note-1', structured_notes: null, status: 'completed' }] });
    loadOwnedRecurringServiceKeys.mockResolvedValue([]);
    openBalanceSummary.mockResolvedValue({ total: 12, count: 1, moreCount: 0, invoices: [] });
    expect(await relayContext.accountOverviewText('c-1111')).not.toContain('$12');
    expect(await relayContext.serviceHistoryText('c-1111')).not.toContain('SAFE:note-1');
  });

  test('get_service_history → last visits use the customer-facing notes scrub, never raw internal notes', async () => {
    primeDb({
      records: [
        { service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'note-1', structured_notes: null, status: 'completed' },
        { service_date: '2026-06-15', service_type: 'Pest Control', technician_notes: 'internal-only-secret', structured_notes: JSON.stringify({ typedReportDelivery: 'internal_only' }), status: 'completed' },
      ],
    });
    const out = await executeTool('get_service_history', {}, { customerId: 'c-1111', customerTier: 'full' });
    // customerSafeServiceNotes (mocked as SAFE:-prefix) is the ONLY notes path.
    expect(out).toContain('SAFE:note-1');
    // internal_only typed delivery suppresses notes entirely (same predicate
    // as the customer portal's GET /api/services).
    expect(out).not.toContain('internal-only-secret');
    expect(out).not.toContain('SAFE:internal-only-secret');
    assertNoWrites();
  });

  // ⭐ RAW TECHNICIAN NOTES NEVER EGRESS ON A REPORT PATH (AGENTS.md; owner
  // ruling 2026-07-16). The fee scrub alone returns an ordinary visit's note
  // VERBATIM, so a history read that stood on it spoke the technician's
  // internal note — access codes, billing notes — down the phone. Only
  // technicianReportCustomerCopy's reviewed parse may be spoken; anything else
  // parses to null and is simply not said, exactly as get_service_report does.
  test('an UNREVIEWED technician note is not spoken at all (parser-approved copy only)', async () => {
    const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');
    technicianReportCustomerCopy.mockReturnValue(null); // not the reviewed two-section draft
    primeDb({
      records: [{
        service_date: '2026-07-31', service_type: 'Lawn Care',
        technician_notes: 'gate code 4482, customer disputes the invoice', structured_notes: null, status: 'completed',
      }],
    });
    const out = await executeTool('get_service_history', {}, { customerId: 'c-1111', customerTier: 'full' });
    expect(out).toContain('Friday July 31');   // the visit itself is still stated
    expect(out).not.toContain('4482');         // the note is not
    expect(out).not.toContain('disputes');
    expect(out).not.toContain('SAFE:');
    technicianReportCustomerCopy.mockImplementation((notes) => (notes ? { body: String(notes) } : null));
  });

  test('balance of zero reads as none', async () => {
    openBalanceSummary.mockResolvedValue({ total: 0, count: 0, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', {}, { customerId: 'c-1111', customerTier: 'full' });
    expect(out).toMatch(/Open balance: none/);
  });
});

describe('GATE ON — lookup_customer (output shaping is the point)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  // Rows deliberately carry every sensitive field a naive SELECT * would leak;
  // the assertions below prove none of it ever reaches the model.
  const ROW = {
    id: 'c-9001',
    first_name: 'Dana',
    last_name: 'Whitfield',
    city: 'Sarasota',
    address_line1: '482 Palmetto Grove Ln',
    email: 'dana@example.com',
    phone: '+19415550999',
  };

  // Mirrors the session ctx relay-conversation builds: opaque refs + the
  // per-call lookup budget + the caller's own ANI.
  function lookupCtx({ from = FROM, budget = relayContext.LOOKUP_SESSION_BUDGET, callerVerified = true } = {}) {
    const refs = new Map();
    let used = 0;
    return {
      customerId: null,
      from,
      // The session was cross-checked against the signature-verified /voice
      // call_log row. lookup_customer is the one tool an UNMATCHED caller can
      // reach, so it is the one that must check this itself.
      callerVerified,
      consumeLookup: () => {
        if (used >= budget) return false;
        used += 1;
        return true;
      },
      rememberLookup: (row) => {
        const ref = `C${refs.size + 1}`;
        refs.set(ref, row.id);
        return ref;
      },
      resolveLookupRef: (ref) => refs.get(String(ref || '').trim().toUpperCase()) || null,
      _refs: refs,
      _used: () => used,
    };
  }

  // ⭐ THE ADDRESS-ORACLE FIX. One criterion never yields a ref — and the
  // refusal is identical whether or not the DB would have matched, so the
  // refusal itself is not an oracle either.
  test('ONE criterion → no ref, no DB read, and the SAME answer match-or-not', async () => {
    primeDb({ customers: [ROW] });
    const ctx = lookupCtx();
    const nameOnly = await executeTool('lookup_customer', { name: 'Dana Whitfield' }, ctx);
    expect(nameOnly).toMatch(/need two details/i);
    expect(nameOnly).not.toMatch(/customer_ref/);
    expect(nameOnly).not.toContain('Dana');
    expect(nameOnly).not.toContain('Sarasota');
    expect(db).not.toHaveBeenCalled();
    expect(ctx._refs.size).toBe(0);

    primeDb({ customers: [] });
    const noMatch = await executeTool('lookup_customer', { name: 'Zebulon Quark' }, ctx);
    expect(noMatch).toBe(nameOnly); // byte-identical: nothing is confirmed or denied
    expect(db).not.toHaveBeenCalled();
    expect(ctx._used()).toBe(0); // a refused lookup costs no budget
  });

  test('street fragment alone → refused (the street oracle is the worst one)', async () => {
    primeDb({ customers: [ROW] });
    const out = await executeTool('lookup_customer', { street: 'Palmetto Grove' }, lookupCtx());
    expect(out).toMatch(/need two details/i);
    expect(db).not.toHaveBeenCalled();
  });

  // ⭐ THE ONE-CRITERION ANI SHORTCUT IS GONE. It read `ctx.from` — the
  // UNVERIFIED WebSocket setup-frame value — as proof of identity, so anyone
  // holding the shared WS key could declare a target number and have it satisfy
  // its own single criterion. Two independent criteria, always.
  test('phone alone is never enough — not even the number the session declared', async () => {
    primeDb({ customers: [ROW] });
    const foreign = await executeTool('lookup_customer', { phone: '941-555-0999' }, lookupCtx());
    expect(foreign).toMatch(/need two details/i);
    expect(db).not.toHaveBeenCalled();

    primeDb({ customers: [ROW] });
    const own = await executeTool('lookup_customer', { phone: FROM }, lookupCtx({ from: FROM }));
    expect(own).toMatch(/need two details/i);
    expect(own).not.toMatch(/customer_ref/);
    expect(db).not.toHaveBeenCalled();
  });

  // ⭐ AND AN UNVERIFIED SESSION CANNOT LOOK ANYTHING UP AT ALL. Every other
  // tool needs a matched customerId (which only exists after verification);
  // this one is reachable by an unmatched caller by design, so it carries the
  // check. The refusal says nothing about whether anything matched.
  test('a session that never proved a live call is refused before any query', async () => {
    primeDb({ customers: [ROW] });
    const out = await executeTool(
      'lookup_customer',
      { name: 'Dana Whitfield', street: 'Palmetto Grove' },
      lookupCtx({ callerVerified: false }),
    );
    expect(out).toMatch(/cannot pull up an account on this call/i);
    expect(out).not.toMatch(/customer_ref/);
    expect(out).not.toContain('Dana');
    expect(db).not.toHaveBeenCalled();
  });

  test('per-call lookup budget: 3 DB-reaching lookups, then the tool is closed', async () => {
    const ctx = lookupCtx();
    for (let i = 0; i < relayContext.LOOKUP_SESSION_BUDGET; i++) {
      primeDb({ customers: [] });
      const out = await executeTool('lookup_customer', { name: `Person${i}`, street: 'Main' }, ctx);
      expect(out).toMatch(/No account matches/i);
    }
    primeDb({ customers: [ROW] });
    const refused = await executeTool('lookup_customer', { name: 'Dana Whitfield', street: 'Palmetto' }, ctx);
    expect(refused).toMatch(/No more account lookups/i);
    expect(refused).not.toMatch(/customer_ref/);
    expect(ctx._refs.size).toBe(0);
  });

  test('single match → match-found + first name + city + ref, NEVER address/email/phone/id', async () => {
    primeDb({ customers: [ROW] });
    const ctx = lookupCtx();
    const out = await executeTool('lookup_customer', { name: 'Dana Whitfield', street: 'Palmetto Grove' }, ctx);
    expect(out).toContain('Dana');
    expect(out).toContain('Sarasota');
    expect(out).toMatch(/customer_ref: C1/);
    // Output shaping — no record dump, ever:
    expect(out).not.toContain('482');
    expect(out).not.toContain('Palmetto Grove');
    expect(out).not.toContain('dana@example.com');
    expect(out).not.toContain('5550999');
    expect(out).not.toContain('c-9001'); // raw id never crosses the model boundary
    expect(out).toMatch(/confirm details they state/i);
    assertNoWrites();
  });

  test('name tokens must each hit first OR last name; street searches address_line1; phone uses the canonical digit key', async () => {
    primeDb({ customers: [ROW] });
    const ctx = lookupCtx();
    await executeTool('lookup_customer', { name: 'Dana Whitfield', street: 'Palmetto Grove', phone: '941-555-0999' }, ctx);
    const b = builders.customers;
    expect(b.whereNull).toHaveBeenCalledWith('deleted_at');
    const rawSqls = [...b.whereRaw.mock.calls, ...b.orWhereRaw.mock.calls].map(([sql]) => sql);
    expect(rawSqls.join(' ')).toMatch(/first_name ILIKE/);
    expect(rawSqls.join(' ')).toMatch(/last_name ILIKE/);
    expect(rawSqls.join(' ')).toMatch(/address_line1 ILIKE/);
    // Phone matching reuses the same 10-digit key predicate as the ANI matcher.
    const phoneParams = b.orWhereRaw.mock.calls.map(([, params]) => params).flat();
    expect(phoneParams).toContain('9415550999');
    // The looked-up row's SELECT never pulls address/email/phone columns.
    expect(b.select).toHaveBeenCalledWith('id', 'first_name', 'city');
  });

  test('no usable criteria → asks for name/street/phone, no DB query', async () => {
    const out = await executeTool('lookup_customer', { name: 'D' }, lookupCtx());
    expect(out).toMatch(/name.*street address.*phone/i);
    expect(db).not.toHaveBeenCalled();
  });

  test('AMBIGUOUS (2–5 matches) → count + first names only, asks the caller to narrow', async () => {
    primeDb({
      customers: [
        { ...ROW, id: 'c-1', first_name: 'Dana' },
        { ...ROW, id: 'c-2', first_name: 'Daniel', city: 'Venice', address_line1: '9 Oak St', email: 'dw@example.com' },
      ],
    });
    const ctx = lookupCtx();
    const out = await executeTool('lookup_customer', { name: 'Whitfield', street: 'Palmetto Grove' }, ctx);
    expect(out).toContain('2 accounts');
    expect(out).toContain('Dana');
    expect(out).toContain('Daniel');
    expect(out).toMatch(/narrow/i);
    // Ambiguous results carry NO refs, cities, or any other fields.
    expect(out).not.toMatch(/customer_ref/);
    expect(out).not.toContain('Sarasota');
    expect(out).not.toContain('Venice');
    expect(out).not.toContain('Oak St');
    expect(ctx._refs.size).toBe(0);
  });

  test('6+ matches → too many, no names at all', async () => {
    primeDb({ customers: Array.from({ length: 6 }, (_, i) => ({ ...ROW, id: `c-${i}`, first_name: `Name${i}` })) });
    const out = await executeTool('lookup_customer', { name: 'Smith', street: 'Main St' }, lookupCtx());
    expect(out).toMatch(/more than five/i);
    expect(out).not.toContain('Name0');
    expect(out).not.toMatch(/customer_ref/);
  });

  test('no match → suggests re-checking, captures as lead', async () => {
    primeDb({ customers: [] });
    const out = await executeTool('lookup_customer', { name: 'Zebulon Quark', street: 'Nowhere Rd' }, lookupCtx());
    expect(out).toMatch(/No account matches/i);
  });
});

describe('GATE ON — disclosure tiers (enforced in tool output, not prompt language)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  function refCtx({ ani = null, tier = 'full' } = {}) {
    return {
      customerId: ani,
      customerTier: ani ? tier : 'redacted',
      resolveLookupRef: (ref) => (String(ref).toUpperCase() === 'C1' ? 'c-9001' : null),
    };
  }

  // ⭐ PAST dates survive; the UPCOMING visit does not. Telling an unverified
  // caller that somebody WILL be at the property — and on which day — is the
  // physical-security disclosure get_today_eta refuses outright, and a lookup
  // ref would otherwise reach it here.
  test('looked-up (non-ANI) overview is REDACTED: past dates + services + balance yes/no; NO upcoming visit at all', async () => {
    primeDb({
      scheduled: [{ scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '9:00 AM', status: 'confirmed' }],
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'gate code 4482', structured_notes: null, status: 'completed' }],
    });
    loadOwnedRecurringServiceKeys.mockResolvedValue(['pest_control']);
    openBalanceSummary.mockResolvedValue({ total: 231.75, count: 3, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', { customer_ref: 'C1' }, refCtx({ ani: 'c-someone-else' }));
    // PAST dates + service names survive:
    expect(out).toContain('Pest Control');
    expect(out).toContain('Friday July 31');
    // …the UPCOMING visit is withheld entirely — no date, and no existence.
    expect(out).not.toContain('Tuesday August 18');
    expect(out).toMatch(/Upcoming appointments: not available for this caller/);
    expect(out).toMatch(/Do NOT say whether one is scheduled/);
    // Balance is yes/no only — never the amount:
    expect(out).toMatch(/Open balance: yes/);
    expect(out).not.toContain('$231.75');
    expect(out).not.toMatch(/\$\d/);
    // No appointment window on the redacted tier:
    expect(out).not.toContain('9:00 AM');
    expect(out).toMatch(/confirm details the caller states/i);
    assertNoWrites();
  });

  test('looked-up ref that IS the ANI-matched caller → full tier (their own account)', async () => {
    openBalanceSummary.mockResolvedValue({ total: 49.5, count: 1, moreCount: 0, invoices: [] });
    const out = await executeTool('get_account_overview', { customer_ref: 'C1' }, refCtx({ ani: 'c-9001' }));
    expect(out).toContain('$49.50');
  });

  test('redacted history: dates + service names only — visit summaries stripped', async () => {
    primeDb({
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'gate code 4482', structured_notes: null, status: 'completed' }],
    });
    const out = await executeTool('get_service_history', { customer_ref: 'C1' }, refCtx({ ani: null }));
    expect(out).toContain('Friday July 31 — Lawn Care');
    expect(out).not.toContain('SAFE:'); // the (already-scrubbed) summary itself is withheld on this tier
    expect(out).not.toContain('4482');
  });

  test('invented/unknown customer_ref → refused, no account read', async () => {
    const out = await executeTool('get_account_overview', { customer_ref: 'C7' }, refCtx({ ani: 'c-9001' }));
    expect(out).toMatch(/not from a lookup_customer result/i);
    expect(openBalanceSummary).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('full tier for the matched caller is unchanged by the tier plumbing', async () => {
    primeDb({
      records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'note-1', structured_notes: null, status: 'completed' }],
    });
    const out = await executeTool('get_service_history', {}, { customerId: 'c-1111', customerTier: 'full' });
    expect(out).toContain('SAFE:note-1');
  });

  // ⭐ CONTACT SLOTS ARE NOT AN AUTHENTICATION BOUNDARY. The three
  // service_contact*_phone columns are a LEAD-DEDUP column set that holds
  // spouses, tenants and PRIOR OCCUPANTS — an ANI matching one of them
  // recognises the account but verifies nobody.
  test('ANI on a contact slot → tier redacted, NOT full', async () => {
    primeDb({ customers: [CONTACT_SLOT_CUSTOMER] });
    loadOwnedRecurringServiceKeys.mockResolvedValue([]);
    openBalanceSummary.mockResolvedValue({ total: 231.75, count: 3, moreCount: 0, invoices: [] });
    const ctx = await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID });
    expect(ctx.customer.id).toBe('c-1111');
    expect(ctx.tier).toBe('redacted');
    expect(ctx.matchedColumn).toBe('service_contact2_phone');
    // The system block itself drops the amount and the arrival window.
    expect(ctx.block).not.toContain('$231.75');
    expect(ctx.block).toMatch(/NOT as that account holder's own/i);
  });

  test('a contact-slot ANI cannot reach a full-tier surface', async () => {
    primeDb({ records: [{ service_date: '2026-07-31', service_type: 'Lawn Care', technician_notes: 'note-1', structured_notes: null, status: 'completed' }] });
    const out = await executeTool('get_service_history', {}, { customerId: 'c-1111', customerTier: 'redacted' });
    expect(out).not.toContain('SAFE:note-1');
    expect(out).toMatch(/Looked-up account|confirm, don't recite/i);
  });

  test('customers.phone wins when the ANI is in BOTH its own column and a slot', async () => {
    primeDb({ customers: [{ ...CONTACT_SLOT_CUSTOMER, phone: FROM }] });
    const ctx = await relayContext.resolveCallerContext(FROM, { callSid: CALL_SID });
    expect(ctx.tier).toBe('full');
    expect(ctx.matchedColumn).toBe('phone');
  });
});

describe('GATE ON — get_pricing (estimator read path only)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('UNMATCHED caller → get_pricing works (pricing is public website information)', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{
        service: 'pest_control', perApp: 112, monthly: 37.33, annual: 448,
        monthlyAfterDiscount: 37.33, annualAfterDiscount: 448,
        frequency: 'quarterly', visitsPerYear: 4, initialFee: 99, requiresManualReview: false,
      }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'pest_control', home_sqft: 2000 }, { customerId: null });
    expect(generateEstimate).toHaveBeenCalled();
    expect(out).toContain('$112 per application');
    expect(out).toMatch(/Quote ONLY these numbers/);
  });

  test('missing required inputs → says exactly what is missing, engine untouched, no guessed number', async () => {
    const out = await executeTool('get_pricing', { service: 'pest_control' }, { customerId: 'c-1111' });
    expect(out).toContain('home_sqft');
    expect(out).toMatch(/Do NOT guess/i);
    expect(out).not.toMatch(/\$\d/);
    expect(generateEstimate).not.toHaveBeenCalled();

    const lawn = await executeTool('get_pricing', { service: 'lawn_care', home_sqft: 2000 }, { customerId: 'c-1111' });
    expect(lawn).toContain('lot_sqft');
    expect(generateEstimate).not.toHaveBeenCalled();
  });

  test('pest pricing comes ONLY from generateEstimate (the /calculate read path), per-APPLICATION wording', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{
        service: 'pest_control', perApp: 112, monthly: 37.33, annual: 448,
        monthlyAfterDiscount: 37.33, annualAfterDiscount: 448,
        frequency: 'quarterly', visitsPerYear: 4, initialFee: 99, requiresManualReview: false,
      }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'pest_control', home_sqft: 2000, frequency: 'quarterly' }, { customerId: 'c-1111' });
    expect(generateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      homeSqFt: 2000,
      propertyType: 'single_family',
      services: { pest: { frequency: 'quarterly' } },
    }));
    expect(out).toContain('$112 per application');
    // ⭐ NO COMBINED PLAN TOTALS. AGENTS.md ("Per application" price copy,
    // owner 2026-07-23) and public-ranges.js's own header rule on this SAME
    // engine output ("no combined per-month or per-year program totals"). This
    // reply used to append "billed monthly that is $37.33 per month; $448 per
    // year" to every non-termite quote.
    expect(out).not.toContain('$37.33');
    expect(out).not.toContain('$448');
    expect(out).not.toMatch(/per month/i);
    // "4 applications per year" is a CADENCE COUNT, not a dollar total — the
    // same thing PriceCard.jsx's cadence line renders ("Count only — no
    // combined annual dollar total").
    expect(out).toContain('4 applications per year');
    expect(out).toMatch(/never add them up into a monthly or yearly plan total/i);
    // The fee is stated WITH its documented waiver (public-ranges.js: waived
    // when bundled with another recurring service or with annual prepay) —
    // stating it flat overquoted every caller about to bundle.
    expect(out).toContain('$99 initial service fee on standalone pest service');
    expect(out).toMatch(/waived if they bundle/i);
    expect(out).toMatch(/pay for the year up front/i);
    expect(out).toMatch(/Quote ONLY these numbers/);
    // Owner rule: "per application", never "per visit".
    expect(out).not.toMatch(/per visit/i);
    // Every dollar figure in the reply came from the engine line.
    const dollars = out.match(/\$[\d.]+/g) || [];
    expect(new Set(dollars)).toEqual(new Set(['$112', '$99']));
  });

  test('termite_bait forces the trelona/basic program like public-quote and reports install + monitoring', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{ service: 'termite_bait', perApp: 72, monthly: 35, annual: 420, monthlyAfterDiscount: 35, annualAfterDiscount: 420, visitsPerYear: 4, install: { price: 610 }, requiresManualReview: false }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'termite_bait', home_sqft: 2000 }, { customerId: 'c-1111' });
    expect(generateEstimate).toHaveBeenCalledWith(expect.objectContaining({
      services: { termite: { system: 'trelona', monitoringTier: 'basic' } },
    }));
    expect(out).toContain('$610 station installation');
    // ⭐ Residential termite bait monitoring is billed PER APPLICATION, not per
    // month (owner 2026-07-20 — routes/public-quote.js deliberately keeps
    // residential termite bait OUT of MONTHLY_BILLED_SERVICE_KEYS, and
    // public-ranges.js publishes `termite_bait_monitoring` with
    // `unit: 'per application'`). "$35 per month monitoring" quoted a billing
    // unit the customer never pays.
    expect(out).toContain('then $72 per application for monitoring');
    expect(out).toContain('4 applications per year');
    expect(out).not.toMatch(/per month/i);
    expect(out).not.toContain('$420');
  });

  test('a genuinely monthly-billed line (no per-application signal) states the monthly ALONE, never an annual roll-up', async () => {
    // No `perApp`/`perVisit` on the line: routes/public-quote.js's
    // perApplicationForLine treats that absence as the design signal for a
    // monthly-billed program (public-ranges.js publishes tree & shrub with
    // `unit: 'per month'`).
    generateEstimate.mockReturnValue({
      lineItems: [{
        service: 'tree_shrub', monthly: 88, annual: 1056,
        monthlyAfterDiscount: 88, annualAfterDiscount: 1056,
        visits: 6, requiresManualReview: false,
      }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'tree_shrub', home_sqft: 2000, lot_sqft: 30000 }, { customerId: 'c-1111' });
    expect(out).toContain('$88 per month');
    expect(out).toContain('6 applications per year');
    // The annual roll-up is never spoken — the monthly is the whole price.
    expect(new Set(out.match(/\$[\d.]+/g) || [])).toEqual(new Set(['$88']));
  });

  // ⭐ AGENTS.md (estimator engine authority): engine low-confidence markers
  // (fpSource fallback, low pricingConfidence, turfBasis fallbacks) route to
  // the review lane and never auto-apply — and a price spoken down the phone
  // is the most binding auto-apply there is. The gate used to read only the
  // explicit manual-review/quote flags, so a lawn line priced off an ESTIMATED
  // turf area (no lawn size from the caller, so the engine derived one from
  // the lot) was read out as an exact number.
  test('low-confidence engine markers refuse the price, exactly like a manual-review line', async () => {
    const priceable = {
      service: 'lawn_care', perApp: 78, monthly: 78, monthlyAfterDiscount: 78,
      visitsPerYear: 12, requiresManualReview: false,
    };
    for (const marker of [
      { turfBasis: 'lotFallback' },
      { turfBasis: 'estimatedTurfSf' },
      { turfBasis: 'countyPrior' },
      { pricingConfidence: 'LOW' },
      { pricingConfidence: 'medium' },
      { fpSource: 'county_fallback' },
    ]) {
      generateEstimate.mockReturnValue({ lineItems: [{ ...priceable, ...marker }], summary: {} });
      const out = await executeTool(
        'get_pricing',
        { service: 'lawn_care', home_sqft: 2000, lot_sqft: 8000 },
        { customerId: 'c-1111' },
      );
      expect(out).toMatch(/needs a custom quote/i);
      expect(out).not.toMatch(/\$\d/);
    }
    // A line the engine priced off a real turf figure still quotes.
    generateEstimate.mockReturnValue({
      lineItems: [{ ...priceable, turfBasis: 'lawnSqFt', pricingConfidence: 'HIGH' }], summary: {},
    });
    const quoted = await executeTool(
      'get_pricing',
      { service: 'lawn_care', home_sqft: 2000, lot_sqft: 8000, lawn_sqft: 5000 },
      { customerId: 'c-1111' },
    );
    expect(quoted).toMatch(/\$78/);
  });

  test('manual-review line → refuses to state a price', async () => {
    generateEstimate.mockReturnValue({
      lineItems: [{ service: 'tree_shrub', perApp: 90, requiresManualReview: true }],
      summary: {},
    });
    const out = await executeTool('get_pricing', { service: 'tree_shrub', home_sqft: 2000, lot_sqft: 30000 }, { customerId: 'c-1111' });
    expect(out).toMatch(/custom quote/i);
    expect(out).toMatch(/do not state a price/i);
    expect(out).not.toContain('$90');
  });

  test('engine throwing → generic fail-closed reply, never a number', async () => {
    generateEstimate.mockImplementation(() => { throw new Error('constants not synced'); });
    const out = await executeTool('get_pricing', { service: 'pest_control', home_sqft: 2000 }, { customerId: 'c-1111' });
    expect(out).toMatch(/Could not look that up/i);
    expect(out).not.toMatch(/\$\d/);
  });
});

describe('RelayConversation wiring', () => {
  test('gate off → no context resolution is even started', () => {
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = new RelayConversation({ callSid: 'CA1', from: FROM, send: jest.fn() });
    expect(convo._contextReady).toBeNull();
    expect(convo._callerContext).toBeNull();
    expect(db).not.toHaveBeenCalled();
  });

  test('gate on + matched → _callerContext carries the customer id for toolCtx', async () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    primeDb({ customers: [CUSTOMER] });
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = new RelayConversation({ callSid: 'CA1', from: FROM, send: jest.fn() });
    await convo._contextReady;
    expect(convo._callerContext.customer.id).toBe('c-1111');
    expect(convo._callerContext.block).toContain('KNOWN CALLER');
  });

  test('gate on + unknown → _callerContext stays null (agent behaves exactly as today)', async () => {
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
    primeDb({ customers: [] });
    const { RelayConversation } = require('../services/voice-agent/relay-conversation');
    const convo = new RelayConversation({ callSid: 'CA1', from: FROM, send: jest.fn() });
    await convo._contextReady;
    expect(convo._callerContext).toBeNull();
  });
});
