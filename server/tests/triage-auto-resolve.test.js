// Triage auto-resolve sweep (2026-07-31). Born from the dead-letter backlog:
// ~1,800 open triage cards vs 32 ever resolved, so actionable cards drowned
// (the booking-miss watchdog's origin incident parked among them unseen).
// These tests pin the pure classifier — moot-condition resolves, age-based
// dismissals, the fail-closed allowlist, in_progress immunity — and the
// gate-off no-op. Fixtures synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const {
  runTriageAutoResolve,
  classifyTriageItem,
  RULE_NOTES,
  SPAM_AGE_DAYS,
  ADVISORY_AGE_DAYS,
} = require('../services/triage-auto-resolve');

const NOW = new Date('2026-07-31T07:20:00Z');
const FRESH = new Date(NOW.getTime() - 2 * 24 * 3600 * 1000).toISOString();
const OLD_31D = new Date(NOW.getTime() - 31 * 24 * 3600 * 1000).toISOString();
const OLD_8D = new Date(NOW.getTime() - 8 * 24 * 3600 * 1000).toISOString();

const CALL_AT = new Date(NOW.getTime() - 3 * 24 * 3600 * 1000).toISOString();
const CUSTOMER_BEFORE = new Date(NOW.getTime() - 100 * 24 * 3600 * 1000).toISOString();
const CUSTOMER_AFTER = new Date(new Date(CALL_AT).getTime() + 20 * 60 * 1000).toISOString();
// Extraction with no address supplied — the moot-eligible shape.
const NO_ADDR_EXTRACTION = { property: { service_address: { raw_text: null, street_line_1: null, city: null, postal_code: null } } };

function item(over = {}) {
  return {
    id: 't1', call_log_id: 'call-1', reason_code: 'address_unverifiable',
    status: 'open', severity: 'advisory', created_at: FRESH, payload: { flag: 'address_unverifiable', confidence: 0.5 },
    call_created_at: CALL_AT, customer_created_at: CUSTOMER_BEFORE,
    customer_pipeline_stage: 'active_customer', customer_deleted_at: null,
    call_extraction: NO_ADDR_EXTRACTION,
    call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: null }),
    customer_address_line1: null, customer_zip: null,
    customer_first_name: 'Pat', customer_last_name: null,
    ...over,
  };
}
const noBookings = { bookedCallIds: new Set(), bookedCallLatest: new Map() };
// A LIVE booking created after the card (the current-routing-result case).
const bookedCtx = (callId, at = new Date(NOW.getTime() - 24 * 3600 * 1000).toISOString()) => (
  { bookedCallIds: new Set([callId]), bookedCallLatest: new Map([[callId, at]]) }
);

