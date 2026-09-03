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
 *
 * Step 4 PR 3a (plan v2 §6.4 / §7 / §13) — inside the SAME locked claim:
 *   - the policy cap: an AUTOMATIC send (mode 'auto', the nightly bridge acting
 *     on a stamped AUTO_OUTREACH) is capped at min(policy.auto_outreach_daily_cap,
 *     LINK_OUTREACH_DAILY_CAP); an owner-approved send keeps the hard cap only
 *   - the authority contract (GATE_LINK_AUTHORITY on): the placement's open
 *     communication instance must be AUTO_OUTREACH, or OWNER_OUTREACH /
 *     OWNER_LEGAL with an approval bound to THIS draft's hash — and the owner's
 *     authenticated click IS that approval (written here, action outreach_send)
 *   - the fail-closed customer exclusion: an identified customer recipient is
 *     a hard block; a shared business domain must have been reviewed by the
 *     owner (the click carries the lookup hash it saw); a lookup error parks
 *   - a confirmed send satisfies the instance and consumes the approval
 */
const { randomUUID } = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const gmailClient = require('../email/gmail-client');
const { isEnabled } = require('../../config/feature-gates');
const { OUTREACH_TYPES, isValidEmail } = require('./link-prospect-worker');
const P = require('./link-authority-policy');
const M = require('./link-outreach-mandate');
const { DEFAULT_OUTREACH_DAILY_CAP: DEFAULT_DAILY_CAP, outreachDailyCeiling } = P;

const AUTH = 'seo_link_placement_authorities';
const SEND_MODES = Object.freeze(['owner', 'auto']);
// thrown inside the claim transaction to roll it back while returning a refusal to the caller
class Rollback extends Error { constructor(result) { super(result.code); this.result = result; } }
// An open prospect, or one the nightly bridge PARKED for the owner's send
// (awaiting_owner, §3.3b) — the owner's click is what the park waits for; an
// automatic send acts on `prospect` rows only (a parked row is the owner's).
const SENDABLE_STATUSES = Object.freeze(['prospect', 'awaiting_owner']);

const OUTREACH_TYPE_SET = new Set(OUTREACH_TYPES);
// Postgres advisory-lock namespace serializing the cap-check + claim so concurrent
// approvals can't both pass the cap or both flip drafted→sending.
const OUTREACH_LOCK_KEY = 778932;
// A 'sending' row stuck past this is treated as a crashed send and may be reopened
// by saveDraft; inside the window it's a live in-flight send and stays locked.
const STALE_SENDING_MS = 15 * 60 * 1000;

