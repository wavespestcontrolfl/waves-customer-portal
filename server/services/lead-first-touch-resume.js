/**
 * Release engine for HELD first-touch email sends (2026-07-30 lane).
 *
 * The call pipeline holds BOTH first-touch emails while an email read-back
 * card is live — the new_lead drip and the newsletter double-opt-in — and
 * records the hold in the durable `first_touch_holds` ledger: what was held,
 * for which address (the post-correction value Step 6 actually withheld),
 * for which call and customer. This module settles that row from every path
 * where the question resolves:
 *
 *   - Triage Inbox resolve / call-level ACCEPT verdict → release as-held.
 *   - Operator email correction (customer-email-fanout via Customer 360 or
 *     the Intelligence Bar) → release to the CORRECTED address — works even
 *     when the review cards were already resolved earlier (e.g. by a deny
 *     verdict), because the ledger row, not the card, carries the pending
 *     state.
 *   - End-of-run reconciliation for a card resolved mid-processing.
 *
 * Consent is re-checked at release: a do-not-contact veto marks the hold
 * 'blocked' (terminal). Every transient failure keeps the row 'pending'
 * with last_error, so each failure mode stays retryable by the next release
 * trigger. The newsletter DOI cannot be rolled back, so transactional
 * callers defer it: the payload is returned for post-commit execution, and
 * released_newsletter is set only when the confirmation actually sent.
 * Never throws into a caller.
 */

const db = require('../models/db');
const logger = require('./logger');

const EMAIL_REVIEW_REASON_CODES = ['email_unverified', 'email_invalid'];
// Same permissive-but-real syntax class the fanout uses — releases are also
// triggered when an email_invalid card is resolved as-is, and enrollCustomer
// performs no syntax validation of its own.
const RESUME_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function customerCallDoNotContact(customerId, dbh) {
  const row = await dbh('call_log')
    .where({ customer_id: customerId })
    .whereRaw("ai_extraction_enriched->'consent'->>'do_not_contact_request' = 'true'")
    .first('id');
  return !!row;
}

// Canonical suppression semantics: only a suppression the automation lane
// itself would honor blocks the release — a group-scoped suppression for an
// unrelated stream (e.g. service_operational) must not bury it.
async function emailSuppressedForNewLead(email, dbh) {
  if (!(await dbh.schema.hasTable('email_suppressions'))) return false;
  const rows = await dbh('email_suppressions')
    .whereRaw('LOWER(email) = ?', [String(email).trim().toLowerCase()])
    .where({ status: 'active' });
  if (!rows.length) return false;
  const { automationSuppressionMatches } = require('./automation-runner');
  const template = await dbh('automation_templates').where({ key: 'new_lead' }).first();
  return rows.some((row) => automationSuppressionMatches(template || {}, row));
}

// Every pending hold in scope (a customer can hold from multiple calls —
// an email edit must release ALL of them, Codex #3084 r7). A 'releasing'
// claim older than the stale window belongs to a dead worker and is
// reclaimable.
const STALE_CLAIM_MS = 10 * 60 * 1000;

async function findPendingHolds({ callLogId = null, customerId = null, dbh }) {
  if (!(await dbh.schema.hasTable('first_touch_holds'))) return [];
  let q = dbh('first_touch_holds').where(function scope() {
    this.where({ status: 'pending' })
      .orWhere(function stale() {
        this.where({ status: 'releasing' })
          .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
      });
  });
  if (callLogId) q = q.where({ call_log_id: callLogId });
  else if (customerId) q = q.where({ customer_id: customerId });
  else return [];
  return q.orderBy('created_at', 'asc').select('*');
}

// Atomic claim (Codex #3084 r7): two release paths racing the same hold —
// a triage verdict against the end-of-run reconciliation — must not both
// run the DOI side effect. The winner flips pending→releasing; the loser's
// conditional update affects 0 rows and skips. Failure paths revert to
// pending (retryable); terminal paths settle released/blocked.
// Returns the claim's FENCE STAMP — the exact updated_at it wrote — or null
// when the claim lost (Codex #3084 r27): a worker suspended past the
// stale-claim window loses the row to the sweep's reclaim, and without a
// fence it would resume blind — sending a second DOI (its claim-time
// skipDedupe marker bypasses the dedupe guard) and competing on settles.
// Nothing else bumps a releasing row's updated_at while a claim is live
// (the correction retarget and the processor merge both preserve it), so a
// changed value means exactly one thing: someone reclaimed the row.
async function claimHold(hold, dbh) {
  const stamp = new Date();
  const claimed = await dbh('first_touch_holds')
    .where({ id: hold.id })
    .where(function claimable() {
      this.where({ status: 'pending' })
        .orWhere(function stale() {
          this.where({ status: 'releasing' })
            .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
        });
    })
    .update({ status: 'releasing', updated_at: stamp });
  return claimed > 0 ? stamp : null;
}

// Atomic lease RENEWAL before an irreversible side effect (Codex #3084
// r28): a read-only ownership check races the sweep — it can report owned
// immediately before the sweep's conditional reclaim lands, and both
// workers would send. The CAS bumps updated_at only while the old stamp
// still matches; success returns the NEW stamp (the caller's fence from
// here on) and, as a side effect, restarts the stale-claim window so the
// sweep cannot reclaim mid-send. Zero rows or an error = lost/unverifiable
// → null (fail-closed: worst case a skipped send the sweep retries, never
// a duplicate DOI). Requires a stamp — legacy stamp-less payloads never
// call this.
async function renewClaim(holdId, claimStamp, dbh) {
  try {
    const stamp = new Date();
    const renewed = await dbh('first_touch_holds')
      .where({ id: holdId, status: 'releasing', updated_at: new Date(claimStamp) })
      .update({ updated_at: stamp });
    return renewed > 0 ? stamp : null;
  } catch (renewErr) {
    logger.warn(`[first-touch-resume] claim lease renewal failed: ${renewErr.code || renewErr.name || 'db_error'} — treating claim as lost`);
    return null;
  }
}

// WHERE-clause fence for hold writes made under a claim (Codex #3084 r27):
// with a stamp, the write lands only while this worker still owns the row
// (status unchanged since claim, updated_at untouched) — a fenced-out
// worker's late settles and re-pends miss silently, leaving the reclaimer's
// state authoritative. Stamp-less calls are unfenced (pre-claim paths and
// legacy payloads).
function fencedHoldWrite(qb, claimStamp) {
  if (claimStamp) {
    qb.where({ status: 'releasing', updated_at: new Date(claimStamp) });
  }
  return qb;
}

// The pre-send GATE (Codex #3084 r34): the LAST hold write before an
// external send, for marked and unmarked holds alike. One CAS atomically
// (1) validates the fence — a denial or reclaim bumped updated_at, so the
// write misses; (2) refuses a denied row outright (belt: every deny write
// today bumps the stamp, so the fence alone would catch it); (3) consumes
// any force-resend marker (last_error → null), handing exactly one
// incarnation the skipDedupe ticket (r31) with no gap between the consume
// and the fence check (the r33 zero-row rule, now for every hold — the
// r31–r33 layout gated only MARKED holds, leaving ordinary holds with no
// fenced write between the lease renewal and the send, so a denial landing
// in that window still mailed the rejected address); and (4) extends the
// lease so the sweep cannot reclaim mid-send. Returns the fresh fence
// stamp, or null — the row belongs to a denier or reclaimer; walk away.
// Stamp-less legacy payloads gate unfenced (the deny guard still applies).
// Throws propagate: group callers run their gates all-or-nothing in one
// transaction and abort the whole send.
async function gateHoldForSend(holdId, claimStamp, dbh = db) {
  const stamp = new Date();
  const gated = await fencedHoldWrite(
    dbh('first_touch_holds')
      .where({ id: holdId })
      .where(function notDenied() {
        this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
      }),
    claimStamp,
  )
    .update({ last_error: null, updated_at: stamp });
  return gated > 0 ? stamp : null;
}