describe('moot-condition resolves', () => {
  test('address flag resolves when the customer now has street + zip', () => {
    const d = classifyTriageItem(item({ customer_address_line1: '123 Sample St', customer_zip: '34205' }), noBookings, { now: NOW });
    expect(d).toEqual({ action: 'resolve', rule: 'address_moot' });
  });

  test('address flag stays open when either address component is missing', () => {
    expect(classifyTriageItem(item({ customer_address_line1: '123 Sample St', customer_zip: '' }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ customer_address_line1: null, customer_zip: '34205' }), noBookings, { now: NOW })).toBeNull();
  });

  test('a card holding NEW address evidence from the call is never resolved by the on-file primary', () => {
    const withEvidence = item({
      reason_code: 'address_unverified',
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      payload: { flag: 'address_unverified', address_as_heard: '456 Other Rd', address_candidates: [{ value: '456 Other Rd' }] },
    });
    expect(classifyTriageItem(withEvidence, noBookings, { now: NOW })).toBeNull();
    // Stringified payload (historical rows) is honored too; unparseable fails closed.
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      payload: JSON.stringify({ flag: 'x', address_as_heard: '456 Other Rd' }),
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      payload: 'not-json{',
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('a call whose EXTRACTION supplied an address never resolves from the on-file primary (base-payload blocking cards)', () => {
    const suppliedAddr = item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: { property: { service_address: { raw_text: 'a condo on Other Rd', street_line_1: null } } },
    });
    expect(classifyTriageItem(suppliedAddr, noBookings, { now: NOW })).toBeNull();
    // Stringified and missing extractions fail closed.
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: JSON.stringify({ property: { service_address: { street_line_1: '456 Other Rd' } } }),
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: null,
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('PARTIAL V2 address evidence (unit or subdivision alone) blocks the resolve', () => {
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: { property: { service_address: { street_line_2: 'Unit 4' } } },
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: { property: { service_address: { subdivision_or_community: 'Sample Estates' } } },
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('V1-ONLY address evidence blocks the resolve even when V2 heard nothing (the bridge-demotion case)', () => {
    const v1Heard = item({
      reason_code: 'address_unverified',
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: NO_ADDR_EXTRACTION,
      call_extraction_v1: JSON.stringify({ address_line1: '456 Other Rd', city: 'Bradenton', zip: null }),
    });
    expect(classifyTriageItem(v1Heard, noBookings, { now: NOW })).toBeNull();
    // A UNIT alone in the legacy extraction is new partial evidence too.
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction_v1: JSON.stringify({ address_line1: null, address_line2: 'Unit B', city: null, zip: null }),
    }), noBookings, { now: NOW })).toBeNull();
    // Unparseable V1 fails closed; a NULL V1 leaves the V2 verdict standing.
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction_v1: 'not-json{',
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction_v1: null,
    }), noBookings, { now: NOW })).toEqual({ action: 'resolve', rule: 'address_moot' });
  });

  test('an address card on a CONFIRMED-but-unbooked call is never resolved (only trace of the lost booking)', () => {
    const confirmedUnbooked = item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      call_extraction: { ...NO_ADDR_EXTRACTION, scheduling: { status: 'confirmed', confirmed_start_at: '2026-08-05T10:00:00-04:00' } },
    });
    expect(classifyTriageItem(confirmedUnbooked, noBookings, { now: NOW })).toBeNull();
    // Same call WITH booking provenance → the guard releases and it moots.
    expect(classifyTriageItem(confirmedUnbooked, bookedCtx('call-1'), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'address_moot' });
  });

  test('a soft-deleted customer never moots address or surname cards', () => {
    const deletedAt = new Date(NOW.getTime() - 5 * 24 * 3600 * 1000).toISOString();
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      customer_deleted_at: deletedAt,
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      customer_deleted_at: deletedAt,
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('a caller whose first name disagrees with the linked record never moots the surname card (phone-fallback link)', () => {
    // Phone matched the account, but the caller is someone else (spouse/new owner).
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      customer_first_name: 'Alex',
      call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: null }),
    }), noBookings, { now: NOW })).toBeNull();
    // No heard first name at all fails closed.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      call_extraction_v1: JSON.stringify({ first_name: null, last_name: null }),
      call_extraction: NO_ADDR_EXTRACTION,
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('terminal/dormant customer stages never moot address cards (stale on-file data)', () => {
    for (const stage of ['lost', 'disqualified', 'duplicate', 'churned', null]) {
      expect(classifyTriageItem(item({
        customer_address_line1: '123 Sample St', customer_zip: '34205',
        customer_pipeline_stage: stage,
      }), noBookings, { now: NOW })).toBeNull();
    }
  });

  test('a customer created FROM/AFTER the call never moots its own address card (circular provenance)', () => {
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      customer_created_at: CUSTOMER_AFTER,
    }), noBookings, { now: NOW })).toBeNull();
    // Missing timestamps fail closed.
    expect(classifyTriageItem(item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      customer_created_at: null,
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('missing_last_name resolves once a PRE-EXISTING customer has a last name', () => {
    const d = classifyTriageItem(item({ reason_code: 'missing_last_name', customer_last_name: 'Sample' }), noBookings, { now: NOW });
    expect(d).toEqual({ action: 'resolve', rule: 'name_moot' });
  });

  test('a customer born from the call never moots its own surname card (V1-merged surname is not independent evidence)', () => {
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      customer_created_at: CUSTOMER_AFTER,
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('a PRE-EXISTING customer whose surname matches what THIS call heard never moots (backfill provenance)', () => {
    // V1 heard "Sample" and the booking backfill wrote it onto the old record.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: 'Sample' }),
    }), noBookings, { now: NOW })).toBeNull();
    // Case-insensitive match still blocks; unparseable V1 fails closed.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'SAMPLE',
      call_extraction_v1: JSON.stringify({ last_name: 'sample' }),
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      call_extraction_v1: 'not-json{',
    }), noBookings, { now: NOW })).toBeNull();
    // A surname the call did NOT hear is independent → resolves (caller's
    // first name still agrees with the record).
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Independent',
      call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: 'Sample' }),
    }), noBookings, { now: NOW })).toEqual({ action: 'resolve', rule: 'name_moot' });
  });

  test('a card both old AND moot records the moot rule, not the age rule', () => {
    const d = classifyTriageItem(
      item({ reason_code: 'missing_last_name', customer_last_name: 'Sample', created_at: OLD_31D }),
      noBookings, { now: NOW },
    );
    expect(d.rule).toBe('name_moot');
  });
});

