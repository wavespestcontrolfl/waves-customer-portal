/**
 * Link Prospect Outreach (Backlink Manager M3b)
 *
 * Approval-gated outbound editorial outreach. A draft (recipient/subject/body)
 * is composed — by Hermes via the worker /report 'drafted' outcome, or manually
 * by an operator — and parked on the prospect. An operator then APPROVES the
 * send with an explicit, authenticated click; only then does the portal send the
 * one-to-one email via the existing Waves Gmail OAuth (contact@wavespestcontrol.com).
 *
 * Guardrails (design §9, mandatory because we send from the PRIMARY inbox, not an
 * isolated one — reputation protection is behavioral, there's no domain to burn):
 *   - human-approval-gated: nothing sends without the operator's authenticated POST
 *   - lane master switch: linkProspectOutreach must be ON (default OFF everywhere)
 *   - hard daily rate-limit (≤ ~12 cold sends / trailing 24h, env-overridable)
 *   - idempotent: an atomic drafted→sending→sent compare-and-swap means a
 *     double-click or a runaway loop can't double-send the same prospect
 *   - one-to-one only: the operator/Hermes writes the body; no templated blasts
 */
const { randomUUID } = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const gmailClient = require('../email/gmail-client');
const { isEnabled } = require('../../config/feature-gates');
const { OUTREACH_TYPES, isValidEmail } = require('./link-prospect-worker');

const OUTREACH_TYPE_SET = new Set(OUTREACH_TYPES);
const DEFAULT_DAILY_CAP = 12; // within design §9's ≤10–15 cold sends/day
// Postgres advisory-lock namespace serializing the cap-check + claim so concurrent
// approvals can't both pass the cap or both flip drafted→sending.
const OUTREACH_LOCK_KEY = 778932;
// A 'sending' row stuck past this is treated as a crashed send and may be reopened
// by saveDraft; inside the window it's a live in-flight send and stays locked.
const STALE_SENDING_MS = 15 * 60 * 1000;

/** Daily cold-send cap, env-overridable; falls back to the default on bad input. */
function dailyCap() {
  const n = parseInt(process.env.LINK_OUTREACH_DAILY_CAP, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_DAILY_CAP;
}

// gmail-client.sendMessage sends Content-Type text/html, so a plain-text draft
// must be escaped + line-broken. Operators write plain prose; this preserves it.
function textToHtml(text) {
  const esc = String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return esc.replace(/\r\n|\r|\n/g, '<br>\n');
}

/**
 * Pure precondition check for an approval+send (no I/O → unit-testable). Order
 * matters: lane gate first (off → nothing), then draft shape, then idempotency,
 * then rate limit. Returns { ok:true } or { ok:false, code }.
 */
function checkSendPreconditions({ prospect, gateOn, dailyCount, cap }) {
  if (!gateOn) return { ok: false, code: 'gate_off' };
  if (!prospect) return { ok: false, code: 'not_found' };
  if (!OUTREACH_TYPE_SET.has(prospect.link_type)) return { ok: false, code: 'not_outreach' };
  if (prospect.outreach_sent_at || prospect.outreach_status === 'sent') {
    return { ok: false, code: 'already_sent' };
  }
  // Only an open prospect is sendable — a row moved to a terminal lifecycle status
  // (lost/rejected/placed/contacted) must not be sent even if a stale draft lingers.
  if (prospect.status !== 'prospect') return { ok: false, code: 'not_actionable' };
  if (prospect.outreach_status !== 'drafted') return { ok: false, code: 'no_draft' };
  if (!isValidEmail(prospect.outreach_to_email)) return { ok: false, code: 'invalid_recipient' };
  if (!prospect.outreach_subject || !prospect.outreach_body) {
    return { ok: false, code: 'incomplete_draft' };
  }
  if (dailyCount >= cap) return { ok: false, code: 'rate_limited' };
  return { ok: true };
}

/**
 * Sends counted toward the daily cap = anything ATTEMPTED in the trailing 24h
 * (outreach_attempted_at, stamped at claim time). Counting by attempt — not outcome —
 * means in-flight ('sending'), completed ('sent'), AND ambiguous ('send_error', which
 * may have reached Gmail) all count, so a timeout can't quietly let the cap be
 * exceeded. Cleared on re-draft. Parameterized so it can run inside the claim txn.
 */
async function dailySendCount(q = db) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const row = await q('seo_link_prospects')
    .whereNotNull('outreach_attempted_at')
    .where('outreach_attempted_at', '>=', since)
    .count('* as c')
    .first();
  return parseInt(row && row.c, 10) || 0;
}

