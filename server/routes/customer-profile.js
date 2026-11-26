/**
 * Customer profile edit (GATE_CUSTOMER_PROFILE_EDIT, owner 2026-11-26) — an
 * authenticated account holder changes their own first name, last name and
 * email on the customers row their session is signed in to.
 *
 *   PUT /api/customer/profile  { firstName?, lastName?, email? }
 *     → 200 { profile: { firstName, lastName, email }, changed: [...] }
 *
 * Out of scope on purpose: the phone number (it is the login identity).
 * Refused: a contact session (the auth layer answers 403 because this route
 * is not in CONTACT_SESSION_ROUTES; checked again here), a cancelled account,
 * and every call while the gate is off (404 {enabled:false} before any read).
 *
 * Email: customers.email is not unique (migration 20260417000010), so no
 * duplicate check. After a change the customer gets the "account updated"
 * notice (AccountMembershipEmail.sendAccountUpdated): an email change goes to
 * the OLD address and to the NEW address, so a takeover is visible to the
 * person who lost the address; a name-only change goes to the current address.
 * Phone and the rest of the row are never touched.
 *
 * Write order mirrors the Customer 360 edit: customers row FOR UPDATE (active = true judged on the locked row),
 * then lockAssignedCustomerEmails, then the update, then propagateCustomerEmailChange / propagateCustomerNameChange
 * with the locked before/after rows, all in one transaction with the audit row. Both notices go to the addresses
 * of the committed edit (contactOverride), never to whatever the row says after a later edit.
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

const router = express.Router();

const NAME_PART = Joi.string().trim().max(50).pattern(/^[^<>\u0000-\u001f]*$/, 'plain text');
const profileSchema = Joi.object({
  firstName: NAME_PART.min(1),
  lastName: NAME_PART.allow(''),
  email: Joi.string().trim().max(150).email({ tlds: { allow: false } }),
}).or('firstName', 'lastName', 'email');

// A hijacked session must not be able to flood the old address with notices: at most this many SAVED changes per
// customer per hour, counted from committed audit rows under the customer row lock, so it holds across server
// instances and restarts and a request that saved nothing never uses any of it.
const MAX_SAVED_CHANGES_PER_HOUR = 10;

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
    .where({ actor_type: 'customer', actor_id: customerId, action: 'customer.profile_edit' })
    .where('created_at', '>', trx.raw("now() - interval '1 hour'"))
    .count('* as n')
    .first();
  return Number(row?.n || 0);
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
// card), and moveNewsletter:false keeps it from moving, merging or claiming any newsletter subscriber row (the
// customer can re-subscribe the new address).
const SELF_SERVICE_EMAIL_SCOPE = ['customer_email_missing'];

async function commitProfileEdit(trx, { customerId, input, req }) {
  // Row lock first, then the shared per-address advisory key: the admin editor's order. Active is judged on the
  // LOCKED row, so a cancellation that committed after authenticate() cannot be edited past.
  const before = await trx('customers').where({ id: customerId, active: true }).whereNull('deleted_at').forUpdate().first();
  if (!before) return null;
  const changes = diffProfile(before, input);
  if (!Object.keys(changes).length) return { before, after: before, changes, items: [], emailSync: null };
  if (await savedChangesInLastHour(trx, customerId) >= MAX_SAVED_CHANGES_PER_HOUR) throw httpError(429, 'Too many profile changes. Please try again later.');
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
    emailSync = await require('../services/customer-email-fanout').propagateCustomerEmailChange(
      { before, after, source: 'Customer app profile edit', reviewReasonCodes: SELF_SERVICE_EMAIL_SCOPE, moveNewsletter: false }, trx,
    );
  }
  if (changes.first_name !== undefined || changes.last_name !== undefined) {
    await require('../services/customer-contact-fanout').propagateCustomerNameChange({ before, after }, trx);
  }
  await recordAuditEvent({
    actor_type: 'customer',
    actor_id: customerId,
    action: 'customer.profile_edit',
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
  if (emailMoved && oldEmail) recipients.push({ key: 'old', kind: 'old', email: oldEmail, summary: OLD_ADDRESS_SUMMARY });
  if (clean(after.email)) recipients.push({ key: 'current', kind: emailMoved ? 'new' : 'same', email: clean(after.email), summary: CHANGE_SUMMARY });
  for (const { key, kind, email, summary } of recipients) {
    void Promise.resolve(AccountMembershipEmail.sendAccountUpdated({
      customerId,
      actorCustomerId: customerId,
      alwaysNotify: true,
      changedItems: noticeItems(kind, items),
      changeSummary: summary,
      accountSection: 'Account profile',
      contactOverride: { email, name },
      idempotencyKey: `account.profile_edit:${customerId}:${stamp}:${key}`,
    })).catch((err) => logger.warn(`[customer-profile] account.updated email failed for ${customerId}: ${err.message}`));
  }
}

router.put('/', gateOn, authenticateAllowInactive, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (req.contactSession) return res.status(403).json({ error: 'This part of the portal is for the account holder.', code: 'ACCOUNT_HOLDER_ONLY' });
    if (req.customerInactive) return res.status(403).json({ error: 'This account is not active.' });

    const { value, error } = profileSchema.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'Please check your name and email address.', details: error.details.map((d) => d.message) });

    const customerId = req.customerId;
    let outcome;
    try {
      outcome = await db.transaction((trx) => commitProfileEdit(trx, { customerId, input: value, req }));
    } catch (err) {
      if (err.profileStatus) return res.status(err.profileStatus).json({ error: err.message, ...(err.profileCode ? { code: err.profileCode } : {}) });
      throw err;
    }
    // No active row under the lock: the account was cancelled (or removed) after authenticate() read it.
    if (!outcome) return res.status(403).json({ error: 'This account is not active.' });

    const { before, after, changes, items, emailSync } = outcome;
    runPostCommitFanout(emailSync, customerId);
    if (items.length) sendChangeNotices({ customerId, before, after, changes, items });

    return res.json({
      profile: { firstName: clean(after.first_name), lastName: clean(after.last_name), email: clean(after.email) },
      changed: Object.keys(changes).map((k) => ({ first_name: 'firstName', last_name: 'lastName', email: 'email' }[k])),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
