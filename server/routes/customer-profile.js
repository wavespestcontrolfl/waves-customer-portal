/**
 * Customer profile edit (GATE_CUSTOMER_PROFILE_EDIT, owner 2026-11-26) — an authenticated account holder changes
 * their own first name, last name and email on the customers row their session is signed in to.
 *
 *   PUT  /api/customer/profile                { firstName?, lastName?, email? }
 *     → 200 { profile, changed: [names saved], emailPending?: { email, expiresInMinutes } }
 *     → 409 email_unavailable_for_code (the address is on the global suppression list; no code stored or sent)
 *   POST /api/customer/profile/confirm-email  { code, email }   (email = the pending address the form showed)
 *     → 200 { profile, changed: ['email'] } | 400 code_wrong / code_expired | 429 code_attempts | 409 email_unavailable
 *
 * Names save in one step. An EMAIL change takes two: the typed address is not written anywhere (not customers.email,
 * not the fan-out) until the customer types back the 6-digit code mailed to THAT address (15 minutes, 5 tries;
 * services/customer-email-change-code.js, table customer_email_change_requests). An unproven address must never
 * receive invoices, signing links or queued sends. Once the code proves the mailbox, the confirm step hands the address
 * to the shared operator email write (services/customer-email-write.js applyOperatorCustomerEmail), the same sequence
 * and fan-out the admin email edits run.
 *
 * Out of scope on purpose: the phone number (it is the login identity).
 * Refused: a contact session (the auth layer answers 403 because these routes are not in CONTACT_SESSION_ROUTES;
 * checked again here), a cancelled account, and every call while the gate is off (404 {enabled:false}, before any read).
 *
 * Hourly quota: at most 10 of (saved profile changes + code requests) per customer per hour, counted from committed
 * audit rows under the customer row lock, so it holds across instances. A code request uses its unit whether it is
 * answered with a code or with the "cannot mail that address" refusal.
 *
 * Email: customers.email is not unique (migration 20260417000010), but an address held by a live customer on another
 * account is refused 409 at confirm time (after the mailbox is proven, so the refusal cannot be used to probe
 * addresses). A code is good only while customers.email still equals the address on file when it was issued.
 * Every "account updated" notice from this route is one generic message with no values (see NOTICE_SUMMARY).
 *
 * Lock order: customers row FOR UPDATE first (active, and the session's account, judged on the locked row), then the
 * code request row, then (inside the shared writer) the per-address key, the update and the fan-out, then the audit
 * row, all in one transaction.
 */
const express = require('express');
const Joi = require('joi');
const db = require('../models/db');
const logger = require('../services/logger');
// authenticateAllowInactive (NOT authenticate): a cancelled account's session must reach the handler's own 403,
// not the 401 that makes the app try to refresh its token. The handler and the locked read both refuse inactive.
const { authenticateAllowInactive } = require('../middleware/auth');
const { customerProfileEditLive } = require('../config/feature-gates');
const AccountMembershipEmail = require('../services/account-membership-email');
const { recordAuditEvent } = require('../services/audit-log');
const { applyOperatorCustomerEmail } = require('../services/customer-email-write');
const { cleanValidEmailOrNull } = require('../utils/intake-normalize');
const EmailCode = require('../services/customer-email-change-code');

const router = express.Router();

const NAME_PART = Joi.string().trim().max(50).pattern(/^[^<>\u0000-\u001f]*$/, 'plain text');
const profileSchema = Joi.object({
  firstName: NAME_PART.min(1),
  lastName: NAME_PART.allow(''),
  email: Joi.string().trim().max(150).email({ tlds: { allow: false } }),
}).or('firstName', 'lastName', 'email');
// The confirm names the address the form showed ("We sent a code to ..."): a code for any other pending address is refused.
const confirmSchema = Joi.object({
  code: Joi.string().trim().pattern(/^\d{6}$/).required(),
  email: Joi.string().trim().max(150).email({ tlds: { allow: false } }).required(),
});

