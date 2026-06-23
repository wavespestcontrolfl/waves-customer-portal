// Price-match draft service. Composes a Mark price-match email from proof-backed
// opportunities and stages it as a PENDING draft (no auto-send); an admin sends
// or dismisses it from /admin. The send target is the external SiteOne rep, so it
// only goes out on an explicit admin action — never from the model/cron loop.

const { randomUUID } = require('crypto');
const sendgrid = require('../sendgrid-mail');
const logger = require('../logger');
const { composeMarkEmail } = require('./mark-email');

// Mark Roczkowski, SiteOne rep. Overridable via env; defaults to the known
// address so the feature works without extra config.
const markEmail = () => process.env.MARK_EMAIL || 'mmroczkowski@siteone.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';

// Owner-copy notification: when a draft is STAGED (not sent), email the owner the
// exact composed draft plus a review link, so a staged draft never sits unseen.
// Opt-in (PRICE_MATCH_NOTIFY_OWNER=true) so it stays inert in dev/tests and is a
// flag-flip in prod. Recipient defaults to the owner address (the SendGrid from).
const ownerNotifyEnabled = () => process.env.PRICE_MATCH_NOTIFY_OWNER === 'true';
const ownerNotifyEmail = () => process.env.PRICE_MATCH_OWNER_EMAIL || fromEmail();
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');
// Bound the best-effort owner-copy send: SendGrid's fetch has no timeout and createDraft
// runs under the price-scan-weekly advisory lock, so a stalled request must not hold the
// lock/DB connection. It's a convenience email — timing out just skips it.
const OWNER_NOTIFY_TIMEOUT_MS = Number(process.env.PRICE_MATCH_NOTIFY_TIMEOUT_MS) || 8000;
const sameAddress = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// Resolve `promise` but reject if it hasn't settled within `ms`. Clears its timer so a
// fast resolve leaves no dangling handle.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// A 'sending' claim older than this is considered stuck (crash between claim and
// finalize) and is safe to reclaim — comfortably longer than any real send, so we
// never reopen a claim while sendDraft is still mid-flight. Used as a timestamp
// threshold INSIDE the conditional UPDATEs so the stale check is atomic.
const STALE_CLAIM_MS = 10 * 60 * 1000;
const staleBefore = (nowMs) => new Date(nowMs - STALE_CLAIM_MS);

// HTTP status of a SendGrid send failure, used to tell a DEFINITE rejection (4xx —
// not accepted) from an AMBIGUOUS 5xx/network failure (maybe accepted). Prefers the
// structured err.status that sendOne/apiCall set; falls back to parsing the
// "SendGrid <status>: ..." message so a definite rejection is still classified even
// if a mailer throws a plain Error.
function sendFailureStatus(err) {
  if (err && Number.isInteger(err.status)) return err.status;
  const m = err && typeof err.message === 'string' && err.message.match(/SendGrid (\d{3})\b/);
  return m ? Number(m[1]) : null;
}
const isDefiniteRejection = (err) => {
  const s = sendFailureStatus(err);
  return s != null && s >= 400 && s < 500;
};

// Compose + persist a PENDING draft from opportunities. Returns the row, or null
// when there's nothing proof-backed to ask Mark about (no empty drafts).
//   matches: see composeMarkEmail — each needs a competitor.source_url (proof).
async function createDraft(db, matches, opts = {}) {
  const composed = composeMarkEmail(matches, opts);
  if (!composed) return null;
  const [row] = await db('price_match_drafts')
    .insert({
      status: 'pending',
      recipient: opts.recipient || markEmail(),
      subject: composed.subject,
      html: composed.html,
      text_body: composed.text,
      // Persist ONLY the opportunities that made it into the email (proof-backed,
      // priced, positive savings) — never the raw input — so the admin review
      // snapshot matches exactly what will be sent (no proofless/no-savings rows
      // showing up in the review UI's proof links). Mirrors composed.includedCount.
      matches: JSON.stringify(composed.included || []),
      included_count: composed.includedCount,
    })
    .returning('*');
  // Best-effort owner copy AFTER the draft is persisted — never let a notify
  // failure lose the draft (the draft is the source of truth; the email is a
  // convenience). notifyOwnerOfStagedDraft swallows its own errors.
  await notifyOwnerOfStagedDraft(row, composed, opts);
  return row;
}