describe('age-based dismissals', () => {
  test(`spam_or_wrong_number dismisses after ${SPAM_AGE_DAYS} days, not before`, () => {
    expect(classifyTriageItem(item({ reason_code: 'spam_or_wrong_number', created_at: OLD_8D }), noBookings, { now: NOW }))
      .toEqual({ action: 'dismiss', rule: 'spam_aged' });
    expect(classifyTriageItem(item({ reason_code: 'spam_or_wrong_number', created_at: FRESH }), noBookings, { now: NOW })).toBeNull();
  });

  test(`advisory informational flags dismiss after ${ADVISORY_AGE_DAYS} days, not before`, () => {
    expect(classifyTriageItem(item({ reason_code: 'voicemail', created_at: OLD_31D }), noBookings, { now: NOW }))
      .toEqual({ action: 'dismiss', rule: 'advisory_aged' });
    expect(classifyTriageItem(item({ reason_code: 'voicemail', created_at: OLD_8D }), noBookings, { now: NOW })).toBeNull();
  });

  test('a BLOCKING-severity row never age-dismisses even for an allowlisted code', () => {
    expect(classifyTriageItem(
      item({ reason_code: 'voicemail', severity: 'blocking', created_at: OLD_31D }),
      noBookings, { now: NOW },
    )).toBeNull();
  });
});

describe('fail-closed allowlist — owed work is NEVER swept', () => {
  const owedCodes = [
    'quote_promised', 'cancellation_request', 'after_hours_emergency',
    'prior_complaint_unresolved', 'commercial_requires_quote',
    'auto_booking_skipped_after_approval', 'existing_appointment_same_date',
    'ambiguous_existing_appointment', 'outbound_booking_review',
    'unassigned_auto_booking', 'booking_time_conflict',
    'email_bounce_reverify', 'extraction_failed_permanent',
    'v2_extraction_invalid', 'shared_phone_ambiguous', 'out_of_service_area',
    'do_not_contact_requested', 'hoa_common_area_requires_approval',
    'implied_consent_non_ani_recipient',
    // Advisory-by-design cards carrying OWED office confirmations — never
    // age out (the read-back/identity/access check stands until performed).
    'address_recovered', 'address_readback', 'caller_phone_not_on_file',
    'email_unverified', 'email_invalid', 'caller_not_authorized',
    'rental_or_tenant_occupied', 'second_service_address',
    'secondary_contact_captured', 'name_email_mismatch',
    'not_confirmed', 'confirmed_without_start_time', 'ambiguous_scheduling',
    'ambiguous_pest_or_service',
    'some_future_unknown_code',
  ];
  // missing_last_name never AGE-dismisses (owed identity task) — but the
  // moot rule still closes it on independent surname evidence, so it is
  // asserted separately from the codes above.
  test('missing_last_name aged 31d with NO surname stays open (identity task owed)', () => {
    expect(classifyTriageItem(
      item({ reason_code: 'missing_last_name', customer_last_name: null, created_at: OLD_31D }),
      noBookings, { now: NOW },
    )).toBeNull();
  });
  test.each(owedCodes)('%s stays open even when ancient', (code) => {
    expect(classifyTriageItem(item({ reason_code: code, created_at: OLD_31D }), noBookings, { now: NOW })).toBeNull();
  });

  test('a created booking does NOT clear cancellation/coordination transition requests', () => {
    const booked = bookedCtx('call-1');
    expect(classifyTriageItem(item({ reason_code: 'reschedule_or_cancel' }), booked, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ reason_code: 'existing_appointment_coordination' }), booked, { now: NOW })).toBeNull();
  });

  test('low_extraction_confidence never auto-clears (no booking rule, no age rule)', () => {
    const booked = bookedCtx('call-1');
    expect(classifyTriageItem(item({ reason_code: 'low_extraction_confidence' }), booked, { now: NOW })).toBeNull();
    // Nor does age: the office owes confirming the doubted fields.
    expect(classifyTriageItem(item({ reason_code: 'low_extraction_confidence', created_at: OLD_31D }), noBookings, { now: NOW })).toBeNull();
  });

  test('in_progress (human-claimed) is untouchable regardless of rule match', () => {
    expect(classifyTriageItem(
      item({ status: 'in_progress', customer_address_line1: '123 Sample St', customer_zip: '34205' }),
      noBookings, { now: NOW },
    )).toBeNull();
  });
});

