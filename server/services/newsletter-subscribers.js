/**
 * Shared subscriber helpers — single source of truth for the
 * lookup → resub-or-insert → customer-link flow that three call sites
 * (admin add, public signup, quote-wizard dual-write) used to duplicate
 * with subtly different validation. Audit §9.3.
 */

const db = require('../models/db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Subscribe (or resubscribe) an email. Idempotent across the three
 * call sites. Returns { subscriber, action } where action is one of:
 *   'created'         — new row inserted
 *   'resubscribed'    — existing row was unsubscribed; flipped to active
 *   'already_active'  — existing active row, no change
 *
 * Each caller adapts the result to its own response shape (admin
 * returns the subscriber, public route exposes only success flags,
 * quote-wizard logs + ignores).
 *
 * Validation tier:
 *   strict=true (default) — full email regex; throws if invalid
 *   strict=false          — minimal "@" check, used by the admin route
 *                           because admin-typed inputs are trusted and
 *                           the existing endpoint accepted
 *                           bare-domain values
 *
 * `linkCustomer` defaults true; pass false if the caller prefers to
 * batch the customer-link query for many emails (the bulk-import path).
 */
async function subscribeOrResubscribe({
  email,
  firstName = null,
  lastName = null,
  source = 'public_form',
  strict = true,
  linkCustomer = true,
} = {}) {
  if (!email) {
    const err = new Error('email required');
    err.code = 'EMAIL_REQUIRED';
    throw err;
  }
  const lc = String(email).trim().toLowerCase();

  if (strict) {
    if (!EMAIL_RE.test(lc)) {
      const err = new Error('valid email required');
      err.code = 'INVALID_EMAIL';
      throw err;
    }
  } else if (!lc.includes('@')) {
    const err = new Error('email required');
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  const existing = await db('newsletter_subscribers').where({ email: lc }).first();

  if (existing) {
    if (existing.status === 'unsubscribed') {
      await db('newsletter_subscribers').where({ id: existing.id }).update({
        status: 'active',
        resubscribed_at: new Date(),
        unsubscribed_at: null,
        updated_at: new Date(),
      });
      if (linkCustomer) await linkToCustomer(lc);
      const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
      return { subscriber: fresh, action: 'resubscribed' };
    }
    if (linkCustomer) await linkToCustomer(lc);
    // Re-read so callers see the current row (customer_id may have
    // just been populated by the link).
    const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
    return { subscriber: fresh, action: 'already_active' };
  }

  const [row] = await db('newsletter_subscribers').insert({
    email: lc,
    first_name: firstName,
    last_name: lastName,
    source,
    status: 'active',
  }).returning('*');

  if (linkCustomer) await linkToCustomer(lc);
  // Re-read for the same reason — surfaces the freshly populated
  // customer_id without requiring callers to know the link runs.
  const fresh = await db('newsletter_subscribers').where({ id: row.id }).first();
  return { subscriber: fresh, action: 'created' };
}

/**
 * Link a newsletter subscriber to its matching customer (by email) when
 * one isn't linked yet. Case-insensitive on the customers side because
 * customer rows come from many entry points (booking, lead webhooks,
 * Twilio call ingestion, admin add) and not all of them lowercase email
 * before insert. Idempotent: only touches rows where customer_id IS NULL,
 * so calling repeatedly on the same email is a no-op.
 *
 * Without this, the "Customers only" / "Leads only" segment filters in
 * the composer match ~zero subscribers because customer_id was NULL on
 * every legacy row.
 */
async function linkToCustomer(email) {
  if (!email) return;
  const lc = email.toLowerCase();
  await db.raw(
    `UPDATE newsletter_subscribers
       SET customer_id = c.id, updated_at = NOW()
       FROM customers c
       WHERE newsletter_subscribers.email = ?
         AND LOWER(c.email) = ?
         AND newsletter_subscribers.customer_id IS NULL`,
    [lc, lc],
  );
}

module.exports = { subscribeOrResubscribe, linkToCustomer, EMAIL_RE };
