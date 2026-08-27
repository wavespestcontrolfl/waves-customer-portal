/**
 * landline-suppression — channel-agnostic landline learning from Twilio delivery
 * failures.
 *
 * Twilio carrier error 30006 ("Landline or unreachable carrier") on an outbound
 * A2P SMS means the destination cannot receive SMS at all. The appointment-
 * reminder path already learns this on a 30006 bounce, but only into the
 * `customers.line_type` cache, which ONLY the appointment path consults — so
 * every other automated SMS path (invoice dunning, review requests, balance
 * reminders, …) keeps texting the same dead number on its next run.
 *
 * This module closes that gap: on a 30006 delivery callback it records a HARD
 * `non_mobile` entry in `messaging_suppression`, which the canonical send path
 * (send_customer_message → check_suppression) honors for every purpose and
 * audience. The number is then skipped by all SMS paths until the record is
 * cleared. It also refreshes the `customers.line_type` cache (best-effort) so
 * the two landline signals stay consistent.
 *
 * Scope is deliberately narrow — only code 30006 acts. Transient/unrelated
 * delivery codes (30003 unreachable handset, 30005 unknown handset, 30007
 * carrier filtering) are NOT treated as landline signals: they don't reliably
 * mean "this number can never receive SMS," and a hard suppression off a single
 * transient failure would wrongly silence a real mobile.
 *
 * Best-effort and idempotent: never throws (the caller dispatches it off the
 * webhook's 200 response path), and re-processing the same bounce is a no-op.
 */

const db = require('../../models/db');
const logger = require('../logger');
const { recordNonMobileSuppression } = require('./validators/suppression');

// Carrier delivery codes that mean "this number is not SMS-capable" (landline).
const NON_MOBILE_DELIVERY_CODES = new Set(['30006']);

/**
 * Normalize a phone string to E.164. Must match send_customer_message's
 * normalizeRecipient so the suppression key lines up with what the send path
 * queries on (loadSuppressionState matches `messaging_suppression.phone` against
 * the normalized recipient).
 */
function normalizeE164(phone) {
  if (!phone) return null;
  const trimmed = String(phone).trim();
  if (!trimmed) return null;
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (trimmed.startsWith('+')) return trimmed;
  return trimmed;
}

function lastTen(phone) {
  return String(phone || '').replace(/\D/g, '').slice(-10);
}

/**
 * Suppress a number that bounced as a landline / non-mobile.
 *
 * @param {{ sid?: string, status?: string, errorCode?: string|number, to?: string }} args
 * @returns {Promise<{ acted: boolean, reason?: string, recorded?: boolean, phone?: string }>}
 */