// Email the owner a copy of a freshly STAGED draft (the exact email that would go
// to Mark) plus a review link. Goes ONLY to the owner — never to Mark — and never
// throws: a mailer outage must not fail draft creation. No-op unless opted in.
// `opts.sendgrid` is injectable for tests.
async function notifyOwnerOfStagedDraft(row, composed, opts = {}) {
  if (!ownerNotifyEnabled()) return;
  const mailer = opts.sendgrid || sendgrid;
  try {
    if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) return;
    const to = ownerNotifyEmail();
    // FAIL CLOSED: the owner-copy address must never resolve to the external rep. A
    // mis-set PRICE_MATCH_OWNER_EMAIL (or a from-address fallback) that equals the draft
    // recipient would otherwise auto-deliver the draft to Mark before any admin approval,
    // breaking the never-auto-send invariant. Skip rather than leak.
    if (sameAddress(to, row.recipient) || sameAddress(to, markEmail())) {
      logger.warn(`[price-scan] owner draft-notify SKIPPED — owner-copy address resolves to the rep (${to}); set a distinct PRICE_MATCH_OWNER_EMAIL`);
      return;
    }
    const reviewUrl = `${adminPortalUrl()}/admin/price-match`;
    const n = row.included_count;
    const subject = `[Review] Price-match draft ready — ${n} ${n === 1 ? 'opportunity' : 'opportunities'} for Mark`;
    const banner = `A price-match draft was just staged. It has NOT been sent — review and send it from ${reviewUrl}. Below is the exact email that will go to Mark (${row.recipient}) once you approve it.`;
    const sendPromise = mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject,
      html: `<p>${banner}</p><hr/>${composed.html}`,
      text: `${banner}\n\n----\n\n${composed.text}`,
      categories: ['price-match', 'price-match-owner-copy'],
    });
    // Swallow a LATE rejection (if the timeout already won the race) so it can't surface
    // as an unhandled rejection; the awaited race below still reports a prompt failure.
    sendPromise.catch(() => {});
    await withTimeout(sendPromise, OWNER_NOTIFY_TIMEOUT_MS, 'owner draft-notify');
  } catch (err) {
    logger.warn(`[price-scan] owner draft-notify email failed (draft ${row && row.id}): ${err && err.message}`);
  }
}

// status may be a single value or an array (e.g. the 'active' view shows pending
// AND sending so a stuck claim is never hidden). Falsy status -> all.
async function listDrafts(db, { status = 'pending', limit = 50 } = {}) {
  const q = db('price_match_drafts').orderBy('created_at', 'desc').limit(limit);
  if (Array.isArray(status)) q.whereIn('status', status);
  else if (status) q.where({ status });
  return q;
}

async function getDraft(db, id) {
  return db('price_match_drafts').where({ id }).first();
}

