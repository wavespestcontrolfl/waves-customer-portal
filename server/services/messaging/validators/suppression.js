/**
 * Suppression validator. Checks whether a recipient is on the
 * messaging_suppression list for any of: HARD opt-out, wrong-number flag,
 * or per-customer DNC. Wrong-number records survive even when the phone
 * later gets reused — they're keyed on the (phone, recorded_at) pair
 * with an active flag.
 *
 * The table itself ships in commit 7's migration (alongside
 * message_audit_log). Until that migration runs, this validator no-ops
 * gracefully — load_suppression_state catches a missing-table error and
 * returns null, and validators interpret null as "no suppression record".
 *
 * Suppression is HARD: an entry here blocks every purpose, every audience,
 * every channel, until the entry is explicitly cleared. The only escape
 * hatch is a START keyword on the inbound channel, which is handled by
 * the twilio-webhook STOP/START flow and clears the suppression record.
 */

const db = require('../../../models/db');
const logger = require('../../logger');
const { toE164 } = require('../../../utils/phone');

/**
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} _policy
 * @param {Object} contactState - augmented by loadSuppressionState before this validator runs
 * @returns {Promise<{ ok: boolean, code?: string, reason?: string }>}
 */
async function checkSuppression(input, _policy, contactState) {
  const suppression = contactState && contactState.suppression;
  if (!suppression) return { ok: true };

  if (suppression.reason === 'opt_out_keyword' || suppression.reason === 'opt_out_natural_language') {
    return {
      ok: false,
      code: 'SUPPRESSED_OPT_OUT',
      reason: `Recipient is suppressed (reason: ${suppression.reason}, since ${suppression.created_at})`,
    };
  }
  if (suppression.reason === 'wrong_number') {
    return {
      ok: false,
      code: 'SUPPRESSED_WRONG_NUMBER',
      reason: `Recipient is on the wrong-number suppression list (since ${suppression.created_at})`,
    };
  }
  if (suppression.reason === 'manual_dnc') {
    return {
      ok: false,
      code: 'SUPPRESSED_MANUAL_DNC',
      reason: 'Recipient was manually added to the do-not-contact list by an operator',
    };
  }
  if (suppression.reason === 'non_mobile') {
    return {
      ok: false,
      code: 'SUPPRESSED_NON_MOBILE',
      reason: `Recipient's number is a landline / non-SMS-capable line (learned from a carrier delivery failure, since ${suppression.created_at})`,
    };
  }

  return {
    ok: false,
    code: 'SUPPRESSED_OTHER',
    reason: `Recipient is suppressed (reason: ${suppression.reason || 'unknown'})`,
  };
}

/**
 * Load the active suppression record (if any) for the recipient phone.
 * Augments contactState in-place.
 *
 * Schema (lands in commit 7 migration):
 *   messaging_suppression
 *     phone           text    primary key
 *     reason          text    'opt_out_keyword'|'opt_out_natural_language'|'wrong_number'|'manual_dnc'|'other'
 *     active          bool    default true
 *     source          text    e.g. 'twilio_webhook_STOP'
 *     captured_body   text    the inbound text that triggered it
 *     created_at      timestamptz
 *     cleared_at      timestamptz nullable — when START or admin clears it
 */
async function loadSuppressionState(input, contactState) {
  if (!input || !input.to) return contactState;
  try {
    // Suppression rows written by the Twilio webhook carry the canonical
    // E.164 sender value, but input.to can arrive formatted (e.g.
    // '+44 20 7946 0958' survives normalizeRecipient). Query both forms —
    // an exact-only match would miss an ACTIVE STOP while the (equally
    // canonicalized) inbound-history evidence matches, and the consent
    // validator's no-prefs exception would send to an opted-out number
    // (Codex P1 on PR #3057, 2396f5557).
    const candidates = [...new Set([input.to, toE164(input.to)].filter(Boolean))];
    const row = await db('messaging_suppression')
      .whereIn('phone', candidates)
      .where({ active: true })
      .first();
    if (row) {
      contactState.suppression = row;
    }
    // Positive-load marker: the query SUCCEEDED (row or clean no-row).
    // The consent validator's no-prefs conversational exception requires
    // this — transient errors and the missing-table state both leave it
    // unset, so unknown suppression state can never authorize that
    // exception even though legacy paths below stay fail-open.
    contactState.suppressionLoaded = true;
  } catch (err) {
    // ONLY the undefined-relation error (Postgres 42P01) means "migration
    // not yet applied" and may fail open. Matching any error that merely
    // mentions the table name (e.g. "permission denied for table
    // messaging_suppression") would skip the failure flag below and let
    // the consent validator's no-prefs exception send to a possibly
    // suppressed number (Codex P1 on 5fbf59c8b).
    if (err && (err.code === '42P01' || /relation .* does not exist/i.test(err.message || ''))) {
      // Migration not yet applied. Fail open for the legacy paths — the
      // consent validator's sms_enabled=false path still catches the most
      // common opt-out case (which the existing twilio-webhook STOP handler
      // already writes). suppressionLoaded stays unset though: in this state
      // a pre-customer STOP may exist ONLY as an inbound sms_log row
      // (recordSuppression had no table to write to), which the no-prefs
      // exception would read as positive reply evidence — so that exception
      // must treat missing-table as unknown, not clean (Codex P2 on
      // 2396f5557).
      return contactState;
    }
    logger.warn(`[messaging:suppression] lookup failed: ${err.message}`);
    // Transient failure: suppression state is UNKNOWN, not empty.
    // checkSuppression keeps failing open here (recipients with a prefs
    // row still have the sms_enabled gate), but the consent validator's
    // no-prefs conversational exception requires positively loaded
    // suppression state and turns this flag into the retryable
    // CONSENT_LOOKUP_FAILED (Codex P1 on PR #3057, 92cb96ae4).
    contactState.suppressionLookupFailed = true;
  }
  return contactState;
}

