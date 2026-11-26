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
const rateLimit = require('express-rate-limit');
const db = require('../models/db');
const logger = require('../services/logger');
const { authenticate } = require('../middleware/auth');
const { customerProfileEditLive } = require('../config/feature-gates');
const AccountMembershipEmail = require('../services/account-membership-email');
const { recordAuditEvent } = require('../services/audit-log');

const router = express.Router();

const NAME_PART = Joi.string().trim().max(50).pattern(/^[^<>\u0000-\u001f]*$/, 'plain text');
const profileSchema = Joi.object({
  firstName: NAME_PART.min(1),
  lastName: NAME_PART.allow(''),
  email: Joi.string().trim().max(150).email({ tlds: { allow: false } }),
}).or('firstName', 'lastName', 'email');

// A hijacked session must not be able to flood the old address with notices.
const profileLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `profile:${req.customerId || 'anon'}`,
  skipFailedRequests: true,
  validate: false,
  message: { error: 'Too many profile changes. Please try again later.' },
});

function gateOn(req, res, next) {
  if (!customerProfileEditLive()) return res.status(404).json({ enabled: false });
  return next();
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
// with the LOCKED before/after rows: open leads, estimates, queued sends and the newsletter tokens follow the new
// address; open records follow the new name. Email scope is the call path's narrow one ('customer_email_missing'):
// a customer-typed address is not verified by staff, so it moves the copies but never releases a held first-touch
// send or settles a staff read-back card (customer-email-fanout.js, operatorAssertedEmail).
const SELF_SERVICE_EMAIL_SCOPE = ['customer_email_missing'];

async function commitProfileEdit(trx, { customerId, input, req }) {
  // Row lock first, then the shared per-address advisory key: the admin editor's order. Active is judged on the
  // LOCKED row, so a cancellation that committed after authenticate() cannot be edited past.
  const before = await trx('customers').where({ id: customerId, active: true }).whereNull('deleted_at').forUpdate().first();
  if (!before) return null;
  const changes = diffProfile(before, input);
  if (!Object.keys(changes).length) return { before, after: before, changes, items: [], emailSync: null };
  await require('../utils/customer-comms-lock').lockAssignedCustomerEmails(trx, changes);
  await trx('customers').where({ id: customerId }).update({ ...changes, updated_at: trx.fn.now() });
  const after = { ...before, ...changes };
  let emailSync = null;
  if (changes.email !== undefined) {
    emailSync = await require('../services/customer-email-fanout').propagateCustomerEmailChange(
      { before, after, source: 'Customer app profile edit', reviewReasonCodes: SELF_SERVICE_EMAIL_SCOPE }, trx,
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

// Fire-and-forget after the save: a notice that fails to send never undoes the change. Every recipient is the
// address of the COMMITTED edit, passed as a contactOverride, so a later edit cannot redirect the notice to a
// third mailbox: the old address when the email moved, and the new (or unchanged) address from the committed row.
function sendChangeNotices({ customerId, before, after, changes, items }) {
  const stamp = Date.now();
  const base = {
    customerId,
    actorCustomerId: customerId,
    alwaysNotify: true,
    changedItems: items,
    changeSummary: 'Your name or email address on your Waves account was changed in the customer app.',
    accountSection: 'Account profile',
  };
  const name = clean(after.first_name);
  const recipients = [];
  const oldEmail = clean(before.email);
  if (changes.email !== undefined && oldEmail) recipients.push({ key: 'old', email: oldEmail });
  if (clean(after.email)) recipients.push({ key: 'current', email: clean(after.email) });
  for (const { key, email } of recipients) {
    void Promise.resolve(AccountMembershipEmail.sendAccountUpdated({
      ...base,
      contactOverride: { email, name },
      idempotencyKey: `account.profile_edit:${customerId}:${stamp}:${key}`,
    })).catch((err) => logger.warn(`[customer-profile] account.updated email failed for ${customerId}: ${err.message}`));
  }
}

router.put('/', gateOn, authenticate, profileLimiter, async (req, res, next) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (req.contactSession) return res.status(403).json({ error: 'This part of the portal is for the account holder.', code: 'ACCOUNT_HOLDER_ONLY' });
    if (req.customerInactive) return res.status(403).json({ error: 'This account is not active.' });

    const { value, error } = profileSchema.validate(req.body || {}, { abortEarly: false, stripUnknown: true });
    if (error) return res.status(400).json({ error: 'Please check your name and email address.', details: error.details.map((d) => d.message) });

    const customerId = req.customerId;
    const outcome = await db.transaction((trx) => commitProfileEdit(trx, { customerId, input: value, req }));
    if (!outcome) return res.status(404).json({ error: 'Customer not found or not active' });

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