// A hijacked session must not be able to flood the old address with notices or a stranger's mailbox with codes, or
// test without limit which addresses Waves cannot mail: at most this many SAVED changes plus CODE REQUESTS per
// customer per hour, counted from committed audit rows under the customer row lock, so it holds across server
// instances and restarts, and a request that did neither never uses any.
const MAX_SAVED_CHANGES_PER_HOUR = 10;
const AUDIT_SAVED = 'customer.profile_edit';
// One row per code request, written in the PUT transaction before the email is handed to the provider. The request
// uses its unit whether it is answered with a code (outcome `issued`) or with the "cannot mail that address" refusal
// (outcome `refused`), and keeps it if the send then fails.
const AUDIT_CODE_REQUESTED = 'customer.profile_email_code_requested';

// First in each route chain, so a dark route reads nothing (it is a registered passthrough in
// server/config/route-auth-guards.json, like the roof-entry-read gate); server/index.js ALSO mounts it before the
// global limiter, so a dark probe is answered there and never counted.
function gateOn(req, res, next) {
  if (!customerProfileEditLive()) return res.status(404).json({ enabled: false });
  return next();
}

// The code refusal never says why an address cannot be mailed.
const CODE_SUPPRESSED = "We can't send email to that address. Please call or text the office.";

// The refusal text never says whether the address belongs to someone else.
const EMAIL_UNAVAILABLE = 'That email address cannot be used here. Please call or text the office to change it.';

function httpError(status, message, code) {
  return Object.assign(new Error(message), { profileStatus: status, profileCode: code });
}

// The shared error handler logs an error's message and stack, and a database error's message carries the SQL with its
// bound values (here the typed name and email). Forward the error's class and database code only (AGENTS.md "PII in
// logs"; routes/requests.js plan-restart forwards the same way).
function withoutBoundValues(err) {
  return Object.assign(new Error(`customer profile request failed (${err?.code || err?.name || 'error'})`), { code: err?.code });
}

async function savedChangesInLastHour(trx, customerId) {
  const row = await trx('audit_log')
    .where({ actor_type: 'customer', actor_id: customerId })
    .whereIn('action', [AUDIT_SAVED, AUDIT_CODE_REQUESTED])
    .where('created_at', '>', trx.raw("now() - interval '1 hour'"))
    .count('* as n')
    .first();
  return Number(row?.n || 0);
}

async function assertUnderQuota(trx, customerId) {
  if (await savedChangesInLastHour(trx, customerId) >= MAX_SAVED_CHANGES_PER_HOUR) throw httpError(429, 'Too many profile changes. Please try again later.', 'quota');
}

const clean = (v) => String(v == null ? '' : v).trim();

// The name fields whose stored value differs from the request. (An email never goes through here: it takes the code
// step and the shared operator email write.)
function diffNames(current, input) {
  const changes = {};
  if (input.firstName !== undefined && input.firstName !== clean(current.first_name)) changes.first_name = input.firstName;
  if (input.lastName !== undefined && input.lastName !== clean(current.last_name)) changes.last_name = input.lastName;
  return changes;
}

// Active, and the session's account (the row's effective account is account_id, else its own id): judged on the LOCKED
// row, so a cancellation or an account move that committed after authenticate() cannot be edited past.
function ownsActiveRow(row, req) {
  return row.active === true && String(row.account_id || row.id) === String(req.accountId);
}

// The customer row under FOR UPDATE, or null.
async function lockOwnedCustomer(trx, { customerId, req }) {
  const row = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate().first();
  return row && ownsActiveRow(row, req) ? row : null;
}

// One committed audit row per quota unit, in the caller's transaction. Never a value: the name and email are the
// customer's own contact data (a saved change lists WHICH fields changed, a code request lists only its outcome).
async function auditStep(trx, { customerId, action, detail, req }) {
  await recordAuditEvent({
    actor_type: 'customer',
    actor_id: customerId,
    action,
    resource_type: 'customer',
    resource_id: customerId,
    metadata: { ...detail, source: 'customer_portal' },
    ip_address: req.ip || null,
    user_agent: req.get?.('user-agent') || null,
    critical: true,
    trx,
  });
}

