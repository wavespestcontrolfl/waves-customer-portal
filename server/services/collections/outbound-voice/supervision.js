/**
 * Per-call supervision for the collections voice lane.
 *
 * "Supervised" = an admin-approved (hand-dialed) case; only supervised calls
 * may ride the owner shakedown call-window override (codex P1 on #3555).
 * Origination stamps `collectionsSupervised` into the call_log metadata it
 * writes before calls.create, and every in-call reader (vestibule webhooks,
 * relay conversation) resolves supervision through here — never from the
 * case's approved_by, which writeCallOutcome clears (codex #3560 P2).
 *
 * Legacy rows (originated before the stamp existed) resolve ONCE from the
 * case and are durably backfilled so a later webhook retry — after the
 * outcome cleared approved_by — classifies the call exactly as the first
 * attempt did (codex #3560 P0). A failed case read resolves unsupervised
 * WITHOUT backfilling, so the next retry can still succeed.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const ContactPolicy = require('../contact-policy');

async function resolveCallSupervision({ row, meta, database = db }) {
  if (meta && typeof meta.collectionsSupervised === 'boolean') return meta.collectionsSupervised;
  if (!row || !meta || !meta.collectionCaseId) return false;
  let supervised;
  try {
    const linked = await database('collection_cases')
      .where({ id: meta.collectionCaseId })
      .first('approved_by');
    supervised = ContactPolicy.isSupervisedApprover(linked && linked.approved_by);
  } catch (err) {
    logger.warn(`[collections-supervision] case read failed for call_log ${row.id}: ${err.message} — treating as unsupervised (no backfill)`);
    return false;
  }
  try {
    await database('call_log')
      .where({ id: row.id })
      .whereRaw("COALESCE(metadata->>'collectionsSupervised', '') = ''")
      .update({
        metadata: database.raw("COALESCE(metadata, '{}'::jsonb) || ?::jsonb", [JSON.stringify({ collectionsSupervised: supervised })]),
        updated_at: new Date(),
      });
  } catch (err) {
    logger.warn(`[collections-supervision] backfill failed for call_log ${row.id}: ${err.message}`);
  }
  return supervised;
}

module.exports = { resolveCallSupervision };
