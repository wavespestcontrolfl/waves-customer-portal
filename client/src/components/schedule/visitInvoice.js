// Attached-invoice display state for an appointment, derived from the
// schedule payloads' checkoutInvoice* fields (GET /admin/schedule + /week).
//
// An invoice attached to a scheduled service is authoritative for what the
// visit collects: completion billing and the Charge-now mint both REUSE it
// as-is (admin-dispatch completion + POST /admin/schedule/:id/invoice), so a
// preview built from estimatedPrice alone under-states a first visit whose
// accept-minted invoice also carries the WaveGuard setup fee. The sheets
// branch on this instead of the per-application price when one exists.

const round2 = (n) => Math.round(n * 100) / 100;

export function attachedVisitInvoice(service) {
  if (!service || !service.checkoutInvoiceId) return null;
  const total = service.checkoutInvoiceTotal != null ? Number(service.checkoutInvoiceTotal) : null;
  if (total == null || !Number.isFinite(total)) return null;
  const status = String(service.checkoutInvoiceStatus || '').toLowerCase();
  const settled = status === 'paid' || status === 'prepaid';
  const processing = status === 'processing';
  // Refunded/cancelled invoices are non-void but the payment paths reject
  // them — never treat them as collectible; the sheet falls back to the
  // normal mint/edit flow instead of colliding with a dead invoice.
  const uncollectible = ['refunded', 'canceled', 'cancelled'].includes(status);
  // Account credit rides credit_applied while invoices.total stays gross —
  // the charge paths collect total − credit_applied, so every promised
  // amount here is the amount DUE, never the gross.
  const creditApplied = Math.max(0, Number(service.checkoutInvoiceCreditApplied) || 0);
  const amountDue = Math.max(0, round2(total - creditApplied));
  const lines = (Array.isArray(service.checkoutInvoiceLines) ? service.checkoutInvoiceLines : [])
    .map((li) => ({ description: String(li?.description || ''), amount: Number(li?.amount) }))
    .filter((li) => li.description && Number.isFinite(li.amount));
  // The INVOICE's own Bill-To: a payer-billed invoice survives the visit's
  // payer being cleared/deactivated, and the Charge-now reuse path refuses
  // it — never collectible from the homeowner.
  const payerBilled = !!service.checkoutInvoicePayerBilled;
  return {
    id: service.checkoutInvoiceId,
    number: service.checkoutInvoiceNumber || null,
    status,
    total,
    creditApplied,
    amountDue,
    // The visit's recorded prepayment has already been consumed by this
    // invoice (server reduced its total) — don't net it a second time.
    prepaidApplied: !!service.checkoutInvoicePrepaidApplied,
    settled,
    processing,
    uncollectible,
    payerBilled,
    // Open = still collectible at/after the visit (draft/sent/overdue).
    open: !settled && !processing && !uncollectible && !payerBilled,
    lines,
  };
}

export function visitInvoiceStatusNote(inv) {
  if (!inv) return '';
  if (inv.status === 'prepaid') return 'Covered by account credit — nothing to collect.';
  if (inv.settled) return 'Paid — nothing to collect at this visit.';
  if (inv.processing) return 'Payment processing — do not collect again.';
  if (inv.uncollectible) return `${inv.status === 'refunded' ? 'Refunded' : 'Canceled'} — not collectible; bill via a new invoice.`;
  return 'Collected when the visit is completed.';
}
