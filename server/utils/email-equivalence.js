'use strict';

/**
 * Gmail dot-equivalence for call-captured email candidates.
 *
 * Gmail (and googlemail.com) ignores dots in the local part, so
 * `j.q.sample1990@gmail.com` and `jqsample1990@gmail.com` deliver to the same
 * inbox. When two email readings differ ONLY by such dots they are the same
 * address, not a disagreement (owner ruling, 2026-09-29).
 *
 * Deliberately narrow: ONLY dots, ONLY gmail.com / googlemail.com, and only
 * when every reading names the SAME domain. A `+tag`, a letter, a
 * gmail-vs-googlemail domain difference, or any non-Gmail address is left
 * alone (dots matter on other providers). Pure, no I/O.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function splitGmail(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return null;
  const undotted = local.replace(/\./g, '');
  if (!undotted) return null;
  return { undotted, domain };
}

/**
 * If EVERY value is a Gmail address on the same Gmail domain and they all
 * share one dot-stripped local part, returns the canonical address (lowercase
 * undotted local part at that domain). Otherwise null. A single value returns
 * its own undotted form; callers that only want a collapse decision should
 * pass 2+ values.
 */
function collapseGmailDotEquivalent(values) {
  const list = Array.isArray(values) ? values : [];
  if (!list.length) return null;
  let first = null;
  for (const v of list) {
    const parts = splitGmail(v);
    if (!parts) return null;
    if (!first) first = parts;
    else if (parts.undotted !== first.undotted || parts.domain !== first.domain) return null;
  }
  return `${first.undotted}@${first.domain}`;
}

// True when two readings are the same address: identical after trim +
// lowercase, or Gmail dot-only equivalent.
function emailsEquivalent(a, b) {
  const x = String(a == null ? '' : a).trim().toLowerCase();
  const y = String(b == null ? '' : b).trim().toLowerCase();
  if (x === y) return true;
  return collapseGmailDotEquivalent([x, y]) !== null;
}

// A stable grouping key: the canonical form for a Gmail address, else the
// trimmed lowercase value.
function emailEquivalenceKey(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return collapseGmailDotEquivalent([s]) || s;
}

module.exports = { collapseGmailDotEquivalent, emailsEquivalent, emailEquivalenceKey };
