'use strict';

// A customer who unsubscribed from our emails can get them back without staff
// (GATE_PORTAL_EMAIL_RESUBSCRIBE, owner 2026-11-04, gap #18). Customers sign in
// with a phone code only, so nothing in the app proves they own the mailbox.
// So the app never releases a block itself. It asks for one email, "Turn Waves
// emails back on?", sent to the holder's own address on file. Only a click from
// that mailbox (POST /api/public/email-resubscribe/:token) undoes the block.
// Staff can still release a row with the Release button
// (admin-email-templates.js POST /suppressions/:id/release); that path is untouched.
//
// What counts as releasable (all must hold):
//   - active row covering the address (suppressionCoversEmail: exact + Gmail
//     mailbox equivalence), the same match the send path blocks on;
//   - suppression_type 'unsubscribe' only. Bounce, spam complaint and
//     do_not_email are facts about the address or a staff decision; an active
//     one on the address also stops the confirmation email from being sent;
//   - group_key NULL (blocks every stream) or 'service_operational'.
//     'marketing_newsletter' is NOT released here: newsletter consent has its
//     own double opt-in flow;
//   - made by the customer, not by staff. Two tests, because `source` is
//     mutable (the SendGrid webhook overwrites an existing active row's source
//     with 'sendgrid_event_webhook' when the same event arrives later):
//       1. source is one of the three customer-origin sources that exist in
//          prod: 'sendgrid_event_webhook' (webhooks-sendgrid.js
//          recordEmailSuppressionForEvent), and 'sendgrid_asm_backfill' and
//          'sendgrid_dropped_backfill_2026_06_01'. The two backfill sources are
//          NOT in the repo: one-off June 2026 prod imports of SendGrid's own
//          unsubscribe lists (unsubscribes the customers made at SendGrid).
//          Prod on 2026-11-04: 5 active global webhook unsubscribes, 2 active
//          service_operational asm-backfill rows, 1 active service_operational
//          dropped-webhook row, 1 active service group_unsubscribe; no
//          admin_manual rows; no row carries metadata.created_by.
//       2. metadata has no 'created_by' key. The admin create route
//          (admin-email-templates.js POST /suppressions) always writes that
//          key (value may be null) and the webhook's metadata merge never
//          writes it, so it survives the source overwrite and marks staff rows.
//
// SendGrid keeps its own unsubscribe lists. Left alone, the next send is
// dropped by SendGrid and the webhook re-creates the local block. So on the
// click the order is: clear SendGrid FIRST (clearSendgridBeforeRelease), then
// release locally, in a transaction under the address lock, only the rows whose
// SendGrid list was confirmed cleared. A failed clear leaves the rows active and
// the link unused, so the customer can click the button again.
//
// Between the SendGrid DELETE and the local release a newer opt-out can arrive:
// the webhook (recordEmailSuppressionForEvent) updates an existing ACTIVE row
// in place (same id) and SendGrid restores its own block. So the pre-read also
// captures each row's Postgres row version (xmin, which any update changes),
// and the release only touches a row whose version is unchanged under the lock.
// A changed row stays active; the customer can ask again.
//
// The request side (requestResubscribeEmail) stores only a sha256 of the token;
// the token itself exists only in the emailed link.

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { suppressionCoversEmail } = require('../utils/email-equivalence');

const RELEASABLE_SOURCES = ['sendgrid_event_webhook', 'sendgrid_asm_backfill', 'sendgrid_dropped_backfill_2026_06_01'];
const SERVICE_GROUP_KEY = 'service_operational';
const RELEASE_CONSENT_SOURCE = 'email_confirm_link';
const RELEASE_REASON = 'Customer confirmed by email link';
const SENDGRID_TIMEOUT_MS = 8000;
// Same three types the send path treats as stop-everything (email-template-library GLOBAL_SUPPRESSION_TYPES).
const HARD_BLOCK_TYPES = ['bounce', 'spam_complaint', 'do_not_email'];
const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RESEND_WINDOW_MS = 24 * 60 * 60 * 1000;
// 32 random bytes as base64url = 43 characters.
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

