/**
 * Zelle payment-notice helpers — pure parsing (no DB, no LLM). Money must
 * never depend on a model verdict, so everything here is deterministic and
 * unit-tested. Holds the invoice-number memo reader, the Plaid bank-feed line
 * parser (GATE_ZELLE_BANK_RECONCILE) and the Authentication-Results clause
 * splitter the inbox hygiene checks share. (The Capital One email-notice
 * parser and sender-trust predicate were removed 2026-11-26 with the dropped
 * email route.)
 */
const { properCase } = require('../utils/name-case');

// Invoice numbers as minted by services/invoice.js (WPC-YYYY-NNNN…).
const INVOICE_NUMBER_RE = /\bWPC-\d{4}-\d{3,6}\b/gi;

const PAYER_MAX = 120;

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

// Authentication-Results header parsing (RFC 8601), shared with inbox hygiene:
// clauses are split on ';' OUTSIDE quoted strings and parenthesised comments,
// quoted strings and comments are dropped; a comment containing a quote or
// backslash (the ingredients of every break-out payload) yields no clauses.
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

module.exports = {
  memoInvoiceNumbers,
  authResultClauses,
  bankZelleText,
  isZelleBankCredit,
  parseZelleBankPayer,
};
