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
 *   - hard daily rate-limit (≤ ~12 cold sends per ET calendar day, env-overridable)
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
 *
 * Step 4 PR 3b (§6.4) — the FOLLOW-UP, one per placement, +10 days, only if no
 * reply: the same claim (`followUp: true`) over the follow-up columns — its own
 * draft, token, attempt stamp and status machine (link-outreach-mandate) — under
 * the communication/followup instance, and WITH a fail-closed reply check inside
 * the locked claim: the Gmail thread is read before any authority is granted; a
 * reply or a bounce skips the follow-up for good, a lookup error/timeout refuses
 * it (nothing sends without a successful lookup proving silence). The follow-up
 * writes ONLY its own columns — never `status` (the Judge owns it from placed).
 */
const { randomUUID } = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const gmailClient = require('../email/gmail-client');
const { isEnabled } = require('../../config/feature-gates');
const { OUTREACH_TYPES, isValidEmail } = require('./link-prospect-worker');
// one conversation per inbox (plan §13): a conversation with this recipient is OPEN while the placement is contacted /
// negotiating (or parked from one of those for a checkout / follow-up approval), a send is in flight, sent, or an
// unreconciled ambiguous send may have been delivered — and CLOSED, releasing the inbox for a later placement, once
// the placement is lost / rejected or carries the durable closure stamp (conversation_closed_at, §3.3: written when a
// live / indexed placement's communication lifecycle completes; a lost-link recovery cycle clears it when it reopens
// the same placement). A lifetime send stamp alone holds nothing: a finished conversation is not an open one.
// a conversation is OVER once the placement reached its outcome — won (placed / live / indexed), watched, lost or
// rejected — or carries the closure stamp; a `sent` pitch on a completed placement holds no inbox
const CONVERSATION_CLOSED_STATUSES = Object.freeze(['placed', 'live', 'indexed', 'watching', 'lost', 'rejected']);
// — EXCEPT while a send is ambiguous (in flight or errored before Sent-folder reconciliation): Gmail may have delivered
// the pitch, so the inbox stays held whatever the status reads until the reconcile settles the outcome
// (a follow-up in flight / errored holds the inbox the same way — its send may have been delivered too)
const ambiguousSend = (row) => M.AMBIGUOUS_SEND_STATUSES.includes(row.outreach_status) || M.AMBIGUOUS_SEND_STATUSES.includes(row.follow_up_status);
// — and EXCEPT while a submit-first placement's ONE follow-up is still owed past its outcome (M.followUpOwed — the
// domain guard reads the same): its conversation is not over and the inbox stays held
const conversationClosed = (row, path) => !ambiguousSend(row)
  && (Boolean(row.conversation_closed_at) || (CONVERSATION_CLOSED_STATUSES.includes(row.status) && !M.followUpOwed(row, path) && !M.initialSendOwed(row, path)));
// `path` = the placement's acquisition path (execution_after_send) — the follow-up lifecycle is path-dependent
const CONVERSATION_OPEN = (row, path = null) => !conversationClosed(row, path) && (
  M.initialSendOwed(row, path) || ['contacted', 'negotiating'].includes(row.status)
  || (row.status === 'awaiting_owner' && ['contacted', 'negotiating'].includes(row.parked_from_status))
  || ['sending', 'sent', 'send_error'].includes(row.outreach_status));

/**
 * The RECIPIENT-level guard (plan §13: one conversation per inbox — the domain lock covers the domain, not the
 * inbox). Takes `pg_advisory_xact_lock(hashtext('link_outreach_inbox:' || recipient))` in the caller's transaction
 * and returns the other placement whose conversation with this inbox is open (null = free). EVERY writer that opens
 * a conversation — the send claim, and the manual status edit that records one — takes it, so two writers cannot
 * both enter under each other. Candidates come by host (both google hosts for gmail) and match in the canonical form.
 */
async function inboxConflict(trx, { recipient, excludeId = null }) {
  const inbox = M.normalizeEmail(recipient);
  if (!inbox) return null;
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`link_outreach_inbox:${inbox}`]);
  const inboxHost = inbox.slice(inbox.lastIndexOf('@') + 1);
  const hosts = M.GOOGLE_HOSTS.includes(inboxHost) ? [...M.GOOGLE_HOSTS] : [inboxHost];
  let q = trx('seo_link_prospects').whereRaw(`split_part(${M.STORED_SQL}, '@', 2) = ANY(?)`, ['outreach_to_email', hosts]);
  if (excludeId) q = q.where('id', '<>', excludeId);
  const others = (await q.select('id', 'status', 'parked_from_status', 'outreach_status', 'follow_up_status', 'follow_up_due_at', 'conversation_closed_at', 'outreach_to_email', 'path_id')).filter((o) => M.normalizeEmail(o.outreach_to_email) === inbox);
  const pathIds = [...new Set(others.map((o) => o.path_id).filter(Boolean))];
  const paths = pathIds.length ? await trx('seo_link_acquisition_paths').whereIn('id', pathIds).select('id', 'execution_after_send', 'acquisition_type', 'account_required') : [];
  const pathById = new Map(paths.map((p) => [p.id, p]));
  return others.find((o) => CONVERSATION_OPEN(o, pathById.get(o.path_id) || null)) || null;
}
const P = require('./link-authority-policy');
const M = require('./link-outreach-mandate');
const { lockProspectDomain } = require('./prospect-domain-lock');
const { DEFAULT_OUTREACH_DAILY_CAP: DEFAULT_DAILY_CAP, outreachDailyCeiling } = P;
const { BRIDGE_STATES } = require('./link-authority-selection');

const AUTH = 'seo_link_placement_authorities';
const SEND_MODES = Object.freeze(['owner', 'auto']);
// thrown inside the claim transaction to roll it back while returning a refusal to the caller
class Rollback extends Error { constructor(result) { super(result.code); this.result = result; } }
// An open prospect, or one the nightly bridge PARKED for the owner's send
// (awaiting_owner, §3.3b) — the owner's click is what the park waits for; an
// automatic send acts on `prospect` rows only (a parked row is the owner's).
const SENDABLE_STATUSES = Object.freeze(['prospect', 'awaiting_owner']);
const JUDGE_STATUSES = ['placed', 'live', 'indexed'];
const lateSend = (placement, path) => JUDGE_STATUSES.includes(placement.status) && P.submitFirst(path || {});

const { etDateString, parseETDateTime, addETDaysAtWallClock } = require('../../utils/datetime-et');
const OUTREACH_TYPE_SET = new Set(OUTREACH_TYPES);
// Postgres advisory-lock namespace serializing the cap-check + claim so concurrent
// approvals can't both pass the cap or both flip drafted→sending.
const OUTREACH_LOCK_KEY = 778932;
// A 'sending' row stuck past this is treated as a crashed send and may be reopened
// by saveDraft; inside the window it's a live in-flight send and stays locked.
const STALE_SENDING_MS = 15 * 60 * 1000;
// the reply check's ceiling: a thread read past it is a lookup failure (the follow-up is refused, never sent)
const REPLY_CHECK_TIMEOUT_MS = 15 * 1000;
// the two sends share one claim; `kind` names the columns and the instance each acts on
const KIND = Object.freeze({
  initial: { instanceKind: '-', action: 'outreach_send', status: 'outreach_status', token: 'outreach_send_token', attemptedAt: 'outreach_attempted_at', sentAt: 'outreach_sent_at', label: 'Outreach' },
  followUp: { instanceKind: 'followup', action: 'outreach_followup', status: 'follow_up_status', token: 'follow_up_send_token', attemptedAt: 'follow_up_attempted_at', sentAt: 'follow_up_sent_at', label: 'Follow-up' },
});
const kindOf = (followUp) => (followUp ? KIND.followUp : KIND.initial);

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
function checkSendPreconditions({ prospect, gateOn, dailyCount, cap, followUp = false, late = false }) {
  if (!gateOn) return { ok: false, code: 'gate_off' };
  if (!prospect) return { ok: false, code: 'not_found' };
  if (!OUTREACH_TYPE_SET.has(prospect.link_type)) return { ok: false, code: 'not_outreach' };
  if (followUp) return checkFollowUpPreconditions({ prospect, dailyCount, cap });
  // a follow-up still ambiguous from an earlier cycle (a recovered row reopened before its reconcile) may have reached
  // the inbox: no new pitch until the Sent folder settles it (the same rule the initial lane applies to its own states)
  if (M.AMBIGUOUS_SEND_STATUSES.includes(prospect.follow_up_status)) return { ok: false, code: 'needs_reconcile' };
  if (prospect.outreach_sent_at || prospect.outreach_status === 'sent') {
    return { ok: false, code: 'already_sent' };
  }
  // Only an open (or owner-parked) prospect is sendable — a row moved to a terminal
  // lifecycle status (lost/rejected/placed/contacted) must not be sent even if a stale draft lingers.
  if (!SENDABLE_STATUSES.includes(prospect.status) && !late) return { ok: false, code: 'not_actionable' };
  if (prospect.outreach_status !== 'drafted') return { ok: false, code: 'no_draft' };
  const bad = draftRefusal(M.draftOf(prospect, false));
  if (bad) return bad;
  if (dailyCount >= cap) return { ok: false, code: 'rate_limited' };
  return { ok: true };
}
// what a send needs of its draft, the pitch's or the follow-up's (M.draftOf): a valid recipient, a subject, a body —
// the one reader for the preconditions and the locked claim
const draftRefusal = (draft) => (!isValidEmail(draft.outreach_to_email) ? { ok: false, code: 'invalid_recipient' }
  : !draft.outreach_subject || !draft.outreach_body ? { ok: false, code: 'incomplete_draft' } : null);
// the follow-up's shape (§6.4): the initial pitch went out, ONE follow-up ever, drafted, to the thread's recipient. The
// lifecycle status is narrowed against the PATH under the lock (FOLLOW_UP_STATUSES: the Judge-owned statuses count
// only on a submit-first path); here the widest set the lane ever accepts.
function checkFollowUpPreconditions({ prospect, dailyCount, cap }) {
  if (prospect.outreach_status !== 'sent') return { ok: false, code: 'no_initial_send' };
  if (prospect.follow_up_sent_at || prospect.follow_up_status === 'sent') return { ok: false, code: 'already_sent' };
  if (!M.FOLLOW_UP_STATUSES_ANY.includes(prospect.status)) return { ok: false, code: 'not_actionable' };
  if (prospect.follow_up_status !== 'drafted') return { ok: false, code: 'no_draft' };
  const bad = draftRefusal(M.draftOf(prospect, true));
  if (bad) return bad;
  if (dailyCount >= cap) return { ok: false, code: 'rate_limited' };
  return { ok: true };
}

