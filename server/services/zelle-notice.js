/**
 * Capital One "Someone sent you money with Zelle" notice — pure parsing and
 * trust predicate (no DB, no LLM). Money must never depend on a model
 * verdict, so everything here is deterministic and unit-tested against a
 * real (redacted) notice: server/tests/fixtures/zelle-notice-capitalone.*.
 *
 * The notices reach contact@ through the owner's Gmail forwarding filter
 * (personal inbox → contact@, owner ruling 2026-09-02). Gmail auto-forward
 * preserves From / Subject / body and Capital One's DKIM signature, so the
 * Gmail-written Authentication-Results at contact@ still carries an aligned
 * `dkim=pass header.i=@…capitalone.com` clause; only the envelope sender
 * becomes the forwarder's +caf_ address (SPF aligns to gmail.com, which the
 * predicate correctly ignores). Anything that does not authenticate as
 * Capital One is never trusted — the reconciler parks it for a human.
 */
const psl = require('psl');
const { decodeHTML } = require('entities');
const { domainFromAddress } = require('./email/spam-blocker');
const { properCase } = require('../utils/name-case');

const ZELLE_SENDER_ORG_DOMAIN = 'capitalone.com';
// \s also matches NBSP, so an encoded space in the HTML rendering still hits.
const NOTICE_MARKER_RE = /sent\s+you\s+money\s+with\s+Zelle/i;
// Invoice numbers as minted by services/invoice.js (WPC-YYYY-NNNN…).
const INVOICE_NUMBER_RE = /\bWPC-\d{4}-\d{3,6}\b/gi;

const MEMO_MAX = 200;
const PAYER_MAX = 120;

function isZelleNoticeCandidate({ subject, body_text: bodyText, body_html: bodyHtml, snippet } = {}) {
  return NOTICE_MARKER_RE.test(String(subject || ''))
    || NOTICE_MARKER_RE.test(String(bodyText || '').slice(0, 4000))
    || NOTICE_MARKER_RE.test(String(snippet || ''))
    // HTML-only rendering: decode it the same way the parser will (styles and
    // tags dropped, entities such as &nbsp; decoded) BEFORE bounding, so a
    // long <head> or an encoded space cannot hide the marker.
    || NOTICE_MARKER_RE.test(htmlToText(bodyHtml).slice(0, 4000));
}