async function suppressNonMobileOnBounce({ errorCode, to, sid = null } = {}) {
  try {
    if (!NON_MOBILE_DELIVERY_CODES.has(String(errorCode || ''))) {
      return { acted: false, reason: 'not_a_landline_code' };
    }
    const phone = normalizeE164(to);
    if (!phone) {
      return { acted: false, reason: 'no_recipient' };
    }

    // Suppression + line_type cache run in ONE transaction under the SAME
    // per-phone advisory lock the START handler and 21610 recorders take
    // (codex #3495 r16): as separate autocommit statements, a START could
    // land between them — clearing the suppression and NULLing line_type —
    // and the trailing cache write would then re-block the freshly opted-in
    // recipient (isLandline treats the cache as authoritative). Under the
    // lock we either fully precede START (whose clear then also NULLs the
    // cache) or fully follow it (its committed tombstone makes the
    // supersede guard reject the stale bounce ⇒ recorded=false ⇒ no cache
    // write). A trx failure retries under the lock WITHOUT the cache write,
    // then falls back to the plain undatable-send record as a last resort —
    // the suppression itself must never be dropped (fail toward not
    // texting), mirroring the START handler's ladder.
    const applySuppression = async (trx, { withCache }) => {
      // Date the bounced send so a clearance tombstone NEWER than it (a
      // START received after this message went out) survives — a delayed
      // 30006 for an older send is stale evidence against a number that
      // provably texted us since. Unknown send time ⇒ never supersede.
      // The primary send path stamps created_at PRE-handoff and marks the
      // row (metadata.pre_handoff_stamp) — those rows need NO grace, and
      // backdating them lets a START from shortly BEFORE a genuinely-later
      // send outrank the carrier's current verdict (hook P1). Legacy
      // writers still log after messages.create() returns, so UNSTAMPED
      // rows keep the seconds-scale shave: a START whose clearance raced
      // the log insert keeps its clearance; a genuine landline just bounces
      // the next send with a clearly-newer sentAt and suppresses then.
      const SEND_RACE_GRACE_MS = 5 * 1000;
      let sentAt = null;
      if (sid) {
        const { hasPreHandoffStamp } = require('./suppression-ownership');
        const row = await trx('sms_log').where({ twilio_sid: sid }).first('created_at', 'metadata');
        if (row?.created_at) {
          sentAt = new Date(new Date(row.created_at).getTime() - (hasPreHandoffStamp(row) ? 0 : SEND_RACE_GRACE_MS));
        }
      }
      const result = await recordNonMobileSuppression({
        phone,
        source: `twilio_status_${errorCode}`,
        supersedeClearedBefore: sentAt,
        dbh: trx,
      });
      // recordNonMobileSuppression swallows its own SQL errors to
      // { ok: false } — on a transactional dbh Postgres has already
      // aborted, so throw to roll back and run the ladder (the same
      // silent-rollback trap the recipient-optin fix closed).
      if (result?.ok === false) {
        throw Object.assign(new Error('suppression write reported failure'), { code: 'suppression_write_failed' });
      }
      // Keep the customers.line_type cache (read by the appointment path's
      // send-time landline guard) consistent. Only touch live rows not
      // already cached as landline. Gated on recorded: when the verdict was
      // stale evidence (a delayed 30006 that lost to a newer START's
      // clearance tombstone, or any standing row it must not clobber), the
      // cache must stay silent too — isLandline() treats customers.line_type
      // as authoritative after START deletes the phone-keyed cache, so an
      // ungated write here would re-block the opted-in recipient through
      // the side door the suppression row just refused to open.
      const digits = lastTen(phone);
      if (withCache && result.recorded && digits) {
        await trx('customers')
          .whereRaw("regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ?", [`%${digits}`])
          .whereNull('deleted_at')
          .where((q) => q.whereNull('line_type').orWhereNot('line_type', 'landline'))
          .update({ line_type: 'landline' });
      }
      return !!result.recorded;
    };
    let recorded = false;
    try {
      await db.transaction(async (trx) => {
        await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [phone]);
        recorded = await applySuppression(trx, { withCache: true });
      });
    } catch (lockedErr) {
      logger.warn(`[landline-suppression] locked suppression failed (${lockedErr.code || lockedErr.message}) — retrying under the lock without the cache write`);
      try {
        await db.transaction(async (trx) => {
          await trx.raw("SELECT pg_advisory_xact_lock(hashtext('twilio_21610'), hashtext(?::text))", [phone]);
          recorded = await applySuppression(trx, { withCache: false });
        });
      } catch (retryErr) {
        // Both locked attempts failed — land the plain record as the last
        // resort with no send date (never supersedes a tombstone) and no
        // cache write. Fail toward not texting.
        logger.error(`[landline-suppression] locked retry also failed (${retryErr.code || retryErr.message}) — last-resort plain record`);
        const res = await recordNonMobileSuppression({
          phone,
          source: `twilio_status_${errorCode}`,
          supersedeClearedBefore: null,
        });
        recorded = !!res?.recorded;
      }
    }

    if (recorded) {
      logger.info(`[landline-suppression] Suppressed non-mobile recipient (carrier ${errorCode}) — future SMS will skip it`);
    }
    return { acted: true, recorded: !!recorded, phone };
  } catch (err) {
    logger.error(`[landline-suppression] suppressNonMobileOnBounce failed: ${err.message}`);
    return { acted: false, reason: 'error' };
  }
}

module.exports = {
  suppressNonMobileOnBounce,
  NON_MOBILE_DELIVERY_CODES,
  _internals: { normalizeE164 },
};