/**
 * Sends counted toward the daily cap = anything ATTEMPTED since the start of the current ET calendar day
 * (outreach_attempted_at, stamped at claim time). A calendar day, not a trailing 24h window: the ONE automatic
 * dispatcher is the 3:35 ET nightly, and a trailing window measured from its start still held the previous
 * night's attempts (stamped seconds after that run began) — the first candidate read rate_limited and the whole
 * batch aborted every other night. Counting by attempt — not outcome —
 * means in-flight ('sending'), completed ('sent'), AND ambiguous ('send_error', which
 * may have reached Gmail) all count, so a timeout can't quietly let the cap be
 * exceeded. Cleared on re-draft. Parameterized so it can run inside the claim txn.
 */
// A reopened lost-recovery row keeps every previous attempt in the append-only
// quality_signals.prior_outreach_attempts array (lost-link-recovery appends the
// stamp there so the resend can write its own); each in-window element counts.
const PRIOR_ATTEMPTS_SQL = "jsonb_array_elements_text(CASE WHEN jsonb_typeof(quality_signals -> 'prior_outreach_attempts') = 'array' THEN quality_signals -> 'prior_outreach_attempts' ELSE '[]'::jsonb END)";
const PRIOR_IN_WINDOW_COUNT_SQL = `(SELECT count(*) FROM ${PRIOR_ATTEMPTS_SQL} AS a WHERE a::timestamptz >= ?)`;
// A follow-up attempt (§6.4, follow_up_attempted_at) counts exactly like an initial one — both terms COALESCEd, so a
// NULL follow-up stamp never nulls the row's sum and drops the initial send from it: initial + follow-up sends can
// never exceed the daily limit.
async function dailySendCount(q = db, now = new Date()) {
  const since = parseETDateTime(`${etDateString(now)}T00:00`);
  const row = await q('seo_link_prospects')
    .whereRaw(`(outreach_attempted_at >= ? OR follow_up_attempted_at >= ? OR ${PRIOR_IN_WINDOW_COUNT_SQL} > 0)`, [since, since, since])
    // Current side COALESCEd: a NULL timestamp compares to NULL, and NULL + n is
    // NULL — which SUM would drop, counting an ordinary attempt as zero.
    .select(q.raw(`COALESCE(SUM(COALESCE((outreach_attempted_at >= ?)::int, 0) + COALESCE((follow_up_attempted_at >= ?)::int, 0) + ${PRIOR_IN_WINDOW_COUNT_SQL}), 0) AS c`, [since, since, since]))
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
  const draftPath = prospect.path_id && !SENDABLE_STATUSES.includes(prospect.status) ? await db('seo_link_acquisition_paths').where({ id: prospect.path_id }).first() : null;
  if (!SENDABLE_STATUSES.includes(prospect.status) && !lateSend(prospect, draftPath)) return { ok: false, code: 'not_actionable' };
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
    outreach_draft_attempts: 0,
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
      .where((b) => b.whereNull('lease_mode').orWhere('lease_mode', 'draft'))
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
async function sendOutreach({ prospectId, approvedBy = 'admin', mode = 'owner', reviewedLookupHash = null, draftHash = null, followUp = false, now }) {
  if (!SEND_MODES.includes(mode)) return { ok: false, code: 'bad_mode' };
  // an automatic send exists only under the authority contract (§7): nothing has stamped AUTO_OUTREACH otherwise
  if (mode === 'auto' && !isEnabled('linkAuthority')) return { ok: false, code: 'not_authorized', error: 'GATE_LINK_AUTHORITY is off — no automatic send' };
  const gateOn = isEnabled('linkProspectOutreach');
  const prospect = await db('seo_link_prospects').where({ id: prospectId }).first();
  const cap = dailyCap();
  const K = kindOf(followUp);
  // Fast-fail non-rate preconditions on the pre-read (dailyCount=0 → rate branch
  // no-ops; the cap is enforced atomically in the claim txn). The authoritative
  // content comes from the row the claim returns, not this read.
  const prePath = prospect?.path_id ? await db('seo_link_acquisition_paths').where({ id: prospect.path_id }).first() : null;
  const late = prospect && lateSend(prospect, prePath);
  const pre = checkSendPreconditions({ prospect, gateOn, dailyCount: 0, cap, followUp, late });
  if (!pre.ok) return pre;
  if (mode === 'auto' && !followUp && prospect.status !== 'prospect' && !late) return { ok: false, code: 'not_actionable' };

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
  const claim = await db.transaction((trx) => claimUnderLock(trx, { prospectId, prospect, cap, mode, reviewedLookupHash, draftHash, followUp, approvedBy, sendToken, now }))
    .catch((err) => { if (err instanceof Rollback) return err.result; throw err; });
  if (!claim.ok) return claim;
  const { row: claimed, authority, draft, thread } = claim;

  // Send the CLAIMED version (the locked claim validated it — recipient, subject, body).
  let sent;
  try {
    sent = await deliver({ draft, claimed, thread });
  } catch (err) {
    // AMBIGUOUS: a timeout/error here may have still reached Gmail (it accepted the
    // message but we never saw the response). Do NOT reopen to 'drafted' — that would
    // let a retry duplicate-send. Park it in a non-sendable reconciliation state; a
    // human checks the Sent folder and re-drafts only if it truly didn't go out.
    await markSendError(prospectId, sendToken, followUp);
    // Log a code/name only — a raw Gmail error message can echo the recipient (PII).
    logger.error(`[link-outreach] ${K.label.toLowerCase()} send failed (ambiguous) for ${prospectId} (code=${(err && (err.code || err.name)) || 'unknown'}) — needs reconciliation`);
    return { ok: false, code: 'send_failed', error: err && err.message };
  }
  const ids = { message_id: sent.id || null, thread_id: sent.threadId || null };
  const threadRef = ids.thread_id || ids.message_id;
  const rows = await finalizeSend({ prospectId, sendToken, claimed, authority, threadRef, approvedBy, followUp });

  // The email DID send. If finalize somehow matched ≠1 row, surface it loudly for
  // manual reconciliation rather than reporting a clean success (or silently retrying).
  if (rows.length !== 1) {
    logger.error(`[link-outreach] FINALIZE MISSED after a successful send for ${prospectId} msg=${ids.message_id} thread=${threadRef} — reconcile manually`);
    return { ok: false, code: 'finalize_failed', ...ids, error: 'email sent but DB finalize matched no row; reconcile manually' };
  }
  logger.info(`[link-outreach] ${K.label.toLowerCase()} sent ${prospectId} msg=${ids.message_id} thread=${threadRef} mode=${mode}`); // no recipient (PII)
  return { ok: true, prospect: rows[0], ...ids, authority: authority.rowId ? { level: authority.level, approval_id: authority.approvalId } : null };
}

// the Gmail call: a follow-up (the claim carries the thread check) joins the pitch's thread and answers its message
// (In-Reply-To), so the recipient's client threads it too; the pitch opens a new thread
const deliver = ({ draft, claimed, thread }) => (thread
  ? gmailClient.sendMessage(draft.outreach_to_email, draft.outreach_subject, textToHtml(draft.outreach_body), claimed.outreach_thread_ref, thread.inReplyTo)
  : gmailClient.sendMessage(draft.outreach_to_email, draft.outreach_subject, textToHtml(draft.outreach_body)));

// §13 on a follow-up whose thread recipient is an identified customer / lead contact: the recipient cannot change (the
// pitch's counterpart is re-addressed on the board), so the follow-up ENDS — skipped, the conversation completes and the
// closure sweep releases the inbox. The sender applies it on either mode; the owner queue applies it in place of a card
// nothing could ever send. CAS on the drafted state.
async function closeCustomerRecipientFollowUp(q, prospectId, now = new Date()) {
  const n = await q('seo_link_prospects').where({ id: prospectId, follow_up_status: 'drafted' }).update({ follow_up_status: 'skipped', follow_up_skipped_reason: 'customer_recipient', updated_at: now });
  if (n) logger.info(`[link-outreach] follow-up for ${prospectId} skipped: the thread's recipient is a customer contact`);
  return n;
}

// The follow-up a confirmed PITCH schedules (§6.4: one, ten ET days out) — under the authority contract ONLY: with
// GATE_LINK_AUTHORITY off no follow-up can ever send (sendAuthority refuses it, the bridge decides nothing), so a
// scheduled one would sit none / due forever and the closure sweep (sent / skipped only) would never release the inbox
// or the domain — it is settled skipped at once instead
const followUpSchedule = (sentAt) => (isEnabled('linkAuthority')
  ? { follow_up_status: 'none', follow_up_due_at: M.followUpDueAt(sentAt), follow_up_skipped_reason: null }
  : { follow_up_status: 'skipped', follow_up_due_at: null, follow_up_skipped_reason: M.GATE_OFF_REASON });

// Finalize ONLY our own claim (the send token still matches). The token is private
// to the send path, so this can't be stranded by an unrelated updated_at write.
// The communication instance is satisfied and its approval consumed in the
// same transaction (§3.3b: only satisfaction proves the send happened).
async function finalizeSend({ prospectId, sendToken, claimed, authority, threadRef, approvedBy, followUp = false }) {
  const now = new Date();
  const K = kindOf(followUp);
  const note = `${K.label} sent ${now.toISOString()} to ${claimed.outreach_to_email} by ${approvedBy}`;
  return db.transaction(async (trx) => {
    const release = { claimed_at: null, claimed_by: null, notes: claimed.notes ? `${claimed.notes}\n${note}` : note, updated_at: now };
    const own = () => trx('seo_link_prospects').where({ id: prospectId, [K.token]: sendToken });
    let r;
    if (followUp) {
      // the follow-up settles on its own columns only — the row's lifecycle (contacted, or a Judge-owned placed /
      // live / indexed on a submit-first path) is never touched by it (§6.4)
      r = await own().update({ ...release, follow_up_status: 'sent', follow_up_sent_at: now, follow_up_send_token: null, follow_up_skipped_reason: null }).returning('*'); // an owner-routing marker is spent by the send
    } else {
      // the initial pitch schedules its ONE follow-up (+10 days, §6.4); the draft for it is leased once it is due
      const sent = { ...release, outreach_status: 'sent', outreach_sent_at: now, outreach_thread_ref: threadRef, outreach_send_token: null, ...followUpSchedule(now) };
      // a row still awaiting its conversation leaves the park by the send itself (→ contacted); a lifecycle the admin
      // advanced while Gmail was being called (lost / watching / placed …) is the later decision and stays — the send
      // stamp alone lands on it (the reconcile keeps a hand-advanced lifecycle the same way)
      r = await own().whereIn('status', [...SENDABLE_STATUSES]).update({ ...sent, status: 'contacted', parked_from_status: null }).returning('*');
      if (!(r || []).length) r = await own().update(sent).returning('*');
    }
    const rows = r || [];
    if (rows.length === 1 && authority.rowId) await satisfySendInstance(trx, { prospectId, rowId: authority.rowId, now, followUp });
    return rows;
  });
}

/**
 * The locked claim phase of a send, in order:
 *   locks — the outreach cap lock; the placement's DOMAIN (the registry's per-domain writer lock: an owner
 *     Reject / Watch, an investigator re-rank and the bridge all take it before their row locks, so a domain
 *     decision commits before or after this claim, never inside it — the manual status edit orders domain →
 *     inbox → row, the order kept here); the recipient's INBOX (the §13 guard); then the prospect row;
 *   the row and path the send acts on (lockedSendRow) → the draft the click DISPLAYED (`draftHash`, §3.6b: the
 *     card's hash must equal the locked draft's — a draft edited under an open card, in another tab or by another
 *     operator, is not the text this admin reviewed, and an owner's approval never binds text the owner never read;
 *     every click entry — both routes and the queue's sendRow — requires the hash, the automatic send has no card) →
 *     the recipient review (reviewRecipient) → the cap (capRefusal) → the authority (sendAuthority) → the
 *     drafted→sending CAS.
 * Returns { ok, row, authority } or a refusal; a refusal after the authority step wrote an approval is THROWN
 * (Rollback) so nothing commits.
 */
async function claimUnderLock(trx, { prospectId, prospect, cap, mode, reviewedLookupHash, draftHash = null, followUp = false, approvedBy, sendToken, now = null }) {
  const K = kindOf(followUp);
  await trx.raw('SELECT pg_advisory_xact_lock(?)', [OUTREACH_LOCK_KEY]);
  await lockProspectDomain(trx, prospect.target_domain);
  // the inbox guard, serialized on the recipient the pre-read draft names; the locked row must still name it below
  const inbox = M.normalizeEmail(prospect.outreach_to_email);
  const open = await inboxConflict(trx, { recipient: inbox, excludeId: prospectId });
  if (open) return { ok: false, code: 'inbox_in_flight', error: `another placement already has a conversation with this recipient (${open.status}${open.outreach_status ? ` / ${open.outreach_status}` : ''}) — one conversation per inbox` };
  // prospect → path lock order, same as saveDraft (settlement locks the path)
  await trx('seo_link_prospects').where({ id: prospectId }).forUpdate().first('id');
  // the policy row LOCKED for the claim (prospect → policy → path): the §6.4 cap below and the §7 authority decide under
  // it, and `updatePolicy` locks the same row — a tightening cannot commit between this read and the send
  const { policy } = await P.loadPolicy(trx, { lock: true });
  const locked = await lockedSendRow(trx, { prospectId, prospect, mode, inbox, followUp });
  if (!locked.ok) return locked;
  const { current, onPath, draft } = locked;
  if (draftHash != null && M.draftHash(draft) !== draftHash) return { ok: false, code: 'draft_changed', error: 'the draft changed while you looked at it — reload and read the current text before sending' };
  const attemptAt = now || new Date();
  const reviewed = await reviewRecipient(trx, { prospectId, recipient: draft.outreach_to_email, mode, reviewedLookupHash });
  if (!reviewed.ok) return followUp ? settleRecipientRefusal(trx, { prospectId, reviewed, mode, now: attemptAt }) : reviewed;
  // checked BEFORE the authority step so a capped click never records an approval for a send that did not happen
  const capped = await capRefusal(trx, { mode, policy, cap, now: attemptAt });
  if (capped) return capped;
  // §6.4 — the reply check, BEFORE any authority is granted: a follow-up is never sent without a successful
  // lookup proving silence; a reply or a bounce settles the follow-up as skipped (committed — no approval exists
  // yet), a lookup failure refuses it and leaves the draft for a later attempt (a pitch has no thread to read)
  const thread = await replyCheck(trx, { prospectId, current, mode, now: attemptAt, followUp });
  if (!thread.ok) return thread;
  // §7 — the authority contract, re-validated under the same lock as the claim.
  // From here on the owner's approval may have been written: a refusal below
  // ROLLS the transaction BACK (thrown, caught by the caller) rather than
  // committing an approval for a send that never claimed.
  const authority = await sendAuthority(trx, { placement: current, path: onPath, policy, mode, draft, review: reviewed.review, approvedBy, now: attemptAt, followUp });
  if (!authority.ok) return authority;
  // the CAS is bound to the path whose standing was just verified, to the status the checks read, and to the
  // draft state of THIS send's columns (the initial pitch's, or the follow-up's)
  let cas = trx('seo_link_prospects').where({ id: prospectId, [K.status]: 'drafted', status: current.status, path_id: current.path_id }).whereNull(K.sentAt);
  if (followUp) cas = cas.where({ outreach_status: 'sent' });
  const claimedRows = await cas
    // Stamp the attempt (counts toward the cap regardless of outcome) and release any
    // Hermes lease as we take the row in-flight, so a stale worker report (optimistic
    // concurrency on claimed_at) can't overwrite the send.
    // — and drop any closure stamp a reopened row still carries: from here the conversation is OPEN for the §13 guard
    .update({ [K.status]: 'sending', [K.token]: sendToken, [K.attemptedAt]: attemptAt, claimed_at: null, claimed_by: null, leased_provider: null, lease_mode: null, conversation_closed_at: null, updated_at: attemptAt })
    .returning('*');
  if (!claimedRows || claimedRows.length === 0) throw new Rollback({ ok: false, code: 'already_sent' });
  return { ok: true, row: claimedRows[0], authority, draft, thread };
}

// §13 on a FOLLOW-UP whose recipient the claim refused — the recipient is the THREAD's and cannot be replaced (the
// pitch's counterpart is re-addressed on the board): an identified customer / lead contact is a hard block for
// everyone, so the follow-up ENDS (skipped; the conversation completes and the closure sweep releases the inbox)
// rather than staying a drafted row the nightly retries and the card can never send; a shared business domain is a
// STABLE refusal of an AUTOMATIC attempt (only the owner's click acknowledges the match) — marked on the row so the
// nightly re-decides the follow-up OWNER_OUTREACH and the card offers it, rather than retrying an invisible AUTO row
// every night. Any other refusal stands as the review returned it.
async function settleRecipientRefusal(trx, { prospectId, reviewed, mode, now }) {
  if (reviewed.code === 'customer_recipient') {
    await closeCustomerRecipientFollowUp(trx, prospectId, now);
    return { ...reviewed, error: `${reviewed.error} — the follow-up is closed (the thread's recipient cannot change)` };
  }
  if (mode === 'auto' && reviewed.code === 'recipient_review_required') {
    await trx('seo_link_prospects').where({ id: prospectId, follow_up_status: 'drafted' }).update({ follow_up_skipped_reason: M.RECIPIENT_REVIEW_REQUIRED, updated_at: now });
    return { ...reviewed, error: `${reviewed.error} — routed to the owner` };
  }
  return reviewed;
}

// a header value from a Gmail metadata-format message
const headerOf = (msg, name) => { const h = ((msg && msg.payload && msg.payload.headers) || []).find((x) => String(x.name || '').toLowerCase() === name.toLowerCase()); return h ? String(h.value || '') : ''; };
const addressOf = (from) => { const m = /<([^>]+)>/.exec(from || ''); return M.normalizeEmail(m ? m[1] : from); };
// a Gmail message's send time: internalDate (ms), else its Date header; null when neither parses
const sentAtOf = (msg) => { const t = msg && msg.internalDate ? new Date(Number(msg.internalDate)) : new Date(headerOf(msg, 'Date')); return Number.isNaN(t.getTime()) ? null : t; };
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref())]);
/**
 * §6.4 — the fail-closed reply check inside the locked claim: the pitch's Gmail thread is read (`threads.get` on
 * outreach_thread_ref); any message not from our own address is a reply, a mailer-daemon / postmaster message is a
 * bounce — either settles the follow-up `skipped` in this transaction (CAS on the drafted row) and refuses the send;
 * a lookup error, an empty thread, a timeout or a missing thread ref refuses (reply_check_failed) and — on an
 * AUTOMATIC attempt — parks the follow-up for the owner (plan §6.4: never sent by default after a failed lookup):
 * the failure is stamped on the placement (follow_up_skipped_reason, the draft stays drafted), followUpReview then
 * reads the follow-up as the owner's, the nightly re-selects the domain ON THE MARKER (the failure is stamped with the
 * run's own clock, equal to decided_at — no timestamp would), re-decides it OWNER_OUTREACH and the auto dispatch leaves it; the
 * owner's click re-runs the check, fail-closed the same way. Silence returns the pitch's Message-ID so the follow-up
 * answers it. A pitch has no thread to read: ok, nothing to answer.
 */
