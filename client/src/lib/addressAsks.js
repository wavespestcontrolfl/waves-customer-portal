// Open "this address may be wrong" cards shared by admin booking surfaces.
export const ADDRESS_ASK_REASONS = new Set([
  'missing_unit_number',
  'address_unverified',
  'missing_service_address',
  'low_confidence_address',
  'address_validation_unavailable',
  'address_unverifiable',
  'address_not_validated',
  'on_file_proof_customer_mismatch',
]);

// Valid premises whose street still needs a read-back. Separate because the
// copy differs and the estimate panel is scoped to validation failures.
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

/** Build one notice from one selected card; older cards may lack evidence. */
export function addressAskNotice(asks) {
  const open = filterAddressConfirmations(asks);
  if (open.length === 0) return null;
  // Mismatch > validation failure > read-back > missing unit.
  const rank = (i) => {
    if (i.reason_code === 'on_file_proof_customer_mismatch') return -1;
    if (i.reason_code === 'missing_unit_number') return 2;
    if (ADDRESS_READBACK_REASONS.has(i.reason_code)) return 1;
    return 0;
  };
  // Recovery and low-confidence read-back describe different evidence.
  const readbackReason = (i) => (i.reason_code === 'address_recovered'
    ? 'the street was pieced back together from a garbled recording and has not been read back'
    : 'the street validated, but it was heard with low confidence and has not been read back');
  // A same-call address_unverified card is the hold behind a missing-unit ask.
  // Classify that pair before ranking so another call's real failure can win.
  const sameCall = (a, b) => (a.call_log_id ?? null) === (b.call_log_id ?? null);
  // A live same-call recovery supersedes its stale generic hold. A stamped
  // recovery does not; it yields to a current validation/unit ask.
  const liveRecovery = (r, i) => r.reason_code === 'address_recovered'
    && !r.payload?.recovery_superseded_at
    && sameCall(r, i);
  const retiredRecoveryWithCurrentAsk = (i) => i.reason_code === 'address_recovered'
    && i.payload?.recovery_superseded_at
    && open.some((r) => r !== i && ADDRESS_ASK_REASONS.has(r.reason_code) && sameCall(r, i));
  const considered = open.filter((i) => !(i.reason_code === 'address_unverified'
    && open.some((r) => liveRecovery(r, i)))
    // Retired recovery remains owed only when no current same-call ask exists.
    && !retiredRecoveryWithCurrentAsk(i));
  const pool = considered.length > 0 ? considered : open;
  const effectiveRank = (i) => {
    const r = rank(i);
    if (i.reason_code === 'address_unverified'
      && pool.some((u) => u.reason_code === 'missing_unit_number' && sameCall(u, i))) return 2;
    return r;
  };
  const sorted = [...pool].sort((a, b) => effectiveRank(a) - effectiveRank(b));
  // Select the unit companion itself; otherwise prefer same-rank evidence.
  const worst = effectiveRank(sorted[0]);
  const lead = sorted[0];
  const card = worst === 2
    ? (lead.reason_code === 'missing_unit_number'
      ? lead
      : sorted.find((i) => i.reason_code === 'missing_unit_number' && sameCall(i, lead)) || lead)
    : sorted.find((i) => effectiveRank(i) === worst && i.payload?.address_as_heard) || lead;
  const askKind = effectiveRank(card);
  const candidates = Array.isArray(card.payload?.address_candidates)
    ? card.payload.address_candidates.filter(Boolean)
    : [];
  const unitBuilding = card.reason_code === 'missing_unit_number'
    ? card.payload?.unit_ask_building
    : null;
  const building = unitBuilding?.street_line_1
    ? [unitBuilding.street_line_1, unitBuilding.city, unitBuilding.postal_code].filter(Boolean).join(', ')
    : null;
  const heardSnapshot = card.payload?.heard_address;
  const snapshotParts = heardSnapshot && typeof heardSnapshot === 'object'
    ? [
      heardSnapshot.street_line_1,
      heardSnapshot.street_line_2,
      heardSnapshot.city,
      heardSnapshot.postal_code,
    ].map((part) => String(part || '').trim()).filter(Boolean)
    : [];
  const heard = card.payload?.address_as_heard
    || (heardSnapshot?.street_line_1 ? snapshotParts.join(', ') : heardSnapshot?.raw_text)
    || (snapshotParts.length > 0 ? snapshotParts.join(', ') : null)
    || null;
  return {
    // Identity changes when an otherwise identical warning is replaced.
    cardId: card.id ?? null,
    callId: card.call_log_id ?? null,
    unitOnly: askKind === 2,
    readbackOnly: askKind === 1,
    reason: askKind === 2
      ? 'the caller gave the building but no unit number'
      : askKind === 1
        ? readbackReason(card)
        : card.reason_code === 'on_file_proof_customer_mismatch'
          ? 'the saved address was validated for a different customer and this service address still needs confirmation'
          : 'the address from the call did not validate',
    // A validated building is not transcription evidence.
    heard: askKind === 2 ? null : heard,
    building,
    candidates: [...new Set(candidates)].slice(0, 5),
  };
}
