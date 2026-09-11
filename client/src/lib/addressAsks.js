/**
 * Open "this address may be wrong" review cards, shared by every admin surface
 * that acts on a customer's service address.
 *
 * The call pipeline files an address_review card whenever Address Validation
 * could not resolve what the caller said, and blocks its own auto-booking on
 * it. Nothing stopped a HUMAN from booking that same address by hand: on
 * 2026-09-10 a transcription turned a caller's spoken ordinal street into a
 * similar-sounding word, the card opened as designed, and 66 seconds later the
 * visit was booked manually off the customer record. A tech drove to a street
 * that does not exist. (Call c3c27b01; see the triage card for the strings.)
 *
 * Read-only context, fail-open: a surface that cannot load these still works,
 * it just loses the warning.
 */

// The address_review lane also files multi-property / second-address /
// property-role / dropped-call cards. Those say "which address", not "this
// address may be wrong", so they are deliberately NOT in this set.
export const ADDRESS_ASK_REASONS = new Set([
  'missing_unit_number',
  'address_unverified',
  'missing_service_address',
  'low_confidence_address',
  'address_validation_unavailable',
  'address_unverifiable',
  'address_not_validated',
]);

// Address Validation ACCEPTED a real premise, but which premise is still owed
// a read-back: a street recovery pieced back together from a garble, or one
// the extractor itself had low confidence in. Both are ADVISORY_TRIAGE_FLAGS
// (call-triage-flags.js) — they never block routing, so a call carrying only
// these auto-books AND dispatches on a street nobody has confirmed. That is
// the same hole as an unvalidated address, so the booking warning covers it.
// Kept separate from the validation asks above because the copy differs and
// because the estimate tool's panel is scoped to validation failures only.
export const ADDRESS_READBACK_REASONS = new Set([
  'address_recovered',
  'address_readback',
]);

/** The validation-ask cards out of a /admin/triage response's items. */
export function filterAddressAsks(items) {
  return (Array.isArray(items) ? items : []).filter(
    (i) => i && ADDRESS_ASK_REASONS.has(i.reason_code),
  );
}

/** Every card that means "confirm this street before a tech drives to it". */
export function filterAddressConfirmations(items) {
  return (Array.isArray(items) ? items : []).filter(
    (i) => i && (ADDRESS_ASK_REASONS.has(i.reason_code) || ADDRESS_READBACK_REASONS.has(i.reason_code)),
  );
}

/**
 * What to tell an operator about these cards, or null when there is nothing
 * owed. `heard` is the street as the transcriber wrote it and `candidates` the
 * house-number-matched streets recovery thought the caller more likely said —
 * both come off the card payload, both are absent on older cards.
 *
 * Everything shown comes from ONE card. A customer with active cards from two
 * different calls would otherwise pair one call's heard street with another
 * call's suggestions and point the operator at an unrelated property.
 */
export function addressAskNotice(asks) {
  const open = filterAddressConfirmations(asks);
  if (open.length === 0) return null;
  // Worst class first: an address that did not validate outranks one that
  // validated but still owes a read-back, which outranks a known building
  // missing only its unit. The chosen card is the one the copy speaks for.
  const rank = (i) => {
    if (i.reason_code === 'missing_unit_number') return 2;
    if (ADDRESS_READBACK_REASONS.has(i.reason_code)) return 1;
    return 0;
  };
  // The two read-back cards are NOT the same claim. address_recovered means a
  // garbled street was reconstructed; address_readback means Address Validation
  // accepted the premise but the extractor's own confidence in it was low, and
  // no recovery need have happened. Saying "pieced back together" for the
  // latter tells the operator something untrue about the record.
  const readbackReason = (i) => (i.reason_code === 'address_recovered'
    ? 'the street was pieced back together from a garbled recording and has not been read back'
    : 'the street validated, but it was heard with low confidence and has not been read back');
  const sorted = [...open].sort((a, b) => rank(a) - rank(b));
  // Among equals, prefer a card that actually carries recovery evidence.
  const worst = rank(sorted[0]);
  const card = sorted.find((i) => rank(i) === worst && i.payload?.address_as_heard) || sorted[0];
  const kind = rank(card);
  const candidates = Array.isArray(card.payload?.address_candidates)
    ? card.payload.address_candidates.filter(Boolean)
    : [];
  return {
    unitOnly: kind === 2,
    readbackOnly: kind === 1,
    reason: kind === 2
      ? 'the caller gave the building but no unit number'
      : kind === 1
        ? readbackReason(card)
        : 'the address from the call did not validate',
    heard: card.payload?.address_as_heard || null,
    candidates: [...new Set(candidates)].slice(0, 5),
  };
}