// Never log or store an error message: a database error can carry the SQL with
// the address binding, and a fetch error can carry the URL. Code or name only.
function errorWord(err) {
  if (err?.name === 'TimeoutError') return 'timeout';
  return String(err?.code || err?.name || 'error').replace(/[^\w.-]/g, '').slice(0, 60) || 'error';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ACTIVE customer-made unsubscribes that block this address (see the header).
async function releasableUnsubscribes(email, { dbh = db } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  return dbh('email_suppressions')
    .select('email_suppressions.*', dbh.raw('xmin::text AS row_version'))
    .where(suppressionCoversEmail(normalized))
    .where({ status: 'active', suppression_type: 'unsubscribe' })
    .whereIn('source', RELEASABLE_SOURCES)
    .whereRaw("(COALESCE(metadata, '{}'::jsonb) -> 'created_by') IS NULL")
    .where(function groupScope() {
      this.whereNull('group_key').orWhere('group_key', SERVICE_GROUP_KEY);
    })
    .orderBy('suppressed_at', 'asc');
}

// True when an active bounce / spam complaint / do-not-email row covers the address.
async function hasHardBlock(email, { dbh = db } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  const row = await dbh('email_suppressions')
    .where(suppressionCoversEmail(normalized))
    .where({ status: 'active' })
    .whereRaw(`LOWER(suppression_type) IN (${HARD_BLOCK_TYPES.map(() => '?').join(', ')})`, HARD_BLOCK_TYPES)
    .first('id');
  return !!row;
}

// `t***@gmail.com`. Never the whole local part.
function maskEmail(email) {
  const [local, domain] = normalizeEmail(email).split('@');
  if (!local || !domain) return '';
  return `${local[0]}***@${domain}`;
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const isTokenShape = (token) => typeof token === 'string' && TOKEN_RE.test(token);

// The latest request for this address that was actually emailed in the last 24 h.
async function recentSentRequest(email, { dbh = db, now = new Date() } = {}) {
  return dbh('email_resubscribe_requests')
    .whereRaw('lower(email) = ?', [normalizeEmail(email)])
    .where('sent_at', '>', new Date(now.getTime() - RESEND_WINDOW_MS))
    .orderBy('sent_at', 'desc')
    .first();
}

// What a request sent inside the 24 h cap means now. 'sent' = its link still works (unused,
// not expired), so the app says "check your email". 'wait' = the link was used or has expired,
// the cap still holds, and a new email can go out at nextAt (sent_at + 24 h).
function windowAnswer(request, maskedEmail, now) {
  const sentAt = new Date(request.sent_at);
  if (!request.used_at && new Date(request.expires_at) > now) return { state: 'sent', maskedEmail, sentAt: sentAt.toISOString() };
  return { state: 'wait', maskedEmail, nextAt: new Date(sentAt.getTime() + RESEND_WINDOW_MS).toISOString() };
}

// What the app shows for the holder's own address: null (nothing to do),
// { state: 'paused', maskedEmail, nextAt? } (nextAt = a link was already used today; ask again
// after it) or { state: 'sent', maskedEmail, sentAt } (a usable link was emailed).
// A bounce / spam complaint / do-not-email row hides the block, so the app
// never reveals why. Never throws: a read problem shows nothing.
async function resubscribeStatus(email, { dbh = db, now = new Date() } = {}) {
  try {
    const normalized = normalizeEmail(email);
    if (!normalized || !(await releasableUnsubscribes(normalized, { dbh })).length) return null;
    if (await hasHardBlock(normalized, { dbh })) return null;
    const maskedEmail = maskEmail(normalized);
    const recent = await recentSentRequest(normalized, { dbh, now });
    if (!recent) return { state: 'paused', maskedEmail };
    const { state, nextAt, ...rest } = windowAnswer(recent, maskedEmail, now);
    return state === 'sent' ? { state, ...rest } : { state: 'paused', maskedEmail, nextAt };
  } catch (err) {
    logger.warn(`[email-resubscribe] status lookup failed (${errorWord(err)})`);
    return null;
  }
}

// A send that never reached SendGrid (not configured, a guard refusal) or that SendGrid
// conclusively rejected (sendgrid-mail isDefiniteRejection) was NOT delivered. Anything else
// (timeout, network error, 5xx, an odd 4xx, no status) may have been accepted.
function sendDefinitelyFailed(err) {
  if (err?.code === 'SENDGRID_NOT_CONFIGURED' || err?.annualOfferWithheld || err?.annualOfferGuardFailed) return true;
  return require('./sendgrid-mail').isDefiniteRejection(err);
}

// A local hard block (bounce / spam complaint / do-not-email) is NOT enforced by SendGrid and
// sendOne does not read local suppressions, so the handoff re-checks it (same recipe as
// billing-channel-email-authority.js: a refusal tagged providerBoundaryBlocked).
function hardBlockRefusal() {
  const refusal = new Error('address has a hard block');
  refusal.code = 'hard_block';
  refusal.providerBoundaryBlocked = true;
  return refusal;
}

// POST /api/notifications/email-resubscribe, after the route checked the gate and the session.
// Transaction 1, under the per-address lock: nothing releasable or a hard block = send nothing; an
// email sent in the last 24 h = send nothing, answer 'sent' while its link still works, else
// 'wait'; else insert the request WITH sent_at = now (the durable send claim) and COMMIT, before
// any network call. Transaction 2 does the send: it takes the address lock again (the key every
// suppression writer takes), re-checks that the claim still stands and that no hard block has
// appeared since tx1 (a staff do_not_email added between the two would otherwise still be mailed),
// and calls the sender inside it with a providerBoundaryCheck that re-checks the hard blocks on
// that same transaction right before the fetch. The lock is held through the HTTP call, which is
// bounded to ~10 s. Outcomes:
//   - a hard block appeared (either check): nothing is sent, the claim is undone (sent_at null,
//     outcome { send_refused }), and the answer is 'not_paused';
//   - accepted: leave the claim as is;
//   - a definite rejection: undo the claim (sent_at null, outcome { send_failed }), 'failed', so a
//     retry can send;
//   - anything uncertain (timeout, reset, 5xx, no status): the email may have been delivered, so
//     the claim stays (the 24 h cap holds and the link works), outcome { send_uncertain }, and the
//     answer is 'sent'.
// Returns { state: 'not_paused' | 'sent' | 'wait' | 'failed', maskedEmail?, sentAt?, nextAt? }.
// Lock order: tx1 takes the address key then inserts a NEW request row (no other transaction can
// hold a row that does not exist yet). tx2 (a separate transaction, after tx1 committed) locks
// that request row FIRST (FOR UPDATE), then the address key, the same request row -> address key
// order as completeResubscribe, so a confirmation pressed while the send is still in flight waits
// on the row instead of deadlocking against the send's later settle() update.
async function requestResubscribeEmail({ customerId, email, firstName = '' }, { dbh = db, now = new Date() } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { state: 'not_paused' };
  const token = newToken();
  const claim = await dbh.transaction(async (trx) => {
    await require('../utils/customer-comms-lock').lockCustomerEmail(trx, normalized);
    if (!(await releasableUnsubscribes(normalized, { dbh: trx })).length || await hasHardBlock(normalized, { dbh: trx })) {
      return { answer: { state: 'not_paused' } };
    }
    const maskedEmail = maskEmail(normalized);
    const recent = await recentSentRequest(normalized, { dbh: trx, now });
    if (recent) return { answer: windowAnswer(recent, maskedEmail, now) };
    const [request] = await trx('email_resubscribe_requests').insert({
      email: normalized,
      customer_id: customerId || null,
      token_hash: hashToken(token),
      requested_at: now,
      sent_at: now,
      expires_at: new Date(now.getTime() + REQUEST_TTL_MS),
      outcome: JSON.stringify({ send_claimed: true }),
    }).returning(['id']);
    return { requestId: request.id, maskedEmail };
  });
  if (claim.answer) return claim.answer;
  return dbh.transaction((trx) => sendClaimedConfirmation(trx, { claim, normalized, token, firstName, now }));
}

// Transaction 2 of requestResubscribeEmail.
async function sendClaimedConfirmation(trx, { claim, normalized, token, firstName, now }) {
  // The request row first, then the address key (see the lock order note above).
  const stillClaimed = await trx('email_resubscribe_requests').where({ id: claim.requestId }).forUpdate().first();
  if (!stillClaimed || !stillClaimed.sent_at || stillClaimed.used_at) return { state: 'not_paused' };
  await require('../utils/customer-comms-lock').lockCustomerEmail(trx, normalized);
  const settle = (patch) => trx('email_resubscribe_requests').where({ id: claim.requestId }).update({ ...patch, updated_at: new Date() });
  const refuse = async () => {
    await settle({ sent_at: null, outcome: JSON.stringify({ send_refused: 'hard_block' }) });
    return { state: 'not_paused' };
  };
  if (await hasHardBlock(normalized, { dbh: trx })) return refuse();
  try {
    await require('./email-resubscribe-confirm').sendResubscribeConfirmation({
      to: normalized, token, firstName, database: trx,
      providerBoundaryCheck: async () => {
        if (await hasHardBlock(normalized, { dbh: trx })) throw hardBlockRefusal();
        return { ok: true };
      },
    });
  } catch (err) {
    if (err?.providerBoundaryBlocked) return refuse();
    const code = Number.isFinite(Number(err?.status)) ? `http_${Number(err.status)}` : errorWord(err);
    if (sendDefinitelyFailed(err)) {
      logger.warn(`[email-resubscribe] confirmation email rejected (${code})`);
      await settle({ sent_at: null, outcome: JSON.stringify({ send_failed: code }) });
      return { state: 'failed' };
    }
    logger.warn(`[email-resubscribe] confirmation email outcome uncertain (${code})`);
    await settle({ outcome: JSON.stringify({ send_uncertain: code }) });
    return { state: 'sent', maskedEmail: claim.maskedEmail, sentAt: now.toISOString() };
  }
  await settle({ outcome: JSON.stringify({ sent: true }) });
  return { state: 'sent', maskedEmail: claim.maskedEmail, sentAt: now.toISOString() };
}

// Runs on the caller's transaction, after clearSendgridBeforeRelease. Takes the
// shared per-address lock the SendGrid webhook writer takes, re-reads the
// releasable rows for the address as it stands under the lock, and releases
// only those whose id is in `onlyIds` (SendGrid confirmed that list cleared)
// AND whose row version still equals the one captured at the pre-read
// (`versionById`): a row updated since (a newer opt-out merged in place by the
// webhook) is left active. `sendgridClear` maps row id -> { ok: true, status,
// at }, written in the same update. No onlyIds = nothing released; an id with
// no captured version is not released.
async function releaseOwnUnsubscribes({ email, customerId = null, requestId = null, onlyIds = [], versionById = {}, sendgridClear = {} }, { dbh = db } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !onlyIds.length) return [];
  await require('../utils/customer-comms-lock').lockCustomerEmail(dbh, normalized);
  const allowed = new Set(onlyIds.map(String));
  const rows = (await releasableUnsubscribes(normalized, { dbh }))
    .filter((row) => allowed.has(String(row.id)) && versionById[row.id] && versionById[row.id] === row.row_version);
  const now = new Date();
  const released = [];
  for (const row of rows) {
    const metadata = {
      released_via: RELEASE_CONSENT_SOURCE,
      release_reason: RELEASE_REASON,
      released_by: null,
      released_for_customer_id: customerId == null ? null : String(customerId),
      request_id: requestId == null ? null : String(requestId),
      sendgrid_clear: sendgridClear[row.id] || null,
    };
    const [updated] = await dbh('email_suppressions')
      .where({ id: row.id, status: 'active' })
      .whereRaw('xmin::text = ?', [versionById[row.id]])
      .update({
        status: 'released',
        released_at: now,
        updated_at: now,
        consent_source: RELEASE_CONSENT_SOURCE,
        consent_timestamp: now,
        metadata: dbh.raw('COALESCE(metadata, \'{}\'::jsonb) || ?::jsonb', [JSON.stringify(metadata)]),
      })
      .returning('*');
    if (updated) released.push(updated);
  }
  return released;
}

async function sendgridDelete(path) {
  try {
    const res = await fetch(`https://api.sendgrid.com/v3${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });
    // 404 = the address was not on that list: already clear.
    if (res.ok || res.status === 404) return { ok: true, status: res.status };
    return { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, reason: errorWord(err) };
  }
}

// One DELETE per list the address's rows came from, in parallel so the worst
// case stays one timeout. A list that cannot be attempted is a failure.
async function clearAddressLists(email, { global, service }) {
  const encoded = encodeURIComponent(email);
  const serviceGroup = String(process.env.SENDGRID_ASM_GROUP_SERVICE || '').trim();
  const attempt = (wanted, path, missing) => {
    if (!wanted) return Promise.resolve(null);
    if (missing) return Promise.resolve({ ok: false, reason: missing });
    return sendgridDelete(path);
  };
  const noKey = process.env.SENDGRID_API_KEY ? null : 'no_api_key';
  const [globalResult, serviceResult] = await Promise.all([
    attempt(global, `/asm/suppressions/global/${encoded}`, noKey),
    attempt(service, `/asm/groups/${encodeURIComponent(serviceGroup)}/suppressions/${encoded}`,
      noKey || (serviceGroup ? null : 'service_group_not_configured')),
  ]);
  return { global: globalResult, service: serviceResult };
}

// Distinct stored addresses with the list(s) their rows came from.
function sendgridTargets(rows) {
  const byEmail = new Map();
  for (const row of rows) {
    const key = String(row.email || '').trim();
    if (!key) continue;
    const entry = byEmail.get(key) || { global: false, service: false };
    if (!row.group_key) entry.global = true;
    else if (row.group_key === SERVICE_GROUP_KEY) entry.service = true;
    byEmail.set(key, entry);
  }
  return byEmail;
}

// Call BEFORE the route's transaction. Reads the releasable rows (no lock) and
// clears SendGrid's list for each (global for a NULL-group row, the service ASM
// group for a service_operational row; the address exactly as stored). Never
// throws. `clearedIds` = rows whose list SendGrid confirmed cleared (2xx or
// 404); `clearById` = the note to stamp on each; `versionById` = each cleared
// row's row version at the pre-read. Anything else (no key, no
// service group id, timeout, HTTP error) leaves its rows out and is logged.
async function clearSendgridBeforeRelease(email, { dbh = db } = {}) {
  const result = { clearedIds: [], outcomes: [], clearById: {}, versionById: {} };
  try {
    const rows = await releasableUnsubscribes(email, { dbh });
    for (const [stored, lists] of sendgridTargets(rows)) {
      const results = await clearAddressLists(stored, lists);
      const at = new Date().toISOString();
      for (const [list, outcome] of Object.entries(results)) {
        if (!outcome) continue;
        result.outcomes.push({ list, ...outcome });
        if (!outcome.ok) logger.warn(`[email-resubscribe] SendGrid ${list} clear did not complete (${outcome.status || outcome.reason})`);
      }
      for (const row of rows.filter((r) => String(r.email || '').trim() === stored)) {
        const outcome = row.group_key ? results.service : results.global;
        if (outcome && outcome.ok) {
          result.clearedIds.push(row.id);
          result.clearById[row.id] = { ok: true, status: outcome.status, at };
          result.versionById[row.id] = row.row_version;
        }
      }
    }
  } catch (err) {
    logger.warn(`[email-resubscribe] SendGrid pre-clear failed (${errorWord(err)})`);
    return { clearedIds: [], outcomes: [], clearById: {}, versionById: {} };
  }
  return result;
}

// The link's request, by token. Status: 'unknown' (bad shape, no row, never sent), 'used',
// 'expired', or 'open'. The token shape is checked before any query.
async function findRequest(token, { dbh = db, now = new Date() } = {}) {
  if (!isTokenShape(token)) return { status: 'unknown' };
  const request = await dbh('email_resubscribe_requests').where({ token_hash: hashToken(token) }).first();
  if (!request || !request.sent_at) return { status: 'unknown' };
  if (request.used_at) return { status: refusedLink(request) ? 'expired' : 'used', request };
  if (new Date(request.expires_at) <= now) return { status: 'expired', request };
  return { status: 'open', request };
}

// A link completeResubscribe invalidated for a hard block (used_at + outcome.refused) stays the
// generic 'expired' on every later open or press, never "You're all set" (the blocks still stand).
function refusedLink(row) {
  if (!row || !row.used_at || !row.outcome) return false;
  let outcome = row.outcome;
  if (typeof outcome === 'string') {
    try { outcome = JSON.parse(outcome); } catch { return false; }
  }
  return !!(outcome && outcome.refused);
}

// The click. Serialized per request and re-validated before any side effect: one transaction
// takes the request row FOR UPDATE first, so a concurrent or late second POST waits, then sees
// used_at and answers 'already' with no SendGrid call and no release (it can never clear a NEW
// unsubscribe after the first POST consumed the token). Then it takes the address lock and
// re-checks hard blocks (bounce / spam complaint / do-not-email): staff may have added one after
// the link was issued, and clearing SendGrid's list for a hard-blocked address could let a sender
// that checks only SendGrid mail it. A hard block means NO SendGrid call and NO release; the link
// is invalidated (used_at set, outcome { refused: 'hard_block' }) and the answer is 'expired',
// which the route renders as the generic expired page, so nothing reveals why. Otherwise
// SendGrid is cleared for the releasable rows (bounded to 8 s, now under both locks), and only
// the rows SendGrid confirmed are released. Lock order is request row -> address key everywhere
// (the send transaction takes them in the same order; requestResubscribeEmail's first
// transaction takes the address key and then inserts a different, new row). The request is marked
// used ONLY when no releasable row is left; a failed clear or a row that changed in between leaves
// it open so the button works again. Returns 'done' (rows released), 'already' (used, or nothing
// left to release), 'expired' (expired, or refused for a hard block) or 'retry'.
async function completeResubscribe(request, { dbh = db, now = new Date() } = {}) {
  return dbh.transaction(async (trx) => {
    const locked = await trx('email_resubscribe_requests').where({ id: request.id }).forUpdate().first();
    if (!locked || !locked.sent_at) return 'expired';
    if (locked.used_at) return refusedLink(locked) ? 'expired' : 'already';
    if (new Date(locked.expires_at) <= now) return 'expired';
    await require('../utils/customer-comms-lock').lockCustomerEmail(trx, normalizeEmail(locked.email));
    if (await hasHardBlock(locked.email, { dbh: trx })) {
      await trx('email_resubscribe_requests').where({ id: locked.id })
        .update({ used_at: now, updated_at: now, outcome: JSON.stringify({ refused: 'hard_block' }) });
      return 'expired';
    }
    const pre = await clearSendgridBeforeRelease(locked.email, { dbh: trx });
    const released = await releaseOwnUnsubscribes({
      email: locked.email, customerId: locked.customer_id, requestId: locked.id,
      onlyIds: pre.clearedIds, versionById: pre.versionById, sendgridClear: pre.clearById,
    }, { dbh: trx });
    if ((await releasableUnsubscribes(locked.email, { dbh: trx })).length) return 'retry';
    await trx('email_resubscribe_requests').where({ id: locked.id })
      .update({ used_at: now, updated_at: now, outcome: JSON.stringify({ released_ids: released.map((r) => r.id) }) });
    return released.length ? 'done' : 'already';
  });
}

module.exports = {
  findRequest,
  completeResubscribe,
  releasableUnsubscribes,
  hasHardBlock,
  resubscribeStatus,
  requestResubscribeEmail,
  releaseOwnUnsubscribes,
  clearSendgridBeforeRelease,
  normalizeEmail,
  maskEmail,
  hashToken,
  isTokenShape,
  errorWord,
  RELEASABLE_SOURCES,
  REQUEST_TTL_MS,
  RESEND_WINDOW_MS,
};
