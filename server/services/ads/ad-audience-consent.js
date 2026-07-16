/**
 * Marketing-consent suppression for ad-audience uploads.
 *
 * Custom Audiences (Meta) and Customer Match (Google) upload hashed customer /
 * lead PII so the platform serves ads TO those people (retargeting). A contact
 * who has explicitly opted out of marketing must not be added to those
 * audiences. Two canonical opt-out sources:
 *   - messaging_suppression (phone): STOP / natural-language stop / wrong number
 *     / manual DNC — the same list the SMS wrapper honors.
 *   - email_suppressions (email): unsubscribe / spam_complaint / manual /
 *     do_not_email. A `bounce` is a deliverability signal, not a consent signal,
 *     so it does NOT suppress here.
 *
 * Matching is by normalized phone (last 10 digits) and lowercased email, so it
 * lines up regardless of +1 / formatting differences between the tables.
 *
 * Fail-closed: if the opt-out lists can't be loaded, the caller propagates the
 * error and skips the upload this run (retried next cron) rather than uploading
 * an unverified set — a suppression control must never fail open.
 */

const db = require('../../models/db');
const logger = require('../logger');

const EMAIL_OPTOUT_TYPES = ['unsubscribe', 'spam_complaint', 'manual', 'do_not_email'];

function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

function normEmail(e) {
  if (!e) return null;
  const s = String(e).trim().toLowerCase();
  return s || null;
}

async function loadMarketingSuppression() {
  const phones = new Set();
  const emails = new Set();

  const phoneRows = await db('messaging_suppression').where({ active: true }).select('phone');
  for (const r of phoneRows) {
    const n = normPhone(r.phone);
    if (n) phones.add(n);
  }

  const emailRows = await db('email_suppressions')
    .where({ status: 'active' })
    .whereIn('suppression_type', EMAIL_OPTOUT_TYPES)
    .select('email');
  for (const r of emailRows) {
    const n = normEmail(r.email);
    if (n) emails.add(n);
  }

  return {
    phones,
    emails,
    isSuppressed(member) {
      const ph = normPhone(member && member.phone);
      const em = normEmail(member && member.email);
      return Boolean((ph && phones.has(ph)) || (em && emails.has(em)));
    },
  };
}

/**
 * Drop explicit marketing opt-outs from a [{ key, email, phone }] member list.
 * Throws if the opt-out lists can't be loaded (fail-closed).
 */
async function filterMarketingSuppressed(members, { audienceKey } = {}) {
  if (!Array.isArray(members) || members.length === 0) return members || [];
  const sup = await loadMarketingSuppression();
  const kept = members.filter((m) => !sup.isSuppressed(m));
  const dropped = members.length - kept.length;
  if (dropped > 0) {
    logger.info(`[ad-consent] suppressed ${dropped}/${members.length} opted-out contacts${audienceKey ? ` from ${audienceKey}` : ''}`);
  }
  return kept;
}

module.exports = {
  loadMarketingSuppression,
  filterMarketingSuppressed,
  normPhone,
  normEmail,
  _private: { EMAIL_OPTOUT_TYPES },
};
