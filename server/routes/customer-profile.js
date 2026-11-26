/**
 * Customer profile edit (GATE_CUSTOMER_PROFILE_EDIT, owner 2026-11-26) — an authenticated account holder changes
 * their own first name, last name and email on the customers row their session is signed in to.
 *
 *   PUT  /api/customer/profile                { firstName?, lastName?, email? }
 *     → 200 { profile, changed: [names saved], emailPending?: { email, expiresInMinutes } }
 *   POST /api/customer/profile/confirm-email  { code }
 *     → 200 { profile, changed: ['email'] } | 400 code_wrong / code_expired | 429 code_attempts | 409 email_unavailable
 *
 * Names save in one step. An EMAIL change takes two: the typed address is not written anywhere (not customers.email,
 * not the fan-out) until the customer types back the 6-digit code mailed to THAT address (15 minutes, 5 tries;
 * services/customer-email-change-code.js, table customer_email_change_requests). An unproven address must never
 * receive invoices, signing links or queued sends. The confirm step then runs the locked commit below.
 *
 * Out of scope on purpose: the phone number (it is the login identity).
 * Refused: a contact session (the auth layer answers 403 because these routes are not in CONTACT_SESSION_ROUTES;
 * checked again here), a cancelled account, and every call while the gate is off (404 {enabled:false}, before any read).
 *
 * Hourly quota: at most 10 of (saved profile changes + code emails) per customer per hour, counted from committed
 * audit rows under the customer row lock, so it holds across instances.
 *
 * Email: customers.email is not unique (migration 20260417000010), but an address held by a live customer on another
 * account is refused 409 at confirm time (after the mailbox is proven, so the refusal cannot be used to probe
 * addresses). After a save the customer gets the "account updated" notice: an email change goes to the OLD address
 * (generic, no new address or name) and to the NEW address; a name-only change goes to the current address.
 *
 * Commit order mirrors the Customer 360 edit: customers row FOR UPDATE (active, and the session's account, judged on
 * the locked row), then lockAssignedCustomerEmails, then the update, then the email and name fan-outs with the locked
 * before/after rows, then the audit row, all in one transaction. Notices go to the addresses of the committed edit
 * (contactOverride), never to whatever the row says after a later edit.
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
const { findCrossAccountEmailConflict } = require('../services/customer-email-write');
const EmailCode = require('../services/customer-email-change-code');

const router = express.Router();

const NAME_PART = Joi.string().trim().max(50).pattern(/^[^<>\u0000-\u001f]*$/, 'plain text');
const profileSchema = Joi.object({
  firstName: NAME_PART.min(1),
  lastName: NAME_PART.allow(''),
  email: Joi.string().trim().max(150).email({ tlds: { allow: false } }),
}).or('firstName', 'lastName', 'email');
const confirmSchema = Joi.object({ code: Joi.string().trim().pattern(/^\d{6}$/).required() });

// A hijacked session must not be able to flood the old address with notices or a stranger's mailbox with codes: at
// most this many SAVED changes plus CODE emails per customer per hour, counted from committed audit rows under the
// customer row lock, so it holds across server instances and restarts, and a request that did neither never uses any.
const MAX_SAVED_CHANGES_PER_HOUR = 10;
const AUDIT_SAVED = 'customer.profile_edit';
const AUDIT_CODE_SENT = 'customer.profile_email_code_sent';

function gateOn(req, res, next) {
  if (!customerProfileEditLive()) return res.status(404).json({ enabled: false });
  return next();
}

// The refusal text never says whether the address belongs to someone else.
const EMAIL_UNAVAILABLE = 'That email address cannot be used here. Please call or text the office to change it.';

function httpError(status, message, code) {
  return Object.assign(new Error(message), { profileStatus: status, profileCode: code });
}

async function savedChangesInLastHour(trx, customerId) {
  const row = await trx('audit_log')
    .where({ actor_type: 'customer', actor_id: customerId })
    .whereIn('action', [AUDIT_SAVED, AUDIT_CODE_SENT])
    .where('created_at', '>', trx.raw("now() - interval '1 hour'"))
    .count('* as n')
    .first();
  return Number(row?.n || 0);
}

async function assertUnderQuota(trx, customerId) {
  if (await savedChangesInLastHour(trx, customerId) >= MAX_SAVED_CHANGES_PER_HOUR) throw httpError(429, 'Too many profile changes. Please try again later.', 'quota');
}

const clean = (v) => String(v == null ? '' : v).trim();

// The fields whose stored value differs from the request. Email compares
// case-insensitively (a re-cased address is not a change) and is saved lower-case.
function diffProfile(current, input) {
  const changes = {};
  if (input.firstName !== undefined && input.firstName !== clean(current.first_name)) changes.first_name = input.firstName;
  if (input.lastName !== undefined && input.lastName !== clean(current.last_name)) changes.last_name = input.lastName;
  if (input.email !== undefined) {
    const next = input.email.toLowerCase();
    if (next !== clean(current.email).toLowerCase()) changes.email = next;
  }
  return changes;
}

function changedItems(current, changes) {
  const items = [];
  if (changes.email !== undefined) {
    items.push({ key: 'email', label: 'Email address', oldValue: clean(current.email), newValue: changes.email });
  }
  if (changes.first_name !== undefined || changes.last_name !== undefined) {
    const nameOf = (first, last) => [clean(first), clean(last)].filter(Boolean).join(' ');
    items.push({
      key: 'name',
      label: 'Name',
      oldValue: nameOf(current.first_name, current.last_name),
      newValue: nameOf(
        changes.first_name !== undefined ? changes.first_name : current.first_name,
        changes.last_name !== undefined ? changes.last_name : current.last_name,
      ),
    });
  }
  return items;
}

// The same fan-out the Customer 360 edit runs (routes/admin-customers.js PUT /:id), inside the edit's transaction
// with the LOCKED before/after rows: open leads, estimates and queued sends follow the new address; open records
// follow the new name. The address is typed by the customer and not proven, so: the email scope is the call path's
// narrow one ('customer_email_missing', it never releases a held first-touch send or settles a staff read-back
// card), and the newsletter gets one rule (propagateSelfServiceEmailChange): the old address's subscriber row is
// unlinked from the customer and nothing moves to the new address (the customer can re-subscribe it).
const SELF_SERVICE_EMAIL_SCOPE = ['customer_email_missing'];

// The customer row under FOR UPDATE, or null. Active is judged on the LOCKED row, so a cancellation that committed
// after authenticate() cannot be edited past; ownership too: the profile may have moved to another account between
// authenticate() reading it and this lock (the row's effective account is account_id, else its own id).
async function lockOwnedCustomer(trx, { customerId, req }) {
  const row = await trx('customers').where({ id: customerId, active: true }).whereNull('deleted_at').forUpdate().first();
  if (!row || String(row.account_id || row.id) !== String(req.accountId)) return null;
  return row;
}

async function commitProfileEdit(trx, { customerId, input, req, locked = null, enforceQuota = true }) {
  // Row lock first, then the shared per-address advisory key: the admin editor's order.
  const before = locked || await lockOwnedCustomer(trx, { customerId, req });
  if (!before) return null;
  const changes = diffProfile(before, input);
  if (!Object.keys(changes).length) return { before, after: before, changes, items: [], emailSync: null };
  if (enforceQuota) await assertUnderQuota(trx, customerId);
  await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, changes);
  if (changes.email !== undefined) {
    // Same predicate the Customer 360 email edit uses: another live customer on a DIFFERENT account holds the address.
    const conflict = await findCrossAccountEmailConflict(trx, { customerId, accountId: before.account_id || before.id, email: changes.email });
    if (conflict) throw httpError(409, EMAIL_UNAVAILABLE, 'email_unavailable');
  }
  await trx('customers').where({ id: customerId }).update({ ...changes, updated_at: trx.fn.now() });
  const after = { ...before, ...changes };
  let emailSync = null;
  if (changes.email !== undefined) {
    emailSync = await require('../services/customer-email-fanout').propagateSelfServiceEmailChange(
      { before, after, source: 'Customer app profile edit', reviewReasonCodes: SELF_SERVICE_EMAIL_SCOPE }, trx,
    );
  }
  if (changes.first_name !== undefined || changes.last_name !== undefined) {
    await require('../services/customer-contact-fanout').propagateCustomerNameChange({ before, after }, trx);
  }
  await recordAuditEvent({
    actor_type: 'customer',
    actor_id: customerId,
    action: AUDIT_SAVED,
    resource_type: 'customer',
    resource_id: customerId,
    // Which fields changed, never the values: the email is the customer's own contact data.
    metadata: { fields: Object.keys(changes), source: 'customer_portal' },
    ip_address: req.ip || null,
    user_agent: req.get?.('user-agent') || null,
    critical: true,
    trx,
  });
  return { before, after, changes, items: changedItems(before, changes), emailSync };
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

// What each mailbox is told. The old mailbox of an email change gets a generic alert with NO new address and no
// new name (a typo fix must not mail the replacement to a stranger); the new mailbox's notice omits the old
// address; a name-only change goes to the same address as before, so it can show old and new.
function noticeItems(kind, items) {
  if (kind === 'old') return [{ key: 'email', label: 'Email address' }];
  if (kind === 'new') return items.map(({ oldValue, old_value, ...rest }) => rest);
  return items;
}
const OLD_ADDRESS_SUMMARY = 'The email address on your Waves account was changed in the customer app. If this was not you, call or text us right away.';
const OLD_ADDRESS_GREETING = 'there';
const CHANGE_SUMMARY = 'Your name or email address on your Waves account was changed in the customer app.';

// Fire-and-forget after the save: a notice that fails to send never undoes the change. Every recipient is the
// address of the COMMITTED edit, passed as a contactOverride, so a later edit cannot redirect a notice to a
// third mailbox.
function sendChangeNotices({ customerId, before, after, changes, items }) {
  const stamp = Date.now();
  const emailMoved = changes.email !== undefined;
  const name = clean(after.first_name);
  const recipients = [];
  const oldEmail = clean(before.email);
  if (emailMoved && oldEmail) recipients.push({ key: 'old', kind: 'old', email: oldEmail, summary: OLD_ADDRESS_SUMMARY, greeting: OLD_ADDRESS_GREETING });
  if (clean(after.email)) recipients.push({ key: 'current', kind: emailMoved ? 'new' : 'same', email: clean(after.email), summary: CHANGE_SUMMARY, greeting: null });
  for (const { key, kind, email, summary, greeting } of recipients) {
    void Promise.resolve(AccountMembershipEmail.sendAccountUpdated({
      customerId,
      actorCustomerId: customerId,
      alwaysNotify: true,
      changedItems: noticeItems(kind, items),
      changeSummary: summary,
      accountSection: 'Account profile',
      // The old address is greeted with no name at all: neither the old nor the new one belongs in that mailbox.
      contactOverride: { email, name: greeting ? '' : name },
      ...(greeting ? { greetingName: greeting } : {}),
      idempotencyKey: `account.profile_edit:${customerId}:${stamp}:${key}`,
    })).catch((err) => logger.warn(`[customer-profile] account.updated email failed for ${customerId}: ${err.message}`));
  }
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
  await assertUnderQuota(trx, customerId);
  const newEmail = typedEmail.toLowerCase();
  const issued = await EmailCode.issueRequest(trx, { customerId, newEmail });
  await recordAuditEvent({
    actor_type: 'customer',
    actor_id: customerId,
    action: AUDIT_CODE_SENT,
    resource_type: 'customer',
    resource_id: customerId,
    metadata: { source: 'customer_portal' },
    ip_address: req.ip || null,
    user_agent: req.get?.('user-agent') || null,
    critical: true,
    trx,
  });
  return { requestId: issued.id, code: issued.code, email: newEmail, expiresInMinutes: issued.expiresInMinutes };
}

// After commit: mail the code to the NEW address. A failed send drops the request (the customer asks again).
async function deliverEmailCode(pending, customerId) {
  try {
    await EmailCode.sendCode({ to: pending.email, code: pending.code });
  } catch (err) {
    logger.warn(`[customer-profile] email code send failed for ${customerId}: ${err.status || err.code || err.name || 'send_failed'}`);
    await EmailCode.dropRequest(db, pending.requestId).catch(() => {});
    return false;
  }
  await EmailCode.markSent(db, pending.requestId).catch(() => {});
  return true;
}

router.put('/', gateOn, authenticateAllowInactive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!holderOnly(req, res)) return undefined;

    const { value, error } = profileSchema.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'Please check your name and email address.', details: error.details.map((d) => d.message) });

    const customerId = req.customerId;
    const { email: typedEmail, ...nameInput } = value;
    let outcome;
    try {
      outcome = await db.transaction(async (trx) => {
        const edit = await commitProfileEdit(trx, { customerId, input: nameInput, req });
        if (!edit) return null;
        return { ...edit, pending: await requestEmailCode(trx, { customerId, locked: edit.after, typedEmail, req }) };
      });
    } catch (err) {
      if (err.profileStatus) return sendProfileError(res, err);
      throw err;
    }
    // No active row under the lock: the account was cancelled (or removed) after authenticate() read it.
    if (!outcome) return res.status(403).json({ error: 'This account is not active.' });

    const { before, after, changes, items, emailSync, pending } = outcome;
    runPostCommitFanout(emailSync, customerId);
    if (items.length) sendChangeNotices({ customerId, before, after, changes, items });
    if (pending && !(await deliverEmailCode(pending, customerId))) {
      return res.status(502).json({ error: 'We could not send the code. Please try again in a moment.', code: 'code_send_failed', profile: profilePayload(after), changed: Object.keys(changes).map((k) => FIELD_NAMES[k]) });
    }

    return res.json({
      profile: profilePayload(after),
      changed: Object.keys(changes).map((k) => FIELD_NAMES[k]),
      ...(pending ? { emailPending: { email: pending.email, expiresInMinutes: pending.expiresInMinutes } } : {}),
    });
  } catch (err) {
    return next(err);
  }
});

const CODE_REFUSALS = {
  missing: [400, 'That code has expired. Ask for a new code.', 'code_expired'],
  expired: [400, 'That code has expired. Ask for a new code.', 'code_expired'],
  attempts: [429, 'Too many wrong codes. Ask for a new code.', 'code_attempts'],
  wrong: [400, 'That code is not right. Check the newest email and try again.', 'code_wrong'],
};

// Step 2: judge the code and, only when it is right, run the locked commit with the address the code was sent to.
// Every refusal RETURNS (never throws) so the transaction commits: a wrong code must keep its attempt count, and an
// address another account holds consumes the request.
async function confirmInTransaction(trx, { customerId, code, req }) {
  const locked = await lockOwnedCustomer(trx, { customerId, req });
  if (!locked) return { gone: true };
  const check = await EmailCode.checkCode(trx, { customerId, code });
  if (check.outcome !== 'ok') return { refused: check };
  const { request } = check;
  try {
    const edit = await commitProfileEdit(trx, { customerId, input: { email: request.new_email }, req, locked, enforceQuota: false });
    await EmailCode.consume(trx, request.id);
    return { edit };
  } catch (err) {
    if (err.profileStatus !== 409) throw err;
    await EmailCode.consume(trx, request.id);
    return { conflict: err };
  }
}

router.post('/confirm-email', gateOn, authenticateAllowInactive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!holderOnly(req, res)) return undefined;
    const { value, error } = confirmSchema.validate(req.body || {}, { stripUnknown: true });
    if (error) return res.status(400).json({ error: 'Enter the 6-digit code from the email.', code: 'code_wrong' });

    const customerId = req.customerId;
    const outcome = await db.transaction((trx) => confirmInTransaction(trx, { customerId, code: value.code, req }));
    if (outcome.gone) return res.status(403).json({ error: 'This account is not active.' });
    if (outcome.conflict) return sendProfileError(res, outcome.conflict);
    if (outcome.refused) {
      const [status, message, code] = CODE_REFUSALS[outcome.refused.outcome];
      return res.status(status).json({ error: message, code, ...(outcome.refused.attemptsLeft !== undefined ? { attemptsLeft: outcome.refused.attemptsLeft } : {}) });
    }

    const { before, after, changes, items, emailSync } = outcome.edit;
    runPostCommitFanout(emailSync, customerId);
    if (items.length) sendChangeNotices({ customerId, before, after, changes, items });
    return res.json({ profile: profilePayload(after), changed: Object.keys(changes).map((k) => FIELD_NAMES[k]) });
  } catch (err) {
    if (err.profileStatus) return sendProfileError(res, err);
    return next(err);
  }
});

module.exports = router;