async function settleHold(holdId, patch, dbh, claimStamp = null) {
  // EVERY retryable settle (pending + a fallback marker) is deny-preserving
  // (Codex #3084 r22): a deny stamping after the pre-send read must not be
  // buried under ANY retry marker — the card is resolved by then, and the
  // sweep excludes only the exact deny marker. Terminal released settles
  // carry their own deny guard (settleIfTargetUnchanged); 'blocked' is a
  // stronger consent terminal and may overwrite. With a claimStamp every
  // write is fenced (Codex #3084 r27): a worker that lost its claim to the
  // sweep's reclaim writes nothing.
  if (patch.status === 'pending' && patch.last_error) {
    const updated = await fencedHoldWrite(
      dbh('first_touch_holds')
        .where({ id: holdId })
        .where(function notDenied() {
          this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
        }),
      claimStamp,
    )
      .update({ ...patch, updated_at: new Date() });
    if (!updated) {
      const { last_error, ...rest } = patch;
      await fencedHoldWrite(dbh('first_touch_holds').where({ id: holdId }), claimStamp)
        .update({ ...rest, status: 'pending', updated_at: new Date() });
    }
    return;
  }
  await fencedHoldWrite(dbh('first_touch_holds').where({ id: holdId }), claimStamp)
    .update({ ...patch, updated_at: new Date() });
}

// A claimant settles from its claim-time snapshot — work merged into the row
// DURING the claim window (Step 8 adding held_newsletter while a drip-only
// release is in flight; the r9 merge preserves the 'releasing' claim) would
// otherwise be buried under the terminal 'released'. Re-read after every
// released-settle and flip back to pending if unreleased work remains, so
// the end-of-run reconciliation (or the next trigger) picks it up
// (Codex #3084 r10).
async function repenIfWorkMergedDuringClaim(holdId, dbh) {
  const fresh = await dbh('first_touch_holds')
    .where({ id: holdId })
    .first('held_drip', 'released_drip', 'held_newsletter', 'released_newsletter', 'status');
  if (fresh && fresh.status === 'released'
      && ((fresh.held_drip && !fresh.released_drip) || (fresh.held_newsletter && !fresh.released_newsletter))) {
    // Deny-preserving (Codex #3084 r24): a deny stamping between the
    // released settle and this re-pend must not be replaced by the
    // merged-work marker — the sweep excludes only the exact deny marker
    // and would otherwise release the merged work to the rejected address.
    await repenHoldPreservingDeny(holdId, 'work_merged_during_release', dbh);
  }
}

// Failure re-pend that cannot bury a concurrently-landed deny stamp (Codex
// #3084 r19): a verdict can stamp 'email_denied_await_correction' after this
// worker claimed the row, and an unconditional recovery write would replace
// the stamp — the card is resolved by then, so the sweep (which excludes
// only the exact marker) would release the address the operator rejected.
// Two steps: write the fallback error only onto un-stamped rows; a stamped
// row re-pends with its stamp untouched.
async function repenHoldPreservingDeny(holdId, fallbackError, dbh, claimStamp = null) {
  const updated = await fencedHoldWrite(
    dbh('first_touch_holds')
      .where({ id: holdId })
      .where(function notDenied() {
        this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
      }),
    claimStamp,
  )
    .update({ status: 'pending', last_error: fallbackError, updated_at: new Date() });
  if (!updated) {
    await fencedHoldWrite(dbh('first_touch_holds').where({ id: holdId }), claimStamp)
      .update({ status: 'pending', updated_at: new Date() });
  }
}

// Terminal settles are CONDITIONAL on the target this release observed
// (Codex #3084 r19): a SECOND correction can retarget the row's held_email
// after the pre-send read, and an unconditional released-settle would bury
// the newer address with nothing left to retry. A mismatch re-pends
// 'superseded_during_send' (NOT the send-failed marker — skipDedupe must
// stay false; the correction's rotation cleared the pending subscriber's
// delivered-stamp, so the retry sends a fresh DOI to the new target).
async function settleIfTargetUnchanged(holdId, observedEmailLc, patch, dbh, claimStamp = null) {
  const settled = await fencedHoldWrite(
    dbh('first_touch_holds')
      .where({ id: holdId })
      .whereRaw("LOWER(COALESCE(held_email, '')) = ?", [observedEmailLc]),
    claimStamp,
  )
    // A deny stamping AFTER the pre-send read must survive the settle
    // (Codex #3084 r21): the claim-safe merge preserves held_email, so the
    // target CAS alone would pass and the released patch's last_error:null
    // would clear the fresh stamp. The sends already went to the
    // previously-approved target; the NEW cycle's deny keeps every future
    // release gated until a correction.
    .where(function notDenied() {
      this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
    })
    .update({ ...patch, updated_at: new Date() });
  if (!settled) {
    // The fallback re-pend carries the same fence (r27): when the settle
    // missed because the claim was RECLAIMED (not merely retargeted), the
    // reclaimer owns the row and this worker must not touch it.
    await repenHoldPreservingDeny(holdId, 'superseded_during_send', dbh, claimStamp);
  }
  return settled > 0;
}

// Delivered = the DOI confirmation actually went out, or the helper
// deliberately skipped (unsubscribed/invalid — nothing left to retry). A
// created subscriber whose confirmation SEND failed keeps the hold
// retryable (Codex #3084 r6).
function newsletterDelivered(outcome) {
  if (!outcome) return false;
  if (outcome.skipped) return true;
  return outcome.confirmationEmailSent !== false;
}

// The send-failed marker ('newsletter_doi_not_confirmed') forces an
// unconditional resend on retry (skipDedupe) — but when a correction has
// rotated the subscriber AWAY from the address THIS attempt targeted, the
// failure is obsolete: the rotated target's own callback owns delivery, and
// arming the force-resend would double-mail it (Codex #3084 r25). Verify
// the subscriber still carries the attempted address; rotated → the
// superseded marker, unverifiable → the fail-closed marker (both keep the
// dedupe guard intact on retry). Bound to the ATTEMPTED subscriber when
// its id is known (Codex #3084 r31): a DIFFERENT subscriber claiming the
// now-free address before the failure lands would otherwise satisfy an
// email-only lookup and arm the force-resend for a hold that meanwhile
// targets the rotated address — a duplicate DOI on its next release. The
// ATTEMPTED confirmation token binds too when known (Codex #3084 r32):
// corrections rotate the token, and an A→B→A rotation restores id+email
// with a NEWER token whose DOI may already be delivered — the stale
// attempt's failure must read as superseded, never as a force-resend.
async function sendFailedMarkerFor(sentEmailLc, dbh, subscriberId = null, confirmationToken = null) {
  try {
    let q = dbh('newsletter_subscribers')
      .whereRaw('LOWER(email) = ?', [String(sentEmailLc || '').trim().toLowerCase()]);
    if (subscriberId) q = q.where({ id: subscriberId });
    if (confirmationToken) q = q.where({ confirmation_token: confirmationToken });
    const sub = await q.first('id');
    return sub ? 'newsletter_doi_not_confirmed' : 'superseded_during_send';
  } catch (verifyErr) {
    logger.warn(`[first-touch-resume] send-failure target verify failed: ${verifyErr.code || verifyErr.name || 'db_error'}`);
    return 'doi_state_unverified';
  }
}

// A pending subscriber whose DOI went out within this window was already
// resumed by an earlier release — a post-send settle failure or a sibling
// hold for the same recipient must not fire the confirmation again
// (Codex #3084 r12). subscribeOrResubscribe pre-stamps confirmation_sent_at,
// but the resume path CLEARS the stamp when the actual send fails
// (subscribeNewCallCustomerToNewsletter, Codex #3084 r13) — so a present,
// recent stamp means a send that did not visibly fail, and this guard never
// buries an undelivered DOI.
const RESUME_DOI_DEDUPE_MS = 24 * 60 * 60 * 1000;

