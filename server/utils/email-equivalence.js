'use strict';

/**
 * Gmail dot-insensitivity — the one shared rule.
 *
 * Google is the one major provider that ignores dots in the mailbox name, so
 * dot-variants on these domains are literally the same mailbox. Do NOT extend
 * this to other providers (dots are significant elsewhere), and do NOT strip
 * +tags (a tag is deliberate, not a mishear). Pure, no I/O.
 *
 * gmailCanonicalMailbox is the candidate canonicalizer the contact
 * quarantine arbiter weighs (moved here unchanged so every caller shares one
 * rule). Delivery-mailbox identity for suppression/ownership SQL stays in
 * customer-comms-lock.js (it also strips +tags, which is right for "same
 * inbox" but not for "same candidate").
 */

const GOOGLE_DOT_INSENSITIVE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * Canonical mailbox for Google's dot-insensitivity, or null when the rule
 * does not apply. googlemail.com aliases gmail.com, so both collapse to the
 * same canonical key.
 */
function gmailCanonicalMailbox(email) {
  const [local, domain] = String(email || '').toLowerCase().split('@');
  if (!local || !domain || !GOOGLE_DOT_INSENSITIVE_DOMAINS.has(domain)) return null;
  // Strip dots only from the mailbox name BEFORE any +tag: the tag is the
  // deliberate part (filters can key on its exact text), so tag spellings
  // that differ by a dot stay distinct candidates for the model to weigh.
  const plusAt = local.indexOf('+');
  const mailbox = plusAt === -1 ? local : local.slice(0, plusAt);
  const tag = plusAt === -1 ? '' : local.slice(plusAt);
  return `${mailbox.replace(/\./g, '')}${tag}@gmail.com`;
}