async function replyCheck(trx, { prospectId, current, mode, now, followUp }) {
  if (!followUp) return { ok: true, inReplyTo: null };
  const failed = async (why) => {
    if (mode === 'auto') await trx('seo_link_prospects').where({ id: prospectId, follow_up_status: 'drafted' }).update({ follow_up_skipped_reason: M.REPLY_CHECK_FAILED, updated_at: now });
    return { ok: false, code: 'reply_check_failed', error: `${why}; the follow-up is not sent without proof of silence${mode === 'auto' ? ' — routed to the owner' : ' — retry later'}` };
  };
  if (!current.outreach_thread_ref) return failed('the pitch carries no Gmail thread reference');
  let messages;
  try {
    const thread = await withTimeout(gmailClient.getThread(current.outreach_thread_ref), REPLY_CHECK_TIMEOUT_MS);
    messages = (thread && thread.messages) || [];
    if (!messages.length) throw new Error('empty thread');
  } catch (err) {
    logger.error(`[link-outreach] reply check failed for ${prospectId} (code=${(err && (err.code || err.name)) || 'unknown'}) — follow-up not sent`);
    return failed('the Gmail thread lookup failed');
  }
  const own = M.normalizeEmail(gmailClient.ownAddress());
  const froms = messages.map((m) => addressOf(headerOf(m, 'From')));
  // …and a SECOND message of our own in the thread is a follow-up already sent by hand from the inbox (the owner
  // answering silence before the due date): the ONE follow-up the plan allows exists — the scheduled one settles. A
  // Gmail DRAFT in the thread (threads.get lists it, own address, DRAFT label) was never sent: not a follow-up
  const ownSent = messages.filter((m, i) => froms[i] === own && !(m.labelIds || []).includes('DRAFT'));
  const reason = froms.some((a) => /^(mailer-daemon|postmaster)@/.test(a)) ? 'bounce'
    : froms.some((a) => a && a !== own) ? 'reply'
      : ownSent.length > 1 ? 'manual_follow_up' : null;
  if (reason) {
    // the hand-sent follow-up IS the conversation's last send: its time is stamped as the follow-up's (the closure
    // sweep's silence window runs from it), the latest own message's Gmail time — or, unreadable, the check's own
    const manualAt = reason === 'manual_follow_up' ? (ownSent.slice(1).map(sentAtOf).filter(Boolean).sort((a, b) => b - a)[0] || now) : null;
    await trx('seo_link_prospects').where({ id: prospectId, follow_up_status: 'drafted' }).update({ follow_up_status: 'skipped', follow_up_skipped_reason: reason, ...(manualAt ? { follow_up_sent_at: manualAt } : {}), updated_at: now });
    logger.info(`[link-outreach] follow-up for ${prospectId} skipped: ${reason}`);
    const refusal = { bounce: ['bounced', 'the pitch bounced — no follow-up'], reply: ['reply_received', 'the recipient replied — the conversation is the owner\'s; no automatic follow-up'], manual_follow_up: ['follow_up_in_thread', 'a follow-up was already sent from the inbox by hand — the one follow-up exists; the scheduled one is settled'] }[reason];
    return { ok: false, code: refusal[0], error: refusal[1] };
  }
  return { ok: true, inReplyTo: headerOf(messages[0], 'Message-ID') || null };
}