// Send a PENDING draft to its recipient (Mark). Concurrency-safe: atomically
// CLAIMS the draft (pending -> sending) before sending, so two concurrent approve
// clicks can't both call sendOne; the loser matches zero rows and gets a conflict.
// A send failure releases the claim back to pending so it stays retryable.
// Returns { ok, draft?, messageId?, reason? }. sendgrid is injectable for tests.
async function sendDraft(db, id, { actor } = {}, deps = {}) {
  const mailer = deps.sendgrid || sendgrid;
  // Pre-flight: don't CLAIM a draft we definitely can't send. sendgrid.sendOne
  // throws before any network call when SENDGRID_API_KEY is missing; claiming
  // first would strand the draft in 'sending' until stale recovery, and each
  // retry would re-stick it. (Ambiguous transport failures AFTER the claim stay
  // claimed — a timeout isn't proof the email wasn't accepted.)
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    return { ok: false, reason: 'not_configured' };
  }
  // Unique per-claim token: the finalize update matches it, so a STALE send that
  // returns after the draft was reset + re-claimed can't finalize the newer claim.
  const token = deps.token || randomUUID();

  const claimed = await db('price_match_drafts')
    .where({ id, status: 'pending' })
    .update({ status: 'sending', claimed_at: db.fn.now(), claim_token: token })
    .returning('*');
  if (!claimed.length) {
    const existing = await getDraft(db, id);
    return existing ? { ok: false, reason: `already_${existing.status}` } : { ok: false, reason: 'not_found' };
  }
  const draft = claimed[0];

  // Durably record that a send is being ATTEMPTED against this claim BEFORE calling
  // SendGrid. Once this stamp is set the email may have gone out, so resetStuckDraft
  // will NOT reopen the row for a resend (that's how we avoid a duplicate external
  // email when the finalize write later fails). If THIS write fails we have not sent
  // yet, so bail without sending — the row is still attempt-unstamped and a later
  // stale reset can safely recover it.
  let stamped;
  try {
    stamped = await db('price_match_drafts')
      .where({ id, status: 'sending', claim_token: token })
      .update({ send_attempted_at: db.fn.now() })
      .returning('*');
  } catch (markErr) {
    return { ok: false, reason: 'send_attempt_unrecorded' };
  }
  // This is also a RE-CHECK that we still own the claim immediately before the
  // external send: if the worker paused and the row was reset/dismissed/re-claimed
  // in the meantime, the WHERE (claim_token) matches 0 rows. We no longer own this
  // send — abort BEFORE sendOne, or we'd email a dismissed draft or duplicate a
  // re-claimed one. (The current owner, if any, will send under its own claim.)
  if (!stamped.length) {
    return { ok: false, reason: 'claim_lost' };
  }

  let res;
  try {
    res = await mailer.sendOne({
      to: draft.recipient,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: draft.subject,
      html: draft.html,
      text: draft.text_body,
      categories: ['price-match'],
    });
  } catch (err) {
    // A 4xx from SendGrid means the request was RECEIVED and REJECTED (bad
    // sender/recipient, auth, validation) — the email was definitively NOT
    // accepted, so it's safe to RELEASE the claim back to pending and clear the
    // attempt stamp so the draft stays retryable (otherwise the send_attempted_at
    // guard would strand a clearly-failed send forever, recoverable only by DB
    // surgery). The release is claim-scoped, so it never touches a row we no
    // longer own.
    if (isDefiniteRejection(err)) {
      await db('price_match_drafts')
        .where({ id, status: 'sending', claim_token: token })
        .update({ status: 'pending', claimed_at: null, claim_token: null, send_attempted_at: null });
      return { ok: false, reason: 'rejected', status: sendFailureStatus(err) };
    }
    // Any other failure (5xx, or a network error/timeout with no status) is
    // AMBIGUOUS — SendGrid may have accepted the email — so do NOT reopen the
    // claim: an immediate retry could email the external rep twice. Leave it
    // 'sending' with send_attempted_at set; resetStuckDraft won't auto-resend it,
    // and an admin reconciles against SendGrid (then dismisses) if it's stuck.
    throw err;
  }

  // The email WAS sent. From here on a DB problem must NEVER surface as a normal
  // error: the route would 500, the draft would sit in 'sending', and after the
  // stale window an admin could reset + RE-SEND — a second identical price-match
  // email to the external rep. So a finalize that THROWS collapses to the same
  // reconcile result as a finalize that touches zero rows: report the send
  // happened, leave the row as-is, and let a human verify status vs. SendGrid
  // before any retry (the route logs reconcile as an error).
  let updated;
  try {
    updated = await db('price_match_drafts')
      .where({ id, status: 'sending', claim_token: token })
      .update({
        status: 'sent',
        sent_at: db.fn.now(),
        sent_by: actor || null,
        message_id: (res && res.messageId) || null,
      })
      .returning('*');
  } catch (finalizeErr) {
    return { ok: true, reconcile: true, messageId: res && res.messageId };
  }
  // Zero rows: our claim was reset/superseded by a newer claim, or a crash —
  // surface reconcile rather than silently reporting success OR overwriting the
  // newer claim.
  if (!updated.length) {
    return { ok: true, reconcile: true, messageId: res && res.messageId };
  }
  return { ok: true, draft: updated[0], messageId: res && res.messageId };
}

// Dismiss via ATOMIC conditional updates (the predicate lives in the WHERE, not a
// read-then-update, so a concurrent send-claim can't slip in between). Pending
// dismisses freely; a 'sending' row only if its claim is STALE — never yank a
// draft a send may still be mid-flight on.
async function dismissDraft(db, id, { actor, nowMs = Date.now() } = {}) {
  const set = { status: 'dismissed', dismissed_at: db.fn.now(), sent_by: actor || null };
  const [pending] = await db('price_match_drafts').where({ id, status: 'pending' }).update(set).returning('*');
  if (pending) return pending;
  const [stale] = await db('price_match_drafts')
    .where({ id, status: 'sending' })
    .where('claimed_at', '<', staleBefore(nowMs))
    .update({ ...set, claim_token: null })
    .returning('*');
  return stale || null;
}

// Recover a draft STUCK in 'sending' because it was claimed but the process died
// BEFORE the send was attempted: reset it to pending so it can be re-reviewed/sent.
// Two guards live IN the UPDATE so neither a fresh claim nor a sent-but-unfinalized
// row is ever reopened:
//   - claimed_at < staleBefore  — never touch a fresh in-flight claim.
//   - send_attempted_at IS NULL — never reopen a row whose send was attempted; the
//     email may already have reached Mark, so reopening it would risk a DUPLICATE
//     external send. Those stay 'sending' for manual reconcile (verify in SendGrid,
//     then dismiss) rather than auto-resend.
async function resetStuckDraft(db, id, { nowMs = Date.now() } = {}) {
  const [row] = await db('price_match_drafts')
    .where({ id, status: 'sending' })
    .where('claimed_at', '<', staleBefore(nowMs))
    .whereNull('send_attempted_at')
    .update({ status: 'pending', claimed_at: null, claim_token: null })
    .returning('*');
  return row || null;
}

module.exports = {
  createDraft, listDrafts, getDraft, sendDraft, dismissDraft, resetStuckDraft, markEmail,
};