async function runNewsletterResume(payload, dbh = db, { skipDedupe = false } = {}) {
  // skipDedupe (Codex #3084 r14): a hold re-pended with
  // 'newsletter_doi_not_confirmed' means the SEND itself failed — even if
  // the pre-send confirmation_sent_at stamp survived a failed cleanup, this
  // retry must actually re-send, never trust the stamp.
  if (!skipDedupe) {
    try {
      const emailLc = String(payload.email || '').trim().toLowerCase();
      const existing = await dbh('newsletter_subscribers')
        .whereRaw('LOWER(email) = ?', [emailLc])
        .first('status', 'confirmation_sent_at');
      if (existing && String(existing.status) === 'pending' && existing.confirmation_sent_at
          && (Date.now() - new Date(existing.confirmation_sent_at).getTime()) < RESUME_DOI_DEDUPE_MS) {
        // Preserve canonical linkage even when the send is deduped (Codex
        // #3084 r14): the pending row may predate the call customer, and an
        // unlinked subscriber is invisible to the email fanout's token
        // rotation. Adopt only unlinked rows — never steal a link.
        if (payload.customerId) {
          try {
            await dbh('newsletter_subscribers')
              .whereRaw('LOWER(email) = ?', [emailLc])
              .whereNull('customer_id')
              .update({ customer_id: payload.customerId, updated_at: new Date() });
          } catch (linkErr) {
            logger.warn(`[first-touch-resume] dedupe linkage failed for customer ${payload.customerId}: ${linkErr.code || linkErr.name || 'db_error'}`);
            // Retryable, never terminal (Codex #3084 r17): releasing the
            // hold now would leave the subscriber invisible to the email
            // fanout's customer-scoped token rotation. retryReason (not the
            // send-failed marker) keeps skipDedupe FALSE on retry, so the
            // guard re-runs — re-linking without a second confirmation.
            return { confirmationEmailSent: false, retryReason: 'dedupe_linkage_failed' };
          }
        }
        return { skipped: 'confirmation_recently_sent' };
      }
    } catch (guardErr) {
      // Fail CLOSED (Codex #3084 r22): if delivery state can't be verified,
      // proceeding falls through to subscribeOrResubscribe's
      // confirmation_resent path and can double-mail a DOI that already
      // delivered (only its hold settle failed). Undelivered + retryReason
      // keeps the hold retryable and skipDedupe false — the guard re-runs
      // on the next trigger.
      logger.warn(`[first-touch-resume] DOI-dedupe guard lookup failed: ${guardErr.code || guardErr.name || 'db_error'} — not sending`);
      return { confirmationEmailSent: false, retryReason: 'doi_state_unverified' };
    }
  }
  const CRP = require('./call-recording-processor');
  if (typeof CRP.resumeNewsletterForCallCustomer !== 'function') return null;
  return CRP.resumeNewsletterForCallCustomer(payload);
}

/**
 * Release EVERY pending first-touch hold in scope — a call (triage paths)
 * or a customer (email-correction paths; one customer can hold from several
 * calls). `email` (a corrected address) overrides each ledger row's
 * held_email; the customer's STORED email is deliberately never used — for
 * a matched existing customer it can be a different, stale address than the
 * one confirmed on the call.
 */
