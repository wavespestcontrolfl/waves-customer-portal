'use strict';
// Which OPEN invoice is a Zelle offer (or denial) about? (Codex round-19 P1, PR #5331.)
//
// The aggregator's `billing.openInvoice` is only the NEWEST open own invoice. With several open and
// GATE_PAY_INCLUDE_BALANCE off, the pay page treats each invoice on its own, so the Zelle fact and the
// send-time recheck must be about the SAME invoice the customer is asking about — not always the newest.
//
//   0 or 1 open invoice  -> that invoice (or none): unchanged behavior.
//   several open         -> the invoice the customer's message names: by invoice NUMBER first, then by a
//                           UNIQUE amount. Anything else (no reference, or a reference matching more than
//                           one) cannot be tied to one invoice -> ABSTAIN (null): the drafter offers no
//                           Zelle and a send-time recheck of a Zelle offer cannot pass.
// Pure: no I/O, so the draft, the persisted decision and the send-time recheck all use one resolver.

const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
const centsOf = (raw) => Math.round(Number(String(raw).replace(/[^\d.]/g, '')) * 100);

// "WPC-2026-0123", "wpc 2026 0123", "invoice #0123", "invoice 123"
function invoiceNumbersNamed(text) {
  const t = String(text || '');
  const full = [...t.matchAll(/\b([A-Z]{2,6})[-\s](\d{4})[-\s](\d{2,6})\b/gi)].map((m) => `${m[1]}-${m[2]}-${m[3]}`.toUpperCase());
  // A LIST of numbers after "invoice(s)" names each one ("invoices 0123 and 0124", "invoice #0123, #0124 or #0125") — Codex round-35 P1:
  // only the first used to be read, so a later number was silently dropped.
  const tail = [...t.matchAll(/\binvoices?\s*(?:numbers?|nos?\.?|#)?\s*#?\s*(\d{2,6}(?:\s*(?:,\s*(?:and\s+|or\s+)?|\band\s+|\bor\s+|&\s*|\/\s*)#?\s*\d{3,6})*)\b/gi)]
    .flatMap((m) => m[1].match(/\d{2,6}/g) || []);
  return { full, tail };
}
const stripZeros = (s) => String(s).replace(/^0+/, '') || '0';

// Dollar amounts the customer ties to an INVOICE/BILL ("the $95 invoice", "invoice for $210") — the only
// amounts strong enough to contradict the sole open invoice (a bare "$50" may be anything).
function invoiceAmountsNamed(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/\$\s?\d[\d,]*(?:\.\d{1,2})?/g)) {
    // same SENTENCE only ("Zelle invoice X. I sent $95 last month" ties nothing)
    const before = t.slice(Math.max(0, m.index - 30), m.index).split(/[.!?;]\s/).pop();
    const after = t.slice(m.index + m[0].length, m.index + m[0].length + 30).split(/[.!?;]\s/)[0];
    if (/\b(?:invoices?|bills?|statements?)\b/i.test(`${before} ${after}`)) out.push(centsOf(m[0]));
  }
  return [...new Set(out)];
}

const dueCentsOf = (inv) => Math.round(Number(inv.amountDue) * 100);
// every invoice-scoped amount the customer named is THIS invoice's amount due (Codex round-39 P2)
const namedAmountsAllMatch = (named, inv) => named.every((a) => a === dueCentsOf(inv));

function resolveZelleTargetInvoice(billing, inboundMessage) {
  const open = Array.isArray(billing?.openInvoices) && billing.openInvoices.length
    ? billing.openInvoices
    : (billing?.openInvoice?.id ? [billing.openInvoice] : []);
  if (open.length === 0) return { invoiceId: null, reason: 'no_open_invoice' };

  // Explicit references are parsed FIRST — even with a single open invoice, a message that names a
  // DIFFERENT (or already settled) invoice is not about the open one (Codex round-20 P1).
  const named = invoiceNumbersNamed(inboundMessage);
  const namesNumber = named.full.length > 0 || named.tail.length > 0;
  const namedAmounts = invoiceAmountsNamed(inboundMessage);
  // Codex round-36 P1: EVERY explicit reference is resolved on its own against the open list and they must all land on the
  // SAME single open invoice — a second (or third) number that is not open, ambiguous, or a different invoice makes the
  // target unresolved (abstain), never "the one that happened to match". A tail that is just the tail of a named full
  // number is the same reference.
  const fullTailSet = new Set(named.full.map((f) => stripZeros(f.split('-').pop())));
  const refs = [
    ...named.full.map((f) => (inv) => String(inv.invoiceNumber || '').toUpperCase() === f),
    // Codex round-37 P2: when the open list was CUT, a bare tail ("#0123") could match the wrong invoice (same tail, another
    // year, one the list dropped) — it never resolves; only a FULL invoice number does.
    ...named.tail.filter((t) => !fullTailSet.has(stripZeros(t))).map((t) => (inv) => {
      if (billing?.openInvoicesTruncated) return false;
      const num = String(inv.invoiceNumber || '').toUpperCase();
      return !!num && stripZeros(t) === stripZeros(num.split('-').pop());
    }),
  ];
  let byNumber = [];
  let missing = false;
  let ambiguous = false;
  if (namesNumber) {
    const resolved = new Map();
    for (const matches of refs.map((test) => open.filter(test))) {
      if (matches.length === 0) missing = true;
      else if (matches.length > 1) ambiguous = true;
      else resolved.set(String(matches[0].id), matches[0]);
    }
    byNumber = [...resolved.values()];
    if (!missing && !ambiguous && byNumber.length > 1) return { invoiceId: null, reason: 'reference_conflict' }; // different invoices named
  }
  // the open list was CUT (more open invoices than the context lists): absence from it proves nothing — do not declare
  // a conflict, treat the target as unresolved (Codex round-28 P2)
  if (namesNumber && missing && billing?.openInvoicesTruncated) return { invoiceId: null, reason: 'open_list_truncated' };
  if (namesNumber && missing) return { invoiceId: null, reason: 'named_invoice_not_open' };
  if (namesNumber && ambiguous) return { invoiceId: null, reason: 'ambiguous_invoice_number' };
  if (byNumber.length === 1) {
    const inv = byNumber[0];
    if (namedAmounts.length && !namedAmountsAllMatch(namedAmounts, inv)) return { invoiceId: null, reason: 'reference_conflict' };
    return { invoiceId: inv.id, reason: 'invoice_number' };
  }

  if (open.length === 1) {
    if (namedAmounts.length && !namedAmountsAllMatch(namedAmounts, open[0])) return { invoiceId: null, reason: 'named_amount_differs' };
    return { invoiceId: open[0].id, reason: 'single_open' };
  }

  // Codex round-31 P2: an amount the customer ties to an INVOICE / BILL ("my $200 invoice") identifies the target; a bare
  // amount elsewhere in the message ("…did you receive my $100 payment?") does not. Scoped amounts win; bare amounts
  // are the fallback ONLY when the message has no invoice-scoped amount.
  // Codex round-43 P2: the open list was CUT, so a unique-looking amount match proves nothing (an omitted invoice may carry the
  // same amount due): an amount-only identity NEVER resolves from a truncated list - the target stays unresolved.
  const bareAmountsNamed = [...new Set((String(inboundMessage || '').match(AMOUNT_RE) || []).map(centsOf))];
  if (billing?.openInvoicesTruncated && (namedAmounts.length || bareAmountsNamed.length)) return { invoiceId: null, reason: 'open_list_truncated' };
  if (namedAmounts.length) {
    // Codex round-39 P2: EVERY invoice-scoped amount must resolve to an open invoice - one that matches nothing is an unresolved
    // explicit target, never ignored because a sibling amount matched.
    if (namedAmounts.some((a) => !open.some((inv) => dueCentsOf(inv) === a))) return { invoiceId: null, reason: 'named_amount_differs' };
    const byScoped = open.filter((inv) => namedAmounts.includes(dueCentsOf(inv)));
    if (byScoped.length === 1) return { invoiceId: byScoped[0].id, reason: 'unique_amount' };
    if (byScoped.length > 1) return { invoiceId: null, reason: 'ambiguous_amount' };
    return { invoiceId: null, reason: 'named_amount_differs' }; // the invoice-scoped amount matches no open invoice
  }
  const amounts = [...new Set((String(inboundMessage || '').match(AMOUNT_RE) || []).map(centsOf))];
  // Codex round-41 P2: SEVERAL distinct bare amounts ("Can I Zelle $100 or $200?") are several explicit alternatives — the same
  // "every named figure resolves" rule as the invoice-scoped amounts above: one that matches no open invoice leaves the target
  // unresolved (abstain), never silently dropped because a sibling happened to match.
  if (amounts.length > 1 && amounts.some((a) => !open.some((inv) => dueCentsOf(inv) === a))) return { invoiceId: null, reason: 'ambiguous_amount' };
  if (amounts.length) {
    const byAmount = open.filter((inv) => amounts.includes(Math.round(Number(inv.amountDue) * 100)));
    if (byAmount.length === 1) return { invoiceId: byAmount[0].id, reason: 'unique_amount' };
    if (byAmount.length > 1) return { invoiceId: null, reason: 'ambiguous_amount' };
  }
  return { invoiceId: null, reason: 'multiple_open_unreferenced' };
}

// Does this text name a specific INVOICE (a number, or an amount tied to an invoice / bill)? Used to tell whether an
// EDITED body re-targets the Zelle offer away from the invoice the draft was written for (Codex round-29 P1).
function explicitInvoiceReference(text) {
  const named = invoiceNumbersNamed(text);
  return named.full.length > 0 || named.tail.length > 0 || invoiceAmountsNamed(text).length > 0;
}

module.exports = { resolveZelleTargetInvoice, invoiceNumbersNamed, explicitInvoiceReference };
