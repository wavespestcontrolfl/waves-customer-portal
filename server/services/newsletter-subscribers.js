/**
 * Shared subscriber helpers — single source of truth for the
 * lookup → resub-or-insert → customer-link flow that three call sites
 * (admin add, public signup, quote-wizard dual-write) used to duplicate
 * with subtly different validation. Audit §9.3.
 */

const db = require('../models/db');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Double-opt-in confirmation link lifetime. After this, the link no longer
// confirms (lookupByToken returns 'expired') — a months-old link in an inbox
// can't silently activate a subscription. Stale 'pending' rows are deleted by
// purgeStalePendingSubscribers() after a longer window so the table (and the
// email's eligibility for a fresh signup) doesn't accrue dead pending rows.
const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days — link still confirms
const PENDING_PURGE_MS = 30 * 24 * 60 * 60 * 1000;    // 30 days — then delete the row

/**
 * Subscribe (or resubscribe) an email. Idempotent across all call sites.
 *
 * Returns { subscriber, action } where action is one of:
 *   'created'             — new active row inserted (auto-confirmed path)
 *   'resubscribed'        — unsubscribed row flipped back to active
 *   'already_active'      — existing active row, no change
 *   'already_pending'     — existing pending row, no resend triggered
 *                           (caller passed requireConfirmation=false on
 *                           a row that's mid-DOI; we don't auto-promote)
 *   'confirmation_sent'   — new pending row inserted; caller must send
 *                           the confirmation email (the subscriber row
 *                           contains the freshly-issued confirmation_token)
 *   'confirmation_resent' — existing pending row's confirmation_sent_at
 *                           was bumped; caller resends the email with
 *                           the SAME token (the user may already have
 *                           the prior link)
 *   'confirmed'           — pending row was auto-confirmed without
 *                           sending an email (admin/quote bypass path)
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
 *
 * `requireConfirmation` (default false): when true, new and resubscribe
 * paths land at status='pending' and the caller is expected to send the
 * confirmation email keyed off subscriber.confirmation_token. When
 * false, paths land directly at status='active' (admin add only; public
 * website and quote-wizard signups must pass requireConfirmation=true).
 */
async function subscribeOrResubscribe({
  email,
  firstName = null,
  lastName = null,
  source = 'public_form',
  strict = true,
  linkCustomer = true,
  requireConfirmation = false,
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
    // Pending → still mid-DOI. Resend the confirmation email if the
    // caller is requesting one (the user re-submitted the form because
    // they didn't see the original); auto-promote if the caller is
    // trusted (admin add) on a previously public-form-pending row.
    if (existing.status === 'pending') {
      if (requireConfirmation) {
        await db('newsletter_subscribers').where({ id: existing.id }).update({
          source,
          first_name: firstName !== null ? firstName : existing.first_name,
          last_name: lastName !== null ? lastName : existing.last_name,
          confirmation_sent_at: new Date(),
          updated_at: new Date(),
        });
        if (linkCustomer) await linkToCustomer(lc);
        const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
        return { subscriber: fresh, action: 'confirmation_resent' };
      }
      // Trusted-context promotion: flip pending to active.
      await db('newsletter_subscribers').where({ id: existing.id }).update({
        status: 'active',
        confirmed_at: new Date(),
        updated_at: new Date(),
      });
      if (linkCustomer) await linkToCustomer(lc);
      const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
      return { subscriber: fresh, action: 'confirmed' };
    }

    if (existing.status === 'unsubscribed') {
      const updates = {
        source,
        first_name: firstName !== null ? firstName : existing.first_name,
        last_name: lastName !== null ? lastName : existing.last_name,
        resubscribed_at: new Date(),
        unsubscribed_at: null,
        updated_at: new Date(),
      };
      if (requireConfirmation) {
        updates.status = 'pending';
        updates.confirmation_sent_at = new Date();
        updates.confirmation_token = db.raw('gen_random_uuid()');
        updates.confirmed_at = null;
      } else {
        updates.status = 'active';
        updates.confirmed_at = new Date();
      }
      await db('newsletter_subscribers').where({ id: existing.id }).update(updates);
      if (linkCustomer) await linkToCustomer(lc);
      const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
      return {
        subscriber: fresh,
        action: requireConfirmation ? 'confirmation_sent' : 'resubscribed',
      };
    }

    // status === 'active' — already confirmed. No-op aside from the
    // customer-link refresh (in case the row predates the customer
    // signup and the link is newly possible).
    if (linkCustomer) await linkToCustomer(lc);
    const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
    return { subscriber: fresh, action: 'already_active' };
  }

  // New row.
  const insertRow = {
    email: lc,
    first_name: firstName,
    last_name: lastName,
    source,
    status: requireConfirmation ? 'pending' : 'active',
  };
  if (requireConfirmation) {
    insertRow.confirmation_sent_at = new Date();
  } else {
    insertRow.confirmed_at = new Date();
  }
  const [row] = await db('newsletter_subscribers').insert(insertRow).returning('*');

  if (linkCustomer) await linkToCustomer(lc);
  // Re-read for the same reason — surfaces the freshly populated
  // customer_id without requiring callers to know the link runs.
  const fresh = await db('newsletter_subscribers').where({ id: row.id }).first();
  return {
    subscriber: fresh,
    action: requireConfirmation ? 'confirmation_sent' : 'created',
  };
}

