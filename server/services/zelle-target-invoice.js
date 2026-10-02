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

// Codex round-69 P2: "100 dollars" / "50 bucks" / "75 USD" are amounts too (the money detector's forms)
const AMOUNT_RE = /\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?(?=\s*(?:dollars?|bucks|usd)\b)/gi;
const centsOf = (raw) => Math.round(Number(String(raw).replace(/[^\d.]/g, '')) * 100);

// "WPC-2026-0123", "wpc 2026 0123", "invoice #0123", "invoice 123"
function invoiceNumbersNamed(text) {
  const t = String(text || '');
  const full = [...t.matchAll(/\b([A-Z]{2,6})[-\s](\d{4})[-\s](\d{2,6})\b/gi)].map((m) => `${m[1]}-${m[2]}-${m[3]}`.toUpperCase());
  // A LIST of numbers after "invoice(s)" names each one ("invoices 0123 and 0124", "invoice #0123, #0124 or #0125") — Codex round-35 P1:
  // only the first used to be read, so a later number was silently dropped.
  const tail = [...t.matchAll(/\binvoices?\s*(?:numbers?|nos?\.?|#)?\s*#?\s*(\d{2,6}(?:\s*(?:,\s*(?:and\s+|or\s+)?|\band\s+|\bor\s+|&\s*|\/\s*)#?\s*\d{3,6})*)\b/gi)]
    .flatMap((m) => m[1].match(/\d{2,6}/g) || []);
  // Codex round-48 P1: the bare shorthand "#0002" ("You can Zelle for #0002") names an invoice too - unless the word before it says
  // it is something else (an apartment, suite, order, ticket, account...). An unrelated "#" number can only make the target
  // unresolved (held), never pick a different invoice.
  const NOT_INVOICE_BEFORE = /\b(?:apt|apartment|suite|ste|unit|lot|bldg|building|room|rm|po|order|ticket|case|account|acct|card|check|cheque|ref|reference|confirmation|conf|claim|policy|job|work\s+order|lic|license|permit)\.?\s*$/i;
  const shorthand = [...t.matchAll(/(?<![\w#-])#\s?(\d{3,6})\b/g)]
    .filter((m) => !/\binvoices?\s*(?:numbers?|nos?\.?)?\s*$/i.test(t.slice(0, m.index)) && !NOT_INVOICE_BEFORE.test(t.slice(0, m.index)))
    .map((m) => m[1]);
  return { full, tail: [...new Set([...tail, ...shorthand])] };
}
const stripZeros = (s) => String(s).replace(/^0+/, '') || '0';

// Dollar amounts the customer ties to an INVOICE/BILL ("the $95 invoice", "invoice for $210") — the only
// amounts strong enough to contradict the sole open invoice (a bare "$50" may be anything).
function invoiceAmountsNamed(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(AMOUNT_RE)) {
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

// Codex round-47 P2: the resolver runs in separate PHASES (number -> lone invoice -> amount), each a small function returning a
// verdict or null (= "this phase does not decide"), so an eligibility change touches one phase without bypassing another's checks.

// The open list: every own open invoice, else the newest (older context shape).
const openInvoicesOf = (billing) => (Array.isArray(billing?.openInvoices) && billing.openInvoices.length
  ? billing.openInvoices
  : (billing?.openInvoice?.id ? [billing.openInvoice] : []));

// One test per explicit invoice-number reference. A tail that is just the tail of a named full number is the same reference.
function numberReferenceTests(named, billing) {
  const fullTailSet = new Set(named.full.map((f) => stripZeros(f.split('-').pop())));
  return [
    ...named.full.map((f) => (inv) => String(inv.invoiceNumber || '').toUpperCase() === f),
    // Codex round-37 P2: when the open list was CUT, a bare tail ("#0123") could match the wrong invoice (same tail, another
    // year, one the list dropped) — it never resolves; only a FULL invoice number does.
    ...named.tail.filter((t) => !fullTailSet.has(stripZeros(t))).map((t) => (inv) => {
      if (billing?.openInvoicesTruncated) return false;
      const num = String(inv.invoiceNumber || '').toUpperCase();
      return !!num && stripZeros(t) === stripZeros(num.split('-').pop());
    }),
  ];
}

// PHASE 1 - invoice numbers. Explicit references are parsed FIRST: even with a single open invoice, a message that names a
// DIFFERENT (or already settled) invoice is not about the open one (Codex round-20 P1). Codex round-36 P1: EVERY reference is
// resolved on its own and they must all land on the SAME single open invoice - a second number that is not open, ambiguous,
// or a different invoice leaves the target unresolved (abstain), never "the one that happened to match".
function resolveByNumber(open, billing, named, namedAmounts) {
  if (!(named.full.length > 0 || named.tail.length > 0)) return null;
  const resolved = new Map();
  let missing = false;
  let ambiguous = false;
  for (const matches of numberReferenceTests(named, billing).map((test) => open.filter(test))) {
    if (matches.length === 0) missing = true;
    else if (matches.length > 1) ambiguous = true;
    else resolved.set(String(matches[0].id), matches[0]);
  }
  const byNumber = [...resolved.values()];
  if (!missing && !ambiguous && byNumber.length > 1) return { invoiceId: null, reason: 'reference_conflict' }; // different invoices named
  // the open list was CUT (more open invoices than the context lists): absence from it proves nothing — do not declare
  // a conflict, treat the target as unresolved (Codex round-28 P2)
  if (missing) return { invoiceId: null, reason: billing?.openInvoicesTruncated ? 'open_list_truncated' : 'named_invoice_not_open' };
  if (ambiguous) return { invoiceId: null, reason: 'ambiguous_invoice_number' };
  if (byNumber.length !== 1) return null;
  if (namedAmounts.length && !namedAmountsAllMatch(namedAmounts, byNumber[0])) return { invoiceId: null, reason: 'reference_conflict' };
  return { invoiceId: byNumber[0].id, reason: 'invoice_number' };
}

// PHASE 2 - the lone open invoice (only when no partially paid invoice could be the one the customer means).
function resolveLoneOpen(inv, namedAmounts, bareAmounts) {
  if (namedAmounts.length && !namedAmountsAllMatch(namedAmounts, inv)) return { invoiceId: null, reason: 'named_amount_differs' };
  // SEVERAL distinct bare amounts ("Can I Zelle $100 or $200?") are explicit alternatives: every one must be this invoice's
  // amount (Codex round-44 P2).
  if (!namedAmounts.length && bareAmounts.length > 1 && bareAmounts.some((a) => a !== dueCentsOf(inv))) return { invoiceId: null, reason: 'ambiguous_amount' };
  return { invoiceId: inv.id, reason: 'single_open' };
}

// The open invoices whose amount due is one of `amounts`: exactly one resolves; several are ambiguous; none = `noneReason`.
function uniqueByAmount(open, amounts, noneReason) {
  const hits = open.filter((inv) => amounts.includes(dueCentsOf(inv)));
  if (hits.length === 1) return { invoiceId: hits[0].id, reason: 'unique_amount' };
  if (hits.length > 1) return { invoiceId: null, reason: 'ambiguous_amount' };
  return noneReason ? { invoiceId: null, reason: noneReason } : null;
}
const everyAmountOpen = (open, amounts) => amounts.every((a) => open.some((inv) => dueCentsOf(inv) === a));

// PHASE 3 - amounts. Codex round-31 P2: an amount the customer ties to an INVOICE / BILL ("my $200 invoice") identifies the
// target; a bare amount elsewhere ("...did you receive my $100 payment?") is the fallback ONLY when no invoice-scoped amount
// was named. Codex round-43 P2: from a CUT open list an amount-only identity never resolves (an omitted invoice may carry the
// same amount due). Codex round-39 / round-41 P2: EVERY named figure must resolve to an open invoice - one that matches
// nothing leaves the target unresolved, never silently dropped because a sibling matched.
function resolveByAmount(open, billing, namedAmounts, bareAmounts) {
  if (billing?.openInvoicesTruncated && (namedAmounts.length || bareAmounts.length)) return { invoiceId: null, reason: 'open_list_truncated' };
  if (namedAmounts.length) {
    if (!everyAmountOpen(open, namedAmounts)) return { invoiceId: null, reason: 'named_amount_differs' };
    return uniqueByAmount(open, namedAmounts, 'named_amount_differs');
  }
  if (bareAmounts.length > 1 && !everyAmountOpen(open, bareAmounts)) return { invoiceId: null, reason: 'ambiguous_amount' };
  return (bareAmounts.length && uniqueByAmount(open, bareAmounts, null)) || { invoiceId: null, reason: 'multiple_open_unreferenced' };
}

function resolveZelleTargetInvoice(billing, inboundMessage) {
  const open = openInvoicesOf(billing);
  // An own partially_paid invoice with an amount due is open to the customer (the pay page collects it and may show Zelle for it), but
  // its amount due is NOT knowable here: the paid portions live in payments, not in the invoice row. It is therefore never a target,
  // and its existence means "no open invoice" can never be concluded: the target is unresolved (abstain / ask which invoice), so a
  // denial cannot stand on its absence and an offer cannot be grounded on a figure that is not the invoice's.
  const partialDue = billing?.hasUncountedPartialDue === true;
  // Codex round-50 P2: an own invoice the context cannot model (a legacy 'unpaid' status the pay page may still collect and offer Zelle
  // for) means "no open invoice" can never be concluded either - unresolved, so an account-scoped denial cannot stand on it.
  if (open.length === 0) {
    if (partialDue) return { invoiceId: null, reason: 'partially_paid_invoice' };
    return { invoiceId: null, reason: billing?.hasUnmodeledInvoice === true ? 'unmodeled_invoice' : 'no_open_invoice' };
  }
  const namedAmounts = invoiceAmountsNamed(inboundMessage);
  const bareAmounts = [...new Set((String(inboundMessage || '').match(AMOUNT_RE) || []).map(centsOf))];
  return resolveByNumber(open, billing, invoiceNumbersNamed(inboundMessage), namedAmounts)
    // Codex round-64 P2: an unmodeled own invoice may be payable too - the lone MODELED row is not "the" open invoice, and only an
    // explicit identification (a number above, or an amount tied to an invoice) selects a modeled row; anything else is unresolved
    || (billing?.hasUnmodeledInvoice === true && !namedAmounts.length ? { invoiceId: null, reason: 'unmodeled_invoice' } : null)
    || (open.length === 1 && !partialDue ? resolveLoneOpen(open[0], namedAmounts, bareAmounts) : null)
    || resolveByAmount(open, billing, namedAmounts, bareAmounts);
}

// Does this text name a specific INVOICE (a number, or an amount tied to an invoice / bill)? Used to tell whether an
// EDITED body re-targets the Zelle offer away from the invoice the draft was written for (Codex round-29 P1).
function explicitInvoiceReference(text) {
  const named = invoiceNumbersNamed(text);
  return named.full.length > 0 || named.tail.length > 0 || invoiceAmountsNamed(text).length > 0;
}

module.exports = { resolveZelleTargetInvoice, invoiceNumbersNamed, explicitInvoiceReference };
