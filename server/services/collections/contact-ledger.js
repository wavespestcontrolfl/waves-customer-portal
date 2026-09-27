/**
 * collections_contact_ledger writer — the one place the dunning rails record
 * "this customer was (about to be) reached about an open balance".
 *
 * RECORD-THEN-SEND (codex 2026-08-14 P1, inverted from the original
 * write-after-delivery design): the rails insert the ledger row BEFORE
 * attempting delivery. A swallowed post-send insert failure would silently
 * WIDEN later eligibility — a missing touch makes the policy's frequency
 * windows look clear — so the failure direction is inverted:
 *
 *   - recordContact THROWS on insert failure. The caller must then SKIP the
 *     send: no unledgered customer contact, ever.
 *   - If the send subsequently fails, markSendFailed() best-effort stamps
 *     `send_failed: true` into the row's metadata, but the row STANDS.
 *     Over-suppression (a frequency window blocked by a touch that never
 *     delivered) is the correct failure direction; under-suppression is not.
 *
 * None of this runs inside a knex transaction on the rails — a thrown insert
 * error here is caught by callers in plain (non-trx) flow, so the
 * caught-error-still-aborts-the-trx trap does not apply. Keep it that way:
 * never call recordContact inside a trx without a SAVEPOINT.
 *
 * Seven-day overdue-message spacing (GATE_DUNNING_SPACING, with the policy
 * gate): the policy read and this reservation are separate steps, so two
 * rails on different schedules could both pass the read before either
 * reserved (codex #5108 r1). Under a per-customer lock, a reservation
 * re-checks for another rail's message and lands in the same transaction; a
 * hold throws DUNNING_SPACING_HELD, which every caller already treats as
 * "skip this send for now". enforceSpacing:false is only for recording a
 * message that has already gone out.
 */

const db = require('../../models/db');
const logger = require('../logger');
const DunningSpacing = require('./dunning-spacing');

async function recordContact({
  customerId,
  channel,
  purpose,
  invoiceIds = [],
  source,
  metadata = null,
  occurredAt = new Date(),
  idempotencyKey = null,
  enforceSpacing = true,
}) {
  const entry = { customerId, channel, purpose, invoiceIds, source, metadata, occurredAt, idempotencyKey };
  if (enforceSpacing && DunningSpacing.reservationGuarded({ channel, source })) {
    return db.transaction(async (trx) => {
      const holding = await DunningSpacing.lockedHoldingMessage(trx, { customerId, source, now: new Date(occurredAt) });
      if (holding) throw DunningSpacing.spacingHeldError(holding);
      return reserve(trx, entry);
    });
  }
  return reserve(db, entry);
}

async function reserve(conn, {
  customerId, channel, purpose, invoiceIds, source, metadata, occurredAt, idempotencyKey,
}) {
  // Deliberately NOT wrapped: an insert failure must propagate so the caller
  // skips the delivery it was about to make.
  let query = conn('collections_contact_ledger')
    .insert({
      customer_id: customerId,
      channel,
      purpose,
      invoice_ids: JSON.stringify(invoiceIds),
      occurred_at: occurredAt,
      source,
      metadata: metadata ? JSON.stringify(metadata) : null,
      ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
    });
  // A keyed record is a RESERVATION a retryable caller can safely re-run:
  // the second attempt hits the unique key, inserts nothing, and reuses the
  // standing row — never a duplicate frequency-window touch.
  if (idempotencyKey) query = query.onConflict('idempotency_key').ignore();
  const inserted = await query.returning('id');
  const first = Array.isArray(inserted) ? inserted[0] : inserted;
  const id = first && typeof first === 'object' ? first.id : first;
  if (id) return { id, metadata: metadata || {} };
  if (!idempotencyKey) throw new Error('collections ledger insert returned no id');
  const existing = await conn('collections_contact_ledger')
    .where({ idempotency_key: idempotencyKey })
    .first('id', 'metadata');
  if (!existing) throw new Error('collections ledger reservation neither inserted nor found');
  // A reused reservation is being re-attempted NOW (codex r5): refresh
  // occurred_at so the 24h frequency window starts at the actual delivery
  // attempt, not the first failed one. Later timestamp = longer window —
  // the safe direction; a refresh failure propagates (caller holds).
  await conn('collections_contact_ledger')
    .where({ id: existing.id })
    .update({ occurred_at: occurredAt });
  const existingMeta = typeof existing.metadata === 'string'
    ? JSON.parse(existing.metadata)
    : (existing.metadata || {});
  return { id: existing.id, metadata: existingMeta, reused: true };
}

/**
 * Stamp a keyed reservation as actually delivered. Best-effort and never
 * throws — an unstamped reserved row only ever over-suppresses, which is
 * the safe direction (same doctrine as markSendFailed).
 */
function applyReservationMatch(query, match = {}) {
  const equality = {};
  if (match.customerId) equality.customer_id = match.customerId;
  if (match.channel) equality.channel = match.channel;
  if (match.source) equality.source = match.source;
  if (Object.keys(equality).length) query.where(equality);
  if (match.notificationEventKey) {
    query.whereRaw("metadata->>'notificationEventKey' = ?", [match.notificationEventKey]);
  }
  if (match.invoiceId) {
    query.whereRaw('invoice_ids @> ?::jsonb', [JSON.stringify([match.invoiceId])]);
  }
  return query;
}

