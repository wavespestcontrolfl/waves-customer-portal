// Triage auto-resolve sweep (2026-07-31). Born from the dead-letter backlog:
// ~1,800 open triage cards vs 32 ever resolved, so actionable cards drowned
// (the booking-miss watchdog's origin incident parked among them unseen).
// These tests pin the pure classifier — moot-condition resolves, age-based
// dismissals, the fail-closed allowlist, in_progress immunity — and the
// gate-off no-op. Fixtures synthetic.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The confirmed-hour reading lazy-loads the processor's wall-clock helper.
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: jest.fn(() => false),
  isOwnedNumber: jest.fn(() => false),
  findByNumber: jest.fn(() => null),
  getLeadSourceFromNumber: jest.fn(() => ({ source: 'phone_call' })),
}));

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

// The on-file address the card snapshotted at filing (payload.on_file_address)
// — the evidence arms read it, never the customer_* columns; fixtures that
// set the columns get the same address snapshotted unless they say otherwise.
const onFileOf = (over) => (over.customer_address_line1
  ? { address_line1: over.customer_address_line1, address_line2: over.customer_address_line2 ?? null, city: over.customer_city ?? null, zip: over.customer_zip ?? null }
  : null);
function item(over = {}) {
  const payload = typeof over.payload === 'string' ? over.payload : { flag: 'address_unverifiable', confidence: 0.5, ...(over.payload || {}) };
  if (typeof payload === 'object' && payload.on_file_address === undefined) payload.on_file_address = onFileOf(over);
  return {
    id: 't1', call_log_id: 'call-1', reason_code: 'address_unverifiable',
    status: 'open', severity: 'advisory', created_at: FRESH,
    call_created_at: CALL_AT, customer_created_at: CUSTOMER_BEFORE,
    customer_pipeline_stage: 'active_customer', customer_deleted_at: null,
    call_extraction: NO_ADDR_EXTRACTION,
    call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: null }),
    customer_address_line1: null, customer_zip: null,
    customer_first_name: 'Pat', customer_last_name: null,
    ...over,
    payload,
  };
}
const noBookings = { evidence: new Map() };
// The surname card's filing-time names (the merged V1 extraction's, as the
// processor snapshots them) — never the call's rolling columns.
const heardV1 = (first, last) => ({ payload: { flag: 'missing_last_name', heard_name_v1: { first_name: first, last_name: last } } });
// The booking arm's proof: a LIVE booking created after the card that
// answers its snapshotted ask (the current-routing-result case).
const bookedCtx = (id = 't1') => ({ evidence: new Map([[id, { booking_after_card: true }]]) });

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
    // Same call WITH the booking arm's proof → the guard releases and it moots.
    expect(classifyTriageItem(confirmedUnbooked, bookedCtx(), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'address_moot' });
    // The CARD's filing-time status holds the guard too: a reprocess that
    // rewrote the rolling extraction to 'requested' does not release the
    // original confirmation's only trace (codex r27 P1).
    const confirmedAtFiling = item({
      customer_address_line1: '123 Sample St', customer_zip: '34205',
      payload: { flag: 'address_unverified', scheduling_window: { status: 'confirmed' } },
      call_extraction: { ...NO_ADDR_EXTRACTION, scheduling: { status: 'requested' } },
    });
    expect(classifyTriageItem(confirmedAtFiling, noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(confirmedAtFiling, bookedCtx(), { now: NOW }))
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
      customer_deleted_at: deletedAt, ...heardV1('Pat', null),
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('a caller whose first name disagrees with the linked record never moots the surname card (phone-fallback link)', () => {
    // Phone matched the account, but the caller is someone else (spouse/new owner).
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      customer_first_name: 'Alex', ...heardV1('Pat', null),
    }), noBookings, { now: NOW })).toBeNull();
    // No heard first name at all fails closed.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample', ...heardV1(null, null),
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
    const d = classifyTriageItem(item({ reason_code: 'missing_last_name', customer_last_name: 'Sample', ...heardV1('Pat', null) }), noBookings, { now: NOW });
    expect(d).toEqual({ action: 'resolve', rule: 'name_moot' });
    // The V2 caller snapshot is read beside it — never ALONE: the merged V1
    // names are what the surname backfill writes from, so a card carrying
    // only the V2 caller (an insert site that passed no V1 snapshot) keeps
    // its human verdict (codex r19 P1).
    expect(classifyTriageItem(item({ reason_code: 'missing_last_name', customer_last_name: 'Sample', payload: { heard_name: { first_name: 'Pat', last_name: null }, heard_name_v1: { first_name: 'Pat', last_name: null } } }), noBookings, { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'name_moot' });
    expect(classifyTriageItem(item({ reason_code: 'missing_last_name', customer_last_name: 'Sample', payload: { heard_name: { first_name: 'Pat', last_name: null } } }), noBookings, { now: NOW })).toBeNull();
  });

  test('a customer born from the call never moots its own surname card (V1-merged surname is not independent evidence)', () => {
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      customer_created_at: CUSTOMER_AFTER, ...heardV1('Pat', null),
    }), noBookings, { now: NOW })).toBeNull();
  });

  test('a PRE-EXISTING customer whose surname matches what THIS call heard never moots (backfill provenance)', () => {
    // V1 heard "Sample" and the booking backfill wrote it onto the old record.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample', ...heardV1('Pat', 'Sample'),
    }), noBookings, { now: NOW })).toBeNull();
    // Case-insensitive match still blocks; the V2 snapshot blocks too.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'SAMPLE', ...heardV1('Pat', 'sample'),
    }), noBookings, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      payload: { heard_name: { first_name: 'Pat', last_name: 'Sample' }, heard_name_v1: { first_name: 'Pat', last_name: null } },
    }), noBookings, { now: NOW })).toBeNull();
    // A card filed before the snapshot existed carries no filing-time
    // names: the rolling extraction columns are NOT consulted (a reprocess
    // rewrites them), so it keeps its human verdict (codex r18 P1).
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample',
      call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: null }),
    }), noBookings, { now: NOW })).toBeNull();
    // ...and a reprocess that DROPPED the heard surname from the columns
    // does not turn the backfilled surname into independent evidence.
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Sample', ...heardV1('Pat', 'Sample'),
      call_extraction_v1: JSON.stringify({ first_name: 'Pat', last_name: null }),
    }), noBookings, { now: NOW })).toBeNull();
    // A surname the call did NOT hear is independent → resolves (caller's
    // first name still agrees with the record).
    expect(classifyTriageItem(item({
      reason_code: 'missing_last_name', customer_last_name: 'Independent', ...heardV1('Pat', 'Sample'),
    }), noBookings, { now: NOW })).toEqual({ action: 'resolve', rule: 'name_moot' });
  });

  test('a card both old AND moot records the moot rule, not the age rule', () => {
    const d = classifyTriageItem(
      item({ reason_code: 'missing_last_name', customer_last_name: 'Sample', created_at: OLD_31D, ...heardV1('Pat', null) }),
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
    const booked = bookedCtx();
    expect(classifyTriageItem(item({ reason_code: 'reschedule_or_cancel' }), booked, { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ reason_code: 'existing_appointment_coordination' }), booked, { now: NOW })).toBeNull();
  });

  test('low_extraction_confidence never auto-clears (no booking rule, no age rule)', () => {
    const booked = bookedCtx();
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
  estimateCoversAsk,
  deliveredEstimateScope,
  requestedWindow,
  requestedAddressIsOnFile,
  bookingAtRequestedAddress,
  bookingCoversRequest,
  loadEvidence,
} = require('../services/triage-auto-resolve');

const evidenceFor = (id, flags) => ({ evidence: new Map([[id, flags]]) });

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
    const base = { reason_code: 'caller_not_authorized', call_direction: 'inbound', call_from_phone: '+19415550123', payload: { scheduling_window: { status: 'requested' } } };
    expect(classifyTriageItem(item({ ...base, customer_service_contact2_phone: '(941) 555-0123' }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'caller_phone_added' });
    // Event logged but the number is no longer on any slot → stays open.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415559999' }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW })).toBeNull();
    // On a slot but no post-card human event (the pass itself may have written it) → stays open.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123' }), evidenceFor('t1', {}), { now: NOW })).toBeNull();
    // A confirmed-but-unbooked call keeps its card: the appointment is still
    // owed. The CARD's filing-time status decides — the rolling extraction
    // (a reprocess may have rewritten it to 'requested') is never read.
    const confirmed = { ...base, customer_phone: '+19415550123', payload: { scheduling_window: { status: 'confirmed' } }, call_extraction: { ...NO_ADDR_EXTRACTION, scheduling: { status: 'requested' } } };
    expect(classifyTriageItem(item(confirmed), evidenceFor('t1', { caller_phone_added: true }), { now: NOW })).toBeNull();
    // Only a booking answering the snapshotted ask (the booking arm's
    // evidence) counts as the confirmed appointment.
    expect(classifyTriageItem(item(confirmed), evidenceFor('t1', { caller_phone_added: true, booking_after_card: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'caller_phone_added' });
    // The base payload's scheduling_status serves when the card has no window.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123', payload: { flag: 'caller_not_authorized', scheduling_status: 'confirmed' } }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW })).toBeNull();
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123', payload: { flag: 'caller_not_authorized', scheduling_status: 'requested' } }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'caller_phone_added' });
    // No status at all (a pre-snapshot card) → cannot prove it was not confirmed → stays open.
    expect(classifyTriageItem(item({ ...base, customer_phone: '+19415550123', payload: { flag: 'caller_not_authorized' } }), evidenceFor('t1', { caller_phone_added: true }), { now: NOW })).toBeNull();
  });

  test('not_confirmed resolves on a booking created after the card', () => {
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed' }), evidenceFor('t1', { booking_after_card: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'booking_created' });
    expect(classifyTriageItem(item({ reason_code: 'not_confirmed' }), noBookings, { now: NOW })).toBeNull();
  });

  test('address cards resolve on a completed visit only when every heard address matches the on-file street', () => {
    const heard = {
      reason_code: 'address_unverifiable',
      customer_address_line1: '1234 Palm Ave',
      customer_address_line2: 'Apt 2', // the raw reading names unit 2 — units are identity
      customer_created_at: CUSTOMER_AFTER, // customer born from the call — address_moot cannot fire
      payload: { scheduling_status: null, flag: 'address_unverifiable', address_as_heard: '1234 Palm Avenue', heard_address: { street_line_1: '1234 Palm Ave', raw_text: '1234 palm ave unit 2' } },
    };
    expect(classifyTriageItem(item(heard), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'visit_completed_at_address' });
    // A confirmed call held solely on its address card keeps it until a
    // booking answers the snapshotted ask — an unrelated visit completing
    // at the address is not the confirmed appointment.
    const confirmedHeard = { ...heard, payload: { ...heard.payload, scheduling_status: 'confirmed' } };
    expect(classifyTriageItem(item(confirmedHeard), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
    expect(classifyTriageItem(item(confirmedHeard), evidenceFor('t1', { visit_completed_at_address: true, booking_after_card: true }), { now: NOW }))
      .toEqual({ action: 'resolve', rule: 'visit_completed_at_address' });
    // A different house number anywhere in the heard set fails closed.
    expect(classifyTriageItem(item({ ...heard, payload: { ...heard.payload, address_as_heard: '1236 Palm Ave' } }), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
    // No heard address at all → nothing to prove (address_moot owns that shape).
    expect(classifyTriageItem(item({ ...heard, payload: { flag: 'address_unverifiable' } }), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
    // The rolling extraction is never a reading — only the card's snapshot is.
    expect(classifyTriageItem(item({ ...heard, payload: { flag: 'address_unverifiable' }, call_extraction: { property: { service_address: { street_line_1: '1234 Palm Ave' } } } }), evidenceFor('t1', { visit_completed_at_address: true }), { now: NOW })).toBeNull();
    // No visit evidence → open.
    expect(classifyTriageItem(item(heard), evidenceFor('t1', {}), { now: NOW })).toBeNull();
  });

  test('no evidence map (gate off) → the evidence codes behave exactly as before', () => {
    for (const code of ['quote_promised', 'email_unverified', 'caller_not_authorized', 'not_confirmed']) {
      expect(classifyTriageItem(item({ reason_code: code, created_at: OLD_31D }), noBookings, { now: NOW })).toBeNull();
    }
  });
});

describe('evidence helpers', () => {
  test('heardAddressMatchesOnFile uses the shared suffix-aware street key, locality and unit, and fails closed', () => {
    const snap = (heard_address, over = {}) => item({ customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', payload: { heard_address }, ...over });
    const heard = (line) => snap({ street_line_1: line });
    expect(heardAddressMatchesOnFile(heard('77 oak street'))).toBe(true);
    expect(heardAddressMatchesOnFile(snap({ raw_text: '77 oak street, bradenton' }))).toBe(true);
    // Same number, different street type = a different street.
    expect(heardAddressMatchesOnFile(heard('77 Oak Ave'))).toBe(false);
    expect(heardAddressMatchesOnFile(heard('77 Oak'))).toBe(false);
    // A bare street with no house number proves nothing.
    expect(heardAddressMatchesOnFile(heard('Oak St'))).toBe(false);
    // No on-file street, no snapshot, or a snapshot with no readings → false.
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St' }, { customer_address_line1: null }))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', payload: {} }))).toBe(false);
    expect(heardAddressMatchesOnFile(snap({ street_line_1: null, raw_text: null }))).toBe(false);
    // A matching structured reading cannot hide an unkeyable raw reading.
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak Street', raw_text: 'Oak Street' }))).toBe(false);
    // Locality is compared when the reading carries it.
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St', city: 'Bradenton', postal_code: '34205-1234' }))).toBe(true);
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St', city: 'Tampa' }))).toBe(false);
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St', postal_code: '33601' }))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', payload: { address_as_heard: '77 Oak St, Tampa FL 33601' } }))).toBe(false);
    expect(heardAddressMatchesOnFile(item({ customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', payload: { address_as_heard: '77 Oak Street, Bradenton, FL 34205' } }))).toBe(true);
    // A reading that carries a locality the file LACKS cannot be established.
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St', city: 'Tampa' }, { customer_city: null, customer_zip: null }))).toBe(false);
    // Units are identity: a reading naming a unit the file lacks or differs from fails.
    expect(heardAddressMatchesOnFile(heard('77 Oak St Apt 4'))).toBe(false);
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St', street_line_2: '#4' }, { customer_address_line2: 'Unit 4' }))).toBe(true);
    expect(heardAddressMatchesOnFile(snap({ street_line_1: '77 Oak St', street_line_2: 'Unit A' }, { customer_address_line2: 'Unit B' }))).toBe(false);
    // A unit-only fragment with no street is an ask about some address that cannot be keyed.
    expect(heardAddressMatchesOnFile(snap({ street_line_2: 'Unit 4' }))).toBe(false);
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
    // One requirement per category, each the token lists that answer it
    // (a stopword-only category yields none).
    expect(categories).toEqual([[['pest']], [['mosquito']]]);
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
    // A category the catalog books under ONE service is answered by that
    // service's words too (v2PrimaryLabelForCategory): stinging_insect is
    // "Bee / Wasp Nest Removal" under specialty on a booking, while the
    // engine's own estimate line carries the enum (codex r22 P2).
    const [stinging] = requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['stinging_insect'] } } }));
    expect(stinging).toEqual([['stinging', 'insect'], ['wasp', 'nest'], ['bee', 'wasp', 'nest', 'removal']]);
    expect(serviceTypeMatches('Bee / Wasp Nest Removal specialty', stinging)).toBe(true);
    expect(serviceTypeMatches('Stinging Insect — Paper Wasp', stinging)).toBe(true);
    expect(serviceTypeMatches('Quarterly Pest Control specialty', stinging)).toBe(false);
    expect(serviceTypeMatches('Wasp Nest Removal', stinging)).toBe(true);
    expect(serviceTypeMatches('Wasp Removal', stinging)).toBe(false);
    // The words the compose path scans a category as answer it too: the
    // bundled WaveGuard category is pest control in both category maps, so
    // a pest booking or line answers a card that snapshotted the bundle
    // with no specific service (codex r27 P2). One answer per distinct list.
    const [bundled] = requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['bundled_waveguard'] } } }));
    expect(bundled).toEqual([['bundled', 'waveguard'], ['pest']]);
    expect(serviceTypeMatches('Quarterly Pest Control', bundled)).toBe(true);
    expect(serviceTypeMatches('Lawn Care', bundled)).toBe(false);
    expect(requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['pest_general'] } } }))).toEqual([[['pest']]]);
    // The specific service the caller named narrows the PRIMARY category
    // into one requirement: a flea treatment filed under pest_general is
    // not a generic pest booking, and it is one ask, not two.
    const flea = requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['pest_general'], requested_specific_service: 'Flea Treatment' } } }));
    expect(flea).toEqual([[['pest', 'flea']]]);
    expect(requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: [], requested_specific_service: 'Flea Treatment' } } }))).toEqual([[['flea']]]);
    // ...and it narrows every answer of the primary alike.
    expect(requestedServiceTokens(item({ payload: { scheduling_window: { requested_service_categories: ['stinging_insect'], requested_specific_service: 'Yellow Jacket' } } }))).toEqual([[['stinging', 'insect', 'yellow', 'jacket'], ['wasp', 'nest', 'yellow', 'jacket'], ['bee', 'wasp', 'nest', 'removal', 'yellow', 'jacket']]]);
    // quote_promised cards carry the same ask under quote_scope.
    expect(requestedServiceTokens(item({ payload: { quote_scope: { requested_service_categories: ['lawn_care'] } } }))).toEqual([[['lawn']]]);
    expect(flea.every((tokens) => serviceTypeMatches('Quarterly Pest Control pest_control', tokens))).toBe(false);
    expect(flea.every((tokens) => serviceTypeMatches('Flea Treatment pest_control', tokens))).toBe(true);
  });

  test('a delivered estimate keeps the quote only when distinct priced lines, at the asked cadence, cover every requested service at the asked address', () => {
    const none = { street_line_1: null, street_line_2: null, city: null, postal_code: null, raw_text: null, additional_properties: 0 };
    const base = { call_log_id: 'call-1', call_customer_id: 'cust-1', customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205' };
    const card = (scope) => item({ ...base, reason_code: 'quote_promised', payload: { quote_scope: { requested_service_categories: ['pest_general', 'lawn_care'], requested_specific_service: 'Flea Treatment', requested_service_intent: 'preventative_one_time', requested_address: none, ...scope } } });
    // The engine's typed lines: a recurring pest program, a one-time flea
    // treatment and a one-time lawn treatment.
    // Every fixture is read as its send delivered it: the stamp the send
    // route writes beside the pricing bundle (codex r25 P1).
    const delivered = (row) => ({ ...row, estimate_data: { ...(row.estimate_data || {}), sendSnapshot: { scope: deliveredEstimateScope(row) } } });
    const est = (over) => delivered({ id: 'e1', service_interest: null, address: '77 Oak Street, Bradenton, FL 34205', estimate_data: { result: { recurring: { services: [{ name: 'Pest Control', mo: 40 }], grandTotal: 40 }, oneTime: { items: [{ service: 'Flea Treatment', price: 150 }, { service: 'One-Time Lawn Treatment', price: 90 }] } } }, ...over });
    expect(estimateCoversAsk(card({}), est({}))).toBe(true);
    // The live row is not the quote: a proposal re-authored in place after
    // the send (deliveryState kept, no new handoff) can widen its lines
    // past what went out — coverage reads the delivered stamp, and a row
    // (or sibling) with no stamp proves nothing (codex r25 P1).
    const fleaOnlyStamp = deliveredEstimateScope({ address: '77 Oak Street, Bradenton, FL 34205', estimate_data: { result: { oneTime: { items: [{ service: 'Flea Treatment', price: 150 }] } } } });
    expect(estimateCoversAsk(card({}), { ...est({}), estimate_data: { ...est({}).estimate_data, sendSnapshot: { scope: fleaOnlyStamp } } })).toBe(false);
    expect(estimateCoversAsk(card({}), { ...est({}), estimate_data: { ...est({}).estimate_data, sendSnapshot: {} } })).toBe(false);
    // A generic pest program is not the flea treatment, and the engine's
    // input flag beside typed lines selects a service without pricing it.
    const generic = { result: { recurring: { services: [{ name: 'Pest Control', mo: 40 }, { name: 'Lawn Care Program', mo: 60 }] }, oneTime: { items: [{ service: 'One-Time Lawn Treatment', price: 90 }] } } };
    expect(estimateCoversAsk(card({}), est({ estimate_data: generic }))).toBe(false);
    expect(estimateCoversAsk(card({}), est({ estimate_data: { ...generic, inputs: { svcFlea: true } }, onetime_total: 240 }))).toBe(false);
    // A legacy row with no typed lines is ONE line — service_interest, the
    // reader's families and the svc* flags — at the cadence its totals show.
    const legacy = (over) => est({ estimate_data: {}, service_interest: 'Flea Treatment', onetime_total: 150, ...over });
    const fleaOnly = card({ requested_service_categories: ['pest_general'] });
    expect(estimateCoversAsk(fleaOnly, legacy({}))).toBe(true);
    expect(estimateCoversAsk(fleaOnly, legacy({ onetime_total: null, monthly_total: 40 }))).toBe(false);
    expect(estimateCoversAsk(fleaOnly, legacy({ estimate_data: { inputs: { svcFlea: true } }, service_interest: 'Pest Control' }))).toBe(true);
    // ...and one line answers one service: the lawn ask needs a sibling.
    expect(estimateCoversAsk(card({}), legacy({}))).toBe(false);
    // A service the estimate lacks counts when a sibling in its group prices
    // it — at the asked address (codex r18 P1) and at the asked cadence.
    const partial = est({ estimate_data: { result: { oneTime: { items: [{ service: 'Flea Treatment', price: 150 }] } } } });
    expect(estimateCoversAsk(card({}), partial)).toBe(false);
    const lawnSibling = (over) => delivered({ id: 'e2', service_interest: 'Lawn Care', estimate_data: {}, onetime_total: 90, address: '77 Oak Street, Bradenton, FL 34205', ...over });
    expect(estimateCoversAsk(card({}), partial, [lawnSibling({})])).toBe(true);
    expect(estimateCoversAsk(card({}), partial, [{ ...lawnSibling({}), estimate_data: {} }])).toBe(false);
    expect(estimateCoversAsk(card({}), partial, [lawnSibling({ address: '5 Pine Ave, Sarasota, FL 34236' })])).toBe(false);
    expect(estimateCoversAsk(card({}), partial, [lawnSibling({ address: null })])).toBe(false);
    expect(estimateCoversAsk(card({}), partial, [lawnSibling({ onetime_total: null })])).toBe(false);
    // Cadence binds to the LINE answering the service (codex r19 P1): a
    // recurring-plan ask for pest is not kept by a one-time pest job beside
    // a recurring lawn program; an explicit one-time ask is.
    const plan = { requested_service_categories: ['pest_general'], requested_specific_service: null, requested_service_intent: 'recurring_membership_inquiry' };
    const mixed = est({ estimate_data: { result: { recurring: { services: [{ name: 'Lawn Care Program', mo: 60 }] }, oneTime: { items: [{ service: 'One-Time Pest Treatment', price: 120 }] } } } });
    expect(estimateCoversAsk(card(plan), mixed)).toBe(false);
    expect(estimateCoversAsk(card(plan), est({}))).toBe(true);
    const oneTimePest = { ...plan, requested_service_intent: 'preventative_one_time' };
    expect(estimateCoversAsk(card(oneTimePest), mixed)).toBe(true);
    expect(estimateCoversAsk(card(oneTimePest), est({ estimate_data: generic }))).toBe(false);
    // Any other intent takes either cadence; a snapshot with no intent nothing.
    expect(estimateCoversAsk(card({ ...plan, requested_service_intent: 'active_infestation_treatment' }), mixed)).toBe(true);
    expect(estimateCoversAsk(card({ requested_service_intent: null }), est({}))).toBe(false);
    // An item included ON the program is priced into the recurring plan: it
    // quotes no standalone one-time job.
    const onProgram = est({ estimate_data: { result: { recurring: { services: [{ name: 'Pest Control', mo: 40 }] }, oneTime: { specItems: [{ name: 'Wasp/Bee', price: 0, det: 'Included on program', onProg: true }] } } } });
    const wasp = (intent) => card({ requested_service_categories: ['pest_general'], requested_specific_service: 'Wasp', requested_service_intent: intent });
    expect(estimateCoversAsk(wasp('preventative_one_time'), onProgram)).toBe(false);
    expect(estimateCoversAsk(wasp('recurring_membership_inquiry'), onProgram)).toBe(true);
    // A placeholder prices nothing (codex r20 P1): a quote-required or
    // manual-review entry, or one with no positive amount, is not a line —
    // even after the authoring route cleared its quote-required boolean.
    const oneTimePestAsk = card(oneTimePest);
    const withPlaceholder = (entry) => est({ estimate_data: { result: { recurring: { services: [{ name: 'Lawn Care Program', mo: 60 }] }, specItems: [entry] } } });
    expect(estimateCoversAsk(oneTimePestAsk, withPlaceholder({ service: 'commercial_pest', quoteRequired: true, price: null }))).toBe(false);
    expect(estimateCoversAsk(oneTimePestAsk, withPlaceholder({ service: 'commercial_pest', quoteRequired: false, requiresManualReview: true, price: null }))).toBe(false);
    expect(estimateCoversAsk(oneTimePestAsk, withPlaceholder({ service: 'commercial_pest', quoteRequired: false, price: null }))).toBe(false);
    expect(estimateCoversAsk(oneTimePestAsk, withPlaceholder({ service: 'One-Time Pest Treatment' }))).toBe(false);
    expect(estimateCoversAsk(oneTimePestAsk, withPlaceholder({ service: 'One-Time Pest Treatment', price: 120 }))).toBe(true);
    // An AUTHORED proposal is the quote: its programs / corrective work
    // replace the engine lines (the cleared placeholder AND the engine's
    // lawn program count for nothing) (codex r20 P1).
    const authored = est({ estimate_data: {
      proposal: { enabled: true, programs: [{ service: 'pest', label: 'Quarterly Pest Program', frequencyPerYear: 4, pricePerApplication: 100 }], correctiveWork: [{ label: 'Flea Treatment', amount: 150 }] },
      result: { recurring: { services: [{ name: 'Lawn Care Program', mo: 60 }] }, specItems: [{ service: 'commercial_pest', quoteRequired: false, price: null }] },
    } });
    expect(estimateCoversAsk(card(plan), authored)).toBe(true);
    expect(estimateCoversAsk(card({ requested_service_categories: ['pest_general'] }), authored)).toBe(true);
    expect(estimateCoversAsk(card({ requested_service_categories: ['lawn_care'], requested_specific_service: null }), authored)).toBe(false);
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['lawn_care'] }), authored)).toBe(false);
    // A legacy authored proposal itemizes per BUILDING: a line's service is
    // its description (the canonical normalizer's one name field) and the
    // building it sits under is a place, not a service (codex r22 P2).
    const towers = est({ estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Lawn House', lineItems: [{ description: 'Monthly pest', unitPrice: 200, frequency: 'monthly' }] }] } } });
    expect(estimateCoversAsk(card(plan), towers)).toBe(true);
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['lawn_care'] }), towers)).toBe(false);
    // Authored text gains a family only where the compose path's
    // word-bounded scan vouches for it — the shared reader's pest pattern
    // reads the bare word "general" as Pest Control (and "advanced" as
    // termite): "General lawn maintenance" prices lawn care, not pest
    // control (codex r27 P1). A program's validated family still answers
    // through its catalog label; a corrective flea line still reads as
    // pest work (the reader's grouping, vouched by the scan's flea family).
    const lawnAsk = card({ ...plan, requested_service_categories: ['lawn_care'] });
    const generalLawn = est({ estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Main', lineItems: [{ description: 'General lawn maintenance', unitPrice: 200, frequency: 'monthly' }] }] } } });
    expect(estimateCoversAsk(card(plan), generalLawn)).toBe(false);
    expect(estimateCoversAsk(lawnAsk, generalLawn)).toBe(true);
    const advancedTurf = est({ estimate_data: { proposal: { enabled: true, buildings: [{ name: 'Main', lineItems: [{ description: 'Advanced turf program', unitPrice: 200, frequency: 'monthly' }] }] } } });
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['termite'], requested_specific_service: null }), advancedTurf)).toBe(false);
    expect(estimateCoversAsk(lawnAsk, advancedTurf)).toBe(true);
    const turfProgram = est({ estimate_data: { proposal: { enabled: true, programs: [{ service: 'lawn', label: 'Bermuda program', frequencyPerYear: 8, pricePerApplication: 90 }] } } });
    expect(estimateCoversAsk(card(plan), turfProgram)).toBe(false);
    expect(estimateCoversAsk(lawnAsk, turfProgram)).toBe(true);
    expect(deliveredEstimateScope(turfProgram).lines).toEqual([{ names: ['Bermuda program', 'lawn', 'Lawn Care'], recurring: true, oneTime: false, authored: true }]);
    // The engine's stinging line carries the category enum as its service
    // key; the enum's own words answer it (codex r22 P2).
    const wasps = card({ requested_service_categories: ['stinging_insect'], requested_specific_service: null });
    expect(estimateCoversAsk(wasps, est({ estimate_data: { result: { oneTime: { items: [{ service: 'stinging_insect', name: 'Stinging Insect — Paper Wasp', price: 150 }] } } } }))).toBe(true);
    expect(estimateCoversAsk(wasps, est({ estimate_data: { result: { oneTime: { items: [{ service: 'One-Time Pest Treatment', price: 120 }] } } } }))).toBe(false);
    // The raw engine lineItems (no typed containers) mix cadences and are
    // read row by row: annual / monthly money is a program, any other
    // priced row a one-time job — a mixed quote keeps its one-time services
    // (codex r23 P2).
    const raw = est({ estimate_data: { engineResult: { lineItems: [{ service: 'pest_control', name: 'Quarterly Pest Control', annual: 480, monthly: 40 }, { service: 'flea', name: 'Flea Treatment', price: 150 }, { service: 'rodent_exclusion', name: 'Rodent Exclusion', total: 900 }] } } });
    expect(estimateCoversAsk(card({ requested_service_categories: ['pest_general'] }), raw)).toBe(true);
    expect(estimateCoversAsk(card(plan), raw)).toBe(true);
    expect(estimateCoversAsk(card({ ...plan, requested_specific_service: 'Flea Treatment' }), raw)).toBe(false);
    expect(estimateCoversAsk(card({ requested_service_categories: ['rodent_exclusion'], requested_specific_service: null }), raw)).toBe(true);
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['rodent_exclusion'] }), raw)).toBe(false);
    // ...a per-application-only row is a program; a row with only a generic
    // `amount` (a discount / credit line) prices nothing at either cadence.
    const perApp = est({ estimate_data: { engineResult: { lineItems: [{ service: 'lawn_care', name: 'Lawn Care Program', perApp: 60, visitsPerYear: 8 }, { service: 'waveguard_discount', name: 'Pest Control', amount: 25 }] } } });
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['lawn_care'] }), perApp)).toBe(true);
    expect(estimateCoversAsk(card({ requested_service_categories: ['lawn_care'], requested_specific_service: null }), perApp)).toBe(false);
    expect(estimateCoversAsk(card(plan), perApp)).toBe(false);
    expect(estimateCoversAsk(card({ requested_service_categories: ['pest_general'], requested_specific_service: null }), perApp)).toBe(false);
    // An estimate's address goes through the canonical estimates.address
    // parser: "77 Oak St, Unit 4, Bradenton, FL 34205" is the street, the
    // unit and the locality — not a city called "Unit 4" — so a unit
    // customer's quote prices the asked address, another unit's does not,
    // and a unit the file lacks cannot be established (codex r23 P2).
    const unitCard = item({ ...base, customer_address_line2: 'Unit 4', reason_code: 'quote_promised', payload: { quote_scope: { requested_service_categories: ['pest_general'], requested_specific_service: 'Flea Treatment', requested_service_intent: 'preventative_one_time', requested_address: none } } });
    expect(estimateCoversAsk(unitCard, est({ address: '77 Oak St, Unit 4, Bradenton, FL 34205' }))).toBe(true);
    expect(estimateCoversAsk(unitCard, est({ address: '77 Oak St, Unit 5, Bradenton, FL 34205' }))).toBe(false);
    expect(estimateCoversAsk(unitCard, est({}))).toBe(false);
    expect(estimateCoversAsk(card({ requested_service_categories: ['pest_general'] }), est({ address: '77 Oak St, Unit 4, Bradenton, FL 34205' }))).toBe(false);
    // An annual-only recurring row (a termite bond: annual set, mo zero) is
    // a priced recurring line (codex r21 P2).
    const bond = est({ estimate_data: { result: { recurring: { services: [{ name: 'Termite Bond (5-Year Term)', service: 'termite_bond_5', mo: 0, annual: 300 }, { name: 'Pest Control', mo: 40 }] } } } });
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['termite'] }), bond)).toBe(true);
    expect(estimateCoversAsk(card({ ...plan, requested_service_categories: ['termite'] }), est({ estimate_data: { result: { recurring: { services: [{ name: 'Termite Bond (5-Year Term)', mo: 0, annual: 0 }, { name: 'Pest Control', mo: 40 }] } } } }))).toBe(false);
    // ...an unpriced program is a placeholder too.
    const unpricedProgram = est({ estimate_data: { proposal: { enabled: true, programs: [{ service: 'pest', label: 'Quarterly Pest Program', frequencyPerYear: 4, pricePerApplication: 0 }] } } });
    expect(estimateCoversAsk(card(plan), unpricedProgram)).toBe(false);
    // Distinct requirements need distinct lines (codex r19 P1): a flea
    // treatment AND a separately requested general-pest quote are not both
    // answered by the one flea line, and the same entry persisted under both
    // result roots is one line, not two.
    const two = card({ requested_service_categories: ['pest_general', 'pest_general'] });
    expect(estimateCoversAsk(two, partial)).toBe(false);
    expect(estimateCoversAsk(two, est({ estimate_data: { result: { oneTime: { items: [{ service: 'Flea Treatment', price: 150 }, { service: 'General Pest Treatment', price: 120 }] } } } }))).toBe(true);
    const dup = { oneTime: { items: [{ service: 'Flea Treatment', price: 150 }] } };
    expect(estimateCoversAsk(two, est({ estimate_data: { result: dup, engineResult: dup } }))).toBe(false);
    // Another address, a street with no locality, or no address at all;
    // the property row it prices stands in for a missing address column.
    expect(estimateCoversAsk(card({}), est({ address: '5 Pine Ave, Sarasota, FL 34236' }))).toBe(false);
    expect(estimateCoversAsk(card({}), est({ address: '77 Oak Street' }))).toBe(false);
    expect(estimateCoversAsk(card({}), est({ address: null }))).toBe(false);
    expect(estimateCoversAsk(card({}), est({ address: null, property_address_line1: '77 Oak St', property_zip: '34205' }))).toBe(true);
    // ...and for a street-only column too — the property row proves WHICH
    // street (codex r24 P2); a street-only column with no property does not.
    expect(estimateCoversAsk(card({}), est({ address: '77 Oak Street', property_address_line1: '77 Oak St', property_city: 'Bradenton', property_zip: '34205' }))).toBe(true);
    expect(estimateCoversAsk(card({}), est({ address: '77 Oak Street', property_address_line1: '5 Pine Ave', property_city: 'Sarasota', property_zip: '34236' }))).toBe(false);
    // Intent on the estimate arm (codex r24 P1): an inspection ask is
    // answered only by an inspection line, a treatment ask never by one; a
    // quote-only ask by a line at either cadence.
    const termiteQuote = (intent) => card({ requested_service_categories: ['termite'], requested_specific_service: null, requested_service_intent: intent });
    const inspectionLine = est({ estimate_data: { result: { oneTime: { items: [{ service: 'WDO Inspection (Termite Letter)', price: 125 }] } } } });
    const treatmentLine = est({ estimate_data: { result: { oneTime: { items: [{ service: 'Termite Treatment', price: 900 }] } } } });
    expect(estimateCoversAsk(termiteQuote('inspection_only'), inspectionLine)).toBe(true);
    expect(estimateCoversAsk(termiteQuote('inspection_only'), treatmentLine)).toBe(false);
    expect(estimateCoversAsk(termiteQuote('preventative_one_time'), inspectionLine)).toBe(false);
    expect(estimateCoversAsk(termiteQuote('quote_only'), treatmentLine)).toBe(true);
    // A quote-only ask takes either subtype — the category / specific
    // service says what was quoted, so a delivered inspection quote closes
    // the inspection quote promise (codex r28 P2).
    expect(estimateCoversAsk(termiteQuote('quote_only'), inspectionLine)).toBe(true);
    expect(estimateCoversAsk(termiteQuote('quote_only'), est({ estimate_data: { result: { recurring: { services: [{ name: 'Termite Bond', annual: 300 }] } } } }))).toBe(true);
    expect(estimateCoversAsk(termiteQuote('complaint_or_callback'), treatmentLine)).toBe(false);
    // A call that named a second property is answered only when a delivered
    // estimate at EVERY property prices the ask (codex r24 P2) — the cited
    // row may be either property's; a second property the snapshot did not
    // record binds nothing.
    const pine = { street_line_1: '5 Pine Ave', street_line_2: null, city: 'Sarasota', postal_code: '34236', raw_text: null };
    const twoHomes = card({ requested_address: { ...none, additional_properties: 1, additional: [pine] } });
    const pineEstimate = est({ id: 'e2', address: '5 Pine Ave, Sarasota, FL 34236' });
    expect(estimateCoversAsk(twoHomes, est({}), [pineEstimate])).toBe(true);
    expect(estimateCoversAsk(twoHomes, pineEstimate, [est({})])).toBe(true);
    expect(estimateCoversAsk(twoHomes, est({}), [])).toBe(false);
    expect(estimateCoversAsk(twoHomes, est({}), [est({ id: 'e3', address: '9 Elm St, Venice, FL 34285' })])).toBe(false);
    expect(estimateCoversAsk(card({ requested_address: { ...none, additional_properties: 1 } }), est({}), [pineEstimate])).toBe(false);
    // The ask named another address: the estimate must price THAT one.
    const named = { ...none, street_line_1: '5 Pine Ave', city: 'Sarasota', postal_code: '34236' };
    expect(estimateCoversAsk(card({ requested_address: named }), est({}))).toBe(false);
    expect(estimateCoversAsk(card({ requested_address: named }), est({ address: '5 Pine Ave, Sarasota, FL 34236' }))).toBe(true);
    // A card filed before the snapshot existed has no ask to cover.
    expect(estimateCoversAsk(item({ ...base, reason_code: 'quote_promised', payload: { flag: 'quote_promised' } }), est({}))).toBe(false);
  });

  test('direct bookings are bound to the address the card asked for: on-file when none was named, the named address otherwise', () => {
    const none = { street_line_1: null, street_line_2: null, city: null, postal_code: null, raw_text: null, additional_properties: 0 };
    const base = { call_log_id: 'call-1', call_customer_id: 'cust-1', customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205' };
    const card = (requested_address) => item({ ...base, reason_code: 'not_confirmed', created_at: FRESH, payload: { scheduling_window: { requested_date_range_start: '2026-07-30', requested_service_categories: ['pest_control'], requested_service_intent: 'preventative_one_time', requested_address } } });
    const places = new Map([['p1', { customer_id: 'cust-1', key: '77oakstreet', unit: '', city: 'Bradenton', zip: '34205' }]]);
    const later = new Date(new Date(FRESH).getTime() + 3600 * 1000).toISOString();
    const booking = (over) => ({ id: 'b1', source_call_log_id: 'call-1', parent_service_id: null, status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-07-30', created_at: later, ...over });
    const atOnFile = booking({ service_address_line1: '77 Oak Street', service_address_city: 'Bradenton', service_address_zip: '34205' });
    const atOther = booking({ service_address_line1: '5 Pine Ave', service_address_city: 'Sarasota', service_address_zip: '34236' });
    // Named nothing → the booking must be positively at the on-file address.
    expect(bookingAtRequestedAddress(card(none), atOnFile, places)).toBe(true);
    expect(bookingAtRequestedAddress(card(none), atOther, places)).toBe(false);
    expect(bookingAtRequestedAddress(card(none), booking({ property_id: 'p1' }), places)).toBe(true);
    expect(bookingAtRequestedAddress(card(none), booking({}), places)).toBe(false);
    // A street-only stamp (no city, no ZIP) proves no locality: it counts
    // only through a positively linked property.
    expect(bookingAtRequestedAddress(card(none), booking({ service_address_line1: '77 Oak Street' }), places)).toBe(false);
    expect(bookingAtRequestedAddress(card(none), booking({ service_address_line1: '77 Oak Street', property_id: 'p1' }), places)).toBe(true);
    // Named another address → the booking must be positively at THAT one.
    const named = { ...none, street_line_1: '5 Pine Ave', city: 'Sarasota', postal_code: '34236' };
    expect(bookingAtRequestedAddress(card(named), atOther, places)).toBe(true);
    expect(bookingAtRequestedAddress(card(named), atOnFile, places)).toBe(false);
    expect(bookingAtRequestedAddress(card(named), booking({ service_address_line1: '5 Pine Ave Unit 2', service_address_city: 'Sarasota' }), places)).toBe(false);
    expect(bookingAtRequestedAddress(card(named), booking({ service_address_line1: '5 Pine Ave', service_address_city: 'Venice' }), places)).toBe(false);
    // A street-only off-file ask (no city, no ZIP in any reading) cannot
    // prove WHICH street and binds nothing, even against a booking whose
    // stamp matches the street (codex r28 P1).
    const streetOnly = { ...none, street_line_1: '5 Pine Ave' };
    expect(bookingAtRequestedAddress(card(streetOnly), atOther, places)).toBe(false);
    expect(bookingAtRequestedAddress(card({ ...none, raw_text: '5 Pine Ave' }), atOther, places)).toBe(false);
    expect(bookingAtRequestedAddress(card({ ...none, raw_text: '5 Pine Ave, Sarasota FL 34236' }), atOther, places)).toBe(true);
    // A second-property ask binds nothing.
    expect(bookingAtRequestedAddress(card({ ...none, additional_properties: 1 }), atOnFile, places)).toBe(false);
    // The on-file address is the one the card SNAPSHOTTED at filing: a
    // customer moved to 5 Pine Ave since the card does not turn a booking
    // there into the answer to the implicit 77 Oak ask, and a card filed
    // without the snapshot binds nothing (codex r29 P1).
    const moved = { ...base, reason_code: 'not_confirmed', created_at: FRESH, customer_address_line1: '5 Pine Ave', customer_city: 'Sarasota', customer_zip: '34236', payload: { on_file_address: { address_line1: '77 Oak St', address_line2: null, city: 'Bradenton', zip: '34205' }, scheduling_window: { requested_date_range_start: '2026-07-30', requested_service_categories: ['pest_control'], requested_service_intent: 'preventative_one_time', requested_address: none } } };
    expect(bookingAtRequestedAddress(item(moved), atOnFile, places)).toBe(true);
    expect(bookingAtRequestedAddress(item(moved), atOther, places)).toBe(false);
    const unsnapshotted = { ...moved, payload: { ...moved.payload, on_file_address: null } };
    expect(bookingAtRequestedAddress(item(unsnapshotted), atOther, places)).toBe(false);
    expect(bookingAtRequestedAddress(item(unsnapshotted), atOnFile, places)).toBe(false);
    // Through the booking arm: this call's own booking at the wrong address
    // (a reprocess that moved the property) does not close the original ask.
    expect(bookingCoversRequest(card(none), [atOther], { singleProperty: true, places })).toBe(false);
    expect(bookingCoversRequest(card(none), [atOnFile], { singleProperty: true, places })).toBe(true);
    // …and this call's own booking outside the requested days (a reprocess
    // that moved only the date) does not either.
    expect(bookingCoversRequest(card(none), [{ ...atOnFile, scheduled_date: '2026-08-02' }], { singleProperty: true, places })).toBe(false);
    expect(bookingCoversRequest(card(named), [atOther], { singleProperty: false, places })).toBe(true);
  });

  test('a CONFIRMED call is answered only by a booking at the confirmed ET hour; a recurring-plan ask only by a recurring series', () => {
    const none = { street_line_1: null, street_line_2: null, city: null, postal_code: null, raw_text: null, additional_properties: 0 };
    const base = { call_log_id: 'call-1', call_customer_id: 'cust-1', customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205' };
    const places = new Map([['p1', { customer_id: 'cust-1', key: '77oakstreet', unit: '', city: 'Bradenton', zip: '34205' }]]);
    const ctx = { singleProperty: true, places };
    const later = new Date(new Date(FRESH).getTime() + 3600 * 1000).toISOString();
    const booking = (over) => ({ id: 'b1', source_call_log_id: 'call-1', parent_service_id: null, status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-07-30', window_start: '10:00:00', created_at: later, service_address_line1: '77 Oak Street', service_address_city: 'Bradenton', service_address_zip: '34205', ...over });
    const card = (window) => item({ ...base, reason_code: 'caller_not_authorized', created_at: FRESH, payload: { scheduling_window: { requested_service_categories: ['pest_control'], requested_service_intent: 'preventative_one_time', requested_address: none, ...window } } });
    const confirmed = card({ status: 'confirmed', confirmed_start_at: '2026-07-30T10:00:00-04:00' });
    expect(bookingCoversRequest(confirmed, [booking({})], ctx)).toBe(true);
    // Another booking that day at a different hour is not the appointment
    // the caller confirmed; a row with no window_start cannot prove the hour.
    expect(bookingCoversRequest(confirmed, [booking({ window_start: '14:00:00' })], ctx)).toBe(false);
    expect(bookingCoversRequest(confirmed, [booking({ window_start: null })], ctx)).toBe(false);
    // A UTC-encoded confirmed start is rendered in ET (14:00Z = 10:00 EDT).
    expect(bookingCoversRequest(card({ status: 'confirmed', confirmed_start_at: '2026-07-30T14:00:00Z' }), [booking({})], ctx)).toBe(true);
    // A day-only ask binds no hour.
    expect(bookingCoversRequest(card({ status: 'requested', requested_date_range_start: '2026-07-30' }), [booking({ window_start: '14:00:00' })], ctx)).toBe(true);
    // Cadence: a recurring-plan ask is not answered by a one-time visit in
    // the same category, only by a recurring series; a one-time ask is
    // still answered by a series (it delivers the visit); a snapshot with
    // no intent at all binds nothing.
    const plan = card({ requested_date_range_start: '2026-07-30', requested_service_intent: 'recurring_membership_inquiry' });
    expect(bookingCoversRequest(plan, [booking({})], ctx)).toBe(false);
    expect(bookingCoversRequest(plan, [booking({ is_recurring: true })], ctx)).toBe(true);
    // An explicit one-time ask is answered only by a single visit; an
    // active-infestation ask by either; a snapshot with no intent by nothing.
    expect(bookingCoversRequest(card({ requested_date_range_start: '2026-07-30' }), [booking({ is_recurring: true })], ctx)).toBe(false);
    expect(bookingCoversRequest(card({ requested_date_range_start: '2026-07-30' }), [booking({ is_recurring: false })], ctx)).toBe(true);
    // A day the caller excluded from the range is not answered by a booking
    // on it; the other days in the range still are; a booking with no date
    // cannot prove it avoided the excluded day (codex r16 P1).
    const skipping = card({ requested_date_range_start: '2026-07-28', requested_date_range_end: '2026-07-30', blackout_dates: ['2026-07-29'] });
    expect(bookingCoversRequest(skipping, [booking({ scheduled_date: '2026-07-29' })], ctx)).toBe(false);
    expect(bookingCoversRequest(skipping, [booking({ scheduled_date: '2026-07-30' })], ctx)).toBe(true);
    expect(bookingCoversRequest(skipping, [booking({ scheduled_date: '2026-07-28' })], ctx)).toBe(true);
    expect(bookingCoversRequest(skipping, [booking({ scheduled_date: null })], ctx)).toBe(false);
    // Two separate requests in one coarse category need two bookings: the
    // flea treatment (the primary narrowed by the specific service) and the
    // general-pest visit the model listed as a second request are not both
    // answered by the one flea booking (codex r17 P1).
    const two = card({ requested_date_range_start: '2026-07-30', requested_service_categories: ['pest_general', 'pest_general'], requested_specific_service: 'Flea Treatment' });
    const fleaVisit = booking({ id: 'b1', service_type: 'Flea Treatment', service_category_snapshot: 'pest_general' });
    const genericVisit = booking({ id: 'b2', service_type: 'Quarterly Pest Control', service_category_snapshot: 'pest_general' });
    expect(bookingCoversRequest(two, [fleaVisit], ctx)).toBe(false);
    expect(bookingCoversRequest(two, [genericVisit], ctx)).toBe(false);
    expect(bookingCoversRequest(two, [fleaVisit, genericVisit], ctx)).toBe(true);
    expect(bookingCoversRequest(card({ requested_date_range_start: '2026-07-30', requested_service_categories: ['pest_general'], requested_specific_service: 'Flea Treatment' }), [fleaVisit], ctx)).toBe(true);
    // A category the catalog books under another name and category: the
    // "Bee / Wasp Nest Removal" row stamped specialty answers a
    // stinging_insect ask; a pest booking does not (codex r22 P2).
    const waspVisit = booking({ id: 'b3', service_type: 'Bee / Wasp Nest Removal', service_category_snapshot: 'specialty' });
    const stingingAsk = card({ requested_date_range_start: '2026-07-30', requested_service_categories: ['stinging_insect'] });
    expect(bookingCoversRequest(stingingAsk, [waspVisit], ctx)).toBe(true);
    expect(bookingCoversRequest(stingingAsk, [genericVisit], ctx)).toBe(false);
    // A call that named a second property is answered only when EVERY
    // property has its covering booking (codex r24 P2); a card that counts
    // a second property its snapshot did not record binds nothing.
    const pine = { street_line_1: '5 Pine Ave', street_line_2: null, city: 'Sarasota', postal_code: '34236', raw_text: null };
    const twoHomes = card({ requested_date_range_start: '2026-07-30', requested_address: { ...none, additional_properties: 1, additional: [pine] } });
    const pineVisit = booking({ id: 'b4', service_address_line1: '5 Pine Ave', service_address_city: 'Sarasota', service_address_zip: '34236' });
    expect(bookingCoversRequest(twoHomes, [booking({}), pineVisit], ctx)).toBe(true);
    expect(bookingCoversRequest(twoHomes, [booking({})], ctx)).toBe(false);
    expect(bookingCoversRequest(twoHomes, [pineVisit], ctx)).toBe(false);
    expect(bookingCoversRequest(card({ requested_date_range_start: '2026-07-30', requested_address: { ...none, additional_properties: 1 } }), [booking({}), pineVisit], ctx)).toBe(false);
    const infestation = card({ requested_date_range_start: '2026-07-30', requested_service_intent: 'active_infestation_treatment' });
    expect(bookingCoversRequest(infestation, [booking({ is_recurring: true })], ctx)).toBe(true);
    expect(bookingCoversRequest(infestation, [booking({})], ctx)).toBe(true);
    expect(bookingCoversRequest(card({ requested_date_range_start: '2026-07-30', requested_service_intent: undefined }), [booking({})], ctx)).toBe(false);
    // Intent is more than cadence (codex r24 P1): an inspection ask is
    // answered only by an inspection, a treatment ask never by one; a
    // follow-up by a single visit, not a new series; a quote-only ask by no
    // booking; a complaint or a callback by nothing.
    const termite = (intent, over) => card({ requested_date_range_start: '2026-07-30', requested_service_categories: ['termite'], requested_service_intent: intent, ...over });
    const treatment = booking({ service_type: 'Termite Treatment', service_category_snapshot: 'termite' });
    const inspection = booking({ service_type: 'WDO Inspection (Termite Letter)', service_category_snapshot: 'termite' });
    expect(bookingCoversRequest(termite('inspection_only'), [treatment], ctx)).toBe(false);
    expect(bookingCoversRequest(termite('inspection_only'), [inspection], ctx)).toBe(true);
    expect(bookingCoversRequest(termite('preventative_one_time'), [inspection], ctx)).toBe(false);
    expect(bookingCoversRequest(termite('active_infestation_treatment'), [inspection], ctx)).toBe(false);
    expect(bookingCoversRequest(termite('follow_up_existing_service'), [treatment], ctx)).toBe(true);
    expect(bookingCoversRequest(termite('follow_up_existing_service'), [booking({ service_type: 'Termite Treatment', service_category_snapshot: 'termite', is_recurring: true })], ctx)).toBe(false);
    expect(bookingCoversRequest(termite('quote_only'), [treatment], ctx)).toBe(false);
    expect(bookingCoversRequest(termite('complaint_or_callback'), [treatment], ctx)).toBe(false);
    expect(bookingCoversRequest(termite('cancellation_request'), [treatment], ctx)).toBe(false);
  });

  test('a requested morning / afternoon / evening preference binds the booking’s band; any / unspecified / none bind nothing', () => {
    const none = { street_line_1: null, street_line_2: null, city: null, postal_code: null, raw_text: null, additional_properties: 0 };
    const base = { call_log_id: 'call-1', call_customer_id: 'cust-1', customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205' };
    const places = new Map([['p1', { customer_id: 'cust-1', key: '77oakstreet', unit: '', city: 'Bradenton', zip: '34205' }]]);
    const ctx = { singleProperty: true, places };
    const later = new Date(new Date(FRESH).getTime() + 3600 * 1000).toISOString();
    const booking = (over) => ({ id: 'b1', source_call_log_id: 'call-1', parent_service_id: null, status: 'confirmed', service_type: 'Quarterly Pest Control', scheduled_date: '2026-07-30', window_start: null, time_window: null, created_at: later, service_address_line1: '77 Oak Street', service_address_city: 'Bradenton', service_address_zip: '34205', ...over });
    const card = (preferred_time_of_day) => item({ ...base, reason_code: 'not_confirmed', created_at: FRESH, payload: { scheduling_window: { status: 'requested', requested_date_range_start: '2026-07-30', requested_service_categories: ['pest_control'], requested_service_intent: 'preventative_one_time', requested_address: none, preferred_time_of_day } } });
    // Tuesday morning is not answered by Tuesday afternoon, nor by a row
    // with no clock at all; the legacy time_window band counts.
    expect(bookingCoversRequest(card('morning'), [booking({ window_start: '09:00:00' })], ctx)).toBe(true);
    expect(bookingCoversRequest(card('morning'), [booking({ window_start: '14:00:00' })], ctx)).toBe(false);
    expect(bookingCoversRequest(card('morning'), [booking({})], ctx)).toBe(false);
    expect(bookingCoversRequest(card('morning'), [booking({ time_window: 'morning' })], ctx)).toBe(true);
    expect(bookingCoversRequest(card('evening'), [booking({ time_window: 'evening' })], ctx)).toBe(true);
    expect(bookingCoversRequest(card('evening'), [booking({ time_window: 'afternoon' })], ctx)).toBe(false);
    expect(bookingCoversRequest(card('afternoon'), [booking({ window_start: '12:00:00' })], ctx)).toBe(true);
    expect(bookingCoversRequest(card('afternoon'), [booking({ window_start: '17:00:00' })], ctx)).toBe(false);
    expect(bookingCoversRequest(card('evening'), [booking({ window_start: '17:30:00' })], ctx)).toBe(true);
    for (const pref of ['any', 'unspecified', null, undefined]) {
      expect(bookingCoversRequest(card(pref), [booking({ window_start: '14:00:00' })], ctx)).toBe(true);
      expect(bookingCoversRequest(card(pref), [booking({})], ctx)).toBe(true);
    }
  });

  test('requestedWindow is ET calendar days: confirmed start first, then the requested range, null without either', () => {
    expect(requestedWindow(item({ payload: { scheduling_window: { confirmed_start_at: '2026-08-04T14:00:00Z' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    // 01:00Z is still the previous ET evening.
    expect(requestedWindow(item({ payload: { scheduling_window: { confirmed_start_at: '2026-08-05T01:00:00Z' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    // An ET offset is the agreed wall clock verbatim, even a wrong-season
    // one (the booking path's reading): 23:30 with a winter offset in
    // August is still the 4th, not the instant's 5th.
    expect(requestedWindow(item({ payload: { scheduling_window: { confirmed_start_at: '2026-08-04T23:30:00-05:00' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    expect(requestedWindow(item({ payload: { scheduling_window: { requested_date_range_start: '2026-08-04', requested_date_range_end: '2026-08-06' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-06' });
    // A confirmed start pins BOTH bounds to its day: a residual requested
    // range beside it is not the ask any more (codex r21 P1).
    expect(requestedWindow(item({ payload: { scheduling_window: { confirmed_start_at: '2026-08-04T14:00:00Z', requested_date_range_start: '2026-08-03', requested_date_range_end: '2026-08-06' } } }))).toEqual({ start: '2026-08-04', end: '2026-08-04' });
    expect(requestedWindow(item({ payload: { scheduling_window: { status: 'requested' } } }))).toBeNull();
  });

  test('requestedAddressIsOnFile reads only the filing-time ask: none named, or exactly the on-file address', () => {
    const onFile = { customer_address_line1: '77 Oak St', customer_city: 'Bradenton', customer_zip: '34205', call_extraction: { property: { service_address: { street_line_1: '999 Other Rd' } } } };
    const ask = (requested_address) => item({ ...onFile, payload: { scheduling_window: { requested_address } } });
    const none = { street_line_1: null, street_line_2: null, city: null, postal_code: null, raw_text: null, additional_properties: 0 };
    expect(requestedAddressIsOnFile(ask(none))).toBe(true);
    expect(requestedAddressIsOnFile(ask({ ...none, street_line_1: '77 Oak Street', city: 'Bradenton' }))).toBe(true);
    expect(requestedAddressIsOnFile(ask({ ...none, street_line_1: '78 Oak St' }))).toBe(false);
    expect(requestedAddressIsOnFile(ask({ ...none, additional_properties: 1 }))).toBe(false);
    expect(requestedAddressIsOnFile(ask({ ...none, street_line_2: 'Unit 4' }))).toBe(false);
    // No snapshot (a pre-snapshot card) → never on file, whatever the rolling extraction says.
    expect(requestedAddressIsOnFile(item({ ...onFile, payload: { scheduling_window: {} } }))).toBe(false);
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