/**
 * Save / update an outreach draft on a prospect (manual, or via a Hermes report).
 * Flips outreach_status to 'drafted' so it surfaces in the approval queue. Won't
 * touch an already-sent prospect, and NEVER requeues an ambiguous send (send_error
 * or a stuck 'sending') — those may already have gone out, so they require the
 * explicit reconcileSendError() decision (sent vs not-sent).
 */
async function saveDraft({ prospectId, to, subject, body, owner = null }) {
  if (!isValidEmail(to)) return { ok: false, code: 'invalid_recipient' };
  if (!subject || !body) return { ok: false, code: 'incomplete_draft' };

  const prospect = await db('seo_link_prospects').where({ id: prospectId }).first();
  if (!prospect) return { ok: false, code: 'not_found' };
  if (!OUTREACH_TYPE_SET.has(prospect.link_type)) return { ok: false, code: 'not_outreach' };
  if (prospect.outreach_sent_at || prospect.outreach_status === 'sent') {
    return { ok: false, code: 'already_sent' };
  }
  // Only draft an open prospect — not one moved to a terminal lifecycle status.
  if (prospect.status !== 'prospect') return { ok: false, code: 'not_actionable' };
  // Ambiguous states must be reconciled DELIBERATELY (reconcileSendError), never
  // silently requeued here, since the message may already have reached Gmail:
  //   send_error                → reconcile.
  //   sending, fresh            → genuinely in flight → send_in_flight (try later).
  //   sending, stale (crashed)  → ambiguous → reconcile.
  if (prospect.outreach_status === 'send_error') return { ok: false, code: 'needs_reconcile' };
  if (prospect.outreach_status === 'sending') {
    const updatedMs = prospect.updated_at ? new Date(prospect.updated_at).getTime() : 0;
    const fresh = Date.now() - updatedMs < STALE_SENDING_MS;
    return { ok: false, code: fresh ? 'send_in_flight' : 'needs_reconcile' };
  }

  const patch = {
    outreach_to_email: to.trim(),
    outreach_subject: subject,
    outreach_body: body,
    outreach_status: 'drafted',
    // Invalidate any prior send-claim token so a hung send's finalize/rollback can't
    // match this row after we reopen it; clear the attempt stamp so a reconciled
    // (confirmed-not-sent) draft no longer counts against the daily cap.
    outreach_send_token: null,
    outreach_attempted_at: null,
    // An operator draft takes ownership: release any in-progress Hermes lease so a
    // late worker report can't clobber it (its optimistic concurrency fails on null).
    claimed_at: null,
    claimed_by: null,
    updated_at: new Date(),
  };
  if (owner && !prospect.owner) patch.owner = owner;

  // Conditional write closes the race with /send flipping drafted→sending between our
  // read above and this update: only write an OPEN prospect that is still unsent and in
  // a re-draftable state (none/drafted). 0 rows → a send raced us / status moved on, so
  // we must not resurrect the draft.
  const rows = await db('seo_link_prospects')
    .where({ id: prospectId, status: 'prospect' })
    .whereNull('outreach_sent_at')
    .where((b) => b.whereNull('outreach_status').orWhereIn('outreach_status', ['none', 'drafted']))
    .update(patch)
    .returning('*');
  if (!rows || rows.length === 0) return { ok: false, code: 'send_in_flight' };
  logger.info(`[link-outreach] draft saved for ${prospectId}`); // no recipient (PII)
  return { ok: true, prospect: rows[0] };
}

/**
 * Approve + send. The authenticated operator call IS the approval click (§9).
 *
 * Concurrency model — every mutation is keyed to a single claim:
 *   - Atomic cap-check + CAS drafted→sending under an advisory lock; the claim
 *     RETURNS the locked row, so we send THAT version (not a possibly-stale pre-read
 *     a revised draft could have replaced) and we get a unique claim token.
 *   - The token is `claimedAt` (the row's updated_at at claim time). Rollback and
 *     finalize both predicate on it, so an older hung attempt can only ever affect
 *     ITS OWN claim — never a newer retry that replaced it.
 * Only one send can win the CAS; on a Gmail failure we revert OUR claim to 'drafted'
 * for retry; we never mark sent on a failed send.
 */