// a path a send may act on: live (not superseded) and STANDING — an assessed confidence (NULL = never assessed) and
// no human-step ruling (agent_completable=false); settlement reconciles a disproof only against a lease stamp, so a
// later disproof or ruling on the same path is re-checked at the send
const pathStanding = (path) => Boolean(path) && !path.superseded_by && require('./link-registry').isStandingConfidence(path.confidence) && path.agent_completable !== false;
// the draft is bound to the path's CURRENT revision: a stamp that no longer matches means the path changed in place
// after the draft was written (terms, lane, URL). The stamp is REQUIRED — every draft carries one (the lease that
// produced it, saveDraft, or the migration's backfill), so a missing stamp is a draft nothing bound to a revision
const boundToRevision = (row, path) => row.leased_path_revision != null && path.revision != null && Number(path.revision) === Number(row.leased_path_revision);

/**
 * The row and path a claim will send on, read under the row lock. Settlement first: the draft's acquisition path may
 * have been superseded, revised or disproven since it was saved, and a settlement that moves the row has cleared the
 * draft (composed for a retired route) — abort rather than email obsolete copy; once the row is `sending` settlement
 * refuses to touch it. Zero moved is not proof of a live path (a chain settlement can fail to resolve or refuse), so
 * the re-read row must still be sendable, on the domain the claim locked, and linked to a path — an UNLINKED
 * prospect has passed no standing check at all — read FOR UPDATE and held through the CAS (as worker.claim() holds
 * its path locks through the lease), standing, and at the revision the draft was bound to. The LOCKED draft is what
 * the claim sends (its hash is what an approval binds to and what the customer exclusion reviews): it must be
 * complete and still addressed to the inbox the claim locked. Returns { ok, current, onPath, draft } or a refusal.
 */
async function lockedSendRow(trx, { prospectId, prospect, mode, inbox, followUp = false }) {
  const moved = await require('./link-registry').settleRetiredPlacements(trx, { prospectIds: [prospectId] });
  if (moved) return { ok: false, code: 'path_moved' };
  const current = await trx('seo_link_prospects').where({ id: prospectId }).first();
  if (current?.claimed_at && current.lease_mode === 'acquire') return { ok: false, code: 'acquisition_in_progress', error: 'A submission is in progress; retry after its lease settles.' };
  const onPath = current?.path_id ? await trx('seo_link_acquisition_paths').where({ id: current.path_id }).forUpdate().first() : null;
  const late = current && lateSend(current, onPath);
  const sendable = followUp
    ? current && current.outreach_status === 'sent' && current.follow_up_status === 'drafted'
    : current && (SENDABLE_STATUSES.includes(current.status) || late) && (mode !== 'auto' || current.status === 'prospect' || late) && !M.AMBIGUOUS_SEND_STATUSES.includes(current.follow_up_status);
  if (!sendable) return { ok: false, code: 'not_actionable' };
  if (current.target_domain !== prospect.target_domain) return { ok: false, code: 'not_actionable', error: 'the placement moved to another domain while you looked at it — reload and send again' };
  if (!current.path_id && !followUp) return { ok: false, code: 'path_unlinked', error: 'this prospect is not linked to an acquisition path yet; the registry catch-up links it within the hour' };
  // the pitch sends on a standing path at the revision the draft was bound to; the drafted follow-up's route is
  // SETTLED here (retired, re-drafted or refused — settleDraftedFollowUp), the one place that reads its binding
  const settled = followUp
    ? await settleDraftedFollowUp(trx, { prospectId, current, onPath, mode })
    : (pathStanding(onPath) && boundToRevision(current, onPath) ? null : { ok: false, code: 'path_moved' });
  if (settled) return settled;
  const draft = M.draftOf(current, followUp);
  const bad = draftRefusal(draft);
  if (bad) return bad;
  if (M.normalizeEmail(draft.outreach_to_email) !== inbox) return { ok: false, code: 'recipient_changed', error: 'the draft was re-addressed while you looked at it — reload and send again' };
  return { ok: true, current, onPath, draft };
}

/**
 * The drafted FOLLOW-UP's route settlement at the send (§6.4), under the row and path locks of the claim. A sent
 * conversation is pinned to its path (the mover never re-paths it) and the drafter re-leases none / due only, so a
 * draft whose route moved could only ever refuse here — it is settled instead, the way the lease and the drafter's
 * report settle a due one (followUpRetirement): the path SUPERSEDED after the draft → the follow-up RETIRES (skipped;
 * the conversation completes and the closure sweep releases the inbox); a path not standing for another reason (a
 * disproof, a human-step ruling) may recover → the plain refusal, the draft waits; bound to an EARLIER REVISION of a
 * standing path (terms, lane, URL changed in place) → back to due, the draft cleared, re-drafted against the current
 * route by the next sweep; the placement OUT of the path's follow-up lifecycle → refused; the DOMAIN RE-RANKED to
 * another path → the pinned conversation is frozen off the best path (no authority is ever decided for it) → RETIRES.
 * First of all: an AUTOMATIC attempt after an earlier one was refused on an owner marker (reply check failed, recipient
 * review required) is not the queue's to make — the follow-up is the owner's (followUpReview reads the marker).
 * Returns the refusal, or null when the draft may send.
 */
async function settleDraftedFollowUp(trx, { prospectId, current, onPath, mode }) {
  if (mode === 'auto' && M.OWNER_MARKERS.includes(current.follow_up_skipped_reason)) return { ok: false, code: 'not_authorized', error: `an earlier automatic attempt was refused (${current.follow_up_skipped_reason}) — the follow-up is the owner's` };
  const drafted = () => trx('seo_link_prospects').where({ id: prospectId, follow_up_status: 'drafted', path_id: current.path_id });
  // the contract OFF after the draft (a redeploy), or the path DELETED after the draft (FK SET NULL — the due claim
  // cannot reclaim it, no card can act on it): nothing can ever send it — retired on this attempt, as the lease
  // retires a due one (followUpRetirement), so the conversation completes and the closure sweep releases the inbox
  const gone = !isEnabled('linkAuthority') ? M.GATE_OFF_REASON : !current.path_id ? M.followUpRetirement({ row: current, path: null }) : null;
  if (gone) {
    await drafted().update({ follow_up_status: 'skipped', follow_up_skipped_reason: gone, updated_at: new Date() });
    logger.info(`[link-outreach] follow-up for ${prospectId} retired — ${gone}`);
    return { ok: false, code: current.path_id ? 'not_authorized' : 'path_moved', error: `${gone}; the follow-up is retired` };
  }
  if (onPath && onPath.superseded_by) {
    await drafted().update({ follow_up_status: 'skipped', follow_up_skipped_reason: 'acquisition path superseded before the follow-up', updated_at: new Date() });
    logger.info(`[link-outreach] follow-up for ${prospectId} retired — its acquisition path was superseded after the draft`);
    return { ok: false, code: 'path_moved', error: 'the acquisition path was superseded after the follow-up was drafted; the follow-up is retired' };
  }
  if (!pathStanding(onPath)) return { ok: false, code: 'path_moved' };
  if (!boundToRevision(current, onPath)) {
    await drafted().update({ follow_up_status: 'due', follow_up_subject: null, follow_up_body: null, follow_up_skipped_reason: null, updated_at: new Date() });
    logger.info(`[link-outreach] follow-up for ${prospectId} drafted on path revision ${current.leased_path_revision}, path now ${onPath.revision} — back to due for a re-draft`);
    return { ok: false, code: 'path_moved', error: 'the acquisition path changed after the follow-up was drafted; the draft was discarded — it is re-drafted against the current route' };
  }
  if (!M.FOLLOW_UP_STATUSES(onPath).includes(current.status)) return { ok: false, code: 'not_actionable', error: `the placement is ${current.status} — no follow-up on this path from there` };
  const dom = current.domain_id ? await trx('seo_link_domains').where({ id: current.domain_id }).first('best_path_id') : null;
  if (dom && dom.best_path_id && dom.best_path_id !== current.path_id) {
    await drafted().update({ follow_up_status: 'skipped', follow_up_skipped_reason: 'domain re-ranked to another path before the follow-up', updated_at: new Date() });
    logger.info(`[link-outreach] follow-up for ${prospectId} retired — its domain re-ranked to another path after the draft`);
    return { ok: false, code: 'not_authorized', error: 'the domain re-ranked to another path after the follow-up was drafted; the follow-up is retired' };
  }
  return null;
}

