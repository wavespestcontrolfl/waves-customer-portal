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

module.exports = { gmailCanonicalMailbox, sameGmailInbox, GOOGLE_DOT_INSENSITIVE_DOMAINS };
