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
const NOTICE_MARKER_RE = /sent you money with Zelle/i;
// Invoice numbers as minted by services/invoice.js (WPC-YYYY-NNNN…).
const INVOICE_NUMBER_RE = /\bWPC-\d{4}-\d{3,6}\b/gi;

const MEMO_MAX = 200;
const PAYER_MAX = 120;

function isZelleNoticeCandidate({ subject, body_text: bodyText, body_html: bodyHtml, snippet } = {}) {
  return NOTICE_MARKER_RE.test(String(subject || ''))
    || NOTICE_MARKER_RE.test(String(bodyText || '').slice(0, 4000))
    || NOTICE_MARKER_RE.test(String(snippet || ''))
    // HTML-only rendering: the marker may sit past the snippet, and a tag
    // (Zelle<sup>®</sup>) may split it — strip tags before testing.
    || NOTICE_MARKER_RE.test(String(bodyHtml || '').slice(0, 20000).replace(/<[^>]+>/g, ''));
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

// Capital One's OWN DKIM signature is the only proof accepted: the forwarded
// notice keeps it intact, whereas SPF at contact@ authenticates the
// forwarder's envelope (gmail.com) — and SPF text is forgeable in a way DKIM
// is not. The header is parsed structurally (RFC 8601): clauses are split on
// ';' OUTSIDE quoted strings and parenthesised comments, quoted strings and
// comments are then dropped, and only a clause that itself STARTS with
// `dkim=pass` is read — so `dkim=pass header.i=@capitalone.com` smuggled
// inside a quoted envelope local part or a comment can never count. The
// signing identity is read after its LAST '@' and its org-domain must be
// capitalone.com (public-suffix aware, so capitalone.com.evil.example fails).
function authResultClauses(authResults) {
  const text = String(authResults || '');
  const clauses = [];
  let cur = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '\\' && i + 1 < text.length) { i += 1; continue; }
      if (ch === '"') quoted = false;
      continue;
    }
    if (depth > 0) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === '(') { depth = 1; continue; }
    if (ch === ';') { clauses.push(cur); cur = ''; continue; }
    cur += ch;
  }
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
};
