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
    call_extraction: NO_ADDR_EXTRACTION,
    customer_address_line1: null, customer_zip: null, customer_last_name: null,
    ...over,
  };
}
const noBookings = { bookedCallIds: new Set() };

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

  test('scheduling flags resolve only on source_call_log_id booking provenance', () => {
    const booked = { bookedCallIds: new Set(['call-1']) };
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed' }), booked, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'booking_outcome' });
    // Same code, no provenance → untouched.
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed' }), noBookings, { now: NOW })).toBeNull();
    // Provenance for a DIFFERENT call never clears.
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed', call_log_id: 'call-2' }), booked, { now: NOW })).toBeNull();
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
    expect(classifyTriageItem(item({ reason_code: 'caller_not_authorized', created_at: OLD_31D }), noBookings, { now: NOW }))
      .toEqual({ action: 'dismiss', rule: 'advisory_aged' });
    expect(classifyTriageItem(item({ reason_code: 'caller_not_authorized', created_at: OLD_8D }), noBookings, { now: NOW })).toBeNull();
  });

  test('a BLOCKING-severity row never age-dismisses even for an allowlisted code', () => {
    expect(classifyTriageItem(
      item({ reason_code: 'caller_not_authorized', severity: 'blocking', created_at: OLD_31D }),
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
    'implied_consent_non_ani_recipient', 'some_future_unknown_code',
  ];
  test.each(owedCodes)('%s stays open even when ancient', (code) => {
    expect(classifyTriageItem(item({ reason_code: code, created_at: OLD_31D }), noBookings, { now: NOW })).toBeNull();
  });

  test('a created booking does NOT clear cancellation/coordination transition requests', () => {
    const booked = { bookedCallIds: new Set(['call-1']) };
    expect(classifyTriageItem(item({ reason_code: 'reschedule_or_cancel' }), booked, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ reason_code: 'existing_appointment_coordination' }), booked, { now: NOW })).toBeNull();
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
