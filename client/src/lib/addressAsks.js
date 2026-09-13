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

const VALIDATION_NOTICE = {
  rank: 0,
  unitOnly: false,
  readbackOnly: false,
  reason: 'the address from the call did not validate',
};
const UNIT_NOTICE = {
  rank: 2,
  unitOnly: true,
  readbackOnly: false,
  reason: 'the caller gave the building but no unit number',
};
const NOTICE_BY_REASON = new Map([
  ...[...ADDRESS_ASK_REASONS].map((reason) => [reason, VALIDATION_NOTICE]),
  ['missing_unit_number', UNIT_NOTICE],
  ['on_file_proof_customer_mismatch', {
    rank: -1,
    unitOnly: false,
    readbackOnly: false,
    reason: 'the saved address was validated for a different customer and this service address still needs confirmation',
  }],
  ['address_recovered', {
    rank: 1,
    unitOnly: false,
    readbackOnly: true,
    reason: 'the street was pieced back together from a garbled recording and has not been read back',
  }],
  ['address_readback', {
    rank: 1,
    unitOnly: false,
    readbackOnly: true,
    reason: 'the street validated, but it was heard with low confidence and has not been read back',
  }],
]);

function evidenceFromCard(card, unitOnly) {
  const payload = card.payload ?? {};
  const candidates = Array.isArray(payload.address_candidates)
    ? payload.address_candidates.filter(Boolean)
    : [];
  const unitBuilding = card.reason_code === 'missing_unit_number'
    ? payload.unit_ask_building
    : null;
  const building = unitBuilding?.street_line_1
    ? [unitBuilding.street_line_1, unitBuilding.city, unitBuilding.postal_code]
      .filter(Boolean).join(', ')
    : null;
  const heardSnapshot = payload.heard_address;
  const snapshotParts = heardSnapshot && typeof heardSnapshot === 'object'
    ? [
      heardSnapshot.street_line_1,
      heardSnapshot.street_line_2,
      heardSnapshot.city,
      heardSnapshot.postal_code,
    ].map((part) => String(part || '').trim()).filter(Boolean)
    : [];
  const heard = payload.address_as_heard
    || (heardSnapshot?.street_line_1 ? snapshotParts.join(', ') : heardSnapshot?.raw_text)
    || (snapshotParts.length > 0 ? snapshotParts.join(', ') : null)
    || null;
  return {
    // A validated building is not transcription evidence.
    heard: unitOnly ? null : heard,
    building,
    candidates: [...new Set(candidates)].slice(0, 5),
  };
}

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
  const entries = open.map((card) => {
    const callId = card.call_log_id ?? null;
    // Map uses SameValueZero, while the historical comparison used strict
    // equality. Keep malformed NaN call ids isolated as strict equality did.
    return { card, callKey: Number.isNaN(callId) ? Symbol() : callId };
  });
  const callState = new Map();
  entries.forEach(({ card, callKey }) => {
    const state = callState.get(callKey) || {
      hasUnitAsk: false,
      hasLiveRecovery: false,
      hasCurrentAsk: false,
    };
    state.hasUnitAsk ||= card.reason_code === 'missing_unit_number';
    state.hasLiveRecovery ||= card.reason_code === 'address_recovered'
      && !card.payload?.recovery_superseded_at;
    state.hasCurrentAsk ||= ADDRESS_ASK_REASONS.has(card.reason_code);
    callState.set(callKey, state);
  });

  // Classify same-call companions once, before ranking. A generic hold paired
  // with a unit ask belongs at unit priority, while a live recovery replaces
  // that hold. A retired recovery yields to any current ask from its call.
  const classified = entries.map(({ card, callKey }) => {
    const state = callState.get(callKey);
    const isGenericHold = card.reason_code === 'address_unverified';
    const isRecovery = card.reason_code === 'address_recovered';
    return {
      card,
      callKey,
      notice: isGenericHold && state.hasUnitAsk ? UNIT_NOTICE : NOTICE_BY_REASON.get(card.reason_code),
      suppressed: (isGenericHold && state.hasLiveRecovery)
        || (isRecovery && card.payload?.recovery_superseded_at && state.hasCurrentAsk),
    };
  });
  const considered = classified.filter(({ suppressed }) => !suppressed);
  const pool = considered.length > 0 ? considered : classified;
  const sorted = [...pool].sort((a, b) => a.notice.rank - b.notice.rank);

  // Select the unit card itself; otherwise prefer evidence at the lead rank.
  const lead = sorted[0];
  let selected = lead;
  if (lead.notice.unitOnly) {
    selected = sorted.find(({ card, callKey }) => card.reason_code === 'missing_unit_number'
      && callKey === lead.callKey) || lead;
  } else {
    selected = sorted.find(({ card, notice }) => notice.rank === lead.notice.rank
      && card.payload?.address_as_heard) || lead;
  }
  const { card, notice } = selected;
  return {
    // Identity changes when an otherwise identical warning is replaced.
    cardId: card.id ?? null,
    callId: card.call_log_id ?? null,
    unitOnly: notice.unitOnly,
    readbackOnly: notice.readbackOnly,
    reason: notice.reason,
    ...evidenceFromCard(card, notice.unitOnly),
  };
}
