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
 *  - The contract OWNS: payload validation (customer/date/status against
 *    the DB CHECK set), source attribution, and — gated — completing the
 *    catalog-identity snapshot from the services table when the caller
 *    didn't stamp it.
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

// scheduled_services_status_check — 20260426000004 relaxed set plus
// 'no_show' (20260615000005). A status outside this list would be rejected
// by the DB anyway; failing here names the contract instead of a raw 23514.
const SCHEDULED_SERVICE_STATUSES = [
  'pending', 'confirmed', 'rescheduled', 'en_route', 'on_site',
  'completed', 'cancelled', 'skipped', 'no_show',
];

function contractError(message) {
  const err = new Error(`[booking-contract] ${message}`);
  err.code = 'BOOKING_CONTRACT_VIOLATION';
  return err;
}

// Resolve {service_id, service_key, category} from the live catalog for the
// identity snapshot. service_id wins; otherwise a UNIQUE active name match
// on service_type. Ambiguous or missing → null (the caller's row simply
// stays snapshot-less, exactly as today — enrichment never guesses).
// A QUERY ERROR propagates: inside a PostgreSQL transaction the failed
// statement has already aborted the trx, so swallowing it would only trade
// this error for a "current transaction is aborted" on the insert that
// follows (pre-push Codex P1).
async function resolveCatalogIdentity(conn, insertData) {
  if (insertData.service_id) {
    const row = await conn('services')
      .where({ id: insertData.service_id })
      .first('id', 'service_key', 'category');
    return row || null;
  }
  const name = String(insertData.service_type || '').trim();
  if (!name) return null;
  const hits = await conn('services')
    .where({ is_active: true })
    .whereRaw('LOWER(name) = LOWER(?)', [name])
    .select('id', 'service_key', 'category');
  return hits.length === 1 ? hits[0] : null;
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
  if (!insertData.customer_id && !allowNullCustomer) {
    throw contractError('customer_id is required (pass allowNullCustomer only for estimate slot holds)');
  }
  if (!insertData.scheduled_date) throw contractError('scheduled_date is required');
  const status = insertData.status === undefined ? 'pending' : insertData.status;
  if (!SCHEDULED_SERVICE_STATUSES.includes(String(status))) {
    throw contractError(`status '${status}' is outside the scheduled_services CHECK set`);
  }
  const sourceAction = source?.sourceAction || insertData.source_action;
  if (!sourceAction) {
    throw contractError('source attribution is required: pass source.sourceAction (e.g. admin_manual, voice_agent, admin_ib)');
  }

  const data = { ...insertData };

  // Attribution stamps are part of the ungated contract — they add
  // provenance, never change scheduling/billing behavior. Caller-provided
  // values always win.
  if (cols.source_action && data.source_action === undefined) data.source_action = sourceAction;
  if (cols.booking_source && data.booking_source === undefined && source?.bookingSource) {
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
 * shapes adopt completeScheduledServiceInsert directly instead — the
 * scanner test treats both as compliant.
 */
async function createScheduledService({ trx, insertData, cols, source, idempotencyKey, allowNullCustomer } = {}) {
  const data = await completeScheduledServiceInsert(insertData, { trx, cols, source, allowNullCustomer });
  if (idempotencyKey) {
    if (!cols.idempotency_key) throw contractError('idempotencyKey passed but scheduled_services has no idempotency_key column');
    // A payload carrying a DIFFERENT key would make the conflict guard
    // dedupe on the wrong value and let retries under the intended key
    // double-book (pre-push Codex P1) — refuse the ambiguity.
    if (data.idempotency_key !== undefined && data.idempotency_key !== idempotencyKey) {
      throw contractError(`idempotencyKey '${idempotencyKey}' conflicts with insertData.idempotency_key '${data.idempotency_key}'`);
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
  SCHEDULED_SERVICE_STATUSES,
};