async function sendOutreach({ prospectId, approvedBy = 'admin' }) {
  const gateOn = isEnabled('linkProspectOutreach');
  const prospect = await db('seo_link_prospects').where({ id: prospectId }).first();
  const cap = dailyCap();
  // Fast-fail non-rate preconditions on the pre-read (dailyCount=0 → rate branch
  // no-ops; the cap is enforced atomically in the claim txn). The authoritative
  // content comes from the row the claim returns, not this read.
  const pre = checkSendPreconditions({ prospect, gateOn, dailyCount: 0, cap });
  if (!pre.ok) return pre;

  // Connectivity pre-check BEFORE we claim, so the common "Gmail not connected"
  // misconfig fails cleanly with the draft untouched — rather than claiming the row
  // and then landing it in the ambiguous send-error state below.
  if (!(await gmailClient.isConnected())) return { ok: false, code: 'gmail_not_connected' };

  // Atomic cap-check + claim under an advisory lock so concurrent approvals can't
  // both pass the cap or both flip drafted→sending. Lock held only for count+claim
  // (no network). The claim stamps a dedicated send token and returns the row it
  // locked — every later mutation is gated on that token, which no other writer
  // touches (so unrelated edits to updated_at can't strand a finalize).
  const sendToken = randomUUID();
  const claim = await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [OUTREACH_LOCK_KEY]);
    if ((await dailySendCount(trx)) >= cap) return { ok: false, code: 'rate_limited' };
    const attemptAt = new Date();
    const claimedRows = await trx('seo_link_prospects')
      .where({ id: prospectId, outreach_status: 'drafted', status: 'prospect' })
      .whereNull('outreach_sent_at')
      // Stamp the attempt (counts toward the cap regardless of outcome) and release any
      // Hermes lease as we take the row in-flight, so a stale worker report (optimistic
      // concurrency on claimed_at) can't overwrite the send.
      .update({ outreach_status: 'sending', outreach_send_token: sendToken, outreach_attempted_at: attemptAt, claimed_at: null, claimed_by: null, updated_at: attemptAt })
      .returning('*');
    if (!claimedRows || claimedRows.length === 0) return { ok: false, code: 'already_sent' };
    return { ok: true, row: claimedRows[0] };
  });
  if (!claim.ok) return claim;
  const claimed = claim.row;

  // Send the CLAIMED version. Re-validate it (a draft saved without subject/body
  // could have slipped past the pre-read); on failure release only our own claim.
  if (!isValidEmail(claimed.outreach_to_email) || !claimed.outreach_subject || !claimed.outreach_body) {
    await releaseOurClaim(prospectId, sendToken);
    return { ok: false, code: 'incomplete_draft' };
  }

  let sent;
  try {
    sent = await gmailClient.sendMessage(
      claimed.outreach_to_email,
      claimed.outreach_subject,
      textToHtml(claimed.outreach_body)
    );
  } catch (err) {
    // AMBIGUOUS: a timeout/error here may have still reached Gmail (it accepted the
    // message but we never saw the response). Do NOT reopen to 'drafted' — that would
    // let a retry duplicate-send. Park it in a non-sendable reconciliation state; a
    // human checks the Sent folder and re-drafts only if it truly didn't go out.
    await markSendError(prospectId, sendToken);
    // Log a code/name only — a raw Gmail error message can echo the recipient (PII).
    logger.error(`[link-outreach] send failed (ambiguous) for ${prospectId} (code=${(err && (err.code || err.name)) || 'unknown'}) — needs reconciliation`);
    return { ok: false, code: 'send_failed', error: err.message };
  }

  const now = new Date();
  const threadRef = (sent && (sent.threadId || sent.id)) || null;
  const note = `Outreach sent ${now.toISOString()} to ${claimed.outreach_to_email} by ${approvedBy}`;
  // Finalize ONLY our own claim (the send token still matches). The token is private
  // to the send path, so this can't be stranded by an unrelated updated_at write.
  const rows = await db('seo_link_prospects')
    .where({ id: prospectId, outreach_send_token: sendToken })
    .update({
      status: 'contacted',
      outreach_status: 'sent',
      outreach_sent_at: now,
      outreach_thread_ref: threadRef,
      outreach_send_token: null,
      claimed_at: null,
      claimed_by: null,
      notes: claimed.notes ? `${claimed.notes}\n${note}` : note,
      updated_at: now,
    })
    .returning('*');

  // The email DID send. If finalize somehow matched ≠1 row, surface it loudly for
  // manual reconciliation rather than reporting a clean success (or silently retrying).
  if (!rows || rows.length !== 1) {
    logger.error(`[link-outreach] FINALIZE MISSED after a successful send for ${prospectId} msg=${sent && sent.id} thread=${threadRef} — reconcile manually`);
    return { ok: false, code: 'finalize_failed', message_id: (sent && sent.id) || null, thread_id: (sent && sent.threadId) || null, error: 'email sent but DB finalize matched no row; reconcile manually' };
  }

  logger.info(`[link-outreach] sent ${prospectId} msg=${sent && sent.id} thread=${threadRef}`); // no recipient (PII)
  return { ok: true, prospect: rows[0], message_id: (sent && sent.id) || null, thread_id: (sent && sent.threadId) || null };
}

