/**
 * Booking stamping contract — the single field-stamping authority for new
 * scheduled_services rows (Tier 2 booking-consolidation track).
 *
 * The repo has ~26 hand-built insert sites across 14 files, and the field
 * sets they stamp have drifted: catalog-identity snapshots
 * (service_key_snapshot / service_category_snapshot) are written by some
 * writers and not others, so a scoped recurring discount meeting a
 * snapshot-less row makes loadStoredDiscountScope throw, and source
 * attribution is inconsistent to absent. This module is the contract those
 * writers converge on, one call site per PR; server/tests/
 * booking-insert-contract.test.js freezes the legacy site inventory so it
 * can only shrink.
 *
 * Division of labor (deliberate — see the PR that introduced this):
 *  - The contract OWNS: payload validation (customer/date), source
 *    attribution, and — gated — completing the catalog-identity snapshot
 *    from the services table when the caller didn't stamp it. Status
 *    acceptance deliberately stays with the DB CHECK constraint
 *    (scheduled_services_status_check, AGENTS.md) — a service-level list
 *    would be a second gate every status migration must remember to
 *    extend (GH Codex r5 P1).
 *  - The CALLER keeps: pricing computation, occupancy/comms lock ordering
 *    (scheduling/occupancy.js ORDERING CONTRACT), the transaction,
 *    registerAppointment (customer comms NEVER move in here), inspection
 *    credit, and child/booster spawning.
 *  - Deferred, deliberately NOT stamped here: primary_line_price
 *    defaulting and payer_id/po_number freezing at create time. Both
 *    change billing semantics (a numeric primary_line_price is treated as
 *    authoritative by the invoice builder — codex #3551; a stamped payer
 *    freezes what completion currently resolves live via
 *    COALESCE(visit payer, customer payer)) and need an owner ruling
 *    before any path adopts them.
 *
 * GATE_BOOKING_STAMPING_CONTRACT (config/feature-gates.js): OFF = no
 * behavioral enrichment — validation plus provenance attribution only
 * (source_action/booking_source, caller values always win), so adopting a
 * call site changes nothing at rest; ON = enrichment stamps apply.
 */
const { isEnabled } = require('../../config/feature-gates');

function contractError(message) {
  const err = new Error(`[booking-contract] ${message}`);
  err.code = 'BOOKING_CONTRACT_VIOLATION';
  return err;
}

