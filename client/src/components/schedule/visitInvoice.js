// Attached-invoice display state for an appointment, derived from the
// schedule payloads' checkoutInvoice* fields (GET /admin/schedule + /week).
//
// An invoice attached to a scheduled service is authoritative for what the
// visit collects: completion billing and the Charge-now mint both REUSE it
// as-is (admin-dispatch completion + POST /admin/schedule/:id/invoice), so a
// preview built from estimatedPrice alone under-states a first visit whose
// accept-minted invoice also carries the WaveGuard setup fee. The sheets
// branch on this instead of the per-application price when one exists.
export function attachedVisitInvoice(service) {
  if (!service || !service.checkoutInvoiceId) return null;
  const total = service.checkoutInvoiceTotal != null ? Number(service.checkoutInvoiceTotal) : null;
  if (total == null || !Number.isFinite(total)) return null;
  const status = String(service.checkoutInvoiceStatus || '').toLowerCase();
  const settled = status === 'paid' || status === 'prepaid';
  const processing = status === 'processing';
  const lines = (Array.isArray(service.checkoutInvoiceLines) ? service.checkoutInvoiceLines : [])
    .map((li) => ({ description: String(li?.description || ''), amount: Number(li?.amount) }))
    .filter((li) => li.description && Number.isFinite(li.amount));
  return {
    id: service.checkoutInvoiceId,
    number: service.checkoutInvoiceNumber || null,
    status,
    total,
    settled,
    processing,
    // Open = still collectible at/after the visit (draft/sent/overdue).
    open: !settled && !processing,
    lines,
  };
}

export function visitInvoiceStatusNote(inv) {
  if (!inv) return '';
  if (inv.status === 'prepaid') return 'Covered by account credit — nothing to collect.';
  if (inv.settled) return 'Paid — nothing to collect at this visit.';
  if (inv.processing) return 'Payment processing — do not collect again.';
  return 'Collected when the visit is completed.';
}