/**
 * Read-only token lookup. Used by the GET confirm-page render path —
 * scanners and link previews would trip a state change if GET were
 * mutating, defeating double-opt-in. The actual flip lives in
 * confirmByToken (POST only).
 *
 * Returns { subscriber, action } where action is one of:
 *   'pending'        — row exists at status='pending', ready to confirm
 *   'already_active' — row was already active (idempotent re-visit)
 *   'unsubscribed'   — row is unsubscribed; nothing to do
 *   'not_found'      — token doesn't match any row
 */
async function lookupByToken(token) {
  if (!token) return { subscriber: null, action: 'not_found' };
  const sub = await db('newsletter_subscribers').where({ confirmation_token: token }).first();
  if (!sub) return { subscriber: null, action: 'not_found' };
  if (sub.status === 'active') return { subscriber: sub, action: 'already_active' };
  if (sub.status === 'unsubscribed') return { subscriber: sub, action: 'unsubscribed' };
  // pending — but reject an aged-out confirmation link (double-opt-in TTL) so a
  // months-old link can't silently activate the subscription. confirmByToken
  // returns this without flipping to active; the confirm page shows the
  // expired/invalid message.
  if (sub.confirmation_sent_at
      && (Date.now() - new Date(sub.confirmation_sent_at).getTime()) > CONFIRM_TTL_MS) {
    return { subscriber: sub, action: 'expired' };
  }
  return { subscriber: sub, action: 'pending' };
}

/**
 * Delete stale 'pending' subscribers whose confirmation link aged past the
 * purge window and never confirmed. Frees the email for a fresh signup and
 * keeps the table from accruing dead double-opt-in rows. Called from a daily
 * cron. Returns the number of rows removed.
 */
async function purgeStalePendingSubscribers() {
  const cutoff = new Date(Date.now() - PENDING_PURGE_MS);
  return db('newsletter_subscribers')
    .where({ status: 'pending' })
    .whereNotNull('confirmation_sent_at')
    .where('confirmation_sent_at', '<', cutoff)
    .del();
}

/**
 * Confirm a pending subscriber by token. Idempotent: confirming an
 * already-active row is a no-op (returns the existing subscriber);
 * confirming an unsubscribed row leaves status alone (the user already
 * opted out — confirming would be wrong).
 *
 * Mutates state — only invoke from a non-GET request handler. Email
 * link scanners and corporate-gateway preview fetchers blast every URL
 * in a message with GET; running this on GET would let them confirm
 * pending rows before the human recipient consents.
 *
 * Returns { subscriber, action } where action is one of:
 *   'confirmed'      — pending → active
 *   'already_active' — row was already active
 *   'unsubscribed'   — row is unsubscribed; nothing to do
 *   'not_found'      — token doesn't match any row
 */
async function confirmByToken(token) {
  const initial = await lookupByToken(token);
  if (initial.action !== 'pending') return initial;
  // status === 'pending' — flip to active.
  await db('newsletter_subscribers').where({ id: initial.subscriber.id }).update({
    status: 'active',
    confirmed_at: new Date(),
    updated_at: new Date(),
  });
  await linkToCustomer(initial.subscriber.email);
  const fresh = await db('newsletter_subscribers').where({ id: initial.subscriber.id }).first();
  return { subscriber: fresh, action: 'confirmed' };
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

module.exports = { subscribeOrResubscribe, lookupByToken, confirmByToken, linkToCustomer, purgeStalePendingSubscribers, EMAIL_RE, CONFIRM_TTL_MS };