/**
 * §13 — the customer exclusion, inside EVERY send claim, auto and owner alike: an identified customer contact is a
 * hard block; a shared business domain sends only on the owner's click carrying the lookup hash it reviewed; a lookup
 * failure is fail-closed. Returns { ok, review } or a refusal (the review attached, so the owner acknowledges the
 * match the claim computed).
 */
async function reviewRecipient(trx, { prospectId, recipient, mode, reviewedLookupHash }) {
  let review;
  try { review = await M.recipientReview(trx, recipient); } catch (err) {
    logger.error(`[link-outreach] recipient lookup failed for ${prospectId} (code=${(err && (err.code || err.name)) || 'unknown'}) — parked`);
    return { ok: false, code: 'recipient_lookup_failed', error: 'the customer-recipient lookup failed; not sent (fail-closed) — retry, or review the recipient' };
  }
  if (review.kind === 'customer') return { ok: false, code: 'customer_recipient', review, error: 'the recipient is a customer contact — outreach never goes to a customer' };
  if (review.kind === 'ambiguous' && (mode === 'auto' || reviewedLookupHash !== review.lookup_hash)) {
    return { ok: false, code: 'recipient_review_required', review, error: 'the recipient shares a domain with a customer or lead contact — review the match, then send with it acknowledged' };
  }
  return { ok: true, review };
}

/**
 * The cap, enforced ONLY here under the claim lock (§6.4): an automatic send is bounded by the OWNER's policy value
 * as well as the hard ceiling — a policy cap of 0 (the shipped default) authorizes no automatic send at all; an
 * owner-approved send keeps the hard cap only. Returns a refusal or null.
 */
async function capRefusal(trx, { mode, policy, cap, now }) {
  const policyCap = Number(policy.auto_outreach_daily_cap);
  if (mode === 'auto' && !(Number.isFinite(policyCap) && policyCap > 0)) return { ok: false, code: 'not_authorized', error: 'auto_outreach_daily_cap is 0 — automatic sends are off' };
  const effectiveCap = mode === 'auto' ? Math.min(policyCap, cap) : cap;
  if ((await dailySendCount(trx, now)) >= effectiveCap) return { ok: false, code: 'rate_limited' };
  return null;
}

/**
 * The §7 send gate, under the claim lock. With GATE_LINK_AUTHORITY off nothing
 * has decided a row, and the shipped owner click stands on its own (no row).
 * On: the placement's OPEN communication instance on the path it will send
 * on (openSendInstance) must be AUTO_OUTREACH, or an owner level holding an
 * approval bound to THIS draft's hash — an owner's click without one writes
 * that approval here (the click IS the approval, §6.3 2c), frozen with the
 * draft hash and the recipient review it resolved (bindSendApproval). A stale
 * stamp (inputs moved since the decision), a prior-path row, a send that would
 * legally accept terms, and every other level refuse: the nightly bridge
 * re-decides, the owner acts from the queue.
 */
async function sendAuthority(trx, { placement, path, policy, mode, draft, review, approvedBy, now, followUp = false }) {
  if (!isEnabled('linkAuthority')) {
    if (mode === 'auto') return { ok: false, code: 'not_authorized', error: 'GATE_LINK_AUTHORITY is off — no automatic send' };
    // a follow-up exists under the contract only (§6.4): its instance, its approval and its reply check are the contract's
    if (followUp) return { ok: false, code: 'not_authorized', error: 'GATE_LINK_AUTHORITY is off — follow-ups send under the authority contract only' };
    // the legacy click stands on its own only for a row nothing has decided: a placement the bridge PARKED
    // (awaiting_owner) carries open owner decisions (a price, a signed agreement, a legal send) the send would clear
    // unchecked while the gate is off — it waits for the gate or the card
    if (placement.status !== 'prospect') return { ok: false, code: 'not_authorized', error: 'GATE_LINK_AUTHORITY is off — this placement was parked by the authority bridge and keeps its open decisions; re-enable the gate or decide it on the card' };
    return { ok: true, rowId: null, approvalId: null, level: null };
  }
  const instance = await openSendInstance(trx, { placement, path, policy, followUp });
  if (!instance.ok) return instance;
  const { row } = instance;
  // the send clears the park (finalizeSend: a parked row leaves it by the send itself) — never while ANOTHER owner
  // decision on the placement still stands: the queue lists parked placements only, so that card would vanish with
  // its decision open (a price the owner must enter, a signed agreement); a payment deferred past the send is not a hold
  const hold = await require('./link-authority-bridge').openOwnerHold(trx, { placement, path, exceptRowId: row.id });
  if (hold) return { ok: false, code: 'not_authorized', error: `another owner decision on this placement is still open (${hold.dimension}: ${hold.level}) — the send would clear its park; decide it on the card first` };
  const level = sendLevel({ row, placement, draft, review, mode, followUp });
  if (!level.ok) return level;
  if (!level.approvalLevel) return { ok: true, rowId: row.id, approvalId: null, level: row.level };
  const approval = await bindSendApproval(trx, { ...instance, placement, path, draft, review, approvalLevel: level.approvalLevel, approvedBy, now, followUp });
  return { ok: true, rowId: row.id, approvalId: approval.id, level: row.level };
}

// the domain must still be the bridge's to send on — the owner's Reject / Watch stands (decideDomain leaves the rows
// open; agent_state is not in the hash) — AND the placement must sit on the route the registry selects NOW: a re-rank
// to another live path leaves the placement on the old one until the bridge moves it (settlement follows supersession
// only). The Owner queue's Approve refuses both the same way.
function domainRefusal(domain, path) {
  if (!domain) return { ok: false, code: 'not_authorized', error: 'the placement is not bound to a registry domain' };
  if (!BRIDGE_STATES.includes(domain.agent_state)) return { ok: false, code: 'not_authorized', error: `the domain is ${String(domain.agent_state).replace(/_/g, ' ')} — the owner's domain decision stands; reopen it first` };
  if (!domain.best_path_id || domain.best_path_id !== path.id) return { ok: false, code: 'not_authorized', error: 'the placement is no longer on the domain\'s best path — the nightly bridge rotates it' };
  return null;
}

// A submit-first pitch follows completed execution on its own path. Verifier promotion alone does not complete
// that step; the sender and both approval views use this predicate over the active execution instance.
function submitStepOwed(path, execution) {
  return P.submitFirst(path || {}) && (execution?.path_id !== path.id || !execution?.satisfied_at);
}

/**
 * The placement's OPEN communication instance on the path it will send on, validated: decided, unsatisfied, on
 * this path, on a domain the bridge still owns at its best path, its decision inputs unchanged, NOT a send that
 * itself accepts the publisher's terms (the co-transactional accept_terms instance is not built — refused before
 * any level can grant, an AUTO_OUTREACH row included, plan §3.3b), and no submit-first step still owed. Returns
 * { ok, row, ctx, hash, revision } or a refusal.
 */
async function openSendInstance(trx, { placement, path, policy, followUp = false }) {
  const K = kindOf(followUp);
  const row = await trx(AUTH).where({ prospect_id: placement.id, dimension: 'communication', instance_kind: K.instanceKind }).whereNull('ended_at').first();
  if (!row) return { ok: false, code: 'not_authorized', error: `no ${followUp ? 'follow-up ' : ''}send authority decided for this placement yet — the nightly bridge decides it first` };
  if (row.satisfied_at) return { ok: false, code: 'already_sent' };
  if (followUp && !(await initialSendSatisfied(trx, placement))) return { ok: false, code: 'not_authorized', error: 'the initial send is not recorded as satisfied — the follow-up waits for it' };
  if (row.path_id !== path.id) return { ok: false, code: 'not_authorized', error: 'the send authority was decided on a prior path — the nightly bridge rotates it' };
  // read under the domain lock the claim holds (every domain writer takes it first), so no forUpdate row-lock order to keep
  const domain = placement.domain_id ? await trx('seo_link_domains').where({ id: placement.domain_id }).first() : null;
  const refused = domainRefusal(domain, path);
  if (refused) return refused;
  const ctx = { path, domain, policy, score: domain.score, instanceKey: row.instance_key };
  const hash = P.decisionInputsHash('communication', ctx);
  const revision = Number(path.revision_communication ?? path.revision ?? 1);
  if (hash !== row.decision_inputs_hash || Number(row.path_revision) !== revision) return { ok: false, code: 'not_authorized', error: 'the send inputs changed since the authority was decided — the nightly bridge re-decides it' };
  if (path.terms_accepted_by_send === true) return { ok: false, code: 'not_authorized', error: 'sending this pitch accepts the publisher\'s terms — the co-transactional terms acceptance is not available yet' };
  // an attested path whose agreement the owner cannot open authorizes nothing — the queue's Approve refuses the same
  // way (link-owner-queue), and the board's direct send is not the way around it
  if (path.legal_attestation === true && !require('./link-owner-queue').legalTermsUrlOf(path)) return { ok: false, code: 'not_authorized', error: 'the agreement is not viewable (no terms url in the evidence) — re-investigate before sending' };
  if (row.level === P.LEVELS.AUTO_OUTREACH && !stillAutoOutreach(row, ctx, followUp)) return { ok: false, code: 'not_authorized', error: 'the outreach policy moved since the automatic decision — the nightly bridge re-decides it' };
  const execution = await trx(AUTH).where({ prospect_id: placement.id, dimension: 'execution', instance_kind: '-' }).whereNull('ended_at').first('path_id', 'satisfied_at');
  if (submitStepOwed(path, execution)) return { ok: false, code: 'not_authorized', error: 'submit-first path: the pitch follows the publisher\'s form / account step, which has not completed' };
  return { ok: true, row, ctx, hash, revision };
}

