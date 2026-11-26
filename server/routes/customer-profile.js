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

// Fire-and-forget after the save: a notice that fails to send never undoes the
// change (the row is the record; the failure is logged by the sender).
function sendChangeNotices({ customerId, current, changes, items }) {
  const stamp = Date.now();
  const base = {
    customerId,
    actorCustomerId: customerId,
    alwaysNotify: true,
    changedItems: items,
    changeSummary: 'Your name or email address on your Waves account was changed in the customer app.',
    accountSection: 'Account profile',
  };
  const sends = [];
  const oldEmail = clean(current.email);
  if (changes.email !== undefined && oldEmail) {
    sends.push(AccountMembershipEmail.sendAccountUpdated({
      ...base,
      contactOverride: { email: oldEmail, name: clean(current.first_name) },
      idempotencyKey: `account.profile_edit:${customerId}:${stamp}:old`,
    }));
  }
  sends.push(AccountMembershipEmail.sendAccountUpdated({
    ...base,
    idempotencyKey: `account.profile_edit:${customerId}:${stamp}:current`,
  }));
  for (const send of sends) {
    void Promise.resolve(send).catch((err) => logger.warn(`[customer-profile] account.updated email failed for ${customerId}: ${err.message}`));
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
    const outcome = await db.transaction(async (trx) => {
      const current = await trx('customers').where({ id: customerId }).whereNull('deleted_at').forUpdate()
        .first('id', 'first_name', 'last_name', 'email');
      if (!current) return null;
      const changes = diffProfile(current, value);
      if (!Object.keys(changes).length) return { current, changes, items: [] };
      await trx('customers').where({ id: customerId }).update({ ...changes, updated_at: trx.fn.now() });
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
      return { current, changes, items: changedItems(current, changes) };
    });
    if (!outcome) return res.status(404).json({ error: 'Customer not found' });

    const { current, changes, items } = outcome;
    if (items.length) sendChangeNotices({ customerId, current, changes, items });

    const next = { ...current, ...changes };
    return res.json({
      profile: { firstName: clean(next.first_name), lastName: clean(next.last_name), email: clean(next.email) },
      changed: Object.keys(changes).map((k) => ({ first_name: 'firstName', last_name: 'lastName', email: 'email' }[k])),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
