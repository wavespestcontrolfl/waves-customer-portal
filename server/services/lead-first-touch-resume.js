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
async function claimHold(hold, dbh) {
  const claimed = await dbh('first_touch_holds')
    .where({ id: hold.id })
    .where(function claimable() {
      this.where({ status: 'pending' })
        .orWhere(function stale() {
          this.where({ status: 'releasing' })
            .where('updated_at', '<', new Date(Date.now() - STALE_CLAIM_MS));
        });
    })
    .update({ status: 'releasing', updated_at: new Date() });
  return claimed > 0;
}

async function settleHold(holdId, patch, dbh) {
  await dbh('first_touch_holds').where({ id: holdId }).update({ ...patch, updated_at: new Date() });
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
    await dbh('first_touch_holds').where({ id: holdId })
      .update({ status: 'pending', last_error: 'work_merged_during_release', updated_at: new Date() });
  }
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

// A pending subscriber whose DOI went out within this window was already
// resumed by an earlier release — a post-send settle failure or a sibling
// hold for the same recipient must not fire the confirmation again
// (Codex #3084 r12). subscribeOrResubscribe pre-stamps confirmation_sent_at,
// but the resume path CLEARS the stamp when the actual send fails
// (subscribeNewCallCustomerToNewsletter, Codex #3084 r13) — so a present,
// recent stamp means a send that did not visibly fail, and this guard never
// buries an undelivered DOI.
const RESUME_DOI_DEDUPE_MS = 24 * 60 * 60 * 1000;