// Revert a send claim to 'drafted' — but ONLY if it's still ours (the send token
// matches), so a hung attempt can't reopen a newer in-flight retry. Clears the token.
// Used only for failures KNOWN to be pre-send (no Gmail call happened), so reopening
// for retry is safe.
async function releaseOurClaim(prospectId, sendToken) {
  return db('seo_link_prospects')
    .where({ id: prospectId, outreach_send_token: sendToken })
    .update({ outreach_status: 'drafted', outreach_send_token: null, updated_at: new Date() });
}

// Park OUR claim in a non-sendable 'send_error' state after an AMBIGUOUS send (the
// message may have reached Gmail). Token-gated so it can't touch a newer claim. Stays
// out of the sendable path (checkSendPreconditions requires 'drafted') until a human
// reconciles and deliberately re-drafts.
async function markSendError(prospectId, sendToken) {
  return db('seo_link_prospects')
    .where({ id: prospectId, outreach_send_token: sendToken })
    .update({ outreach_status: 'send_error', outreach_send_token: null, updated_at: new Date() });
}

const RECONCILE_OUTCOMES = ['sent', 'requeue'];
/**
 * Explicit operator reconciliation of an AMBIGUOUS send — a send_error (Gmail errored)
 * or a stuck 'sending' (crashed mid-send, past the stale window). After checking the
 * Sent folder, the operator declares the truth:
 *   'sent'    → it DID go out: record it (status contacted, outreach sent).
 *   'requeue' → it did NOT: back to the approval queue, re-sendable, attempt cleared.
 * A FRESH 'sending' is genuinely in flight and refused (send_in_flight). Deliberate +
 * atomic on the row's current status, so an ambiguous send is never SILENTLY requeued
 * (which is why saveDraft refuses these states).
 */
async function reconcileSendError({ prospectId, outcome, approvedBy = 'admin' }) {
  if (!RECONCILE_OUTCOMES.includes(outcome)) return { ok: false, code: 'bad_outcome' };
  const prospect = await db('seo_link_prospects').where({ id: prospectId }).first();
  if (!prospect) return { ok: false, code: 'not_found' };

  const st = prospect.outreach_status;
  const updatedMs = prospect.updated_at ? new Date(prospect.updated_at).getTime() : 0;
  const staleSending = st === 'sending' && Date.now() - updatedMs >= STALE_SENDING_MS;
  if (st === 'sending' && !staleSending) return { ok: false, code: 'send_in_flight' };
  if (st !== 'send_error' && !staleSending) return { ok: false, code: 'not_reconcilable' };

  const now = new Date();
  const note = outcome === 'sent'
    ? `Outreach reconciled as SENT ${now.toISOString()} by ${approvedBy}`
    : `Outreach reconciled as NOT sent (re-queued) ${now.toISOString()} by ${approvedBy}`;
  const patch = outcome === 'sent'
    ? {
        status: 'contacted',
        outreach_status: 'sent',
        outreach_sent_at: prospect.outreach_sent_at || now,
        outreach_send_token: null,
        notes: prospect.notes ? `${prospect.notes}\n${note}` : note,
        updated_at: now,
      }
    : {
        outreach_status: 'drafted',
        outreach_send_token: null,
        // confirmed not sent → the prior attempt no longer counts against the cap
        outreach_attempted_at: null,
        notes: prospect.notes ? `${prospect.notes}\n${note}` : note,
        updated_at: now,
      };
  // Atomic on the EXACT claim we observed — status AND its send token (null for a
  // send_error). If the row cycled (sending→drafted→a fresh send) between our read and
  // here, the token won't match and we affect 0 rows instead of clobbering the new claim.
  let q = db('seo_link_prospects').where({ id: prospectId, outreach_status: st });
  q = prospect.outreach_send_token
    ? q.where({ outreach_send_token: prospect.outreach_send_token })
    : q.whereNull('outreach_send_token');
  const rows = await q.update(patch).returning('*');
  if (!rows || rows.length === 0) return { ok: false, code: 'not_reconcilable' };
  logger.info(`[link-outreach] reconciled ${prospectId} (${st}) as ${outcome} by ${approvedBy}`);
  return { ok: true, prospect: rows[0] };
}

module.exports = {
  saveDraft,
  sendOutreach,
  reconcileSendError,
  dailySendCount,
  checkSendPreconditions,
  isValidEmail,
  textToHtml,
  dailyCap,
  DEFAULT_DAILY_CAP,
};