// Names save in one step: row lock, quota, update, the name fan-out with the locked before/after rows, audit row.
async function commitNameEdit(trx, { customerId, input, req }) {
  const before = await lockOwnedCustomer(trx, { customerId, req });
  if (!before) return null;
  const changes = diffNames(before, input);
  if (!Object.keys(changes).length) return { before, after: before, changes, emailSync: null };
  await assertUnderQuota(trx, customerId);
  await trx('customers').where({ id: customerId }).update({ ...changes, updated_at: trx.fn.now() });
  const after = { ...before, ...changes };
  await require('../services/customer-contact-fanout').propagateCustomerNameChange({ before, after }, trx);
  await auditStep(trx, { customerId, action: AUDIT_SAVED, detail: { fields: Object.keys(changes) }, req });
  return { before, after, changes, emailSync: null };
}

// Deferred work the fan-out could not do inside the transaction (a DOI confirmation to the corrected address, a
// held newsletter resume). Run after commit, fire-and-forget with an owner, as the Customer 360 route does.
function runPostCommitFanout(emailSync, customerId) {
  if (emailSync?.heldNewsletterResume) {
    require('../services/lead-first-touch-resume').resumeHeldNewsletterPostCommit(emailSync.heldNewsletterResume)
      .catch((err) => logger.error(`[customer-profile] held-newsletter resume failed for ${customerId}: ${err.code || err.name || 'resume_failed'}`));
  }
  if (emailSync?.pendingConfirmation) {
    require('../services/customer-email-fanout').resendPendingConfirmation(emailSync.pendingConfirmation)
      .catch((err) => logger.error(`[customer-profile] DOI re-send failed for ${customerId}: ${err.code || err.name || 'resend_failed'}`));
  }
}

// Every "account updated" notice from this route is ONE generic message with no values: no name (old or new), no
// address, ever. The current address may be the one being replaced, the old address may belong to someone else, and
// a customer-typed value has no business in a mailbox that has not proven it is theirs. Recipients are the addresses
// of the COMMITTED edit, passed as a contactOverride so a later edit cannot redirect a notice: the current address
// for any change, plus the old address when the email moved. The greeting is neutral and the contact name empty.
const NOTICE_SUMMARY = 'Your Waves account details were changed in the app. If this was not you, call or text us right away.';
const NOTICE_GREETING = 'there';
const NOTICE_ITEMS = [{ key: 'profile', label: 'Account profile' }];