async function resumeHeldFirstTouch({
  customerId = null,
  callLogId = null,
  email = null,
  dbh = db,
  source = 'email_review_resolved',
  deferNewsletter = false,
} = {}) {
  const result = { resumed: false, enrolled: false, newsletter: null, newsletterResume: [], skipped: null };
  // The hold currently claimed by this loop iteration — the outer catch
  // re-pends it if an error escapes mid-release, so a claimed row never
  // strands 'releasing' with its card already resolved (Codex #3084 r10).
  let inFlightHoldId = null;
  // Fence stamps for every claim this run took (Codex #3084 r27) — the
  // outer catch re-pends only rows this run still OWNS.
  const claimStamps = new Map();
  try {
    const holds = await findPendingHolds({ callLogId, customerId, dbh });
    if (!holds.length) return { ...result, newsletterResume: null, skipped: 'no_pending_hold' };

    for (const hold of holds) {
      let claimStamp = await claimHold(hold, dbh);
      if (!claimStamp) continue; // another release path owns it
      inFlightHoldId = hold.id;
      claimStamps.set(hold.id, claimStamp);

      // A deny-stamped hold means the operator resolved the card WITHOUT
      // approving the address (Codex #3084 r14) — no automated trigger
      // (end-of-run reconciliation, sweep, triage race) may release it.
      // Only an explicit correction (the `email` override) does; success
      // clears the stamp with the released-settle's last_error: null.
      if (hold.last_error === 'email_denied_await_correction' && !email) {
        await settleHold(hold.id, { status: 'pending' }, dbh, claimStamp);
        result.skipped = result.skipped || 'email_denied';
        continue;
      }

      // Live-card re-check INSIDE the claim (Codex #3084 r22): a
      // force-reprocess can mint a NEW email-review card and re-pend the
      // row with its fresh extraction between a caller's pre-claim check
      // (the sweep's query, a resolve's sibling check) and this claim —
      // the address is back under review and must not send. Only an
      // explicit operator correction (the email override) proceeds past a
      // live card. Fail-closed: an unverifiable card state never sends.
      // The plain re-pend touches no last_error (a deny stays intact).
      if (!email && hold.call_log_id) {
        let liveCard = null;
        try {
          liveCard = await dbh('triage_items')
            .where({ call_log_id: hold.call_log_id })
            .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
            .whereIn('status', ['open', 'in_progress'])
            .first('id');
        } catch (cardErr) {
          logger.warn(`[first-touch-resume] in-claim live-card re-check failed: ${cardErr.code || cardErr.name || 'db_error'} — hold stays pending`);
          liveCard = { unverified: true };
        }
        if (liveCard) {
          await settleHold(hold.id, { status: 'pending' }, dbh, claimStamp);
          result.skipped = result.skipped || 'email_review_live';
          continue;
        }
      }

      const holdCustomerId = hold.customer_id || customerId;
      if (!holdCustomerId) {
        await settleHold(hold.id, { status: 'pending', last_error: 'no_customer_linked' }, dbh, claimStamp);
        continue;
      }
      const customer = await dbh('customers')
        .where({ id: holdCustomerId })
        .first('id', 'first_name', 'last_name');
      if (!customer) {
        await settleHold(hold.id, { status: 'pending', last_error: 'customer_not_found' }, dbh, claimStamp);
        continue;
      }

      const resumeEmail = String(email || hold.held_email || '').trim().toLowerCase();
      if (!resumeEmail || !RESUME_EMAIL_RE.test(resumeEmail)) {
        // Back to pending: a later correction releases it.
        await settleHold(hold.id, { status: 'pending', last_error: 'invalid_email' }, dbh, claimStamp);
        result.skipped = result.skipped || 'invalid_email';
        continue;
      }

      if (await customerCallDoNotContact(holdCustomerId, dbh)) {
        await settleHold(hold.id, { status: 'blocked', last_error: 'do_not_contact' }, dbh, claimStamp);
        logger.info(`[first-touch-resume] customer ${holdCustomerId}: do-not-contact veto — hold blocked (${source})`);
        result.skipped = result.skipped || 'do_not_contact';
        continue;
      }
      if (await emailSuppressedForNewLead(resumeEmail, dbh)) {
        // Back to pending: a corrected address after a bounce releases it.
        await settleHold(hold.id, { status: 'pending', last_error: 'email_suppressed' }, dbh, claimStamp);
        logger.info(`[first-touch-resume] customer ${holdCustomerId}: address suppressed — hold stays pending (${source})`);
        result.skipped = result.skipped || 'email_suppressed';
        continue;
      }

      // Re-read the row immediately before any send (Codex #3084 r13):
      // a SECOND correction supersedes a claimed row's held_email, and a
      // value that CHANGED since our claim-time snapshot is newer than even
      // this release's own email param. A changed address gets its own
      // suppression re-check. The deny stamp is re-checked on the SAME
      // fresh read (Codex #3084 r15): a verdict's bulk resolve precedes its
      // stamp upsert, so a reconciliation claiming in that gap would
      // otherwise gate on a stale unstamped snapshot.
      let sendEmail = resumeEmail;
      let freshDenyStamped = false;
      // The row value this release last OBSERVED — terminal settles are
      // conditional on it still matching (Codex #3084 r19).
      let observedEmailLc = String(hold.held_email || '').trim().toLowerCase();
      try {
        const freshRow = await dbh('first_touch_holds').where({ id: hold.id })
          .first('held_email', 'last_error', 'status', 'updated_at');
        // Fence check on the SAME fresh read (Codex #3084 r27): a worker
        // suspended past the stale-claim window lost this row to the
        // sweep's reclaim — the reclaimer owns every send and settle now,
        // so this worker walks away without writing anything.
        if (!freshRow || String(freshRow.status) !== 'releasing'
            || +new Date(freshRow.updated_at) !== +claimStamp) {
          logger.info('[first-touch-resume] claim lost to a reclaim — abandoning hold untouched');
          result.skipped = result.skipped || 'claim_lost';
          continue;
        }
        freshDenyStamped = freshRow?.last_error === 'email_denied_await_correction';
        observedEmailLc = String(freshRow?.held_email || '').trim().toLowerCase();
        if (observedEmailLc && observedEmailLc !== String(hold.held_email || '').trim().toLowerCase()
            && RESUME_EMAIL_RE.test(observedEmailLc)) {
          sendEmail = observedEmailLc;
        }
      } catch (rereadErr) {
        // Can't verify the authoritative target — never send on a stale
        // guess (Codex #3084 r16): a supersede or deny stamp may have
        // landed since the claim. Back to pending; every retry path
        // re-attempts the read. Deny-preserving (r19): the read failed, so
        // a stamp that landed since the claim must not be overwritten.
        logger.warn(`[first-touch-resume] pre-send target re-read failed: ${rereadErr.code || rereadErr.name || 'db_error'} — hold stays pending`);
        await repenHoldPreservingDeny(hold.id, 'target_verify_failed', dbh, claimStamp);
        result.skipped = result.skipped || 'target_verify_failed';
        continue;
      }
      if (freshDenyStamped && !email) {
        await settleHold(hold.id, { status: 'pending' }, dbh, claimStamp); // stamp untouched
        result.skipped = result.skipped || 'email_denied';
        continue;
      }
      if (sendEmail !== resumeEmail && await emailSuppressedForNewLead(sendEmail, dbh)) {
        await settleHold(hold.id, { status: 'pending', last_error: 'email_suppressed' }, dbh, claimStamp);
        result.skipped = result.skipped || 'email_suppressed';
        continue;
      }

      const patch = {};
      // The ledger's held_email becomes the address this release actually
      // targets (Codex #3084 r10) — after a correction that's the corrected
      // value, after an as-is accept it's unchanged. A later hold-record for
      // the same call (Step 8 newsletter after a mid-run release) reads it
      // back, so the confirmed address wins over a matched customer's stale
      // stored email in BOTH release kinds.
      patch.held_email = sendEmail;
      if (hold.held_drip && !hold.released_drip) {
        // Enrollment creation and its validation are ATOMIC (Codex #3084
        // r29, replacing the r26/r28 post-enroll repair): the fresh
        // enrollment's first step is immediately due, and the scheduler
        // selects due active rows independently — a repair that runs
        // AFTER the insert commits races both the scheduler and a deny
        // stamping just behind the recheck. Inside a transaction that
        // locks the ledger row FOR UPDATE: the scheduler cannot see an
        // uncommitted enrollment, and a deny stamp / correction retarget
        // (both write this hold row) BLOCKS until commit — so validating
        // the fence, deny state, and target BEFORE enrollCustomer is
        // race-free by construction, and a failed validation creates no
        // enrollment at all. On a knex transaction handle this nests as a
        // savepoint (deferred/triage callers).
        let dripSkip = null;
        let dripStamp = null;
        try {
          await dbh.transaction(async (trx) => {
            const locked = await trx('first_touch_holds')
              .where({ id: hold.id })
              .forUpdate()
              .first('held_email', 'last_error', 'status', 'updated_at');
            if (!locked || String(locked.status) !== 'releasing'
                || +new Date(locked.updated_at) !== +claimStamp) {
              // A deny bump intentionally invalidates the lease (r28); a
              // reclaim means the sweep's release owns the row. Either
              // way: no enrollment, no writes, stamp untouched.
              dripSkip = {
                skipped: locked?.last_error === 'email_denied_await_correction'
                  ? 'email_denied' : 'claim_lost',
              };
              return;
            }
            if (String(locked.held_email || '').trim().toLowerCase() !== observedEmailLc) {
              // A correction landed between the pre-send re-read and this
              // lock — the retry releases to the newer target with every
              // check re-run (suppression included).
              dripSkip = { skipped: 'superseded_during_send', repen: true };
              return;
            }
            const AutomationRunner = require('./automation-runner');
            const enroll = await AutomationRunner.enrollCustomer({
              templateKey: 'new_lead',
              customer: {
                email: sendEmail,
                first_name: customer.first_name || null,
                last_name: customer.last_name || null,
                id: holdCustomerId,
              },
              dbh: trx,
            });
            if (!enroll?.enrolled && enroll?.enrollmentId) {
              // Already-enrolled leaves the ACTIVE enrollment's
              // denormalized email untouched, and the scheduler sends each
              // remaining step to the ROW's email (Codex #3084 r20): after
              // a superseded settle re-pends this hold, the retry must
              // retarget that active enrollment to the address THIS
              // release confirmed. CAS'd against the hold's CURRENT target
              // (r21) — under the row lock the target cannot move, so the
              // predicate is now a pure invariant check.
              await trx('automation_enrollments')
                .where({ id: enroll.enrollmentId, status: 'active' })
                .whereRaw('LOWER(email) != ?', [sendEmail])
                .whereRaw(
                  "(SELECT LOWER(COALESCE(held_email, '')) FROM first_touch_holds WHERE id = ?) = ?",
                  [hold.id, sendEmail],
                )
                .update({ email: sendEmail, updated_at: new Date() });
            }
            result.enrolled = result.enrolled || !!enroll?.enrolled;
            // The drip settlement commits WITH the enrollment (Codex #3084
            // r30): a deny landing after this transaction but before the
            // later ledger settle would see an active, immediately-due
            // enrollment whose release was never recorded — the fence
            // correctly blocks that settle, but nothing would cancel the
            // enrollment. Settling released_drip here, under the same row
            // lock, means any later deny arrives strictly AFTER a durably
            // recorded release (the accepted too-late semantics; the
            // correction's enrollment sweep retargets remaining steps).
            // The write doubles as a lease renewal: the fresh stamp is
            // this worker's fence from here on, and it restarts the
            // stale-claim window.
            dripStamp = new Date();
            await trx('first_touch_holds')
              .where({ id: hold.id })
              .update({ released_drip: true, held_email: sendEmail, updated_at: dripStamp });
          });
          if (dripSkip) {
            if (dripSkip.repen) {
              await repenHoldPreservingDeny(hold.id, 'superseded_during_send', dbh, claimStamp);
            } else {
              logger.info(`[first-touch-resume] enroll skipped (${dripSkip.skipped}) — hold left to its owner`);
            }
            result.skipped = result.skipped || dripSkip.skipped;
            continue;
          }
          if (dripStamp) {
            claimStamp = dripStamp;
            claimStamps.set(hold.id, dripStamp);
          }
          patch.released_drip = true;
        } catch (enrollErr) {
          // Back to pending — the ledger row IS the retryable release.
          // Sanitized code only, in the log AND the ledger: an enrollment
          // unique-violation can echo the denormalized email.
          const enrollCode = enrollErr.code || enrollErr.name || 'enroll_failed';
          await settleHold(hold.id, { status: 'pending', last_error: `enroll_failed: ${enrollCode}` }, dbh, claimStamp);
          logger.warn(`[first-touch-resume] enroll failed for customer ${holdCustomerId} — hold stays pending: ${enrollCode}`);
          result.skipped = result.skipped || 'enroll_failed';
          continue;
        }
      }

      let newsletterSettled = !hold.held_newsletter || hold.released_newsletter;
      let deferredThisHold = false;
      let deferredPayload = null;
      if (hold.held_newsletter && !hold.released_newsletter) {
        if (deferNewsletter) {
          // Transactional caller: DOI executes post-commit via
          // resumeHeldNewsletterPostCommit, which settles the row itself.
          // The claim stays 'releasing' until then (stale-claim window
          // reclaims it if the process dies before commit).
          deferredPayload = {
            holdId: hold.id,
            customerId: holdCustomerId,
            email: sendEmail,
            firstName: customer.first_name || null,
            lastName: customer.last_name || null,
            // The claim's fence stamp rides the payload (Codex #3084 r27)
            // so the post-commit callback can prove it still owns the row
            // before sending or settling. The bookkeeping settle below can
            // renew this stamp in place (r32).
            claimStamp,
          };
          result.newsletterResume.push(deferredPayload);
          deferredThisHold = true;
        } else {
          // Direct (non-deferred) path: a thrown resume must not escape to
          // the outer catch with the hold still claimed — treat it as
          // undelivered (re-pends below) and log only a sanitized code (a
          // unique-violation message can echo the subscriber email),
          // Codex #3084 r10.
          // Pre-send GATE (Codex #3084 r34, superseding the r27/r28
          // renewal + r31–r33 consume pair): the enroll above can be
          // slow, so ONE CAS immediately before the DOI validates the
          // fence, refuses a denial, consumes any force-resend marker,
          // and extends the lease — for marked and unmarked holds alike
          // (the r33 layout left ordinary holds with no fenced write
          // between the renewal and the send, so a denial landing in
          // that gap still mailed the rejected address). A gate that
          // misses walks away without writes: the row belongs to its
          // denier or reclaimer, and the drip work already done is
          // recorded (the enroll is idempotent by template+customer).
          let skipDedupe = false;
          try {
            const gateStamp = await gateHoldForSend(hold.id, claimStamp, dbh);
            if (!gateStamp) {
              logger.info('[first-touch-resume] pre-send gate refused (deny/reclaim) — abandoning hold untouched');
              result.skipped = result.skipped || 'claim_lost';
              continue;
            }
            claimStamp = gateStamp;
            claimStamps.set(hold.id, gateStamp);
            // The gate consumed atomically; the claim snapshot says
            // whether a marker was there to consume — that incarnation
            // holds the skipDedupe ticket (r31). A send failure re-arms
            // it via sendFailedMarkerFor below.
            skipDedupe = hold.last_error === 'newsletter_doi_not_confirmed';
          } catch (gateErr) {
            // ABORT, never degrade to the dedupe guard (Codex #3084
            // r32): an unverifiable gate may have left the marker armed,
            // and a prior failed send's surviving confirmation_sent_at
            // stamp would make the guard settle a hold whose DOI never
            // delivered. The plain fenced re-pend keeps last_error
            // untouched, so the marker survives for the retry.
            logger.warn(`[first-touch-resume] pre-send gate failed: ${gateErr.code || gateErr.name || 'db_error'} — hold stays pending, marker intact`);
            await fencedHoldWrite(dbh('first_touch_holds').where({ id: hold.id }), claimStamp)
              .update({ status: 'pending', updated_at: new Date() });
            result.skipped = result.skipped || 'doi_state_unverified';
            continue;
          }
          let outcome = null;
          try {
            outcome = await runNewsletterResume({
              customerId: holdCustomerId,
              email: sendEmail,
              firstName: customer.first_name || null,
              lastName: customer.last_name || null,
            }, dbh, { skipDedupe });
          } catch (newsletterErr) {
            logger.warn(`[first-touch-resume] newsletter resume failed for customer ${holdCustomerId}: ${newsletterErr.code || newsletterErr.name || 'resume_failed'}`);
          }
          result.newsletter = outcome;
          if (newsletterDelivered(outcome)) {
            patch.released_newsletter = true;
            newsletterSettled = true;
          } else {
            patch.status = 'pending';
            // retryReason (e.g. dedupe_linkage_failed) is deliberately NOT
            // the send-failed marker — it must not trigger skipDedupe.
            // Bound to the attempted subscriber when known (r31).
            patch.last_error = outcome?.retryReason
              || await sendFailedMarkerFor(sendEmail, dbh, outcome?.subscriberId || null, outcome?.confirmationToken || null);
          }
        }
      }

      const dripSettled = !hold.held_drip || hold.released_drip || patch.released_drip;
      if (dripSettled && newsletterSettled && !deferredThisHold) {
        patch.status = 'released';
        patch.released_at = new Date();
        patch.last_error = null;
      } else if (!deferredThisHold && !patch.status) {
        patch.status = 'pending';
      }
      if (patch.status === 'released') {
        // Terminal settle only if no concurrent correction retargeted the
        // row since our pre-send read (Codex #3084 r19) AND this worker
        // still owns the claim (r27).
        const settled = await settleIfTargetUnchanged(hold.id, observedEmailLc, patch, dbh, claimStamp);
        if (settled) await repenIfWorkMergedDuringClaim(hold.id, dbh);
      } else if (Object.keys(patch).length) {
        // Retryable settles CAS the target too (Codex #3084 r23): a
        // correction retargeting the claimed row mid-attempt owns
        // held_email — writing the observed address back would point the
        // sweep's retry at the superseded (possibly hard-bounced) value.
        // On a mismatch (or a mid-attempt deny), everything EXCEPT
        // held_email still settles via the deny-preserving path. Fenced
        // (r27): a reclaimed row belongs to the reclaimer.
        const settleStamp = new Date();
        const settled = await fencedHoldWrite(
          dbh('first_touch_holds')
            .where({ id: hold.id })
            .whereRaw("LOWER(COALESCE(held_email, '')) = ?", [observedEmailLc]),
          claimStamp,
        )
          .where(function notDenied() {
            this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
          })
          .update({ ...patch, updated_at: settleStamp });
        if (!settled) {
          const { held_email, ...rest } = patch;
          await settleHold(hold.id, { ...rest, status: 'pending' }, dbh, claimStamp);
        } else if (deferredThisHold && deferredPayload) {
          // The bookkeeping settle's updated_at IS the claim's new lease
          // stamp (Codex #3084 r32): the deferred payload captured the
          // pre-settle stamp, and without this renewal the post-commit
          // callback's renewClaim would read every deferred DOI as
          // claim-lost — parking the corrected send behind the full
          // stale-claim window plus the next sweep.
          deferredPayload.claimStamp = settleStamp;
          claimStamps.set(hold.id, settleStamp);
        }
      }

      result.resumed = result.resumed || result.enrolled
        || newsletterDelivered(result.newsletter) || deferredThisHold;
    }

    if (!result.newsletterResume.length) result.newsletterResume = null;
    if (result.resumed) {
      logger.info(`[first-touch-resume] released first-touch hold(s) (${source}; enrolled=${result.enrolled})`);
    }
    return result;
  } catch (err) {
    // Sanitized code only — subscriber/enrollment errors can echo the email.
    const code = err.code || err.name || 'error';
    logger.warn(`[first-touch-resume] failed (${source}): ${code}`);
    // Restore every claim this run still owns to a retryable state: the
    // in-flight hold AND any earlier deferred claims whose post-commit
    // payloads are being discarded with this error return (Codex #3084
    // r11 — their rows would otherwise sit 'releasing' with no payload
    // left to execute). Guarded on status='releasing' so a hold this loop
    // already settled (pending / blocked / released) is never flipped —
    // 'blocked' is a consent terminal and must stay that way.
    const strandedIds = new Set([
      ...(inFlightHoldId ? [inFlightHoldId] : []),
      ...(Array.isArray(result.newsletterResume)
        ? result.newsletterResume.map((p) => p?.holdId).filter(Boolean)
        : []),
    ]);
    for (const strandedId of strandedIds) {
      try {
        // Deny-preserving (Codex #3084 r19): this is an unknown-state error
        // path — a stamp that landed since the claim must not be buried
        // under the resume_failed marker. Fenced (r27): a row this run no
        // longer owns (the sweep reclaimed it) is the reclaimer's to settle.
        const fence = claimStamps.get(strandedId) || null;
        const repenned = await fencedHoldWrite(
          dbh('first_touch_holds')
            .where({ id: strandedId, status: 'releasing' })
            .where(function notDenied() {
              this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
            }),
          fence,
        )
          .update({ status: 'pending', last_error: `resume_failed: ${code}`, updated_at: new Date() });
        if (!repenned) {
          await fencedHoldWrite(
            dbh('first_touch_holds').where({ id: strandedId, status: 'releasing' }),
            fence,
          )
            .update({ status: 'pending', updated_at: new Date() });
        }
      } catch (repenErr) {
        logger.warn(`[first-touch-resume] hold ${strandedId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
      }
    }
    return { ...result, newsletterResume: null, skipped: 'error' };
  }
}

// Post-commit companion for transactional callers (same contract as the
// fanout's resendPendingConfirmation): execute the deferred newsletter DOI
// after the edit commits, then settle the ledger. Payloads are COALESCED by
// recipient (Codex #3084 r12) — multiple holds for the same customer+email
// are one subscription question, and per-payload execution would send
// confirmation_sent then confirmation_resent to the same inbox. Never
// throws.
async function resumeHeldNewsletterPostCommit(payloadOrList, dbh = db) {
  if (!payloadOrList) return null;
  const list = (Array.isArray(payloadOrList) ? payloadOrList : [payloadOrList]).filter(Boolean);
  if (!list.length) return Array.isArray(payloadOrList) ? [] : null;
  const groups = new Map();
  for (const p of list) {
    const key = `${p.customerId}|${String(p.email || '').trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { payload: p, holdIds: [], claims: new Map() });
    if (p.holdId) {
      groups.get(key).holdIds.push(p.holdId);
      // Per-hold fence stamps (Codex #3084 r27); stamp-less legacy
      // payloads stay unfenced.
      if (p.claimStamp) groups.get(key).claims.set(p.holdId, p.claimStamp);
    }
  }
  const outcomes = [];
  for (const { payload, holdIds, claims } of groups.values()) {
    outcomes.push(await runOnePostCommitResume(payload, holdIds, dbh, claims));
  }
  return Array.isArray(payloadOrList) ? outcomes : outcomes[0];
}

async function runOnePostCommitResume(payload, holdIds, dbh, claims = new Map()) {
  const fenceOf = (holdId) => claims.get(holdId) || null;
  try {
    // Re-read the freshest target before sending (Codex #3084 r13): a
    // second correction may have superseded held_email after this payload
    // was built inside the first correction's transaction.
    let sendPayload = payload;
    if (payload.holdId) {
      try {
        const fresh = await dbh('first_touch_holds').where({ id: payload.holdId }).first('held_email', 'last_error');
        const freshEmail = String(fresh?.held_email || '').trim().toLowerCase();
        if (freshEmail && freshEmail !== String(payload.email || '').trim().toLowerCase()
            && RESUME_EMAIL_RE.test(freshEmail)) {
          sendPayload = { ...payload, email: freshEmail };
        }
      } catch (rereadErr) {
        // Can't verify the authoritative target — never send on a stale
        // guess (Codex #3084 r16). Re-pend every associated hold; the
        // sweep (or a later trigger) retries with a fresh read.
        logger.warn(`[first-touch-resume] post-commit target re-read failed: ${rereadErr.code || rereadErr.name || 'db_error'} — hold(s) stay pending`);
        for (const holdId of holdIds) {
          try {
            // Deny-preserving (r19): the read failed, so a stamp that
            // landed since the claim must not be overwritten. Fenced (r27).
            await repenHoldPreservingDeny(holdId, 'target_verify_failed', dbh, fenceOf(holdId));
          } catch (repenErr) {
            logger.warn(`[first-touch-resume] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
          }
        }
        return { skipped: 'target_verify_failed' };
      }
    }
    // The resend marker is honored from EVERY coalesced hold (Codex #3084
    // r23): one grouped hold's failed send — with a surviving pre-send
    // delivered-stamp — must force the actual resend for the whole group,
    // not only when it happens to be the group's first payload.
    // Fail-closed: an unverifiable marker state re-pends instead of
    // trusting the stamp.
    let holdWasDoiUnconfirmed = false;
    let markedHoldIds = [];
    if (holdIds.length) {
      try {
        // Deny veto BEFORE the send, not only in the settle (Codex #3084
        // r25): a force-reprocess verdict can stamp a still-releasing hold
        // between the correction's defer and this callback with the target
        // unchanged — the conditional settlement would preserve the stamp
        // only AFTER the prohibited DOI went out. Any grouped hold's deny
        // vetoes the group's send; the plain re-pend touches no last_error.
        const denyRow = await dbh('first_touch_holds')
          .whereIn('id', holdIds)
          .where({ last_error: 'email_denied_await_correction' })
          .first('id');
        if (denyRow) {
          for (const holdId of holdIds) {
            await fencedHoldWrite(dbh('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
              .update({ status: 'pending', updated_at: new Date() });
          }
          logger.info('[first-touch-resume] post-commit deny veto — hold(s) stay pending');
          return { skipped: 'email_denied' };
        }
        const markerRows = await dbh('first_touch_holds')
          .whereIn('id', holdIds)
          .where({ last_error: 'newsletter_doi_not_confirmed' })
          .select('id');
        markedHoldIds = markerRows.map((r) => r.id);
        holdWasDoiUnconfirmed = markedHoldIds.length > 0;
      } catch (markerErr) {
        logger.warn(`[first-touch-resume] resend-marker lookup failed: ${markerErr.code || markerErr.name || 'db_error'} — hold(s) stay pending`);
        for (const holdId of holdIds) {
          try {
            await repenHoldPreservingDeny(holdId, 'target_verify_failed', dbh, fenceOf(holdId));
          } catch (repenErr) {
            logger.warn(`[first-touch-resume] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
          }
        }
        return { skipped: 'target_verify_failed' };
      }
    }
    // BOTH outbound vetoes re-run at send time, unconditionally (Codex
    // #3084 r18; supersede-only suppression check since r14): this callback
    // fires after the correction transaction committed, and a do-not-contact
    // request or a bounce suppression landing in that gap is invisible to
    // the in-transaction check. Do-not-contact is the consent terminal
    // (blocked, matching the direct path); a suppressed address goes back
    // to pending for a later correction. A veto lookup that THROWS falls
    // through to the outer catch, which re-pends every hold (retryable).
    if (payload.customerId && await customerCallDoNotContact(payload.customerId, dbh)) {
      for (const holdId of holdIds) {
        await fencedHoldWrite(dbh('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
          .update({ status: 'blocked', last_error: 'do_not_contact', updated_at: new Date() });
      }
      logger.info(`[first-touch-resume] customer ${payload.customerId}: post-commit do-not-contact veto — hold(s) blocked`);
      return { skipped: 'do_not_contact' };
    }
    if (await emailSuppressedForNewLead(sendPayload.email, dbh)) {
      for (const holdId of holdIds) {
        await repenHoldPreservingDeny(holdId, 'email_suppressed', dbh, fenceOf(holdId));
      }
      logger.info('[first-touch-resume] post-commit target suppressed — hold(s) stay pending');
      return { skipped: 'email_suppressed' };
    }
    // Pre-send GATE for the whole group (Codex #3084 r34, superseding the
    // r27/r28 renewal loop and the r31–r33 marker consume): one fenced CAS
    // per hold — validate the fence, refuse a denial, consume any marker,
    // extend the lease — run ALL-OR-NOTHING in one transaction as the last
    // hold write before the send. The r33 layout gated only MARKED holds,
    // so a denial landing after the renewal on an ordinary hold still
    // mailed the rejected address. The send is shared across the WHOLE
    // group, so ONE refused sibling aborts it (r28): its denier or
    // reclaimer owns the send. The rollback restores every marker already
    // consumed (r33), and the plain fenced re-pends keep last_error
    // untouched — markers and deny stamps survive for the retry (the old
    // renewal-abort's deny-preserving re-pend could bury a sibling's
    // force-resend marker under 'claim_lost'; plain re-pends cannot).
    // Legacy stamp-less payloads gate unfenced (deny guard only).
    let skipDedupe = false;
    if (holdIds.length) {
      try {
        const gatedStamps = new Map();
        await dbh.transaction(async (trx) => {
          for (const holdId of holdIds) {
            const gated = await gateHoldForSend(holdId, fenceOf(holdId), trx);
            if (!gated) {
              const lost = new Error(`pre-send gate refused for hold ${holdId}`);
              lost.code = 'send_gate_lost';
              throw lost;
            }
            gatedStamps.set(holdId, gated);
          }
        });
        // Fresh stamps only after the commit — an abort rolls the DB back
        // to the OLD stamps, and the re-pends below must fence on those.
        for (const [holdId, stamp] of gatedStamps) claims.set(holdId, stamp);
        skipDedupe = holdWasDoiUnconfirmed;
      } catch (gateErr) {
        const lostToOwner = gateErr.code === 'send_gate_lost';
        logger.warn(`[first-touch-resume] post-commit pre-send gate ${lostToOwner ? 'refused' : 'failed'}: ${gateErr.code || gateErr.name || 'db_error'} — aborting the group send, markers intact`);
        for (const holdId of holdIds) {
          try {
            await fencedHoldWrite(dbh('first_touch_holds').where({ id: holdId }), fenceOf(holdId))
              .update({ status: 'pending', updated_at: new Date() });
          } catch (repenErr) {
            logger.warn(`[first-touch-resume] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
          }
        }
        return { skipped: lostToOwner ? 'claim_lost' : 'doi_state_unverified' };
      }
    }
    const outcome = await runNewsletterResume(sendPayload, dbh, { skipDedupe });
    const sentEmailLc = String(sendPayload.email || '').trim().toLowerCase();
    for (const holdId of holdIds) {
      if (newsletterDelivered(outcome)) {
        const hold = await dbh('first_touch_holds').where({ id: holdId }).first('held_drip', 'released_drip');
        const dripSettled = !hold || !hold.held_drip || hold.released_drip;
        // Conditional on the target still matching what this callback sent
        // (Codex #3084 r19): correction B can retarget the releasing row
        // after our re-read, and settling would bury B's address with no
        // retry trigger left. Fenced (r27).
        const settled = await settleIfTargetUnchanged(holdId, sentEmailLc, {
          released_newsletter: true,
          status: dripSettled ? 'released' : 'pending',
          ...(dripSettled ? { released_at: new Date(), last_error: null } : {}),
        }, dbh, fenceOf(holdId));
        if (settled && dripSettled) await repenIfWorkMergedDuringClaim(holdId, dbh);
      } else {
        // Back to pending — the DOI never confirmed; the next release
        // trigger (or the ledger sweep) retries it. retryReason outcomes
        // (e.g. dedupe_linkage_failed) keep skipDedupe FALSE on retry.
        // Deny-preserving (r22); the force-resend marker only when the
        // subscriber still carries the attempted address (r25), bound to
        // the attempted subscriber id when known (r31).
        await repenHoldPreservingDeny(holdId, outcome?.retryReason
          || await sendFailedMarkerFor(sentEmailLc, dbh, outcome?.subscriberId || null, outcome?.confirmationToken || null), dbh, fenceOf(holdId));
      }
    }
    return outcome;
  } catch (err) {
    // Sanitized code only — a unique-violation message can echo the
    // subscriber email, and this path exists BECAUSE an address is being
    // corrected; it must not leak into logs (or the ledger).
    const code = err.code || err.name || 'resume_failed';
    logger.warn(`[first-touch-resume] post-commit newsletter resume failed for customer ${payload.customerId}: ${code}`);
    // Restore a retryable state. A failure AFTER a successful send (the
    // settle threw) cannot double-fire on retry: runNewsletterResume's
    // confirmation_sent_at dedupe guard skips the resend and just settles.
    for (const holdId of holdIds) {
      try {
        // Deny-preserving (r22): a stamp landing mid-callback survives.
        // Fenced (r27): rows lost to a reclaim stay the reclaimer's.
        await repenHoldPreservingDeny(holdId, `newsletter_resume_failed: ${code}`, dbh, fenceOf(holdId));
      } catch (repenErr) {
        logger.warn(`[first-touch-resume] hold ${holdId} re-pend failed: ${repenErr.code || repenErr.name || 'db_error'} (stale-claim window will reclaim)`);
      }
    }
    return null;
  }
}

/**
 * Record (or re-pend) the hold — called by the processor at hold time with
 * the address it ACTUALLY withheld (post dictation-decoder / arbiter /
 * domain-correction, which can differ from the persisted extraction).
 * Idempotent per call; a force-reprocess refreshes the row to pending with
 * the fresh address, and held flags accumulate (drip and newsletter holds
 * are recorded at different steps of the same run).
 *
 * Two force-reprocess/race guards when `runStartedAt` is passed:
 *   - A LIVE card minted by an earlier run means the operator is still
 *     reviewing the PREVIOUS address (triage inserts keep the old card via
 *     onConflict-ignore) — resolving that card must release the address it
 *     shows, so the existing held_email is preserved over the fresh guess.
 *   - A row RELEASED during this run means an operator settled the question
 *     mid-run (email correction / accept verdict) — that action's address is
 *     authoritative, so the new hold re-pends against the customer's stored
 *     address (which the correction fanout just wrote), never the stale
 *     in-memory candidate captured before it.
 *
 * The write retries transient failures — this row is the ONLY durable record
 * the release paths read, so processing must not finish without it.
 */
const HOLD_RECORD_ATTEMPTS = 3;

async function recordFirstTouchHold({ callLogId, customerId = null, heldEmail, heldDrip = false, heldNewsletter = false, runStartedAt = null, dbh = db }) {
  for (let attempt = 1; attempt <= HOLD_RECORD_ATTEMPTS; attempt++) {
    try {
      if (!(await dbh.schema.hasTable('first_touch_holds'))) return null;
      const now = new Date();
      let emailToRecord = String(heldEmail || '').trim().toLowerCase();
      if (runStartedAt) {
        const existing = await dbh('first_touch_holds')
          .where({ call_log_id: callLogId })
          .first('held_email', 'status', 'released_at');
        if (existing && existing.released_at && new Date(existing.released_at) >= runStartedAt) {
          // The row's held_email IS the address the mid-run release actually
          // confirmed and sent to (the release stamps it — corrected value
          // after a correction, unchanged after an as-is accept; fanout
          // markers carry the corrected value). NEVER the customer's stored
          // email: for a matched existing customer that can be a stale
          // address the operator did not confirm (Codex #3084 r10).
          // Keyed on released_at alone, NOT status (Codex #3084 r19): when
          // Step 6 adopts a during-run fanout marker it re-pends the row,
          // and Step 8's later call must keep adopting that operator-
          // asserted address — not overwrite it with the stale in-memory
          // newsletter candidate captured before the correction.
          const settledEmail = String(existing.held_email || '').trim().toLowerCase();
          if (settledEmail) {
            emailToRecord = settledEmail;
          } else if (customerId) {
            const cust = await dbh('customers').where({ id: customerId }).first('email');
            const storedEmail = String(cust?.email || '').trim().toLowerCase();
            if (storedEmail) emailToRecord = storedEmail;
          }
        } else if (existing && existing.held_email) {
          const cardFromEarlierRun = await dbh('triage_items')
            .where({ call_log_id: callLogId })
            .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
            .whereIn('status', ['open', 'in_progress'])
            .where('created_at', '<', runStartedAt)
            .first('id');
          if (cardFromEarlierRun) {
            emailToRecord = String(existing.held_email).trim().toLowerCase();
          }
        }
      }
      await dbh('first_touch_holds')
        .insert({
          call_log_id: callLogId,
          customer_id: customerId,
          held_email: emailToRecord,
          held_drip: heldDrip,
          held_newsletter: heldNewsletter,
          status: 'pending',
          created_at: now,
          updated_at: now,
        })
        .onConflict('call_log_id')
        .merge({
          customer_id: customerId,
          // An ACTIVE claim's target changes ONLY via operator retargets
          // (the correction fanout) — a processor merge overwriting it
          // would make the claimant's pre-send fresh read adopt a
          // force-reprocess's unconfirmed guess as if it were a correction
          // and send to it without read-back (Codex #3084 r20). Rows
          // RELEASED during this run keep their address atomically too
          // (Codex #3084 r30): the pre-merge `existing` read adopts a
          // released-during-run target, but a correction can commit in the
          // read→merge gap — the CASE inspects the CURRENT row, so the
          // operator-confirmed value survives no matter when the
          // correction lands.
          held_email: runStartedAt
            ? dbh.raw(
              "CASE WHEN first_touch_holds.status = 'releasing' THEN first_touch_holds.held_email"
              + " WHEN first_touch_holds.released_at IS NOT NULL AND first_touch_holds.released_at >= ?"
              + " AND COALESCE(first_touch_holds.held_email, '') <> '' THEN first_touch_holds.held_email"
              + ' ELSE ? END',
              [runStartedAt, emailToRecord],
            )
            : dbh.raw(
              "CASE WHEN first_touch_holds.status = 'releasing' THEN first_touch_holds.held_email ELSE ? END",
              [emailToRecord],
            ),
          held_drip: dbh.raw('first_touch_holds.held_drip OR excluded.held_drip'),
          held_newsletter: dbh.raw('first_touch_holds.held_newsletter OR excluded.held_newsletter'),
          // Never demote an ACTIVE 'releasing' claim back to 'pending' — a
          // triage accept or correction may be mid-release on this row, and
          // re-pending it would let a second release path claim it and send
          // a duplicate DOI. 'blocked' is the do-not-contact CONSENT
          // terminal (Codex #3084 r19): a force-reprocess whose fresh
          // extraction omits the earlier request must not resurrect the
          // hold into a releasable state. Released/pending re-pend as
          // before.
          status: dbh.raw("CASE WHEN first_touch_holds.status IN ('releasing', 'blocked') THEN first_touch_holds.status ELSE 'pending' END"),
          // A live claim's updated_at IS its fence stamp (Codex #3084 r27)
          // — bumping it here would fence out the owning worker mid-release
          // AND extend a dead claimant's stale-claim window (the r12
          // rationale). Releasing rows keep their stamp; everything else
          // records the merge time as before.
          updated_at: dbh.raw(
            "CASE WHEN first_touch_holds.status = 'releasing' THEN first_touch_holds.updated_at ELSE excluded.updated_at END",
          ),
        });
      return true;
    } catch (err) {
      if (attempt === HOLD_RECORD_ATTEMPTS) {
        logger.error(`[first-touch-resume] hold record failed for call ${callLogId} after ${HOLD_RECORD_ATTEMPTS} attempts: ${err.message}`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
    }
  }
  return null;
}

/**
 * Scheduled sweep for abandoned ledger rows (Codex #3084 r12): a deferred
 * post-commit DOI dies with its worker, and a transiently failed release
 * leaves a pending row after its card resolved — with no later
 * edit/triage/run trigger, nothing would ever retry them. Eligible rows are
 * pending (or stale-releasing) holds whose email question is ANSWERED: at
 * least one RESOLVED email-review card on the call and none still live.
 * Unreviewed holds — a live card, or no card at all (e.g. the card insert
 * failed) — are never auto-released; they stay held until an operator acts.
 * Consent, suppression, and the DOI dedupe guard all re-check inside
 * resumeHeldFirstTouch.
 */
async function sweepAbandonedFirstTouchHolds({ dbh = db, limit = 10 } = {}) {
  const swept = { examined: 0, released: 0 };
  try {
    if (!(await dbh.schema.hasTable('first_touch_holds'))) return swept;
    // Recovery pre-pass (Codex #3084 r29): a transient failure in the
    // merged-work re-pend can strand a row 'released' with unreleased held
    // work — the outer recovery is fenced on status='releasing' and the
    // main sweep below only looks at pending/stale-releasing rows, so
    // nothing else would ever retry it. The CAS matches exactly that
    // inconsistent state (a correctly released row always has its released
    // flags covering its held flags) and re-pends into the normal sweep
    // flow. Deny-STAMPED inconsistent rows re-pend too, KEEPING the stamp
    // (Codex #3084 r30): the correction fanout only retargets pending and
    // releasing rows, so a deny left on a released row could never be
    // lifted — parked as pending-with-stamp, the sweep keeps excluding it
    // while the correction path can finally clear it.
    try {
      await dbh('first_touch_holds')
        .where({ status: 'released' })
        .whereRaw('((held_drip AND NOT released_drip) OR (held_newsletter AND NOT released_newsletter))')
        .update({
          status: 'pending',
          last_error: dbh.raw(
            "CASE WHEN last_error = 'email_denied_await_correction' THEN last_error ELSE 'work_merged_during_release' END",
          ),
          updated_at: new Date(),
        });
    } catch (recoverErr) {
      logger.warn(`[first-touch-resume] merged-work recovery pass failed: ${recoverErr.code || recoverErr.name || 'db_error'} — next sweep retries`);
    }
    // Eligibility filters live IN the query (Codex #3084 r13): a limit
    // applied before filtering would let ten old ineligible rows (live
    // cards, never reviewed) permanently shadow eligible ones behind them.
    // A deny that resolved the card WITHOUT approving the address stamps
    // 'email_denied_await_correction' — those wait for the correction
    // fanout, never the sweep.
    const candidates = await dbh('first_touch_holds')
      .where(function scope() {
        this.where({ status: 'pending' })
          .orWhere(function stale() {
            this.where({ status: 'releasing' })
              .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
          });
      })
      .whereNotNull('call_log_id')
      .where(function notDenied() {
        this.whereNull('last_error').orWhereNot('last_error', 'email_denied_await_correction');
      })
      // Address-less rows (email demoted at intake, deny stamps) can only
      // release via a correction — sweeping them would just churn through
      // the invalid-address guard every pass.
      .whereNot('held_email', '')
      // The LATEST review cycle must be the one that resolved — evaluated
      // IN the query (Codex #3084 r17), because a post-limit filter would
      // let ten old dismissed-cycle rows permanently shadow eligible holds
      // behind them. Also implies at least one resolved card exists.
      .whereRaw(`(
        SELECT t.status FROM triage_items t
        WHERE t.call_log_id = first_touch_holds.call_log_id
          AND t.reason_code IN ('email_unverified', 'email_invalid')
        ORDER BY t.created_at DESC
        LIMIT 1
      ) = 'resolved'`)
      .whereNotExists(function stillLive() {
        this.select(1).from('triage_items')
          .whereRaw('triage_items.call_log_id = first_touch_holds.call_log_id')
          .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
          .whereIn('status', ['open', 'in_progress']);
      })
      .orderBy('updated_at', 'asc')
      .limit(limit)
      .select('id', 'call_log_id');
    for (const row of candidates) {
      swept.examined += 1;
      // Re-checked per row (belt over the query filters — a card can change
      // between the select and this release).
      const live = await dbh('triage_items')
        .where({ call_log_id: row.call_log_id })
        .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
        .whereIn('status', ['open', 'in_progress'])
        .first('id');
      if (live) continue; // still under review — the hold stands
      // The LATEST review cycle must be the one that resolved (Codex #3084
      // r16): a force-reprocess can leave an old resolved card next to a
      // newer DISMISSED one — dismissal is "not actionable", never a
      // confirmation, and the historical resolution must not release the
      // newer unconfirmed address.
      const latest = await dbh('triage_items')
        .where({ call_log_id: row.call_log_id })
        .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
        .orderBy('created_at', 'desc')
        .first('status');
      if (!latest || latest.status !== 'resolved') continue;
      const res = await resumeHeldFirstTouch({ callLogId: row.call_log_id, source: 'ledger_sweep' });
      if (res?.resumed) swept.released += 1;
    }
    if (swept.released) {
      logger.info(`[first-touch-resume] ledger sweep released ${swept.released} abandoned hold(s)`);
    }
  } catch (err) {
    logger.warn(`[first-touch-resume] ledger sweep failed: ${err.code || err.name || 'error'}`);
  }
  return swept;
}

module.exports = {
  resumeHeldFirstTouch,
  resumeHeldNewsletterPostCommit,
  recordFirstTouchHold,
  sweepAbandonedFirstTouchHolds,
  EMAIL_REVIEW_REASON_CODES,
  // Shared with the correction fanout's DOI re-send path (Codex #3084 r19)
  // so its settles and vetoes stay on the canonical semantics.
  repenIfWorkMergedDuringClaim,
  customerCallDoNotContact,
  emailSuppressedForNewLead,
  sendFailedMarkerFor,
  // Claim-fence primitives (Codex #3084 r27, CAS renewal since r28) — the
  // fanout's coalesced resend holds claims too and must honor the same
  // lease.
  renewClaim,
  fencedHoldWrite,
  gateHoldForSend,
};
