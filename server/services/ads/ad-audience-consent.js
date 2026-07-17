/**
 * Marketing-consent suppression for ad-audience uploads.
 *
 * Custom Audiences (Meta) and Customer Match (Google) upload hashed customer /
 * lead PII so the platform serves ads TO those people (retargeting). A contact
 * who has explicitly opted out of marketing must not be added to those
 * audiences. Two canonical opt-out sources:
 *   - messaging_suppression (phone) — but ONLY consent-bearing reasons:
 *     opt_out_keyword / opt_out_natural_language / manual_dnc (and unknown
 *     reasons, conservatively). `non_mobile` rows are carrier landline
 *     detections — a delivery-capability signal, NOT an opt-out — and must not
 *     pull an otherwise-marketable lead out of retargeting. `wrong_number`
 *     means the phone belongs to a STRANGER: that phone identifier must never
 *     upload anywhere, but the person's email remains usable.
 *   - email_suppressions (email): unsubscribe / spam_complaint / manual /
 *     do_not_email. A `bounce` is a deliverability signal, not a consent
 *     signal, so it does NOT suppress here.
 *
 * Matching is by normalized phone (last 10 digits) and canonicalized email.
 * Emails use Google's canonical form (gmail/googlemail drop dots and +tags) —
 * Customer Match canonicalizes before hashing, so a suppression stored as
 * user@gmail.com must also match a lead stored as u.ser+promo@gmail.com or the
 * opted-out person stays uploadable under a dot-variant. Canonical matching
 * can only over-suppress, which is the safe direction for a consent control.
 * google-customer-match.js imports canonicalEmail from here so the match rule
 * and the upload hashing can never drift apart.
 *
 * Fail-closed: if the opt-out lists can't be loaded, the caller propagates the
 * error and skips the upload this run (retried next cron) rather than uploading
 * an unverified set — a suppression control must never fail open.
 */

const db = require('../../models/db');
const logger = require('../logger');

const EMAIL_OPTOUT_TYPES = ['unsubscribe', 'spam_complaint', 'manual', 'do_not_email'];
// messaging_suppression reasons that express the PERSON's marketing opt-out.
// Unknown/other reasons are treated as opt-outs (conservative fail-closed).
const PHONE_NON_CONSENT_REASONS = ['non_mobile', 'wrong_number'];

function normPhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

// Lowercase + trim; gmail/googlemail additionally drop dots and '+tag' from
// the local part — the same canonical form Google Customer Match hashes
// (google-customer-match.js imports this function).
function canonicalEmail(e) {
  if (!e) return null;
  const email = String(e).trim().replace(/\s+/g, '').toLowerCase(); // same pre-clean as data-manager.normalizeEmail
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return null; // not an email — never hash/upload it
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const canonicalLocal = local.split('+')[0].replace(/\./g, '');
    return canonicalLocal ? `${canonicalLocal}@${domain}` : null;
  }
  return email;
}

// Back-compat alias (pre-canonicalization callers/tests).
function normEmail(e) {
  return canonicalEmail(e);
}

async function loadMarketingSuppression() {
  const phones = new Set();        // person-level opt-out (canonical last-10)
  const emails = new Set();        // person-level opt-out (canonical email)
  const invalidPhones = new Set(); // wrong_number: identifier unusable, person NOT opted out
  const rawOptOutPhones = [];      // raw values for platform-side removal hashing
  const rawOptOutEmails = [];

  const phoneRows = await db('messaging_suppression')
    .where({ active: true })
    .select('phone', 'reason');
  for (const r of phoneRows) {
    const n = normPhone(r.phone);
    if (!n) continue;
    const reason = String(r.reason || '').toLowerCase();
    if (reason === 'non_mobile') continue; // landline ≠ opt-out
    if (reason === 'wrong_number') {
      // The number reaches a stranger — never upload it as an identifier for
      // this person, but their email consent is untouched.
      invalidPhones.add(n);
      rawOptOutPhones.push(r.phone);
      continue;
    }
    phones.add(n);
    rawOptOutPhones.push(r.phone);
  }

  const emailRows = await db('email_suppressions')
    .where({ status: 'active' })
    .whereIn('suppression_type', EMAIL_OPTOUT_TYPES)
    .select('email');
  for (const r of emailRows) {
    const n = canonicalEmail(r.email);
    if (!n) continue;
    emails.add(n);
    rawOptOutEmails.push(r.email);
  }

  return {
    phones,
    emails,
    invalidPhones,
    rawOptOutPhones,
    rawOptOutEmails,
    isSuppressed(member) {
      const ph = normPhone(member && member.phone);
      const em = canonicalEmail(member && member.email);
      return Boolean((ph && phones.has(ph)) || (em && emails.has(em)));
    },
  };
}

/**
 * Consent-clean a [{ key, email, phone }] member list.
 *
 * mode 'full' (default — retargeting audiences): drop members whose person
 * opted out of marketing, and null wrong_number phones on the rest (dropping
 * a member entirely when that leaves no identifier).
 *
 * mode 'identifiers-only' (exclusion audiences): opted-out PEOPLE ARE KEPT —
 * the audience exists to EXCLUDE them from prospecting, and removing them
 * would re-expose them to ads. Only invalid identifiers (wrong_number =
 * a stranger's phone) are stripped, since those must not upload anywhere.
 *
 * Throws if the opt-out lists can't be loaded (fail-closed).
 */
async function filterMarketingSuppressed(members, { audienceKey, mode = 'full' } = {}) {
  if (!Array.isArray(members) || members.length === 0) return members || [];
  const sup = await loadMarketingSuppression();
  const kept = [];
  let droppedOptOut = 0;
  let strippedPhones = 0;
  for (const m of members) {
    if (mode === 'full' && sup.isSuppressed(m)) { droppedOptOut += 1; continue; }
    const ph = normPhone(m && m.phone);
    if (ph && sup.invalidPhones.has(ph)) {
      const cleaned = { ...m, phone: null };
      strippedPhones += 1;
      if (!cleaned.email) { droppedOptOut += 1; continue; } // no usable identifier left
      kept.push(cleaned);
      continue;
    }
    kept.push(m);
  }
  if (droppedOptOut > 0 || strippedPhones > 0) {
    logger.info(`[ad-consent] ${audienceKey || 'audience'}: dropped ${droppedOptOut}/${members.length} contacts, stripped ${strippedPhones} invalid phones (mode=${mode})`);
  }
  return kept;
}

module.exports = {
  loadMarketingSuppression,
  filterMarketingSuppressed,
  normPhone,
  normEmail,
  canonicalEmail,
  _private: { EMAIL_OPTOUT_TYPES, PHONE_NON_CONSENT_REASONS },
};