function noticeRecipients(before, after, changes) {
  const addresses = [clean(after.email)];
  if (changes.email !== undefined) addresses.push(clean(before.email));
  const seen = new Set();
  return addresses.filter((email) => {
    const key = email.toLowerCase();
    if (!email || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Fire-and-forget after the save: a notice that fails to send never undoes the change.
function sendChangeNotices({ customerId, before, after, changes }) {
  const stamp = Date.now();
  noticeRecipients(before, after, changes).forEach((email, index) => {
    void Promise.resolve(AccountMembershipEmail.sendAccountUpdated({
      customerId,
      actorCustomerId: customerId,
      alwaysNotify: true,
      changedItems: NOTICE_ITEMS,
      changeSummary: NOTICE_SUMMARY,
      accountSection: 'Account profile',
      contactOverride: { email, name: '' },
      greetingName: NOTICE_GREETING,
      idempotencyKey: `account.profile_edit:${customerId}:${stamp}:${index}`,
      // The recipient is an address the customer typed or just left: the sender logs and stores a failure by its
      // code only, and the provider's own error body is not logged.
      suppressProviderErrorLog: true,
    })).catch((err) => logger.warn(`[customer-profile] account.updated email failed for ${customerId}: ${err.status || err.code || err.name || 'send_failed'}`));
  });
}

function holderOnly(req, res) {
  if (req.contactSession) { res.status(403).json({ error: 'This part of the portal is for the account holder.', code: 'ACCOUNT_HOLDER_ONLY' }); return false; }
  if (req.customerInactive) { res.status(403).json({ error: 'This account is not active.' }); return false; }
  return true;
}

function sendProfileError(res, err) {
  return res.status(err.profileStatus).json({ error: err.message, ...(err.profileCode ? { code: err.profileCode } : {}) });
}

function profilePayload(row) {
  return { firstName: clean(row.first_name), lastName: clean(row.last_name), email: clean(row.email) };
}

const FIELD_NAMES = { first_name: 'firstName', last_name: 'lastName', email: 'email' };

// Step 1 of an email change, inside the PUT transaction: replace the customer's open request with a fresh code and
// write the quota row. Returns what the email needs after commit, or null when the typed address is already the
// customer's own (a re-cased address is not a change).
async function requestEmailCode(trx, { customerId, locked, typedEmail, req }) {
  if (!typedEmail || typedEmail.toLowerCase() === clean(locked.email).toLowerCase()) return null;
  // Quota first: both answers below use one unit, so neither can be asked for without limit.
  await assertUnderQuota(trx, customerId);
  // An address on the global suppression list (bounce, spam complaint, do-not-email, or a global unsubscribe) is
  // never mailed, so no code is stored for it, and the answer does not say why.
  if (await EmailCode.addressSuppressed(trx, typedEmail)) {
    await auditStep(trx, { customerId, action: AUDIT_CODE_REQUESTED, detail: { outcome: 'refused' }, req });
    return { suppressed: true };
  }
  const newEmail = typedEmail.toLowerCase();
  const issued = await EmailCode.issueRequest(trx, { customerId, newEmail, fromEmail: locked.email });
  await auditStep(trx, { customerId, action: AUDIT_CODE_REQUESTED, detail: { outcome: 'issued' }, req });
  return { requestId: issued.id, code: issued.code, email: newEmail, expiresInMinutes: issued.expiresInMinutes };
}

// After commit: mail the code to the NEW address. A send that did not happen drops the request (the customer asks
// again). Answers 'sent', 'suppressed' (the address joined the suppression list after the request was stored: sendCode
// reads the list again at the provider handoff) or 'failed'.
async function deliverEmailCode(pending, customerId) {
  try {
    await EmailCode.sendCode({ to: pending.email, code: pending.code });
  } catch (err) {
    logger.warn(`[customer-profile] email code send failed for ${customerId}: ${err.status || err.code || err.name || 'send_failed'}`);
    await EmailCode.dropRequest(db, pending.requestId).catch(() => {});
    return err.code === 'address_suppressed' ? 'suppressed' : 'failed';
  }
  await EmailCode.markSent(db, pending.requestId).catch(() => {});
  return 'sent';
}

// Why no code went out, as [status, words, code]. 'suppressed' is one answer, whether the list was read before the
// request was stored or again at the provider handoff.
const CODE_NOT_SENT = {
  suppressed: [409, CODE_SUPPRESSED, 'email_unavailable_for_code'],
  failed: [502, 'We could not send the code. Please try again in a moment.', 'code_send_failed'],
};

router.put('/', gateOn, authenticateAllowInactive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!holderOnly(req, res)) return undefined;

    const { value, error } = profileSchema.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'Please check your name and email address.', details: error.details.map((d) => d.message) });

    const customerId = req.customerId;
    const { email: rawEmail, ...nameInput } = value;
    // The shared operator writer's own address test (utils/intake-normalize cleanValidEmailOrNull).
    const typedEmail = rawEmail === undefined ? undefined : cleanValidEmailOrNull(rawEmail);
    if (rawEmail !== undefined && !typedEmail) return res.status(400).json({ error: 'Please check your name and email address.' });
    let outcome;
    try {
      outcome = await db.transaction(async (trx) => {
        const edit = await commitNameEdit(trx, { customerId, input: nameInput, req });
        if (!edit) return null;
        const requested = await requestEmailCode(trx, { customerId, locked: edit.after, typedEmail, req });
        return { ...edit, pending: requested?.suppressed ? null : requested, suppressed: requested?.suppressed === true };
      });
    } catch (err) {
      if (err.profileStatus) return sendProfileError(res, err);
      throw err;
    }
    // No active row under the lock: the account was cancelled (or removed) after authenticate() read it.
    if (!outcome) return res.status(403).json({ error: 'This account is not active.' });

    const { before, after, changes, emailSync, pending, suppressed } = outcome;
    runPostCommitFanout(emailSync, customerId);
    if (Object.keys(changes).length) sendChangeNotices({ customerId, before, after, changes });
    // What was saved, in every answer below: a name saved in this request stays saved when its code did not go out.
    const saved = { profile: profilePayload(after), changed: Object.keys(changes).map((k) => FIELD_NAMES[k]) };
    const delivery = suppressed ? 'suppressed' : (pending && await deliverEmailCode(pending, customerId));
    if (CODE_NOT_SENT[delivery]) {
      const [status, error, code] = CODE_NOT_SENT[delivery];
      return res.status(status).json({ error, code, ...saved });
    }

    return res.json({
      ...saved,
      ...(pending ? { emailPending: { email: pending.email, expiresInMinutes: pending.expiresInMinutes } } : {}),
    });
  } catch (err) {
    return next(withoutBoundValues(err));
  }
});

