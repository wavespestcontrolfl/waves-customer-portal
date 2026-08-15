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
 */

const db = require('../../models/db');
const logger = require('../logger');

async function recordContact({
  customerId,
  channel,
  purpose,
  invoiceIds = [],
  source,
  metadata = null,
  occurredAt = new Date(),
  idempotencyKey = null,
}) {
  // Deliberately NOT wrapped: an insert failure must propagate so the caller
  // skips the delivery it was about to make.
  let query = db('collections_contact_ledger')
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
  const existing = await db('collections_contact_ledger')
    .where({ idempotency_key: idempotencyKey })
    .first('id', 'metadata');
  if (!existing) throw new Error('collections ledger reservation neither inserted nor found');
  // A reused reservation is being re-attempted NOW (codex r5): refresh
  // occurred_at so the 24h frequency window starts at the actual delivery
  // attempt, not the first failed one. Later timestamp = longer window —
  // the safe direction; a refresh failure propagates (caller holds).
  await db('collections_contact_ledger')
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
async function markDelivered(target) {
  if (!target) return false;
  try {
    const query = db('collections_contact_ledger');
    if (typeof target === 'string') query.where({ idempotency_key: target });
    else if (target.id) query.where({ id: target.id });
    else return false;
    await query.update({
      metadata: db.raw(`COALESCE(metadata, '{}'::jsonb) || '{"delivered": true}'::jsonb`),
    });
    return true;
  } catch (err) {
    logger.warn(`[collections-ledger] delivered stamp failed: ${err.message}`);
    return false;
  }
}

/**
 * Stamp a pre-recorded contact as undelivered. Best-effort and never throws —
 * the row standing un-stamped only ever over-suppresses, which is safe.
 * `entry` is the return value of recordContact (id + original metadata).
 */
async function markSendFailed(entry, extra = {}) {
  if (!entry || !entry.id) return false;
  try {
    // Atomic jsonb MERGE, never a whole-object replace from the caller's
    // (possibly stale) snapshot (gh prb-r11): an ambiguous provider failure
    // can race a live call that already stamped voicemail_left or an
    // outcome onto this row — a replace built from the pre-dial entry
    // would erase them (losing voicemail_left re-permits a voicemail
    // inside the 30-day cap).
    await db('collections_contact_ledger')
      .where({ id: entry.id })
      .update({
        metadata: db.raw(
          "COALESCE(metadata, '{}'::jsonb) || ?::jsonb",
          [JSON.stringify({ send_failed: true, ...extra })],
        ),
      });
    return true;
  } catch (err) {
    logger.warn(`[collections-ledger] send-failed stamp failed for ledger row ${entry.id}: ${err.message}`);
    return false;
  }
}

module.exports = { recordContact, markSendFailed, markDelivered };