async function markDelivered(target, { database = db, match = {}, deliveredAt = null } = {}) {
  if (!target) return false;
  try {
    const stamp = async (conn) => {
      const query = conn('collections_contact_ledger');
      if (typeof target === 'string') query.where({ idempotency_key: target });
      else if (target.id) query.where({ id: target.id });
      else return false;
      applyReservationMatch(query, match);
      const changed = await query.update({
        metadata: conn.raw(`COALESCE(metadata, '{}'::jsonb) || '{"delivered": true}'::jsonb`),
        // A message accepted after its reservation (a provider retry) holds
        // the next one from when it actually went out (codex #5108 r1).
        // Later only: never shortens a window the reservation already holds.
        ...(deliveredAt ? {
          occurred_at: conn.raw('GREATEST(occurred_at, ?::timestamptz)', [new Date(deliveredAt)]),
        } : {}),
      });
      return Number(changed) === 1;
    };
    // A failed best-effort stamp on a caller's transaction must roll back to
    // a savepoint; catching a failed statement directly leaves PostgreSQL's
    // whole transaction aborted.
    return database.isTransaction ? await database.transaction(stamp) : await stamp(database);
  } catch (err) {
    logger.warn(`[collections-ledger] delivered stamp failed: ${err.message}`);
    return false;
  }
}

// Outcome flags belong to the ledger's own stamps, never a caller's snapshot.
function reservationSnapshot(metadata) {
  const snapshot = { ...(metadata || {}) };
  for (const key of ['delivered', 'resolved', 'resolution', 'send_failed']) delete snapshot[key];
  return snapshot;
}

// A keyed reservation permits one provider attempt. Only a confirmed failed
// attempt may be retried; an unstamped reused reservation is ambiguous. Clear
// the old failure before retrying so a later acceptance-stamp failure cannot
// make that accepted attempt look safe to send again.
// A retry can quote different debt than the failed attempt that created the
// reservation. `refresh` ({ invoiceIds, metadata }: what this attempt sends)
// is written in the same claim, so the row records what the retry quoted.
async function claimAttempt(entry, refresh = null) {
  if (!entry?.id) return { allowed: false, held: true };
  if (entry.metadata?.delivered === true) return { allowed: false, delivered: true };
  if (entry.metadata?.resolved === true) return { allowed: false, resolved: true };
  if (!entry.reused) return { allowed: true };
  if (entry.metadata?.send_failed !== true) return { allowed: false, held: true };
  const rearm = (conn) => conn('collections_contact_ledger').where({ id: entry.id })
    .whereRaw("metadata @> ?::jsonb AND NOT (metadata @> ?::jsonb) AND NOT (metadata @> ?::jsonb)", [
      JSON.stringify({ send_failed: true }), JSON.stringify({ delivered: true }), JSON.stringify({ resolved: true }),
    ])
    .update({
      metadata: conn.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [
        JSON.stringify({ ...reservationSnapshot(refresh?.metadata), send_failed: false }),
      ]),
      ...(Array.isArray(refresh?.invoiceIds) ? { invoice_ids: JSON.stringify(refresh.invoiceIds) } : {}),
    });
  // Re-arming a failed reservation makes it hold other rails' messages
  // again, so under the spacing gate it takes the same lock and re-check as
  // a new one: another rail could reserve between the refresh and this claim.
  const changed = DunningSpacing.spacingEnforced()
    ? await db.transaction(async (trx) => {
      const row = await trx('collections_contact_ledger').where({ id: entry.id })
        .first('customer_id', 'channel', 'source');
      if (row && DunningSpacing.reservationGuarded(row) && await DunningSpacing.lockedHoldingMessage(trx, {
        customerId: row.customer_id, source: row.source,
      })) return 0;
      return rearm(trx);
    })
    : await rearm(db);
  return changed === 1 ? { allowed: true } : { allowed: false, held: true };
}

/**
 * Stamp a pre-recorded contact as undelivered. Best-effort and never throws —
 * the row standing un-stamped only ever over-suppresses, which is safe.
 * `entry` is the return value of recordContact (id + original metadata).
 */
async function markSendFailed(entry, extra = {}, { database = db, match = {} } = {}) {
  if (!entry || !entry.id) return false;
  try {
    // Atomic jsonb MERGE, never a whole-object replace from the caller's
    // (possibly stale) snapshot (gh prb-r11): an ambiguous provider failure
    // can race a live call that already stamped voicemail_left or an
    // outcome onto this row — a replace built from the pre-dial entry
    // would erase them (losing voicemail_left re-permits a voicemail
    // inside the 30-day cap).
    const stamp = async (conn) => {
      const query = conn('collections_contact_ledger').where({ id: entry.id });
      applyReservationMatch(query, match);
      const changed = await query.update({
        metadata: conn.raw(
          "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ send_failed: true, ...extra })],
        ),
      });
      return Number(changed) === 1;
    };
    return database.isTransaction ? await database.transaction(stamp) : await stamp(database);
  } catch (err) {
    logger.warn(`[collections-ledger] send-failed stamp failed for ledger row ${entry.id}: ${err.message}`);
    return false;
  }
}

module.exports = { recordContact, markSendFailed, markDelivered, claimAttempt };