// `outreach_followup` requires the initial send SATISFIED (§3.3b: a durable prerequisite is completed, not merely
// authorized) — the row-level sent stamp is the placement's evidence, the instance is the contract's
async function initialSendSatisfied(trx, placement) {
  const initial = await trx(AUTH).where({ prospect_id: placement.id, dimension: 'communication', instance_kind: '-' }).whereNull('ended_at').first('id', 'satisfied_at');
  return Boolean(initial && initial.satisfied_at);
}

// An AUTO_OUTREACH stamp is honoured only while the CURRENT policy still grants it: the mandate fields the owner
// tightens (auto_outreach_min_score, legal_attestation_requires_owner, the cap) are outside the decision hash by
// design (a policy edit re-decides through the nightly), but the nightly re-decides its domain batch only, so a row
// outside that batch could send under the superseded policy. The pure decision is re-run here on the inputs the hash
// just verified (the draft's cleanliness is re-reviewed by sendLevel), under the waiver the stamped row stands on.
const stillAutoOutreach = (row, { path, domain, policy, score }, followUp = false) => P.decideAuthority({ path, domain, policy, score, draftClean: true, followUp, waiver: row.floor_waiver_id ? { id: row.floor_waiver_id } : null })
  .instances.some((i) => i.dimension === 'communication' && i.instance_kind === kindOf(followUp).instanceKind && i.level === P.LEVELS.AUTO_OUTREACH);

/**
 * What the row's level lets THIS click do. An AUTO_OUTREACH row sends on its own — the draft is deliberately
 * outside the decision hash (the approval binds it), so a draft edited after the nightly stamped AUTO_OUTREACH is
 * re-reviewed on the LOCKED text in EVERY mode, and an unclean one is not this row's to send (no approval can bind
 * it to an AUTO level, §3.6b): the nightly re-decides it OWNER_* and the owner's click then writes the approval for
 * that text. The owner's decision on an ambiguous recipient (§13) is RECORDED even when the level itself needs no
 * approval: on an AUTO_OUTREACH row the click writes an OWNER_OUTREACH approval carrying the acknowledged match. An
 * owner level sends on the owner's click only. Returns { ok, approvalLevel } (null = nothing to write) or a refusal.
 */
function sendLevel({ row, placement, draft, review, mode, followUp }) {
  const ownerResolvesMatch = mode === 'owner' && review.kind === 'ambiguous';
  if (row.level === P.LEVELS.AUTO_OUTREACH) {
    // the LOCKED text of this send is what the mandate re-reviews — the follow-up by its OWN review (the follow-up's
    // shape against the pitch's subject, the owner-routing marker), the pitch by the bare text (`draft` IS the locked
    // row's columns in both cases)
    const clean = followUp ? M.followUpReview(placement).clean : M.reviewDraft({ to: draft.outreach_to_email, subject: draft.outreach_subject, body: draft.outreach_body }).clean;
    if (!clean) return { ok: false, code: 'not_authorized', error: 'the draft changed since the automatic decision and is no longer clean — the nightly bridge re-decides it for the owner' };
    return { ok: true, approvalLevel: ownerResolvesMatch ? P.LEVELS.OWNER_OUTREACH : null };
  }
  if (mode === 'auto') return { ok: false, code: 'not_authorized', error: `${row.level}: the owner's click is the send authority` };
  if (row.level !== P.LEVELS.OWNER_OUTREACH && row.level !== P.LEVELS.OWNER_LEGAL) return { ok: false, code: 'not_authorized', error: `${row.level} authorizes no send` };
  return { ok: true, approvalLevel: row.level };
}

const liveSendApproval = (a, action = 'outreach_send') => Boolean(a) && a.decision === 'approved' && !a.invalidated_at && !a.consumed_at && a.action === action;
const approvalSnapshot = (a) => (typeof a.terms_snapshot === 'string' ? JSON.parse(a.terms_snapshot) : a.terms_snapshot || {});
/**
 * The approval the click stands on. The row's live approval is reused only for THIS text AND THIS recipient review
 * (§13 binds the match the owner looked at): a contact added since (clear → ambiguous / customer), a resolved match
 * or an edited draft makes it another decision — the old approval is spent and the click writes a fresh one, frozen
 * with the decision inputs, the draft hash and the review it resolved (§6.3 2c). Returns the approval row.
 */
async function bindSendApproval(trx, { row, ctx, hash, revision, placement, path, draft, review, approvalLevel, approvedBy, now, followUp = false }) {
  const K = kindOf(followUp);
  const actionHash = M.draftHash(draft);
  const prior = row.approval_id ? await trx('seo_link_approvals').where({ id: row.approval_id }).first() : null;
  if (liveSendApproval(prior, K.action)) {
    const sameText = prior.action_hash === actionHash;
    const snap = approvalSnapshot(prior);
    if (sameText && snap.recipient_review && snap.recipient_review.lookup_hash === review.lookup_hash) return prior;
    await trx('seo_link_approvals').where({ id: prior.id }).update({ invalidated_at: now, invalidated_reason: sameText ? 'recipient review changed after the approval' : 'draft changed after the approval', updated_at: now });
  }
  const snapshot = { ...P.decisionInputs('communication', ctx), draft_hash: actionHash, recipient_review: { recipient: review.recipient, match_kind: review.kind, matched_ids: review.matched, lookup_hash: review.lookup_hash } };
  // the exact agreement the owner read travels with EVERY approval on an attested path (§3.6b) — the queue's Approve
  // records it the same way (link-owner-queue), so a send-written OWNER_LEGAL approval carries the same evidence
  if (path.legal_attestation === true) snapshot.legal_terms_url = require('./link-owner-queue').legalTermsUrlOf(path);
  const [approval] = await trx('seo_link_approvals').insert({
    prospect_id: placement.id, path_id: path.id, path_revision: revision, decision_inputs_hash: hash,
    money_action: false, decision: 'approved', authority: approvalLevel, approved_amount_cents: null, max_payable_cents: null, terms_snapshot: snapshot,
    dimension: 'communication', action: K.action, instance_key: row.instance_key, action_hash: actionHash,
    approved_by: approvedBy, approved_at: now, created_at: now, updated_at: now,
  }).returning('*');
  await trx(AUTH).where({ id: row.id }).update({ approval_id: approval.id, updated_at: now });
  return approval;
}

// a confirmed send: the instance is satisfied, its approval consumed (§3.6b). Without the claim's row id (a
// reconciled send) the instance is the open one on the placement's path at the revision the send was bound to
// (leased_path_revision) — never a later generation rotated in since.
async function satisfySendInstance(trx, { prospectId, rowId = null, now, followUp = false }) {
  let rows;
  if (rowId) rows = await trx(AUTH).where({ id: rowId }).whereNull('satisfied_at').select('id', 'approval_id');
  else {
    // the draft's stamp is the path's OVERALL revision at the draft; the row's is the COMMUNICATION revision (§3.6b): the
    // send's instance is the open row at the path's current communication revision, provided the COMMUNICATION inputs did
    // not change since the draft — a per-dimension revision carries the overall revision of the change that last moved
    // it, so a communication revision above the draft's stamp is a later generation (never satisfied by this send),
    // while a payment / execution change after the attempt (overall revision moved, communication revision not) leaves
    // the send's own instance in place — it is satisfied, and the approval the owner gave for it is consumed
    const p = await trx('seo_link_prospects').where({ id: prospectId }).first('path_id', 'leased_path_revision');
    if (!p || !p.path_id || p.leased_path_revision == null) return 0;
    const path = await trx('seo_link_acquisition_paths').where({ id: p.path_id }).first('id', 'revision', 'revision_communication');
    if (!path) return 0;
    const commRevision = Number(path.revision_communication ?? path.revision ?? 1);
    if (commRevision > Number(p.leased_path_revision)) return 0;
    rows = (await trx(AUTH).where({ prospect_id: prospectId, dimension: 'communication', instance_kind: kindOf(followUp).instanceKind, path_id: p.path_id }).whereNull('ended_at').whereNull('satisfied_at').select('id', 'approval_id', 'path_revision'))
      .filter((r) => Number(r.path_revision) === commRevision);
  }
  if (!rows.length) return 0;
  await trx(AUTH).whereIn('id', rows.map((r) => r.id)).update({ satisfied_at: now, satisfied_reason: 'sent', updated_at: now });
  const approvalIds = rows.map((r) => r.approval_id).filter(Boolean);
  if (approvalIds.length) await trx('seo_link_approvals').whereIn('id', approvalIds).whereNull('consumed_at').update({ consumed_at: now, updated_at: now });
  return rows.length;
}

// Park OUR claim in a non-sendable 'send_error' state after an AMBIGUOUS send (the
// message may have reached Gmail). Token-gated so it can't touch a newer claim. Stays
// out of the sendable path (checkSendPreconditions requires 'drafted') until a human
// reconciles and deliberately re-drafts.
async function markSendError(prospectId, sendToken, followUp = false) {
  const K = kindOf(followUp);
  return db('seo_link_prospects')
    .where({ id: prospectId, [K.token]: sendToken })
    .update({ [K.status]: 'send_error', [K.token]: null, updated_at: new Date() });
}

const RECONCILE_OUTCOMES = ['sent', 'requeue', 'skip']; // 'skip' = a follow-up only (the owner's terminal review of one nothing can verify)
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
async function reconcileSendError({ prospectId, outcome, approvedBy = 'admin', followUp = false }) {
  if (!RECONCILE_OUTCOMES.includes(outcome)) return { ok: false, code: 'bad_outcome' };
  const prospect = await db('seo_link_prospects').where({ id: prospectId }).first();
  if (!prospect) return { ok: false, code: 'not_found' };
  if (outcome === 'skip' && !followUp) return { ok: false, code: 'bad_outcome', error: 'skip settles a follow-up only — a pitch is re-queued or re-drafted' };
  return followUp ? reconcileFollowUp({ prospect, outcome, approvedBy }) : reconcileInitial({ prospect, outcome, approvedBy });
}

