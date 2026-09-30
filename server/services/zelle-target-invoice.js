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
  const tail = [...t.matchAll(/\binvoice\s*(?:number|no\.?|#)?\s*#?\s*(\d{2,6})\b/gi)].map((m) => m[1]);
  return { full, tail };
}
const stripZeros = (s) => String(s).replace(/^0+/, '') || '0';

function resolveZelleTargetInvoice(billing, inboundMessage) {
  const open = Array.isArray(billing?.openInvoices) && billing.openInvoices.length
    ? billing.openInvoices
    : (billing?.openInvoice?.id ? [billing.openInvoice] : []);
  if (open.length === 0) return { invoiceId: null, reason: 'no_open_invoice' };
  if (open.length === 1) return { invoiceId: open[0].id, reason: 'single_open' };

  const named = invoiceNumbersNamed(inboundMessage);
  const byNumber = open.filter((inv) => {
    const num = String(inv.invoiceNumber || '').toUpperCase();
    if (!num) return false;
    if (named.full.includes(num)) return true;
    const last = num.split('-').pop();
    return named.tail.some((t) => stripZeros(t) === stripZeros(last));
  });
  if (byNumber.length === 1) return { invoiceId: byNumber[0].id, reason: 'invoice_number' };
  if (byNumber.length > 1) return { invoiceId: null, reason: 'ambiguous_invoice_number' };

  const amounts = [...new Set((String(inboundMessage || '').match(AMOUNT_RE) || []).map(centsOf))];
  if (amounts.length) {
    const byAmount = open.filter((inv) => amounts.includes(Math.round(Number(inv.amountDue) * 100)));
    if (byAmount.length === 1) return { invoiceId: byAmount[0].id, reason: 'unique_amount' };
    if (byAmount.length > 1) return { invoiceId: null, reason: 'ambiguous_amount' };
  }
  return { invoiceId: null, reason: 'multiple_open_unreferenced' };
}

module.exports = { resolveZelleTargetInvoice, invoiceNumbersNamed };