/**
 * Insert / upsert a suppression record. Called by the inbound webhook
 * the moment STOP / wrong-number is detected, before any outbound queue
 * fires. Idempotent — repeated calls just re-stamp the row.
 */
async function recordSuppression({ phone, reason, source, capturedBody, dbh = db }) {
  if (!phone) throw new Error('recordSuppression: phone is required');
  if (!reason) throw new Error('recordSuppression: reason is required');
  try {
    await dbh('messaging_suppression')
      .insert({
        phone,
        reason,
        source: source || null,
        captured_body: capturedBody ? String(capturedBody).slice(0, 1000) : null,
        active: true,
        created_at: dbh.fn.now(),
      })
      .onConflict('phone')
      .merge({
        reason,
        source: source || null,
        captured_body: capturedBody ? String(capturedBody).slice(0, 1000) : null,
        active: true,
        cleared_at: null,
      });
    return { ok: true };
  } catch (err) {
    logger.warn(`[messaging:suppression] recordSuppression failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Record a non-mobile (landline) suppression learned from a carrier delivery
 * failure, WITHOUT clobbering any pre-existing suppression record.
 *
 * Unlike recordSuppression (which upserts/merges on conflict — correct for an
 * explicit STOP/wrong-number signal), this is an automatic signal inferred from
 * a single bounce, so it must never overwrite a stronger, intentional record
 * (opt_out, wrong_number, manual_dnc) nor resurrect an admin-cleared row. We
 * therefore insert-if-absent: a conflict on the phone PK is silently ignored,
 * leaving any existing row (active or cleared, any reason) exactly as it was.
 *
 * Returns { ok, recorded } — recorded=true only when a brand-new row was written.
 */
async function recordNonMobileSuppression({ phone, source }) {
  if (!phone) throw new Error('recordNonMobileSuppression: phone is required');
  try {
    const inserted = await db('messaging_suppression')
      .insert({
        phone,
        reason: 'non_mobile',
        source: source || 'twilio_status_callback',
        active: true,
        created_at: db.fn.now(),
      })
      .onConflict('phone')
      // insert-if-absent, with ONE carve-out: a pure clearance TOMBSTONE
      // (reason='cleared' — written by clearSuppression when a START
      // arrived for a phone with no standing row) is supersedable by a
      // genuine landline verdict, or generic SMS keeps burning sends at a
      // known non-mobile number forever (codex #3495). Every other
      // existing row — active anything, or an inactive row that kept its
      // original reason (admin-cleared opt_out etc.) — stays untouched,
      // preserving the never-clobber contract above.
      .merge({
        reason: 'non_mobile',
        source: source || 'twilio_status_callback',
        active: true,
        cleared_at: null,
      })
      .where('messaging_suppression.reason', 'cleared')
      .where('messaging_suppression.active', false);
    // Knex returns the inserted rows ([] when the conflict was ignored). Treat a
    // non-empty result as "newly recorded"; fall back to length-agnostic ok.
    const recorded = Array.isArray(inserted) ? inserted.length > 0 : !!inserted;
    return { ok: true, recorded };
  } catch (err) {
    logger.warn(`[messaging:suppression] recordNonMobileSuppression failed: ${err.message}`);
    return { ok: false, recorded: false, error: err.message };
  }
}

/**
 * Clear a suppression record (e.g. on inbound START keyword).
 */
async function clearSuppression({ phone, source, dbh = db }) {
  if (!phone) throw new Error('clearSuppression: phone is required');
  try {
    // UPSERT, not update: a clearance against a phone with NO standing row
    // must still persist an inactive tombstone (codex #3495) — otherwise a
    // late provider opt-out callback arriving after this clear finds
    // neither a clearance to defer to nor a row to overwrite, and
    // re-suppresses a recipient who explicitly opted in. Inactive rows are
    // inert to every send-path read (they filter active = true).
    await dbh('messaging_suppression')
      .insert({
        phone,
        reason: 'cleared',
        source: source ? `cleared_by:${source}` : null,
        active: false,
        created_at: dbh.fn.now(),
        cleared_at: dbh.fn.now(),
      })
      .onConflict('phone')
      .merge({
        active: false,
        cleared_at: dbh.fn.now(),
        source: source ? `cleared_by:${source}` : null,
      });
    // Also drop any cached line-type so a START/admin clear fully un-blocks the
    // number. The proactive line-type guard (phone_line_types, gated) blocks
    // cached landlines on its own authority, independent of this suppression row;
    // without clearing it a false positive or a number ported landline->mobile
    // would stay blocked forever despite the clear. Next send re-evaluates fresh.
    // Best-effort: the table may not exist yet, and a cache miss is harmless.
    try {
      // Deliberately the GLOBAL connection even when dbh is a transaction:
      // this delete is best-effort and its error is swallowed — inside a
      // caller's transaction a swallowed failure would still ABORT the
      // transaction, silently rolling back the clearance above (codex
      // #3495). Outside it, a cache-delete failure costs nothing.
      await db('phone_line_types').where({ phone }).del();
    } catch (cacheErr) {
      if (!/relation .* does not exist|phone_line_types/i.test(cacheErr.message)) {
        logger.warn(`[messaging:suppression] line-type cache clear failed: ${cacheErr.message}`);
      }
    }
    return { ok: true };
  } catch (err) {
    logger.warn(`[messaging:suppression] clearSuppression failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  checkSuppression,
  loadSuppressionState,
  recordSuppression,
  recordNonMobileSuppression,
  clearSuppression,
};
