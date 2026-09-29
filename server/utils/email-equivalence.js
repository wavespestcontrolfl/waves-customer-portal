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

module.exports = { gmailCanonicalMailbox, sameGmailInbox, suppressionCoversEmail, suppressionCoversColumnSql, GOOGLE_DOT_INSENSITIVE_DOMAINS };