// Minimal HTML → text: drop head/style/script, turn block boundaries into
// newlines, strip tags, then decode entities with the `entities` library
// (every named / decimal / hex form, so an accented payer name survives).
// Only reached when body_text is absent (the sync stores both).
function htmlToText(html) {
  return decodeHTML(String(html || '')
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '));
}

// Normalise the notice text so one set of regexes covers the text and HTML
// renderings: NBSP → space, drop ®, straighten curly apostrophes, collapse
// runs of spaces (newlines are kept — the memo ends at a line break).
function noticeText({ body_text: bodyText, body_html: bodyHtml } = {}) {
  const raw = bodyText && String(bodyText).trim() ? String(bodyText) : htmlToText(bodyHtml);
  return raw
    .replace(/ /g, ' ')
    .replace(/[®™]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

// Integer arithmetic only: the template always prints two decimals, so the
// dollars and cents are parsed as separate integers (no float rounding).
function parseAmountCents(text) {
  const m = text.match(/in the amount of \$ ?([\d,]+)\.(\d{2})\b/i);
  if (!m) return null;
  const dollars = Number(m[1].replace(/,/g, ''));
  if (!Number.isSafeInteger(dollars)) return null;
  const cents = dollars * 100 + Number(m[2]);
  return cents > 0 ? cents : null;
}

function parsePayerName(text) {
  const m = text.match(/(?:^|\n)\s*([^\n]{1,120}?) has just sent you money with Zelle/i);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim().slice(0, PAYER_MAX);
  return name ? properCase(name) : null;
}

function parseMemo(text) {
  // Horizontal whitespace only after the colon — an empty memo must not swallow
  // the next paragraph.
  const m = text.match(/Here's the message from [^:\n]{1,120}:[ \t]*([^\n]*)/i);
  if (!m) return null;
  const memo = m[1].trim().slice(0, MEMO_MAX);
  return memo || null;
}

// { payerName, amountCents, memo } or null when the notice template is not
// recognised (payer and amount are mandatory; the memo is optional).
function parseZelleNotice(text) {
  const t = String(text || '');
  const amountCents = parseAmountCents(t);
  const payerName = parsePayerName(t);
  if (!amountCents || !payerName) return null;
  return { payerName, amountCents, memo: parseMemo(t) };
}

function memoInvoiceNumbers(memo) {
  const found = String(memo || '').match(INVOICE_NUMBER_RE) || [];
  return [...new Set(found.map((n) => n.toUpperCase()))];
}

// ── Bank-feed lines (GATE_ZELLE_BANK_RECONCILE) ─────────────────────────────
// Capital One's own wording for a received Zelle on the account's transaction
// list — the statement CSV and Plaid's original_description — is "Zelle money
// received from <payer>". The payer is the sender's Zelle profile name, or an
// email address when the sender's bank sent no name. A bank line has no memo.
// Plaid's cleaned `description` may drop the payer, so the bank's own wording
// is read first. The feed itself is the trust: the row came from the bank
// through Plaid, so there is no sender to authenticate.
const BANK_ZELLE_RE = /\bzelle\b/i;
// Money coming BACK (a returned, reversed or cancelled outgoing transfer) is
// not a payment from a customer.
const BANK_NOT_A_PAYMENT_RE = /\b(?:return(?:ed)?|revers(?:al|ed)|refund(?:ed)?|cancel(?:l?ed)?)\b/i;
const BANK_RECEIVED_RE = /^zelle\s+(?:money\s+)?(?:received|payment|transfer)\s+from\s+(.+)$/i;
// A trailing reference some banks append ("… Conf# AB12CD", "…; Ref 123").
const BANK_TRAILER_RE = /\s*(?:[;|].*|\s(?:conf(?:irmation)?|ref(?:erence)?)\b.*)$/i;

// The line that names the Zelle transfer, or null when neither field does.
function bankZelleText({ original_description: original, description } = {}) {
  const tidy = (v) => String(v || '').replace(/\s+/g, ' ').trim();
  for (const text of [tidy(original), tidy(description)]) {
    if (BANK_ZELLE_RE.test(text)) return text;
  }
  return null;
}

// A staged credit that reads as a Zelle payment someone sent us.
function isZelleBankCredit(row = {}) {
  const text = bankZelleText(row);
  return !!text && !BANK_NOT_A_PAYMENT_RE.test(text);
}

// The payer on a "Zelle money received from …" line, or null when the line
// does not name one in that shape.
function parseZelleBankPayer(text) {
  const m = String(text || '').replace(/\s+/g, ' ').trim().match(BANK_RECEIVED_RE);
  if (!m) return null;
  const name = m[1].replace(BANK_TRAILER_RE, '').trim().slice(0, PAYER_MAX);
  if (!name) return null;
  return name.includes('@') ? name.toLowerCase() : properCase(name);
}

// Capital One's OWN DKIM signature is the only proof accepted: the forwarded
// notice keeps it intact, whereas SPF at contact@ authenticates the
// forwarder's envelope (gmail.com) — and SPF text is forgeable in a way DKIM
// is not. The header is parsed structurally (RFC 8601): clauses are split on
// ';' OUTSIDE quoted strings and parenthesised comments, quoted strings and
// comments are then dropped, and only a clause that itself STARTS with
// `dkim=pass` is read; a comment containing a quote or backslash (the
// ingredients of every break-out payload) makes the whole header untrusted. The
// signing identity is read after its LAST '@' and its org-domain must be
// capitalone.com (public-suffix aware, so capitalone.com.evil.example fails).
// Skip a quoted run starting at text[i] === '"', honouring backslash
// escapes; returns the index of the closing quote (or the end of text).
function skipQuoted(text, i) {
  for (let j = i + 1; j < text.length; j += 1) {
    if (text[j] === '\\') { j += 1; continue; }
    if (text[j] === '"') return j;
  }
  return text.length;
}
// Top-level method clauses of an Authentication-Results header. Quoted
// strings are skipped (escape-aware) and comments are dropped. FAIL CLOSED
// on anything a genuine Google header never carries inside a comment — a
// quote or a backslash — because those are exactly the characters every
// break-out payload needs; such a header yields NO clauses at all.
function authResultClauses(authResults) {
  const text = String(authResults || '');
  const clauses = [];
  let cur = '';
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (depth > 0) {
      if (ch === '"' || ch === '\\') return [];
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      continue;
    }
    if (ch === '"') { i = skipQuoted(text, i); continue; }
    if (ch === '\\') { i += 1; continue; }
    if (ch === '(') { depth = 1; continue; }
    if (ch === ';') { clauses.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (depth > 0) return [];
  clauses.push(cur);
  return clauses.map((c) => c.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
}

function dkimSignedByCapitalOne(authResults) {
  for (const clause of authResultClauses(authResults)) {
    if (!/^dkim=pass\b/.test(clause)) continue;
    const m = clause.match(/\bheader\.[di]=([^\s]+)/);
    if (!m) continue;
    const identity = m[1];
    const signer = identity.slice(identity.lastIndexOf('@') + 1);
    if (signer && psl.get(signer) === ZELLE_SENDER_ORG_DOMAIN) return true;
  }
  return false;
}

// Fail closed: only an authenticated Capital One sender is trusted. The
// header must exist (Gmail wrote it — gmail-client keeps only Google's own
// Authentication-Results), the From org-domain must be capitalone.com, AND
// a Capital One DKIM signature must have verified (SPF never suffices).
function isTrustedZelleSender({ from_address: fromAddress, authentication_results: authResults } = {}) {
  if (authResults == null) return false;
  // The sync stores the bare address; tolerate a "Name <addr>" form anyway.
  const angle = String(fromAddress || '').match(/<([^<>]+)>/);
  const domain = domainFromAddress(angle ? angle[1] : fromAddress);
  if (!domain || psl.get(domain) !== ZELLE_SENDER_ORG_DOMAIN) return false;
  return dkimSignedByCapitalOne(authResults);
}

module.exports = {
  ZELLE_SENDER_ORG_DOMAIN,
  isZelleNoticeCandidate,
  noticeText,
  parseZelleNotice,
  memoInvoiceNumbers,
  isTrustedZelleSender,
  authResultClauses,
  bankZelleText,
  isZelleBankCredit,
  parseZelleBankPayer,
};