const CODE_REFUSALS = {
  missing: [400, 'That code has expired. Ask for a new code.', 'code_expired'],
  expired: [400, 'That code has expired. Ask for a new code.', 'code_expired'],
  stale: [400, 'That code has expired. Ask for a new code.', 'code_expired'],
  mismatch: [400, 'That code was sent to a different email address. Ask for a new code.', 'code_expired'],
  attempts: [429, 'Too many wrong codes. Ask for a new code.', 'code_attempts'],
  wrong: [400, 'That code is not right. Check the newest email and try again.', 'code_wrong'],
};

// Step 2: judge the code and, only when it is right, hand the address the code was sent to to the SHARED operator email
// write (services/customer-email-write.js applyOperatorCustomerEmail, the one the admin triage confirm uses): row lock,
// address key, cross-account refusal, diff-gated write, the admin fan-out, all in this transaction. Row lock first, then
// the request row: the same order as the PUT. Every refusal RETURNS (never throws) so the transaction commits: a wrong
// code must keep its attempt count, and a spent request (right code, an address another account holds) stays consumed.
async function confirmInTransaction(trx, { customerId, code, email, req }) {
  const locked = await lockOwnedCustomer(trx, { customerId, req });
  if (!locked) return { gone: true };
  const check = await EmailCode.checkCode(trx, { customerId, code, currentEmail: locked.email, expectedEmail: email });
  if (check.outcome !== 'ok') return { refused: check };
  const { request } = check;
  const result = await applyOperatorCustomerEmail(trx, {
    customerId, email: request.new_email, source: 'Customer app profile edit', rowAllowed: (row) => ownsActiveRow(row, req),
  });
  await EmailCode.consume(trx, request.id);
  if (result.outcome === 'not_allowed' || result.outcome === 'customer_not_found') return { gone: true };
  if (result.outcome === 'email_in_use') return { conflict: httpError(409, EMAIL_UNAVAILABLE, 'email_unavailable') };
  if (result.outcome === 'unchanged') return { edit: { before: result.before, after: result.before, changes: {}, emailSync: null } };
  const changes = { email: request.new_email };
  await auditStep(trx, { customerId, action: AUDIT_SAVED, detail: { fields: Object.keys(changes) }, req });
  return { edit: { before: result.before, after: { ...result.before, ...changes }, changes, emailSync: result.emailSync } };
}

router.post('/confirm-email', gateOn, authenticateAllowInactive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!holderOnly(req, res)) return undefined;
    const { value, error } = confirmSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) return res.status(400).json({ error: 'Enter the 6-digit code from the email.', code: 'code_wrong' });

    const customerId = req.customerId;
    const outcome = await db.transaction((trx) => confirmInTransaction(trx, { customerId, code: value.code, email: value.email, req }));
    if (outcome.gone) return res.status(403).json({ error: 'This account is not active.' });
    if (outcome.conflict) return sendProfileError(res, outcome.conflict);
    if (outcome.refused) {
      const [status, message, code] = CODE_REFUSALS[outcome.refused.outcome];
      return res.status(status).json({ error: message, code, ...(outcome.refused.attemptsLeft !== undefined ? { attemptsLeft: outcome.refused.attemptsLeft } : {}) });
    }

    const { before, after, changes, emailSync } = outcome.edit;
    runPostCommitFanout(emailSync, customerId);
    if (Object.keys(changes).length) sendChangeNotices({ customerId, before, after, changes });
    return res.json({ profile: profilePayload(after), changed: Object.keys(changes).map((k) => FIELD_NAMES[k]) });
  } catch (err) {
    if (err.profileStatus) return sendProfileError(res, err);
    return next(withoutBoundValues(err));
  }
});

module.exports = router;
// The dark gate on its own, for server/index.js to mount before the global /api/ limiter (a dark probe is never counted).
module.exports.gateOn = gateOn;