async function runNewsletterResume(payload, dbh = db) {
  try {
    const existing = await dbh('newsletter_subscribers')
      .whereRaw('LOWER(email) = ?', [String(payload.email || '').trim().toLowerCase()])
      .first('status', 'confirmation_sent_at');
    if (existing && String(existing.status) === 'pending' && existing.confirmation_sent_at
        && (Date.now() - new Date(existing.confirmation_sent_at).getTime()) < RESUME_DOI_DEDUPE_MS) {
      return { skipped: 'confirmation_recently_sent' };
    }
  } catch (guardErr) {
    logger.warn(`[first-touch-resume] DOI-dedupe guard lookup failed: ${guardErr.code || guardErr.name || 'db_error'} — proceeding with resume`);
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
  try {
    const holds = await findPendingHolds({ callLogId, customerId, dbh });
    if (!holds.length) return { ...result, newsletterResume: null, skipped: 'no_pending_hold' };

    for (const hold of holds) {
      if (!(await claimHold(hold, dbh))) continue; // another release path owns it
      inFlightHoldId = hold.id;

      const holdCustomerId = hold.customer_id || customerId;
      if (!holdCustomerId) {
        await settleHold(hold.id, { status: 'pending', last_error: 'no_customer_linked' }, dbh);
        continue;
      }
      const customer = await dbh('customers')
        .where({ id: holdCustomerId })
        .first('id', 'first_name', 'last_name');
      if (!customer) {
        await settleHold(hold.id, { status: 'pending', last_error: 'customer_not_found' }, dbh);
        continue;
      }

      const resumeEmail = String(email || hold.held_email || '').trim().toLowerCase();
      if (!resumeEmail || !RESUME_EMAIL_RE.test(resumeEmail)) {
        // Back to pending: a later correction releases it.
        await settleHold(hold.id, { status: 'pending', last_error: 'invalid_email' }, dbh);
        result.skipped = result.skipped || 'invalid_email';
        continue;
      }

      if (await customerCallDoNotContact(holdCustomerId, dbh)) {
        await settleHold(hold.id, { status: 'blocked', last_error: 'do_not_contact' }, dbh);
        logger.info(`[first-touch-resume] customer ${holdCustomerId}: do-not-contact veto — hold blocked (${source})`);
        result.skipped = result.skipped || 'do_not_contact';
        continue;
      }
      if (await emailSuppressedForNewLead(resumeEmail, dbh)) {
        // Back to pending: a corrected address after a bounce releases it.
        await settleHold(hold.id, { status: 'pending', last_error: 'email_suppressed' }, dbh);
        logger.info(`[first-touch-resume] customer ${holdCustomerId}: address suppressed — hold stays pending (${source})`);
        result.skipped = result.skipped || 'email_suppressed';
        continue;
      }

      // Re-read the target immediately before any send (Codex #3084 r13):
      // a SECOND correction supersedes a claimed row's held_email, and a
      // value that CHANGED since our claim-time snapshot is newer than even
      // this release's own email param. A changed address gets its own
      // suppression re-check.
      let sendEmail = resumeEmail;
      try {
        const freshRow = await dbh('first_touch_holds').where({ id: hold.id }).first('held_email');
        const freshEmail = String(freshRow?.held_email || '').trim().toLowerCase();
        if (freshEmail && freshEmail !== String(hold.held_email || '').trim().toLowerCase()
            && RESUME_EMAIL_RE.test(freshEmail)) {
          sendEmail = freshEmail;
        }
      } catch (rereadErr) {
        logger.warn(`[first-touch-resume] pre-send target re-read failed: ${rereadErr.code || rereadErr.name || 'db_error'} — using claim-time target`);
      }
      if (sendEmail !== resumeEmail && await emailSuppressedForNewLead(sendEmail, dbh)) {
        await settleHold(hold.id, { status: 'pending', last_error: 'email_suppressed' }, dbh);
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
        try {
          const AutomationRunner = require('./automation-runner');
          const enroll = await AutomationRunner.enrollCustomer({
            templateKey: 'new_lead',
            customer: {
              email: sendEmail,
              first_name: customer.first_name || null,
              last_name: customer.last_name || null,
              id: holdCustomerId,
            },
            dbh,
          });
          result.enrolled = result.enrolled || !!enroll?.enrolled;
          patch.released_drip = true;
        } catch (enrollErr) {
          // Back to pending — the ledger row IS the retryable release.
          // Sanitized code only, in the log AND the ledger: an enrollment
          // unique-violation can echo the denormalized email.
          const enrollCode = enrollErr.code || enrollErr.name || 'enroll_failed';
          await settleHold(hold.id, { status: 'pending', last_error: `enroll_failed: ${enrollCode}` }, dbh);
          logger.warn(`[first-touch-resume] enroll failed for customer ${holdCustomerId} — hold stays pending: ${enrollCode}`);
          result.skipped = result.skipped || 'enroll_failed';
          continue;
        }
      }

      let newsletterSettled = !hold.held_newsletter || hold.released_newsletter;
      let deferredThisHold = false;
      if (hold.held_newsletter && !hold.released_newsletter) {
        if (deferNewsletter) {
          // Transactional caller: DOI executes post-commit via
          // resumeHeldNewsletterPostCommit, which settles the row itself.
          // The claim stays 'releasing' until then (stale-claim window
          // reclaims it if the process dies before commit).
          result.newsletterResume.push({
            holdId: hold.id,
            customerId: holdCustomerId,
            email: sendEmail,
            firstName: customer.first_name || null,
            lastName: customer.last_name || null,
          });
          deferredThisHold = true;
        } else {
          // Direct (non-deferred) path: a thrown resume must not escape to
          // the outer catch with the hold still claimed — treat it as
          // undelivered (re-pends below) and log only a sanitized code (a
          // unique-violation message can echo the subscriber email),
          // Codex #3084 r10.
          let outcome = null;
          try {
            outcome = await runNewsletterResume({
              customerId: holdCustomerId,
              email: sendEmail,
              firstName: customer.first_name || null,
              lastName: customer.last_name || null,
            }, dbh);
          } catch (newsletterErr) {
            logger.warn(`[first-touch-resume] newsletter resume failed for customer ${holdCustomerId}: ${newsletterErr.code || newsletterErr.name || 'resume_failed'}`);
          }
          result.newsletter = outcome;
          if (newsletterDelivered(outcome)) {
            patch.released_newsletter = true;
            newsletterSettled = true;
          } else {
            patch.status = 'pending';
            patch.last_error = 'newsletter_doi_not_confirmed';
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
      if (Object.keys(patch).length) await settleHold(hold.id, patch, dbh);
      if (patch.status === 'released') await repenIfWorkMergedDuringClaim(hold.id, dbh);

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
        await dbh('first_touch_holds')
          .where({ id: strandedId, status: 'releasing' })
          .update({ status: 'pending', last_error: `resume_failed: ${code}`, updated_at: new Date() });
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
    if (!groups.has(key)) groups.set(key, { payload: p, holdIds: [] });
    if (p.holdId) groups.get(key).holdIds.push(p.holdId);
  }
  const outcomes = [];
  for (const { payload, holdIds } of groups.values()) {
    outcomes.push(await runOnePostCommitResume(payload, holdIds, dbh));
  }
  return Array.isArray(payloadOrList) ? outcomes : outcomes[0];
}

async function runOnePostCommitResume(payload, holdIds, dbh) {
  try {
    // Re-read the freshest target before sending (Codex #3084 r13): a
    // second correction may have superseded held_email after this payload
    // was built inside the first correction's transaction.
    let sendPayload = payload;
    if (payload.holdId) {
      try {
        const fresh = await dbh('first_touch_holds').where({ id: payload.holdId }).first('held_email');
        const freshEmail = String(fresh?.held_email || '').trim().toLowerCase();
        if (freshEmail && freshEmail !== String(payload.email || '').trim().toLowerCase()
            && RESUME_EMAIL_RE.test(freshEmail)) {
          sendPayload = { ...payload, email: freshEmail };
        }
      } catch (rereadErr) {
        logger.warn(`[first-touch-resume] post-commit target re-read failed: ${rereadErr.code || rereadErr.name || 'db_error'} — using payload target`);
      }
    }
    const outcome = await runNewsletterResume(sendPayload, dbh);
    for (const holdId of holdIds) {
      if (newsletterDelivered(outcome)) {
        const hold = await dbh('first_touch_holds').where({ id: holdId }).first('held_drip', 'released_drip');
        const dripSettled = !hold || !hold.held_drip || hold.released_drip;
        await dbh('first_touch_holds').where({ id: holdId }).update({
          released_newsletter: true,
          status: dripSettled ? 'released' : 'pending',
          ...(dripSettled ? { released_at: new Date(), last_error: null } : {}),
          updated_at: new Date(),
        });
        if (dripSettled) await repenIfWorkMergedDuringClaim(holdId, dbh);
      } else {
        // Back to pending — the DOI never confirmed; the next release
        // trigger (or the ledger sweep) retries it.
        await dbh('first_touch_holds').where({ id: holdId })
          .update({ status: 'pending', last_error: 'newsletter_doi_not_confirmed', updated_at: new Date() });
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
        await dbh('first_touch_holds').where({ id: holdId })
          .update({ status: 'pending', last_error: `newsletter_resume_failed: ${code}`, updated_at: new Date() });
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
        if (existing && existing.status === 'released'
            && existing.released_at && new Date(existing.released_at) >= runStartedAt) {
          // The row's held_email IS the address the mid-run release actually
          // confirmed and sent to (the release stamps it — corrected value
          // after a correction, unchanged after an as-is accept; fanout
          // markers carry the corrected value). NEVER the customer's stored
          // email: for a matched existing customer that can be a stale
          // address the operator did not confirm (Codex #3084 r10).
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
          held_email: emailToRecord,
          held_drip: dbh.raw('first_touch_holds.held_drip OR excluded.held_drip'),
          held_newsletter: dbh.raw('first_touch_holds.held_newsletter OR excluded.held_newsletter'),
          // Never demote an ACTIVE 'releasing' claim back to 'pending' — a
          // triage accept or correction may be mid-release on this row, and
          // re-pending it would let a second release path claim it and send
          // a duplicate DOI. Released/blocked/pending all re-pend as before.
          status: dbh.raw("CASE WHEN first_touch_holds.status = 'releasing' THEN 'releasing' ELSE 'pending' END"),
          updated_at: now,
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
      .whereExists(function answered() {
        this.select(1).from('triage_items')
          .whereRaw('triage_items.call_log_id = first_touch_holds.call_log_id')
          .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
          .where('status', 'resolved');
      })
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
      const resolved = await dbh('triage_items')
        .where({ call_log_id: row.call_log_id })
        .whereIn('reason_code', EMAIL_REVIEW_REASON_CODES)
        .where({ status: 'resolved' })
        .first('id');
      if (!resolved) continue; // never reviewed — never auto-release
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
};
