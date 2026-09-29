'use strict';

/**
 * Gmail dot-equivalence for the call's two email readings.
 *
 * Gmail (and googlemail.com) ignores dots in the mailbox name, so
 * `j.q.sample1990@gmail.com` and `jqsample1990@gmail.com` deliver to the same
 * inbox. When the V1 and V2 readings differ ONLY by such dots they are one
 * address, not a disagreement (owner ruling, 2026-09-29).
 *
 * Deliberately narrow, and the same identity rule as
 * contact-quarantine-arbiter.js gmailCanonicalMailbox: dots are stripped only
 * from the mailbox name BEFORE any +tag (a tag is deliberate — "+lead.1" and
 * "+lead1" stay distinct), only on gmail.com / googlemail.com, and here only
 * when every reading names the SAME domain. Anything else is left alone.
 * Pure, no I/O. The caller still has to clear suppression and ownership for
 * the chosen spelling (call-recording-processor.js) before it is kept.
 */

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

function splitGmail(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return null;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (!GMAIL_DOMAINS.has(domain)) return null;
  const plusAt = local.indexOf('+');
  const mailbox = (plusAt === -1 ? local : local.slice(0, plusAt)).replace(/\./g, '');
  const tag = plusAt === -1 ? '' : local.slice(plusAt);
  if (!mailbox) return null;
  return { key: `${mailbox}${tag}`, domain };
}

/**
 * If EVERY value (2+) is a Gmail address on the same Gmail domain and they
 * differ only by dots in the mailbox name, returns the canonical address
 * (lowercase, mailbox undotted, tag unchanged, at that domain). Otherwise null.
 */
function collapseGmailDotEquivalent(values) {
  const list = Array.isArray(values) ? values : [];
  if (list.length < 2) return null;
  let first = null;
  for (const v of list) {
    const parts = splitGmail(v);
    if (!parts) return null;
    if (!first) first = parts;
    else if (parts.key !== first.key || parts.domain !== first.domain) return null;
  }
  return `${first.key}@${first.domain}`;
}

module.exports = { collapseGmailDotEquivalent };