// Resolve {service_id, service_key, category} from the live catalog for
// the identity snapshot, in DURABILITY order (the same precedence
// service-catalog-names uses): service_id → the row's own
// service_key_snapshot (survives a catalog-row delete's ON DELETE SET
// NULL, unlike the mutable display name) → a UNIQUE active name match on
// service_type. Ambiguous or missing → null (the caller's row simply
// stays snapshot-less, exactly as today — enrichment never guesses).
// A QUERY ERROR propagates: inside a PostgreSQL transaction the failed
// statement has already aborted the trx, so swallowing it would only trade
// this error for a "current transaction is aborted" on the insert that
// follows (pre-push Codex P1).
async function resolveCatalogIdentity(conn, insertData) {
  // Inside a transaction, hold a share lock on the uniquely resolved row
  // through the caller's insert — the same stability service-catalog-names
  // uses — so a concurrent deactivate/archive can't retire the service
  // between this read and the insert that references it (GH Codex r4 P2).
  const stable = (q) => (conn.isTransaction && typeof q.forShare === 'function' ? q.forShare() : q);
  if (insertData.service_id) {
    const row = await stable(conn('services')
      .where({ id: insertData.service_id }))
      .first('id', 'service_key', 'category');
    return row || null;
  }
  // Fallback lookups link only LIVE catalog rows: is_active AND not
  // archived (archiveService sets both flags together; the pair is what the
  // 20260831 typed-visit resolution migration treats as authoritative), so
  // an archived row can neither be newly stamped nor make an otherwise
  // unique name ambiguous (pre-push Codex r6 P1).
  const live = { is_active: true, is_archived: false };
  const snapshotKey = String(insertData.service_key_snapshot || '').trim();
  if (snapshotKey) {
    const byKey = await stable(conn('services')
      .where({ service_key: snapshotKey, ...live }))
      .select('id', 'service_key', 'category');
    return byKey.length === 1 ? byKey[0] : null;
  }
  const name = String(insertData.service_type || '').trim();
  if (!name) return null;
  // Name matching goes through the SAME alias bridge completion uses
  // (serviceNameCandidates: " Service" suffix, visit-program tails,
  // cadence qualifiers, rename aliases) — an exact-name-only match would
  // leave legacy/pre-rename labels snapshot-less, exactly the rows the
  // scoped-discount replay throws on (GH Codex r2 P1). Unique-row
  // semantics across ALL candidates: more than one DISTINCT catalog row
  // matching means ambiguity, and enrichment never guesses.
  const { serviceNameCandidates } = require('../service-completion-profiles');
  const candidates = serviceNameCandidates(name).map((c) => c.toLowerCase());
  if (!candidates.length) return null;
  const hits = await stable(conn('services')
    .where(live)
    .whereRaw(`LOWER(name) IN (${candidates.map(() => '?').join(', ')})`, candidates))
    .select('id', 'service_key', 'category');
  const distinct = [...new Map(hits.map((h) => [h.id, h])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * Validate and (gate on) complete a scheduled_services insert payload.
 * Pure with respect to the caller's transaction: reads the catalog, writes
 * nothing. Returns a NEW object; the input is not mutated.
 *
 * @param {object} insertData  the payload the caller built
 * @param {object} opts
 *   - trx: the caller's knex connection/transaction (catalog reads)
 *   - cols: scheduled_services columnInfo() map (column-existence guard,
 *     same convention as the admin-schedule writers)
 *   - source: { sourceAction, bookingSource? } — required attribution;
 *     stamped onto source_action / booking_source when the caller's
 *     payload doesn't already carry them
 *   - allowNullCustomer: true only for the estimate slot-hold shape
 *     (reserveSlot inserts customer_id NULL by design)
 */
async function completeScheduledServiceInsert(insertData, { trx, cols, source, allowNullCustomer = false } = {}) {
  if (!insertData || typeof insertData !== 'object') throw contractError('insertData is required');
  if (!trx) throw contractError('trx (knex connection) is required');
  if (!cols || typeof cols !== 'object') throw contractError('cols (scheduled_services columnInfo) is required');

  // ── Validation (always on) ─────────────────────────────────────────
  if (!insertData.customer_id) {
    // The escape hatch admits ONLY the estimate slot-hold shape: an
    // EXPLICIT customer_id: null plus the reservation expiry marker the
    // hold lifecycle keys on. A merely omitted customer or a payload
    // without hold markers would otherwise insert a permanent
    // customer-less appointment through the nullable column
    // (GH Codex r2 P2).
    const explicitHold = allowNullCustomer
      && Object.prototype.hasOwnProperty.call(insertData, 'customer_id')
      && insertData.customer_id === null
      && insertData.reservation_expires_at;
    if (!explicitHold) {
      throw contractError('customer_id is required (allowNullCustomer admits only the explicit slot-hold shape: customer_id null + reservation_expires_at)');
    }
  }
  if (!insertData.scheduled_date) throw contractError('scheduled_date is required');
  const sourceAction = source?.sourceAction || insertData.source_action;
  if (!sourceAction) {
    throw contractError('source attribution is required: pass source.sourceAction (e.g. admin_manual, voice_agent, admin_ib)');
  }

  const data = { ...insertData };

  // Attribution stamps are part of the ungated contract — they add
  // provenance, never change scheduling/billing behavior. A caller's
  // NON-EMPTY value always wins; null/'' counts as absent (a fixed-shape
  // payload carrying source_action: null must not persist blank
  // provenance past the requirement check — GH Codex P2).
  const blank = (v) => v == null || v === '';
  if (cols.source_action && blank(data.source_action)) data.source_action = sourceAction;
  if (cols.booking_source && blank(data.booking_source) && source?.bookingSource) {
    data.booking_source = source.bookingSource;
  }

  if (!isEnabled('bookingStampingContract')) return data;

  // ── Gated enrichment ───────────────────────────────────────────────
  // Catalog-identity snapshot: rows missing service_key_snapshot /
  // service_category_snapshot are the ones loadStoredDiscountScope
  // (admin-schedule.js) throws on when a scoped recurring discount is
  // replayed. Only fills ABSENT fields; a caller that stamped its own
  // snapshot (slot-reservation's deliberate restamp at commit, the
  // seeder's child identity) is never overridden.
  const wantsKey = cols.service_key_snapshot && data.service_key_snapshot === undefined;
  const wantsCategory = cols.service_category_snapshot && data.service_category_snapshot === undefined;
  const wantsServiceId = cols.service_id && data.service_id === undefined;
  if (wantsKey || wantsCategory || wantsServiceId) {
    const identity = await resolveCatalogIdentity(trx, data);
    if (identity) {
      if (wantsServiceId) data.service_id = identity.id;
      if (wantsKey) data.service_key_snapshot = identity.service_key || null;
      if (wantsCategory) data.service_category_snapshot = identity.category || null;
    }
  }

  return data;
}

/**
 * Thin insert wrapper for callers whose transaction shape allows it: runs
 * the contract, then performs the insert (opt-in idempotency via
 * onConflict('idempotency_key').ignore()). Callers with bespoke insert
 * shapes (bulk rows, savepoints) adopt completeScheduledServiceInsert
 * directly instead — the scanner test recognizes an insert whose payload
 * came out of that helper as compliant, so both routes leave the frozen
 * inventory.
 */
async function createScheduledService({ trx, insertData, cols, source, idempotencyKey, allowNullCustomer } = {}) {
  const data = await completeScheduledServiceInsert(insertData, { trx, cols, source, allowNullCustomer });
  // Distinguish "idempotency not requested" (option omitted) from a
  // SUPPLIED blank key: a caller that opted in but computed '' must fail
  // closed, not fall through to an unguarded insert a retry would
  // double-book (GH Codex P1).
  if (idempotencyKey !== undefined) {
    // Trim before judging: a whitespace-only key is a failed computation,
    // and stamping it would make the NEXT unrelated failure read as an
    // idempotent replay and silently drop a booking (GH Codex r4 P2).
    idempotencyKey = typeof idempotencyKey === 'string' ? idempotencyKey.trim() : idempotencyKey;
    if (!idempotencyKey || typeof idempotencyKey !== 'string') {
      throw contractError('idempotencyKey was supplied but is blank — refuse rather than insert unguarded');
    }
    if (!cols.idempotency_key) throw contractError('idempotencyKey passed but scheduled_services has no idempotency_key column');
    // A payload carrying a DIFFERENT non-blank key would make the conflict
    // guard dedupe on the wrong value and let retries under the intended
    // key double-book (pre-push Codex P1) — refuse the ambiguity. A
    // null/blank payload value counts as absent (the column is nullable)
    // and the supplied option stamps over it (GH Codex r2 P2).
    const payloadKey = data.idempotency_key;
    if (payloadKey != null && payloadKey !== '' && payloadKey !== idempotencyKey) {
      throw contractError(`idempotencyKey '${idempotencyKey}' conflicts with insertData.idempotency_key '${payloadKey}'`);
    }
    data.idempotency_key = idempotencyKey;
    const [row] = await trx('scheduled_services')
      .insert(data)
      .onConflict('idempotency_key')
      .ignore()
      .returning('*');
    return row || null; // null = idempotent replay, caller decides how to reload
  }
  const [row] = await trx('scheduled_services').insert(data).returning('*');
  return row;
}

module.exports = {
  completeScheduledServiceInsert,
  createScheduledService,
};