// the pitch's reconcile: over the outreach columns and, on 'sent', the lifecycle a still-awaiting row opens
async function reconcileInitial({ prospect, outcome, approvedBy }) {
  const prospectId = prospect.id;
  const st = prospect.outreach_status;
  const updatedMs = prospect.updated_at ? new Date(prospect.updated_at).getTime() : 0;
  const staleSending = st === 'sending' && Date.now() - updatedMs >= STALE_SENDING_MS;
  if (st === 'sending' && !staleSending) return { ok: false, code: 'send_in_flight' };
  if (st !== 'send_error' && !staleSending) return { ok: false, code: 'not_reconcilable' };
  // a re-queued draft is listed by the pending queue and accepted by the sender only on a row still awaiting its
  // conversation: a row moved on by hand (watching / lost / placed …) would take a draft nothing lists or sends
  const path = prospect.path_id && outcome === 'requeue' && !SENDABLE_STATUSES.includes(prospect.status) ? await db('seo_link_acquisition_paths').where({ id: prospect.path_id }).first() : null;
  if (outcome === 'requeue' && !SENDABLE_STATUSES.includes(prospect.status) && !lateSend(prospect, path)) return { ok: false, code: 'not_requeueable', error: `the placement has moved on (${prospect.status}) — a re-queued draft would be listed nowhere and sent by nothing; move it back to prospect first, or settle the send as sent` };

  const now = new Date();
  const note = outcome === 'sent'
    ? `Outreach reconciled as SENT ${now.toISOString()} by ${approvedBy}`
    : `Outreach reconciled as NOT sent (re-queued) ${now.toISOString()} by ${approvedBy}`;
  // a confirmed send opens the conversation (→ contacted) on a row still awaiting one; a row whose lifecycle the
  // admin already advanced by hand (watching / lost / placed …) keeps that lifecycle — only the send stamp settles
  const sentAt = prospect.outreach_sent_at || now;
  // the confirmed pitch schedules its follow-up like a clean send does (§6.4) — ONLY when the send left a Gmail thread
  // reference for the reply check to read (an errored send captured none, and the reconcile cannot supply one): a
  // pitch confirmed from the Sent folder without a thread grows no follow-up; its silence is the owner's read
  const schedule = prospect.outreach_thread_ref ? followUpSchedule(sentAt) : {};
  const patch = outcome === 'sent'
    ? {
        ...(SENDABLE_STATUSES.includes(prospect.status) ? { status: 'contacted', parked_from_status: null } : {}),
        outreach_status: 'sent',
        outreach_sent_at: sentAt,
        outreach_send_token: null,
        ...schedule,
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
  // Atomic on the EXACT row we observed — its send state AND its send token (null for a
  // send_error) AND its lifecycle status: the patch above was decided on that status (a
  // hand-advanced row keeps it; an awaiting one opens the conversation), so a concurrent
  // lifecycle edit, like a cycled claim (sending→drafted→a fresh send), matches 0 rows
  // instead of being overwritten.
  const rows = await db.transaction(async (trx) => {
    let q = trx('seo_link_prospects').where({ id: prospectId, outreach_status: st, status: prospect.status });
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

// whether a drafted follow-up is the OWNER'S to settle (§6.4): the contract off (nothing else sends it), an owner
// marker from the automatic attempt, or the open follow-up instance decided OWNER_* by the policy. Read once before
// the reconcile's locks (the fast refusal) and AGAIN under them: the bridge may re-decide the instance AUTO between
// the card's read and the click, and a stale Skip must not settle a follow-up the queue now sends
async function ownerRoutedFollowUp(q, row) {
  if (!isEnabled('linkAuthority') || M.OWNER_MARKERS.includes(row.follow_up_skipped_reason)) return true;
  const open = await q(AUTH).where({ prospect_id: row.id, dimension: 'communication', instance_kind: 'followup' }).whereNull('ended_at').whereNull('satisfied_at').select('level');
  return open.some((r) => String(r.level || '').startsWith('OWNER_'));
}

// the reconcile's write (pure): 'sent' settles the follow-up sent; a retirement (`gone` — the owner's skip, or a route
// the requeue could not re-draft on) settles it skipped with the reason; a plain requeue returns it to drafted. The
// attempt stamp is cleared ONLY on a confirmed-not-sent requeue: a SKIP of an ambiguous attempt keeps it — Gmail may
// have delivered the message, and dailySendCount counts every attempt of the ET day against the cap (a sent
// reconcile keeps it for the same reason)
function followUpReconcilePatch({ outcome, gone, row, now, approvedBy }) {
  const at = now.toISOString();
  const note = outcome === 'sent' ? `Follow-up reconciled as SENT ${at} by ${approvedBy}`
    : outcome === 'skip' ? `Follow-up skipped ${at} by ${approvedBy} after review — ${gone}`
      : gone ? `Follow-up reconciled as NOT sent ${at} by ${approvedBy} — ${gone}; follow-up retired`
        : `Follow-up reconciled as NOT sent (re-queued) ${at} by ${approvedBy}`;
  const base = { follow_up_send_token: null, notes: row.notes ? `${row.notes}\n${note}` : note, updated_at: now };
  if (outcome === 'sent') return { ...base, follow_up_status: 'sent', follow_up_sent_at: row.follow_up_sent_at || now };
  if (gone) return { ...base, follow_up_status: 'skipped', follow_up_skipped_reason: gone, ...(outcome === 'skip' ? {} : { follow_up_attempted_at: null }) };
  return { ...base, follow_up_status: 'drafted', follow_up_attempted_at: null, follow_up_skipped_reason: null };
}

// the follow-up's reconcile (§6.4): the same Sent-folder decision over ITS columns — 'sent' settles it (the follow-up
// instance satisfied, the lifecycle untouched), 'requeue' returns it to drafted with the attempt cleared. Atomic on
// the follow-up state and token the read observed.
async function reconcileFollowUp({ prospect, outcome, approvedBy }) {
  const st = prospect.follow_up_status;
  // aged from the follow-up's own attempt stamp (immutable for the attempt), never the shared updated_at: the daily
  // verifier bumps that on a Judge-owned placed / live row and would make a crashed send read in flight again
  const attemptedMs = prospect.follow_up_attempted_at ? new Date(prospect.follow_up_attempted_at).getTime() : 0;
  const staleSending = st === 'sending' && Date.now() - attemptedMs >= STALE_SENDING_MS;
  if (st === 'sending' && !staleSending) return { ok: false, code: 'send_in_flight' };
  // the owner's TERMINAL review (§6.4): a drafted follow-up that is the OWNER'S to send — routed by the automatic
  // attempt on a marker (the thread unreadable for good: deleted, a 404 on every read; a recipient match the owner
  // will not acknowledge) or by the policy (unclean copy, a score outside the automatic threshold: the open follow-up
  // instance decided OWNER_*) — may be skipped outright: the queue never sends it, the Owner queue offers only Send,
  // and the conversation holds its inbox and domain until it is settled. Only an owner-routed drafted follow-up and the
  // ambiguous send states skip: an AUTO-decided draft is the queue's to send — unless the contract is OFF (nothing
  // sends it: the owner's skip is the one action left).
  const ownerRouted = st === 'drafted' && await ownerRoutedFollowUp(db, prospect);
  if (outcome === 'skip' && !ownerRouted && st !== 'send_error' && !staleSending) return { ok: false, code: 'not_reconcilable', error: 'only a follow-up that is yours to send (routed to you by the automatic attempt or the policy), or an ambiguous send, can be skipped' };
  if (outcome !== 'skip' && st !== 'send_error' && !staleSending) return { ok: false, code: 'not_reconcilable' };
  const now = new Date();
  // the decision is taken UNDER the row lock, on the row and path as they are in this transaction (never the caller's
  // pre-read): a requeue on a row that has LEFT the path-specific follow-up lifecycle (a send-first row the verifier
  // promoted to live while the send was in flight, or between the pre-read and this write) cannot yield a sendable
  // draft — the sender refuses it, followUpPending excludes it, the bridge ends its instance — so the follow-up
  // RETIRES (`skipped`) instead of parking a draft nowhere lists
  let retired = false;
  const rows = await db.transaction(async (trx) => {
    // under the locks every route writer takes (the per-domain lock, then the row, then the path FOR UPDATE — the
    // lease's and the send's order): a supersede / re-rank orders before or after this decision, never between the
    // route read and the CAS, so a requeue never parks a draft on a route that just moved
    await lockProspectDomain(trx, prospect.target_domain);
    const row = await trx('seo_link_prospects').where({ id: prospect.id }).forUpdate().first('id', 'status', 'path_id', 'domain_id', 'notes', 'follow_up_sent_at', 'follow_up_skipped_reason');
    if (!row) return [];
    if (outcome === 'skip' && st === 'drafted' && !(await ownerRoutedFollowUp(trx, row))) return []; // re-decided AUTO meanwhile: the queue's to send
    const path = row.path_id ? await trx('seo_link_acquisition_paths').where({ id: row.path_id }).forUpdate().first('id', 'execution_after_send', 'acquisition_type', 'account_required', 'superseded_by') : null;
    const dom = row.domain_id ? await trx('seo_link_domains').where({ id: row.domain_id }).first('best_path_id') : null;
    // …and a requeue cannot yield a sendable draft either when the ROUTE moved on under the pinned conversation — the
    // path superseded, or the domain re-ranked to another path — exactly the states the lease and the send retire
    const gone = outcome === 'sent' ? null
      : outcome === 'skip' ? `skipped by ${approvedBy} after review${prospect.follow_up_skipped_reason ? ` (${prospect.follow_up_skipped_reason})` : ''}`
        : M.followUpRetirement({ row, path, domain: dom });
    retired = Boolean(gone);
    const patch = followUpReconcilePatch({ outcome, gone, row, now, approvedBy });
    // the CAS the lane has always had (state + token), plus the lifecycle the decision was taken on
    let q = trx('seo_link_prospects').where({ id: prospect.id, follow_up_status: st, status: row.status, path_id: row.path_id });
    q = prospect.follow_up_send_token ? q.where({ follow_up_send_token: prospect.follow_up_send_token }) : q.whereNull('follow_up_send_token');
    const r = await q.update(patch).returning('*');
    if (outcome === 'sent' && r && r.length === 1) await satisfySendInstance(trx, { prospectId: prospect.id, now, followUp: true });
    // a requeue after a NOT-sent attempt: the owner's approval for THAT attempt is spent — invalidated, so the card
    // offers Send / Skip again instead of a stale "approved" label (the queue reads the approval as live authority)
    if (outcome === 'requeue' && r && r.length === 1) {
      const open = await trx(AUTH).where({ prospect_id: prospect.id, dimension: 'communication', instance_kind: 'followup' }).whereNull('ended_at').whereNull('satisfied_at').whereNotNull('approval_id').select('approval_id');
      if (open.length) await trx('seo_link_approvals').whereIn('id', open.map((x) => x.approval_id)).whereNull('invalidated_at').update({ invalidated_at: now, invalidated_reason: 'follow-up send re-queued after an ambiguous attempt — the next send needs a new click', updated_at: now });
    }
    return r;
  });
  if (!rows || rows.length === 0) return { ok: false, code: 'not_reconcilable' };
  logger.info(`[link-outreach] reconciled follow-up ${prospect.id} (${st}) as ${outcome}${retired ? ' (retired)' : ''} by ${approvedBy}`);
  return { ok: true, prospect: rows[0], ...(retired ? { retired: true } : {}) };
}

/**
 * §13 / §3.3 — the closure of a SILENT conversation. A send-first placement left `contacted` whose lane completed
 * (the pitch sent, its one follow-up sent or skipped — so no send is ambiguous and no follow-up is due / drafted /
 * in flight) and whose reply window has passed — CONVERSATION_SILENT_ET_DAYS ET calendar days since the last send —
 * with no inbound message in the thread is over: conversation_closed_at is stamped and the inbox is released for a
 * later placement (inboxConflict requires the stamp NULL). Silence is PROVED on the thread, as the follow-up's reply
 * check proves it: every message from our own address or from mailer-daemon / postmaster (a bounce is no inbound
 * match — the recipient never received the pitch). A thread with an inbound message is the owner's conversation and
 * stays open (a reply reopens nothing and closes nothing; the owner settles it by hand). A thread read that fails is
 * retried on the next sweep. A pitch reconciled as sent WITHOUT a thread reference is never closed here: its silence
 * cannot be read (the owner's). `limit` bounds the thread reads a run makes; a conversation the sweep leaves open (a
 * reply, a failed read) is stamped quality_signals.closure_checked_at and goes to the back of the line — never-checked
 * first, then least-recently checked — so replied conversations (the owner's, open until settled by hand) never
 * starve a newer silent one. The thread is read UNDER the locks the stamp is written under — the per-domain lock
 * every domain writer takes, then the row FOR UPDATE, as the send's reply check reads it inside the locked claim —
 * and the stamp is conditional on the state the candidate was read in, so a recovery cycle reopening the row (which
 * clears the stamp in its own transaction) or a hand-moved lifecycle is the later decision and wins. No lock reaches
 * Gmail: a reply landing after the read is a reply after the closure, and the plan rules on it (§13) — a reply
 * reopens nothing; a new conversation is a new placement. The closure is the sweep's read of a 45-day silence.
 */
const CONVERSATION_SILENT_ET_DAYS = 45;
const lastSendOf = (r) => r.follow_up_sent_at || r.outreach_sent_at;
const signalsOf = (r) => (r.quality_signals && typeof r.quality_signals === 'object' ? r.quality_signals : {});
const checkedAt = (r) => (signalsOf(r).closure_checked_at ? new Date(signalsOf(r).closure_checked_at).getTime() : 0);
async function closeSilentConversations({ now = new Date(), limit = 50 } = {}) {
  const out = { scanned: 0, closed: 0, open: 0, failed: 0 };
  // the authority contract OFF (a redeploy after follow-ups were scheduled): nothing visits a pending follow-up any
  // more — the drafter and the bridge are gated, no send is attempted — so THIS sweep, gated on the outreach lane
  // only, settles them (skipped, GATE_OFF_REASON: what the pitch stamps when it schedules under the gate off) and
  // the conversations below complete on the same run. A leased row belongs to its lease until the stale sweep.
  // A SCHEDULED follow-up only: `none` counts with a due date (the pitch's schedule) — a pre-migration send carries the
  // column default (`none`, no due date: never scheduled, left for the owner's review) and is not settled or closed here.
  if (!isEnabled('linkAuthority')) {
    const settle = (q) => q.where({ outreach_status: 'sent' }).whereNull('claimed_at').update({ follow_up_status: 'skipped', follow_up_due_at: null, follow_up_skipped_reason: M.GATE_OFF_REASON, updated_at: now });
    out.settled = (await settle(db('seo_link_prospects').whereIn('follow_up_status', ['due', 'drafted'])))
      + (await settle(db('seo_link_prospects').where({ follow_up_status: 'none' }).whereNotNull('follow_up_due_at')));
    if (out.settled) logger.info(`[link-outreach] closure: ${out.settled} pending follow-up(s) settled — ${M.GATE_OFF_REASON}`);
  }
  // silent = CONVERSATION_SILENT_ET_DAYS ET calendar days after the last send AT ITS ET WALL-CLOCK TIME (as the
  // follow-up's due date is computed) — never a bare calendar-day compare, which would release an evening send at
  // the 03:50 sweep of the 45th day, half a day early
  const silent = (r) => addETDaysAtWallClock(new Date(lastSendOf(r)), CONVERSATION_SILENT_ET_DAYS).getTime() <= now.getTime();
  // the completed-lane set is small (one row per conversation) — read whole, the window and the rotation applied in JS
  const candidates = (await db('seo_link_prospects')
    .where({ status: 'contacted', outreach_status: 'sent' })
    .whereIn('follow_up_status', ['sent', 'skipped'])
    .whereNull('conversation_closed_at')
    .whereNotNull('outreach_thread_ref')
    .whereNotNull('outreach_sent_at')
    .select('id', 'target_domain', 'follow_up_status', 'outreach_sent_at', 'follow_up_sent_at', 'outreach_thread_ref', 'quality_signals'))
    .filter(silent)
    .sort((a, b) => (checkedAt(a) - checkedAt(b)) || (new Date(lastSendOf(a)).getTime() - new Date(lastSendOf(b)).getTime()))
    .slice(0, limit);
  const own = M.normalizeEmail(gmailClient.ownAddress());
  const isInbound = (m) => { const a = addressOf(headerOf(m, 'From')); return Boolean(a) && a !== own && !/^(mailer-daemon|postmaster)@/.test(a); };
  for (const c of candidates) {
    out.scanned++;
    const verdict = await db.transaction(async (trx) => {
      await lockProspectDomain(trx, c.target_domain);
      const row = await trx('seo_link_prospects').where({ id: c.id }).forUpdate().first('id', 'notes', 'status', 'outreach_status', 'follow_up_status', 'conversation_closed_at', 'outreach_thread_ref', 'quality_signals');
      // left open this run (a reply, a failed read): to the back of the rotation — a sweep bookkeeping stamp, not a row edit (updated_at untouched)
      const checked = () => trx('seo_link_prospects').where({ id: c.id }).update({ quality_signals: { ...signalsOf(row), closure_checked_at: now.toISOString() } });
      // the state the candidate was read in, re-asserted under the locks: a row moved on meanwhile is not this sweep's;
      // the thread read follows, so the row cannot move between the read and the stamp
      if (!row || row.status !== 'contacted' || row.outreach_status !== 'sent' || row.follow_up_status !== c.follow_up_status || row.conversation_closed_at || !row.outreach_thread_ref) return 'moved';
      let messages;
      try {
        const thread = await withTimeout(gmailClient.getThread(row.outreach_thread_ref), REPLY_CHECK_TIMEOUT_MS);
        messages = (thread && thread.messages) || [];
        if (!messages.length) throw new Error('empty thread');
      } catch (err) {
        logger.warn(`[link-outreach] closure: thread read failed for ${c.id} (code=${(err && (err.code || err.name)) || 'unknown'}) — retried next sweep`);
        await checked();
        return 'failed';
      }
      if (messages.some(isInbound)) { await checked(); return 'open'; }
      const note = `Conversation closed ${now.toISOString()}: silent ${CONVERSATION_SILENT_ET_DAYS} ET days after the last send`;
      const n = await trx('seo_link_prospects')
        .where({ id: c.id, status: 'contacted', outreach_status: 'sent', follow_up_status: c.follow_up_status })
        .whereNull('conversation_closed_at')
        .update({ conversation_closed_at: now, notes: row.notes ? `${row.notes}\n${note}` : note, updated_at: now });
      return n ? 'closed' : 'moved';
    });
    if (verdict in out) out[verdict]++;
    if (verdict === 'closed') logger.info(`[link-outreach] closure: ${c.id} silent ${CONVERSATION_SILENT_ET_DAYS} ET days — conversation closed, inbox released`);
  }
  if (out.scanned) logger.info(`[link-outreach] closure: scanned ${out.scanned} closed ${out.closed} open ${out.open} failed ${out.failed}`);
  return out;
}

module.exports = {
  saveDraft,
  sendOutreach,
  closeCustomerRecipientFollowUp,
  closeSilentConversations,
  CONVERSATION_SILENT_ET_DAYS,
  sendAuthority,
  inboxConflict,
  SEND_MODES,
  reconcileSendError,
  dailySendCount,
  checkSendPreconditions,
  isValidEmail,
  textToHtml,
  dailyCap,
  DEFAULT_DAILY_CAP,
  STALE_SENDING_MS,
  REPLY_CHECK_TIMEOUT_MS,
  SENDABLE_STATUSES,
  lateSend,
  submitStepOwed,
  CONVERSATION_CLOSED_STATUSES,
  conversationOpen: CONVERSATION_OPEN,
  AMBIGUOUS_SEND_STATUSES: M.AMBIGUOUS_SEND_STATUSES,
};