/** Daily cold-send cap — the shared parser in link-authority-policy (env-overridable, default on bad input). */
function dailyCap() {
  return outreachDailyCeiling();
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
  // Only an open (or owner-parked) prospect is sendable — a row moved to a terminal
  // lifecycle status (lost/rejected/placed/contacted) must not be sent even if a stale draft lingers.
  if (!SENDABLE_STATUSES.includes(prospect.status)) return { ok: false, code: 'not_actionable' };
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
// A reopened lost-recovery row keeps every previous attempt in the append-only
// quality_signals.prior_outreach_attempts array (lost-link-recovery appends the
// stamp there so the resend can write its own); each in-window element counts.
const PRIOR_ATTEMPTS_SQL = "jsonb_array_elements_text(CASE WHEN jsonb_typeof(quality_signals -> 'prior_outreach_attempts') = 'array' THEN quality_signals -> 'prior_outreach_attempts' ELSE '[]'::jsonb END)";
const PRIOR_IN_WINDOW_COUNT_SQL = `(SELECT count(*) FROM ${PRIOR_ATTEMPTS_SQL} AS a WHERE a::timestamptz >= ?)`;
async function dailySendCount(q = db) {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const row = await q('seo_link_prospects')
    .whereRaw(`(outreach_attempted_at >= ? OR ${PRIOR_IN_WINDOW_COUNT_SQL} > 0)`, [since, since])
    // Current side COALESCEd: a NULL timestamp compares to NULL, and NULL + n is
    // NULL — which SUM would drop, counting an ordinary attempt as zero.
    .select(q.raw(`COALESCE(SUM(COALESCE((outreach_attempted_at >= ?)::int, 0) + ${PRIOR_IN_WINDOW_COUNT_SQL}), 0) AS c`, [since, since]))
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
  // Only draft an open (or owner-parked) prospect — not one moved to a terminal lifecycle status.
  if (!SENDABLE_STATUSES.includes(prospect.status)) return { ok: false, code: 'not_actionable' };
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

  // The path the draft was composed against, as observed with the prospect
  // above: the write below is conditioned on the LOCKED path still being at
  // this revision, so a path change landing between this read and the lock
  // can never label a stale draft with the new revision.
  const observedPath = prospect.path_id
    ? await db('seo_link_acquisition_paths').where({ id: prospect.path_id }).first('id', 'revision')
    : null;

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
  // The draft write releases any Hermes lease into `drafted` — a NON-claimable
  // state — so the placement is settled onto its live acquisition path in the
  // SAME transaction. If that settlement MOVED the row (its path was superseded
  // or changed while the operator drafted against the stale prospect), the
  // just-written draft was composed for a retired route and the transition
  // has already cleared it: report path_moved so the operator re-drafts.
  const { rows, moved } = await db.transaction(async (trx) => {
    // Lock order is prospect → path in every outreach transaction (the send
    // does the same), so a /send racing this save cannot deadlock it.
    await trx('seo_link_prospects').where({ id: prospectId }).forUpdate().first('id');
    // A manual draft is BOUND to the path revision it was written against:
    // the stamp lets the release-time reconcile and the send-time check see
    // an in-place path change (communication terms, lane) made while the
    // draft awaits approval — exactly like a worker's leased draft.
    if (prospect.path_id) {
      const onPath = await trx('seo_link_acquisition_paths').where({ id: prospect.path_id }).forUpdate().first('id', 'revision');
      const observedRev = observedPath && observedPath.revision != null ? Number(observedPath.revision) : null;
      const lockedRev = onPath && onPath.revision != null ? Number(onPath.revision) : null;
      if (!onPath || lockedRev !== observedRev) return { rows: [], moved: true }; // the path changed under the operator → path_moved, re-draft
      patch.leased_path_revision = lockedRev;
    }
    // …and on the PATH and LANE the operator drafted against: a settlement
    // that moved the row (to a signup lane, say) between the pre-read and
    // this write must make it miss, or a signup placement would be left
    // `drafted` — unclaimable by the runner, refused by the send valve.
    let write = trx('seo_link_prospects')
      .where({ id: prospectId, status: prospect.status, link_type: prospect.link_type })
      .whereNull('outreach_sent_at')
      .where((b) => b.whereNull('outreach_status').orWhereIn('outreach_status', ['none', 'drafted']));
    write = prospect.path_id == null ? write.whereNull('path_id') : write.where('path_id', prospect.path_id);
    const written = await write.update(patch).returning('*');
    if (!written || written.length === 0) return { rows: written, moved: 0 };
    const n = await require('./link-registry').settleRetiredPlacements(trx, { prospectIds: [prospectId] });
    return { rows: written, moved: n };
  });
  if (moved && (!rows || rows.length === 0)) return { ok: false, code: 'path_moved' }; // refused before the write: the path changed under the operator
  if (!rows || rows.length === 0) return { ok: false, code: 'send_in_flight' };
  if (moved) {
    logger.info(`[link-outreach] draft for ${prospectId} discarded — its acquisition path moved while drafting`);
    return { ok: false, code: 'path_moved', error: 'the placement\'s acquisition path changed while you drafted; reload and draft again' };
  }
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
async function sendOutreach({ prospectId, approvedBy = 'admin', mode = 'owner', reviewedLookupHash = null }) {
  if (!SEND_MODES.includes(mode)) return { ok: false, code: 'bad_mode' };
  // an automatic send exists only under the authority contract (§7): nothing has stamped AUTO_OUTREACH otherwise
  if (mode === 'auto' && !isEnabled('linkAuthority')) return { ok: false, code: 'not_authorized', error: 'GATE_LINK_AUTHORITY is off — no automatic send' };
  const gateOn = isEnabled('linkProspectOutreach');
  const prospect = await db('seo_link_prospects').where({ id: prospectId }).first();
  const cap = dailyCap();
  // Fast-fail non-rate preconditions on the pre-read (dailyCount=0 → rate branch
  // no-ops; the cap is enforced atomically in the claim txn). The authoritative
  // content comes from the row the claim returns, not this read.
  const pre = checkSendPreconditions({ prospect, gateOn, dailyCount: 0, cap });
  if (!pre.ok) return pre;
  if (mode === 'auto' && prospect.status !== 'prospect') return { ok: false, code: 'not_actionable' };

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
    // prospect → path lock order, same as saveDraft (settlement locks the path)
    await trx('seo_link_prospects').where({ id: prospectId }).forUpdate().first('id');
    // the policy row read under the lock: the §6.4 cap below and the §7 authority hash
    const { policy } = await P.loadPolicy(trx);
    // Settle the drafted row BEFORE taking it in flight: its acquisition path
    // may have been superseded, revised or disproven since the draft was
    // saved. A settlement that moves the row has cleared the draft (it was
    // composed for a retired route) — abort here rather than email obsolete
    // copy; once the row is `sending` settlement refuses to touch it.
    const moved = await require('./link-registry').settleRetiredPlacements(trx, { prospectIds: [prospectId] });
    if (moved) return { ok: false, code: 'path_moved' };
    // zero moved is not proof of a live path: a chain settlement could not
    // resolve (bounded hops) or refused leaves the row on a retired path —
    // re-read and require the path it will send on to be non-superseded
    // …and STANDING: settlement reconciles a disproof only against a lease
    // stamp, so a later disproof (confidence 0 / NULL) or a human-step ruling
    // (agent_completable=false) on the same path is re-checked here
    const current = await trx('seo_link_prospects').where({ id: prospectId }).first();
    // an UNLINKED prospect (the registry catch-up has not linked it yet) has
    // passed no standing check at all — it is not sent until it has a path
    if (!current || !SENDABLE_STATUSES.includes(current.status) || (mode === 'auto' && current.status !== 'prospect')) return { ok: false, code: 'not_actionable' };
    if (!current.path_id) return { ok: false, code: 'path_unlinked', error: 'this prospect is not linked to an acquisition path yet; the registry catch-up links it within the hour' };
    // …read FOR UPDATE, held through the drafted→sending CAS below (as
    // worker.claim() holds its path locks through the lease): an investigation
    // superseding or revising the path waits for this commit instead of
    // slipping in between the standing read and the CAS
    const onPath = await trx('seo_link_acquisition_paths').where({ id: current.path_id }).forUpdate().first();
    const standing = onPath && !onPath.superseded_by && require('./link-registry').isStandingConfidence(onPath.confidence) && onPath.agent_completable !== false; // NULL confidence = never assessed = not standing
    if (!standing) return { ok: false, code: 'path_moved' };
    // …and the draft must still be bound to the path's CURRENT revision: a
    // stamp that no longer matches means the path changed in place after the
    // draft was written (terms, lane, URL) — copy composed for a route that
    // no longer exists as such is not sent. The stamp is REQUIRED: every
    // draft carries one (the lease that produced it, saveDraft, or the
    // migration's backfill of pre-existing drafts), so a missing stamp is a
    // draft nothing bound to a revision — not sent either.
    if (current.leased_path_revision == null || onPath.revision == null || Number(onPath.revision) !== Number(current.leased_path_revision)) return { ok: false, code: 'path_moved' };
    // the draft the claim will send is the LOCKED row's — its hash is what an
    // approval binds to and what the customer exclusion reviews
    const draft = { outreach_to_email: current.outreach_to_email, outreach_subject: current.outreach_subject, outreach_body: current.outreach_body };
    if (!isValidEmail(draft.outreach_to_email) || !draft.outreach_subject || !draft.outreach_body) return { ok: false, code: 'incomplete_draft' };
    // §13 — inside EVERY send claim, auto and owner alike; a lookup failure is fail-closed
    let review;
    try { review = await M.recipientReview(trx, draft.outreach_to_email); } catch (err) {
      logger.error(`[link-outreach] recipient lookup failed for ${prospectId} (code=${(err && (err.code || err.name)) || 'unknown'}) — parked`);
      return { ok: false, code: 'recipient_lookup_failed', error: 'the customer-recipient lookup failed; not sent (fail-closed) — retry, or review the recipient' };
    }
    if (review.kind === 'customer') return { ok: false, code: 'customer_recipient', review, error: 'the recipient is a customer contact — outreach never goes to a customer' };
    if (review.kind === 'ambiguous' && (mode === 'auto' || reviewedLookupHash !== review.lookup_hash)) {
      return { ok: false, code: 'recipient_review_required', review, error: 'the recipient shares a domain with a customer or lead contact — review the match, then send with it acknowledged' };
    }
    const attemptAt = new Date();
    // the cap, enforced ONLY here under the lock (§6.4): an automatic send is
    // bounded by the OWNER's policy value as well as the hard ceiling — a policy
    // cap of 0 (the shipped default) authorizes no automatic send at all; an
    // owner-approved send keeps the hard cap only. Checked BEFORE the authority
    // step so a capped click never records an approval for a send that did not happen.
    const policyCap = Number(policy.auto_outreach_daily_cap);
    if (mode === 'auto' && !(Number.isFinite(policyCap) && policyCap > 0)) return { ok: false, code: 'not_authorized', error: 'auto_outreach_daily_cap is 0 — automatic sends are off' };
    const effectiveCap = mode === 'auto' ? Math.min(policyCap, cap) : cap;
    if ((await dailySendCount(trx)) >= effectiveCap) return { ok: false, code: 'rate_limited' };
    // §7 — the authority contract, re-validated under the same lock as the claim.
    // From here on the owner's approval may have been written: a refusal below
    // ROLLS the transaction BACK (thrown, caught by the caller) rather than
    // committing an approval for a send that never claimed.
    const authority = await sendAuthority(trx, { placement: current, path: onPath, policy, mode, draft, review, approvedBy, now: attemptAt });
    if (!authority.ok) return authority;
    const claimedRows = await trx('seo_link_prospects')
      .where({ id: prospectId, outreach_status: 'drafted', status: current.status, path_id: current.path_id }) // the CAS is bound to the path whose standing was just verified, and to the status the checks read
      .whereNull('outreach_sent_at')
      // Stamp the attempt (counts toward the cap regardless of outcome) and release any
      // Hermes lease as we take the row in-flight, so a stale worker report (optimistic
      // concurrency on claimed_at) can't overwrite the send.
      .update({ outreach_status: 'sending', outreach_send_token: sendToken, outreach_attempted_at: attemptAt, claimed_at: null, claimed_by: null, updated_at: attemptAt })
      .returning('*');
    if (!claimedRows || claimedRows.length === 0) throw new Rollback({ ok: false, code: 'already_sent' });
    return { ok: true, row: claimedRows[0], authority };
  }).catch((err) => { if (err instanceof Rollback) return err.result; throw err; });
  if (!claim.ok) return claim;
  const claimed = claim.row;
  const authority = claim.authority;

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
  // The communication instance is satisfied and its approval consumed in the
  // same transaction (§3.3b: only satisfaction proves the send happened).
  const rows = await db.transaction(async (trx) => {
    const r = await trx('seo_link_prospects')
      .where({ id: prospectId, outreach_send_token: sendToken })
      .update({
        status: 'contacted', // a parked row leaves the park by the send itself
        parked_from_status: null,
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
    if (r && r.length === 1 && authority.rowId) await satisfySendInstance(trx, { prospectId, rowId: authority.rowId, now });
    return r;
  });

  // The email DID send. If finalize somehow matched ≠1 row, surface it loudly for
  // manual reconciliation rather than reporting a clean success (or silently retrying).
  if (!rows || rows.length !== 1) {
    logger.error(`[link-outreach] FINALIZE MISSED after a successful send for ${prospectId} msg=${sent && sent.id} thread=${threadRef} — reconcile manually`);
    return { ok: false, code: 'finalize_failed', message_id: (sent && sent.id) || null, thread_id: (sent && sent.threadId) || null, error: 'email sent but DB finalize matched no row; reconcile manually' };
  }

  logger.info(`[link-outreach] sent ${prospectId} msg=${sent && sent.id} thread=${threadRef} mode=${mode}`); // no recipient (PII)
  return { ok: true, prospect: rows[0], message_id: (sent && sent.id) || null, thread_id: (sent && sent.threadId) || null, authority: authority.rowId ? { level: authority.level, approval_id: authority.approvalId } : null };
}

/**
 * The §7 send gate, under the claim lock. With GATE_LINK_AUTHORITY off nothing
 * has decided a row, and the shipped owner click stands on its own (no row).
 * On: the placement's OPEN communication instance on the path it will send
 * on must be AUTO_OUTREACH, or an owner level holding an approval bound to
 * THIS draft's hash — an owner's click without one writes that approval here
 * (the click IS the approval, §6.3 2c), frozen with the draft hash and the
 * recipient review it resolved. A stale stamp (inputs moved since the
 * decision), a prior-path row, a send that would legally accept terms, and
 * every other level refuse: the nightly bridge re-decides, the owner acts
 * from the queue.
 */
async function sendAuthority(trx, { placement, path, policy, mode, draft, review, approvedBy, now }) {
  if (!isEnabled('linkAuthority')) {
    return mode === 'auto' ? { ok: false, code: 'not_authorized', error: 'GATE_LINK_AUTHORITY is off — no automatic send' } : { ok: true, rowId: null, approvalId: null, level: null };
  }
  const row = await trx(AUTH).where({ prospect_id: placement.id, dimension: 'communication', instance_kind: '-' }).whereNull('ended_at').first();
  if (!row) return { ok: false, code: 'not_authorized', error: 'no send authority decided for this placement yet — the nightly bridge decides it first' };
  if (row.satisfied_at) return { ok: false, code: 'already_sent' };
  if (row.path_id !== path.id) return { ok: false, code: 'not_authorized', error: 'the send authority was decided on a prior path — the nightly bridge rotates it' };
  const domain = placement.domain_id ? await trx('seo_link_domains').where({ id: placement.domain_id }).first() : null;
  if (!domain) return { ok: false, code: 'not_authorized', error: 'the placement is not bound to a registry domain' };
  const ctx = { path, domain, policy, score: domain.score, instanceKey: row.instance_key };
  const hash = P.decisionInputsHash('communication', ctx);
  const revision = Number(path.revision_communication ?? path.revision ?? 1);
  if (hash !== row.decision_inputs_hash || Number(row.path_revision) !== revision) return { ok: false, code: 'not_authorized', error: 'the send inputs changed since the authority was decided — the nightly bridge re-decides it' };
  if (row.level === P.LEVELS.AUTO_OUTREACH) {
    // the draft is deliberately outside the decision hash (the approval binds it): a draft edited after the
    // nightly stamped AUTO_OUTREACH is re-reviewed on the LOCKED text in EVERY mode — an unclean one is not
    // this row's to send (no approval can bind it to an AUTO level, §3.6b): the nightly re-decides it OWNER_*
    // and the owner's click then writes the approval for that text
    if (!M.draftReview({ ...placement, ...draft }).clean) return { ok: false, code: 'not_authorized', error: 'the draft changed since the automatic decision and is no longer clean — the nightly bridge re-decides it for the owner' };
    return { ok: true, rowId: row.id, approvalId: null, level: row.level };
  }
  if (mode === 'auto') return { ok: false, code: 'not_authorized', error: `${row.level}: the owner's click is the send authority` };
  if (row.level !== P.LEVELS.OWNER_OUTREACH && row.level !== P.LEVELS.OWNER_LEGAL) return { ok: false, code: 'not_authorized', error: `${row.level} authorizes no send` };
  // a send that itself accepts the publisher's terms needs the accept_terms
  // instance satisfied co-transactionally (plan §3.3b) — not built here
  if (path.terms_accepted_by_send === true) return { ok: false, code: 'not_authorized', error: 'sending this pitch accepts the publisher\'s terms — the co-transactional terms acceptance is not available yet' };
  const actionHash = M.draftHash(draft);
  if (row.approval_id) {
    const a = await trx('seo_link_approvals').where({ id: row.approval_id }).first();
    if (a && a.decision === 'approved' && !a.invalidated_at && !a.consumed_at && a.action === 'outreach_send' && a.action_hash === actionHash) return { ok: true, rowId: row.id, approvalId: a.id, level: row.level };
    // an approval for another text (the draft was edited after it) is spent by that edit — the click below replaces it
    if (a && !a.invalidated_at && !a.consumed_at) await trx('seo_link_approvals').where({ id: a.id }).update({ invalidated_at: now, invalidated_reason: 'draft changed after the approval', updated_at: now });
  }
  const snapshot = { ...P.decisionInputs('communication', ctx), draft_hash: actionHash, recipient_review: { recipient: review.recipient, match_kind: review.kind, matched_ids: review.matched, lookup_hash: review.lookup_hash } };
  const [approval] = await trx('seo_link_approvals').insert({
    prospect_id: placement.id, path_id: path.id, path_revision: revision, decision_inputs_hash: hash,
    money_action: false, decision: 'approved', authority: row.level, approved_amount_cents: null, max_payable_cents: null, terms_snapshot: snapshot,
    dimension: 'communication', action: 'outreach_send', instance_key: row.instance_key, action_hash: actionHash,
    approved_by: approvedBy, approved_at: now, created_at: now, updated_at: now,
  }).returning('*');
  await trx(AUTH).where({ id: row.id }).update({ approval_id: approval.id, updated_at: now });
  return { ok: true, rowId: row.id, approvalId: approval.id, level: row.level };
}

// a confirmed send: the instance is satisfied, its approval consumed (§3.6b). Without the claim's row id (a
// reconciled send) the instance is the open one on the placement's path at the revision the send was bound to
// (leased_path_revision) — never a later generation rotated in since.
async function satisfySendInstance(trx, { prospectId, rowId = null, now }) {
  let rows;
  if (rowId) rows = await trx(AUTH).where({ id: rowId }).whereNull('satisfied_at').select('id', 'approval_id');
  else {
    const p = await trx('seo_link_prospects').where({ id: prospectId }).first('path_id', 'leased_path_revision');
    if (!p || !p.path_id || p.leased_path_revision == null) return 0;
    rows = (await trx(AUTH).where({ prospect_id: prospectId, dimension: 'communication', instance_kind: '-', path_id: p.path_id }).whereNull('ended_at').whereNull('satisfied_at').select('id', 'approval_id', 'path_revision'))
      .filter((r) => Number(r.path_revision) === Number(p.leased_path_revision));
  }
  if (!rows.length) return 0;
  await trx(AUTH).whereIn('id', rows.map((r) => r.id)).update({ satisfied_at: now, satisfied_reason: 'sent', updated_at: now });
  const approvalIds = rows.map((r) => r.approval_id).filter(Boolean);
  if (approvalIds.length) await trx('seo_link_approvals').whereIn('id', approvalIds).whereNull('consumed_at').update({ consumed_at: now, updated_at: now });
  return rows.length;
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
        parked_from_status: null,
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
  const rows = await db.transaction(async (trx) => {
    let q = trx('seo_link_prospects').where({ id: prospectId, outreach_status: st });
    q = prospect.outreach_send_token
      ? q.where({ outreach_send_token: prospect.outreach_send_token })
      : q.whereNull('outreach_send_token');
    const r = await q.update(patch).returning('*');
    // the Sent folder proved the send: the open communication instance is satisfied by it (§3.3b)
    if (outcome === 'sent' && r && r.length === 1) await satisfySendInstance(trx, { prospectId, now });
    return r;
  });
  if (!rows || rows.length === 0) return { ok: false, code: 'not_reconcilable' };
  logger.info(`[link-outreach] reconciled ${prospectId} (${st}) as ${outcome} by ${approvedBy}`);
  return { ok: true, prospect: rows[0] };
}

module.exports = {
  saveDraft,
  sendOutreach,
  sendAuthority,
  SEND_MODES,
  reconcileSendError,
  dailySendCount,
  checkSendPreconditions,
  isValidEmail,
  textToHtml,
  dailyCap,
  DEFAULT_DAILY_CAP,
  STALE_SENDING_MS,
  SENDABLE_STATUSES,
};