describe('rule notes', () => {
  test('every rule has a non-empty note within the 500-char column limit', () => {
    for (const note of Object.values(RULE_NOTES)) {
      expect(note.length).toBeGreaterThan(10);
      expect(note.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('runTriageAutoResolve — gate', () => {
  const OLD_GATE = process.env.GATE_TRIAGE_AUTO_RESOLVE;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_TRIAGE_AUTO_RESOLVE;
    else process.env.GATE_TRIAGE_AUTO_RESOLVE = OLD_GATE;
  });

  test('gated off (default) → no-op, no DB access', async () => {
    delete process.env.GATE_TRIAGE_AUTO_RESOLVE;
    const result = await runTriageAutoResolve({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
  });
});

// ── Evidence rules (GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE) ──────────────────────
// ctx.evidence is the per-item proof map loadEvidence() builds; the pure
// classifier only trusts flags on it, so these pin the rule wiring and the
// in-classifier guards (phone on a slot now, heard address ↔ on-file match).
const {
  heardAddressMatchesOnFile,
  callerPhoneOnFile,
  capturedEmails,
  requestedServiceTokens,
  serviceTypeMatches,
  requestedWindow,
  loadEvidence,
} = require('../services/triage-auto-resolve');

const evidenceFor = (id, flags) => ({ bookedCallIds: new Set(), evidence: new Map([[id, flags]]) });

describe('evidence rules', () => {
  test('quote_promised resolves only on a DIRECT delivered estimate', () => {
    expect(classifyTriageItem(item({ reason_code: 'quote_promised' }), evidenceFor('t1', { estimate_direct: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'quote_fulfilled' });
    expect(classifyTriageItem(item({ reason_code: 'quote_promised' }), evidenceFor('t1', {}), { now: NOW })).toBeNull();
    // Evidence keyed to ANOTHER card never leaks across items.
    expect(classifyTriageItem(item({ reason_code: 'quote_promised' }), evidenceFor('t2', { estimate_direct: true }), { now: NOW })).toBeNull();
  });

  test('email_unverified resolves on engagement evidence; email_invalid never does', () => {
    expect(classifyTriageItem(item({ reason_code: 'email_unverified' }), evidenceFor('t1', { email_engaged: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'email_engaged' });
    expect(classifyTriageItem(item({ reason_code: 'email_invalid' }), evidenceFor('t1', { email_engaged: true }), { now: NOW })).toBeNull();
  });

  test('caller_not_authorized needs BOTH the human contact event and the number on a slot now', () => {
    const base = { reason_code: 'caller_not_authorized', call_direction: 'inbound', call_from_phone: '+19415550123' };
    expect(classifyTriageItem(item({ ...base, customer_service_contact2_phone: '(941) 555-0123' }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'caller_phone_added' });
    // Event logged but the number is no longer on any slot → stays open.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415559999' }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW })).toBeNull();
    // On a slot but no post-card human event (the pass itself may have written it) → stays open.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123' }), evidenceFor('t1', {}), { now: NOW })).toBeNull();
    // A confirmed-but-unbooked call keeps its card: the appointment is still owed.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123', call_extraction: { ...NO_ADDR_EXTRACTION, scheduling: { status: 'confirmed' } } }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123', call_extraction: { ...NO_ADDR_EXTRACTION, scheduling: { status: 'confirmed' } } }), { bookedCallIds: new Set(['call-1']), evidence: new Map([['t1', { caller_phone_added: true }]]) }, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'caller_phone_added' });
  });

  test('not_confirmed resolves on a booking created after the card', () => {
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed' }), evidenceFor('t1', { booking_after_card: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'booking_created' });
    // The legacy source-linked set alone (pre-card provenance) is still not enough.
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed' }), bookedCtx('call-1'), { now: NOW })).toBeNull();
  });

  test('address cards resolve on a completed visit only when every heard address matches the on-file street', () => {
    const heard = {
      reason_code: 'address_unverifiable',
      customer_address_line1: '1234 Palm Ave',
      customer_address_line2: 'Apt 2', // the raw reading names unit 2 — units are identity
      customer_created_at: CUSTOMER_AFTER, // customer born from the call — address_moot cannot fire
      payload: { flag: 'address_unverifiable', address_as_heard: '1234 Palm Avenue' },
      call_extraction: { property: { service_address: { street_line_1: '1234 Palm Ave', raw_text: '1234 palm ave unit 2' } } },
    };
    expect(classifyTriageItem(item(heard), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'visit_completed_at_address' });
    // A different house number anywhere in the heard set fails closed.
    expect(classifyTriageItem(item({ ...heard, payload: { flag: 'x', address_as_heard: '1236 Palm Ave' } }), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
    // No heard address at all → nothing to prove (address_moot owns that shape).
    expect(classifyTriageItem(item({ ...heard, payload: { flag: 'x' }, call_extraction: NO_ADDR_EXTRACTION }), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
    // Soft-deleted customer never resolves.
    expect(classifyTriageItem(item({ ...heard, customer_deleted_at: FRESH }), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
  });

  test('no evidence map (gate off) → the evidence codes behave exactly as before', () => {
    for (const code of ['quote_promised', 'email_unverified', 'caller_not_authorized', 'not_confirmed']) {
      expect(classifyTriageItem(item({ reason_code: code, created_at: OLD_31D }), noBookings, { now: NOW })).toBeNull();
    }
  });
});

describe('evidence helpers', () => {
  test('heardAddressMatchesOnFile uses the shared suffix-aware street key, fails closed on unparseable input', () => {
    const heard = (line) => item({ customer_address_line1: '77 Oak St', call_extraction_v1: JSON.stringify({ address_line1: line }), call_extraction: NO_ADDR_EXTRACTION, payload: {} });
    expect(heardAddressMatchesOnFile(heard('77 oak street, bradenton'))).toBe(true);
    // Locality is compared when the reading carries it and the file has it.
    const located = (line, extra = {}) => item({ customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', call_extraction_v1: JSON.stringify({ address_line1: line, ...extra }), call_extraction: NO_ADDR_EXTRACTION, payload: {} });
    expect(heardAddressMatchesOnFile(located('77 Oak St', { city: 'Bradenton', zip: '34205-1234' }))).toBe(true);
    expect(heardAddressMatchesOnFile(located('77 Oak St', { city: 'Tampa' }))).toBe(false);
    expect(heardAddressMatchesOnFile(located('77 Oak St', { zip: '33601' }))).toBe(false);
    // Units are identity: a reading naming a unit the file lacks or differs from fails.
    expect(heardAddressMatchesOnFile(located('77 Oak St Apt 4'))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_address_line2: 'Unit 4', customer_city: 'Bradenton', customer_zip: '34205', call_extraction_v1: JSON.stringify({ address_line1: '77 Oak St', address_line2: '#4' }), call_extraction: NO_ADDR_EXTRACTION, payload: {} }))).toBe(true);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_address_line2: 'Unit B', customer_city: 'Bradenton', customer_zip: '34205', call_extraction_v1: JSON.stringify({}), call_extraction: { property: { service_address: { street_line_1: '77 Oak St', street_line_2: 'Unit A', city: 'Bradenton', postal_code: '34205' } } }, payload: {} }))).toBe(false);
    // A reading that carries a locality the file LACKS cannot be established.
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_city: null, customer_zip: null, call_extraction_v1: JSON.stringify({ address_line1: '77 Oak St', city: 'Tampa' }), call_extraction: NO_ADDR_EXTRACTION, payload: {} }))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', call_extraction_v1: JSON.stringify({}), call_extraction: NO_ADDR_EXTRACTION, payload: { address_as_heard: '77 Oak St, Tampa FL 33601' } }))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', call_extraction_v1: JSON.stringify({}), call_extraction: NO_ADDR_EXTRACTION, payload: { address_as_heard: '77 Oak Street, Bradenton, FL 34205' } }))).toBe(true);
    // (a unit the file lacks — see the unit cases below)
    expect(heardAddressMatchesOnFile(heard('77 Oak St Apt 4'))).toBe(false);
    // Same number, different street type = a different street.
    expect(heardAddressMatchesOnFile(heard('77 Oak Ave'))).toBe(false);
    expect(heardAddressMatchesOnFile(heard('77 Oak'))).toBe(false);
    // A bare street with no house number proves nothing.
    expect(heardAddressMatchesOnFile(heard('Oak St'))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', call_extraction_v1: 'not-json{', call_extraction: NO_ADDR_EXTRACTION, payload: {} }))).toBe(false);
    // A matching structured extraction cannot hide an unkeyable raw reading.
    expect(heardAddressMatchesOnFile(item({
      customer_address_line1: '77 Oak St',
      call_extraction_v1: JSON.stringify({ address_line1: '77 Oak St' }),
      call_extraction: { property: { service_address: { street_line_1: '77 Oak Street', raw_text: 'Oak Street' } } },
      payload: {},
    }))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: null, call_extraction_v1: JSON.stringify({ address_line1: '77 Oak St' }), payload: {} }))).toBe(false);
  });

  test('callerPhoneOnFile matches any of the five slots by digits, outbound uses to_phone', () => {
    expect(callerPhoneOnFile(item({ call_direction: 'inbound', call_from_phone: '19415550100', customer_secondary_phone: '(941) 555-0100' }))).toBe(true);
    expect(callerPhoneOnFile(item({ call_direction: 'outbound', call_to_phone: '+19415550100', call_from_phone: '+19415550999', customer_service_contact3_phone: '9415550100' }))).toBe(true);
    expect(callerPhoneOnFile(item({ call_direction: 'inbound', call_from_phone: '+19415550100', customer_phone: '+19415550101' }))).toBe(false);
  });

  test('capturedEmails is the card\'s filing-time release target only — never the candidates or the call extraction', () => {
    expect(capturedEmails(item({
      call_extraction_v1: JSON.stringify({ email: 'Other@Example.com' }),
      payload: { email_release_target: 'Pat@Example.com', email_candidates: [{ value: 'pat@example.com' }, { value: 'PAT.S@example.com' }] },
    }))).toEqual(['pat@example.com']);
    expect(capturedEmails(item({
      call_extraction_v1: JSON.stringify({ email: 'Other@Example.com' }),
      payload: { email_candidates: [{ value: 'pat@example.com' }] },
    }))).toEqual([]);
  });

  test('requested service tokens ignore generic words; service types match on a specific token', () => {
    const categories = requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['pest_control', 'mosquito_control', 'control'] } } }));
    // One token list per category (a stopword-only category yields none).
    expect(categories).toEqual([['pest'], ['mosquito']]);
    const [pest, mosquito] = categories;
    // The call's rolling extraction is never the source (a reprocess rewrites it).
    expect(requestedServiceTokens(item({ payload: { scheduling_window: {} }, call_extraction: { service_request: { primary_service_category: 'pest_control' } } }))).toEqual([]);
    expect(serviceTypeMatches('Quarterly Pest Control', pest)).toBe(true);
    expect(serviceTypeMatches('Mosquito Treatment', mosquito)).toBe(true);
    expect(serviceTypeMatches('Lawn Care', pest)).toBe(false);
    expect(serviceTypeMatches('Pest Control', [])).toBe(false);
    // EVERY token of the category must appear — a related service sharing
    // one token is not the requested one.
    const [drywood] = requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['drywood_termite'] } } }));
    expect(serviceTypeMatches('Subterranean Termite Treatment', drywood)).toBe(false);
    expect(serviceTypeMatches('Drywood Termite Treatment', drywood)).toBe(true);
    const [exclusion] = requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['rodent_exclusion'] } } }));
    expect(serviceTypeMatches('Rodent Control', exclusion)).toBe(false);
    expect(serviceTypeMatches('Rodent Control rodent_exclusion', exclusion)).toBe(true);
  });

  test('requestedWindow is ET calendar days: confirmed start first, then the requested range, null without either', () => {
    expect(requestedWindow(item({ payload: { scheduling_window: { confirmed_start_at: '2026-08-04T14:00:00Z' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    // 01:00Z is still the previous ET evening.
    expect(requestedWindow(item({ payload: { scheduling_window: { confirmed_start_at: '2026-08-05T01:00:00Z' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    expect(requestedWindow(item({ payload: { scheduling_window: { requested_date_range_start: '2026-08-04', requested_date_range_end: '2026-08-06' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-06' });
    expect(requestedWindow(item({ payload: { scheduling_window: { status: 'requested' } } }))).toBeNull();
  });

  test('loadEvidence is an empty map with the evidence gate off — no DB access', async () => {
    const OLD = process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE;
    delete process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE;
    try {
      const conn = jest.fn(() => { throw new Error('must not query'); });
      const map = await loadEvidence(conn, [item({ reason_code: 'quote_promised' })]);
      expect(map.size).toBe(0);
      expect(conn).not.toHaveBeenCalled();
    } finally {
      if (OLD === undefined) delete process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE;
      else process.env.GATE_TRIAGE_AUTO_RESOLVE_EVIDENCE = OLD;
    }
  });
});
