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
const { hasAlignedAuth } = require('./email/inbox-hygiene');
const { domainFromAddress } = require('./email/spam-blocker');
const { properCase } = require('../utils/name-case');

const ZELLE_SENDER_ORG_DOMAIN = 'capitalone.com';
const NOTICE_MARKER_RE = /sent you money with Zelle/i;
// Invoice numbers as minted by services/invoice.js (WPC-YYYY-NNNN…).
const INVOICE_NUMBER_RE = /\bWPC-\d{4}-\d{3,6}\b/gi;

const MEMO_MAX = 200;
const PAYER_MAX = 120;

function isZelleNoticeCandidate({ subject, body_text: bodyText, snippet } = {}) {
  return NOTICE_MARKER_RE.test(String(subject || ''))
    || NOTICE_MARKER_RE.test(String(bodyText || '').slice(0, 4000))
    || NOTICE_MARKER_RE.test(String(snippet || ''));
}

// Minimal HTML → text: drop head/style/script, turn block boundaries into
// newlines, strip tags, decode the handful of entities Capital One's template
// uses. Only reached when body_text is absent (the sync stores both).
function htmlToText(html) {
  return String(html || '')
    .replace(/<(head|style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|td)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&reg;/gi, '')
    .replace(/&amp;/gi, '&')
    .replace(/&#8217;|&rsquo;/gi, '’')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
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

function parseAmountCents(text) {
  const m = text.match(/in the amount of \$ ?([\d,]+\.\d{2})\b/i);
  if (!m) return null;
  const cents = Math.round(Number(m[1].replace(/,/g, '')) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function parsePayerName(text) {
  const m = text.match(/(?:^|\n)\s*([^\n]{1,120}?) has just sent you money with Zelle/i);
  if (!m) return null;
  const name = m[1].replace(/\s+/g, ' ').trim().slice(0, PAYER_MAX);
  return name ? properCase(name) : null;
}

function parseMemo(text) {
  const m = text.match(/Here's the message from [^:\n]{1,120}:\s*([^\n]*)/i);
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

// Fail closed: only an authenticated Capital One sender is trusted. The
// header must exist (Gmail wrote it — gmail-client keeps only Google's own
// Authentication-Results), the From org-domain must be capitalone.com
// (public-suffix aware, so capitalone.com.evil.example is NOT), and the
// DKIM/SPF alignment must hold for that From domain.
function isTrustedZelleSender({ from_address: fromAddress, authentication_results: authResults } = {}) {
  if (authResults == null) return false;
  // The sync stores the bare address; tolerate a "Name <addr>" form anyway.
  const angle = String(fromAddress || '').match(/<([^<>]+)>/);
  const domain = domainFromAddress(angle ? angle[1] : fromAddress);
  if (!domain || psl.get(domain) !== ZELLE_SENDER_ORG_DOMAIN) return false;
  return hasAlignedAuth(authResults, domain);
}

module.exports = {
  ZELLE_SENDER_ORG_DOMAIN,
  isZelleNoticeCandidate,
  noticeText,
  parseZelleNotice,
  memoInvoiceNumbers,
  isTrustedZelleSender,
};