// A valid dot-atom local part: no leading, trailing or consecutive dots. An
// address that breaks this is not "the same inbox, spelled differently" — it
// is a bad address that may bounce (codex #5323 r4 P2).
function validDotPlacement(email) {
  const local = String(email || '').split('@')[0];
  return !!local && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

/**
 * The read-back card's "same Gmail inbox" test: 2+ readings that share one
 * gmailCanonicalMailbox, every one with valid dot placement, and all on the
 * SAME Google domain (gmail.com vs googlemail.com stays a question for the
 * office). Returns the shared canonical mailbox, or null.
 */
function sameGmailInbox(values) {
  const list = (Array.isArray(values) ? values : []).map((v) => String(v || '').trim().toLowerCase());
  if (list.length < 2 || !list.every(validDotPlacement)) return null;
  const canon = new Set(list.map(gmailCanonicalMailbox));
  const domains = new Set(list.map((v) => v.split('@')[1]));
  if (canon.size !== 1 || canon.has(null) || domains.size !== 1) return null;
  return [...canon][0];
}

/**
 * Knex condition for "an email_suppressions row covers this address": the
 * exact address, and — for a Google address — any row on the same Google
 * mailbox under another spelling (dots, +tag, googlemail), since Gmail
 * delivers them all to one inbox (owner decision 2026-09-29). Strictly
 * wider than the exact match, so it can only ever block more mail.
 * Use as `.where(suppressionCoversEmail(email))`.
 */
function suppressionCoversEmail(email, column = 'email') {
  const normalized = String(email || '').trim().toLowerCase();
  const { googleMailboxIdentity, GOOGLE_MAILBOX_SQL } = require('./customer-comms-lock');
  const mailbox = normalized ? googleMailboxIdentity(normalized) : null;
  return function suppressionMatch() {
    this.whereRaw(`LOWER(${column}) = ?`, [normalized]);
    if (mailbox) {
      this.orWhereRaw(
        `(${GOOGLE_MAILBOX_SQL.isGoogle(column)} AND ${GOOGLE_MAILBOX_SQL.mailbox(column)} = ?)`,
        [mailbox.split('@')[0]],
      );
    }
  };
}

/**
 * The same rule as a correlated SQL predicate, for bulk sends that anti-join
 * suppressions against a table of recipients (the newsletter blast): the
 * suppression column covers the recipient column when they are equal, or both
 * are Google addresses on the same mailbox. Column names come from hardcoded
 * callers only — never user input.
 */
function suppressionCoversColumnSql(suppressionColumn, recipientColumn) {
  const { GOOGLE_MAILBOX_SQL } = require('./customer-comms-lock');
  return `(LOWER(${suppressionColumn}) = LOWER(${recipientColumn})`
    + ` OR (${GOOGLE_MAILBOX_SQL.isGoogle(suppressionColumn)} AND ${GOOGLE_MAILBOX_SQL.isGoogle(recipientColumn)}`
    + ` AND ${GOOGLE_MAILBOX_SQL.mailbox(suppressionColumn)} = ${GOOGLE_MAILBOX_SQL.mailbox(recipientColumn)}))`;
}

/**
 * Which newsletter_subscribers rows a bounce lands on. Takes a fresh
 * `db('newsletter_subscribers')` builder and the delivery's subscriber id and
 * mailed address.
 *
 * - No recorded mailed address: the plain id match (nothing to fence on).
 * - A Google mailed address: EVERY row on that Gmail mailbox (dots, +tag,
 *   googlemail spellings), matched by identity and not by id. The inbox is
 *   what bounced, so every subscriber row for it takes the bounce, and a late
 *   bounce for one spelling still lands when the row was stored under another.
 *   An address on another mailbox (a merged-away typo) still does not match.
 * - A Google address with invalid dot placement: treated like any other
 *   address (exact fence), never widened to the valid mailbox.
 * - Any other address: the delivery's row, fenced to the exact LOWER/TRIM
 *   address, as before (dots and +tags are significant off Google).
 *
 * Bounce writes only. Opt-outs stay unfenced at their call sites.
 */
function subscriberRowsForBounce(query, subscriberId, mailedEmail) {
  const mailed = String(mailedEmail || '').trim().toLowerCase();
  const { GOOGLE_MAILBOX_SQL } = require('./customer-comms-lock');
  // A malformed Gmail address (.john@, jo..hn@, two '@') is not an alias of
  // the valid mailbox; Gmail rejects it, which is often why it bounced. It
  // keeps the exact-address fence below.
  const mailbox = bounceMailbox(mailed);
  if (mailbox) {
    const column = 'TRIM(email)';
    return query.whereRaw(
      // The same well-formedness rule on the stored side: a malformed stored
      // spelling is not an alias of the valid mailbox either.
      `(${GOOGLE_MAILBOX_SQL.isGoogle(column)} AND ${GOOGLE_MAILBOX_SQL.mailbox(column)} = ?
        AND ${wellFormedAddressSql(column)})`,
      [mailbox.split('@')[0]],
    );
  }
  // No subscriber id (the delivery lost it in a merge) and no Gmail mailbox
  // to match by: nothing to bounce-count.
  if (!subscriberId) return query.whereRaw('FALSE');
  const byId = query.where({ id: subscriberId });
  return mailed ? byId.whereRaw('LOWER(TRIM(email)) = ?', [mailed]) : byId;
}

// ONE rule for "a well-formed address the Gmail widening may apply to",
// JS and SQL kept together: exactly one '@', and a local part with no
// leading, trailing or consecutive dots. Anything else — ".john@",
// "jo..hn@", "john@gmail.com@invalid.test" — is not an alias of a valid
// mailbox and keeps the exact-address fence (codex #5413 r1-r3).
function wellFormedAddress(email) {
  const value = String(email || '');
  return value.split('@').length === 2 && validDotPlacement(value);
}

function wellFormedAddressSql(column) {
  const local = `SPLIT_PART(LOWER(${column}), '@', 1)`;
  return `(LENGTH(${column}) - LENGTH(REPLACE(${column}, '@', '')) = 1
        AND ${local} <> ''
        AND ${local} NOT LIKE '.%'
        AND ${local} NOT LIKE '%.'
        AND POSITION('..' IN ${local}) = 0)`;
}

/**
 * The Gmail mailbox a bounce for this mailed address widens to, or null
 * (exact-address fence). Callers use it to decide whether a delivery whose
 * subscriber id was cleared by a merge can still reach the surviving row.
 */
function bounceMailbox(mailedEmail) {
  const mailed = String(mailedEmail || '').trim().toLowerCase();
  if (!mailed || !wellFormedAddress(mailed)) return null;
  const { googleMailboxIdentity } = require('./customer-comms-lock');
  return googleMailboxIdentity(mailed);
}

module.exports = { gmailCanonicalMailbox, sameGmailInbox, suppressionCoversEmail, suppressionCoversColumnSql, subscriberRowsForBounce, bounceMailbox, GOOGLE_DOT_INSENSITIVE_DOMAINS };
