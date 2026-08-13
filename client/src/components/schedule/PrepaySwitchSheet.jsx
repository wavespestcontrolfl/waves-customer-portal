// On-site "switch this customer to annual prepay" sheet (GATE_ONSITE_PREPAY_
// SWITCH). The case it exists for: a customer who chose pay-per-application
// inside the estimate changes their mind at the visit, and the office is
// standing in their driveway on a phone.
//
// Every number comes from GET /admin/schedule/annual-prepay-preview — the
// same server preflight the prepay-on-book modal uses — so this sheet never
// composes an amount. It relays the preview's `mintPayload` to the Customer
// 360 mint (POST /admin/customers/:id/annual-prepay-invoice), then either
// collects on the spot through MobilePaymentSheet or sends the pay link.
//
// ORDER IS THE SAFETY PROPERTY. The accept already minted a per-application
// invoice for this series (setup fee + first application); the owner's
// 2026-08-12 ruling waives that fee, so the prepaid year SUPERSEDES it. That
// void happens LAST — only after the prepay is collected or the pay link is
// deliberately sent:
//   • tender fails / operator backs out → the just-minted prepay invoice is
//     voided (cancelling its payment_pending term) and the superseded
//     invoice is untouched: the visit bills exactly as it did before.
//   • prepay settles → the superseded invoice is voided. If that void fails
//     the operator sees a loud, retryable error, because completion REUSES
//     any non-void invoice attached to the visit — leaving it alive would
//     bill the customer for a visit they just prepaid.

import { useEffect, useState } from 'react';
import MobilePaymentSheet from './MobilePaymentSheet';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  }).then(async (r) => {
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = await r.json(); msg = j.error || msg; } catch { /* keep status */ }
      throw new Error(msg);
    }
    return r.json();
  });
}

const money = (n) => `$${(Number(n) || 0).toFixed(2)}`;

function cadenceWord(cadence) {
  switch (String(cadence || '')) {
    case 'monthly': return 'monthly';
    case 'bimonthly': return 'bimonthly';
    case 'quarterly': return 'quarterly';
    case 'triannual': return 'tri-annual';
    case 'semiannual': return 'semi-annual';
    case 'annual': return 'annual';
    default: return '';
  }
}

// Service types are stored WITH their cadence baked in ("Quarterly Pest
// Control"), so prefixing the cadence again reads "4 quarterly Quarterly Pest
// Control visits". Drop the prefix when the name already carries it.
function coverageLine(preview) {
  const word = cadenceWord(preview.coverageCadence);
  const type = String(preview.coverageServiceType || '').trim();
  const prefix = word && !type.toLowerCase().includes(word.replace('-', '')) && !type.toLowerCase().includes(word)
    ? `${word} `
    : '';
  return `${preview.visitsPerYear} ${prefix}${type} visit${preview.visitsPerYear === 1 ? '' : 's'}`;
}

// "Aug 12, 2026" from a date-only string, read as a local calendar date (a
// bare new Date('YYYY-MM-DD') is parsed as UTC and renders a day early west
// of Greenwich).
function friendlyDate(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return String(ymd || '');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Shell({ children }) {
  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.55)', padding: 16 }}>
      <div className="bg-white rounded-2xl w-full" style={{ maxWidth: 460, padding: 20 }}>
        {children}
      </div>
    </div>
  );
}

export default function PrepaySwitchSheet({ service, onClose, onSaved }) {
  const [preview, setPreview] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState('');
  const [actionError, setActionError] = useState('');
  // Minted prepay invoice awaiting in-person tender.
  const [collecting, setCollecting] = useState(null);
  // Set once the prepay is settled: the superseded invoices still need
  // voiding, and a failure here is louder than a normal error.
  const [cleanupFailed, setCleanupFailed] = useState(null);
  const [done, setDone] = useState(null);

  const visitId = service?.id;
  const customerId = service?.customerId;
  const customerName = service?.customerName || 'this customer';

  useEffect(() => {
    if (!visitId) { setLoadError('No visit selected'); return undefined; }
    let cancelled = false;
    adminFetch(`/admin/schedule/annual-prepay-preview?scheduledServiceId=${encodeURIComponent(visitId)}`)
      .then((d) => { if (!cancelled) setPreview(d); })
      .catch((e) => { if (!cancelled) setLoadError(e.message || 'Could not price the prepaid year'); });
    return () => { cancelled = true; };
  }, [visitId]);

  const supersedes = preview?.supersedes || [];

  // Void every superseded invoice. Returns the list that FAILED so the caller
  // can surface exactly which ones still need a hand — a partial success must
  // never read as done.
  const voidSuperseded = async () => {
    const failures = [];
    for (const inv of supersedes) {
      try {
        await adminFetch(`/admin/invoices/${inv.id}/void`, { method: 'POST' });
      } catch (e) {
        failures.push({ ...inv, error: e.message || 'void failed' });
      }
    }
    return failures;
  };

  // `collected` rides INTO the cleanup state and back out of a retry: a
  // send-path switch whose void failed and later succeeded must not report
  // "collected" and tell the operator to complete a visit whose term is still
  // payment_pending.
  const finish = async (invoice, { collected }) => {
    const failures = await voidSuperseded();
    if (failures.length > 0) {
      setCleanupFailed({ failures, invoice, collected });
      return;
    }
    onSaved?.();
    setDone({ invoice, collected });
  };

  const mint = async ({ chargeInPerson }) => {
    if (!preview?.eligible || !customerId) return;
    setBusy(chargeInPerson ? 'charge' : 'send');
    setActionError('');
    try {
      const result = await adminFetch(`/admin/customers/${customerId}/annual-prepay-invoice`, {
        method: 'POST',
        body: JSON.stringify({ ...preview.mintPayload, chargeInPerson }),
      });
      const invoice = result?.invoice;
      if (!invoice?.id) throw new Error('The prepay invoice did not come back — check Invoices before retrying');
      if (chargeInPerson) {
        setCollecting(invoice);
        return;
      }
      // The mint returns 201 even when the SMS/email leg failed. Voiding the
      // per-application invoice on the strength of a prepay invoice the
      // customer never received would leave them with no bill at all and
      // nothing to pay — keep the existing invoice and say what happened.
      if (result?.delivery && result.delivery.ok === false) {
        setActionError(
          `The ${money(preview.prepayTotal)} prepay invoice was created (${invoice.invoice_number || 'see Invoices'}) but could NOT be delivered`
          + `${result.delivery.error ? `: ${result.delivery.error}` : '.'} `
          + 'The per-application invoice was left in place. Resend the prepay invoice from Invoices, then void the old one.',
        );
        return;
      }
      await finish(invoice, { collected: false });
    } catch (e) {
      setActionError(e.message || 'Could not create the prepay invoice');
    } finally {
      setBusy('');
    }
  };

  // ── In-person tender ────────────────────────────────────────────────────
  if (collecting) {
    // Abort: void the just-minted prepay invoice so its payment_pending term
    // is cancelled and the customer isn't left with coverage nobody paid for.
    // The superseded invoice is deliberately untouched on this path.
    const abortAndClose = async () => {
      setBusy('abort');
      try {
        const fresh = await adminFetch(`/admin/invoices/${collecting.id}`).catch(() => null);
        const status = String(fresh?.status || '').toLowerCase();
        // Settled in the gap (webhook lag, captured PaymentIntent, credit
        // auto-applied) — that's a successful collection, not an abort.
        if (fresh && !['draft', 'sent', 'overdue'].includes(status)) {
          setCollecting(null);
          await finish(collecting, { collected: true });
          return;
        }
        await adminFetch(`/admin/invoices/${collecting.id}/void`, { method: 'POST' });
        setCollecting(null);
        onClose?.();
      } catch (e) {
        setCollecting(null);
        setActionError(`The prepay invoice was created but not collected, and cancelling it failed: ${e.message}. Void ${collecting.invoice_number || 'it'} from Invoices — until then this customer's visits are held against an uncollected prepay.`);
      } finally {
        setBusy('');
      }
    };
    const collected = async () => {
      const invoice = collecting;
      setCollecting(null);
      await finish(invoice, { collected: true });
    };
    return (
      <MobilePaymentSheet
        desktopVisible
        hideInvoiceTender
        service={{ customerId, customerName }}
        invoiceId={collecting.id}
        invoiceToken={collecting.token}
        amount={Number(collecting.total) || 0}
        onClose={abortAndClose}
        onChargeSuccess={collected}
        onPrepaidRecorded={collected}
      />
    );
  }

  // ── Superseded-invoice cleanup failed — the loud one ────────────────────
  if (cleanupFailed) {
    return (
      <Shell>
        <div className="text-alert-fg font-medium" style={{ fontSize: 15, marginBottom: 8 }}>
          {cleanupFailed.collected
            ? 'Prepay collected — but the old invoice is still open'
            : 'Prepay invoice sent — but the old invoice is still open'}
        </div>
        <div className="text-zinc-900" style={{ fontSize: 13, marginBottom: 10 }}>
          {cleanupFailed.failures.map((inv) => `${inv.invoiceNumber || 'Invoice'} (${money(inv.total)})`).join(', ')}{' '}
          could not be voided. Completing this visit will reuse it and bill {customerName}
          {cleanupFailed.collected ? ' for a visit they just prepaid' : ' on top of the prepay invoice they were just sent'}.
          Void it from Invoices now.
        </div>
        <div className="text-ink-secondary" style={{ fontSize: 12, marginBottom: 14 }}>
          {cleanupFailed.failures[0]?.error}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy === 'cleanup'}
            onClick={async () => {
              setBusy('cleanup');
              const failures = await voidSuperseded();
              setBusy('');
              if (failures.length === 0) {
                onSaved?.();
                // Report what actually happened, not what the retry did: a
                // send-path switch is still uncollected.
                setDone({ invoice: cleanupFailed.invoice, collected: cleanupFailed.collected });
                setCleanupFailed(null);
              } else {
                setCleanupFailed({ ...cleanupFailed, failures });
              }
            }}
            className="flex-1 rounded-full bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-60"
            style={{ padding: '12px 16px', fontSize: 14 }}
          >
            {busy === 'cleanup' ? 'Retrying…' : 'Retry void'}
          </button>
          <button
            type="button"
            onClick={() => { onSaved?.(); onClose?.(); }}
            className="flex-1 rounded-full border border-zinc-300 text-zinc-700 font-medium u-focus-ring"
            style={{ padding: '12px 16px', fontSize: 14 }}
          >
            Close
          </button>
        </div>
      </Shell>
    );
  }

  if (done) {
    return (
      <Shell>
        <div className="text-zinc-900 font-medium" style={{ fontSize: 15, marginBottom: 8 }}>
          {done.collected ? 'Annual prepay collected' : 'Annual prepay invoice sent'}
        </div>
        <div className="text-ink-secondary" style={{ fontSize: 13, marginBottom: 14 }}>
          {done.collected
            ? `${customerName} is on annual prepay — the year's visits are marked prepaid as the payment settles.`
            : `${customerName} keeps billing per application until the prepay invoice is paid — this visit will invoice ${money(preview?.perVisit)} on completion if it isn't paid by then. The prepaid year activates on payment.`}
          {supersedes.length > 0 ? ' The per-application invoice for this visit was voided.' : ''}
        </div>
        {done.collected && (
          // The payment path stamps coverage before it returns, so completing
          // next is what the operator should do — and it behaves differently
          // now (no invoice, prepay-specific text). Say so rather than leaving
          // them to discover it.
          <div className="text-zinc-900" style={{ fontSize: 13, marginBottom: 14 }}>
            Complete the visit next: it cuts no invoice and texts the service report as covered by the annual
            prepaid plan.
          </div>
        )}
        <button
          type="button"
          onClick={onClose}
          className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring"
          style={{ padding: '12px 16px', fontSize: 14 }}
        >
          Done
        </button>
      </Shell>
    );
  }

  if (loadError) {
    return (
      <Shell>
        <div className="text-alert-fg" style={{ fontSize: 14, marginBottom: 12 }}>{loadError}</div>
        <button type="button" onClick={onClose} className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring" style={{ padding: '12px 16px', fontSize: 14 }}>Close</button>
      </Shell>
    );
  }

  if (!preview) {
    return (
      <Shell>
        <div className="text-ink-secondary" style={{ fontSize: 14 }}>Pricing the prepaid year…</div>
      </Shell>
    );
  }

  if (!preview.eligible) {
    return (
      <Shell>
        <div className="text-zinc-900 font-medium" style={{ fontSize: 15, marginBottom: 8 }}>
          Annual prepay isn’t available here
        </div>
        <div className="text-ink-secondary" style={{ fontSize: 13, marginBottom: 14 }}>
          This visit {preview.blockReason || 'can’t be sold as an annual prepay'}.
        </div>
        <button type="button" onClick={onClose} className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring" style={{ padding: '12px 16px', fontSize: 14 }}>Close</button>
      </Shell>
    );
  }

  const busyNow = !!busy;

  return (
    <Shell>
      <div className="text-zinc-900 font-medium" style={{ fontSize: 17, marginBottom: 2 }}>
        Switch to annual prepay
      </div>
      <div className="text-ink-secondary" style={{ fontSize: 13, marginBottom: 14 }}>
        {customerName}
      </div>

      <div className="border border-hairline border-zinc-200 rounded-sm" style={{ padding: 12, marginBottom: 12 }}>
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-zinc-900" style={{ fontSize: 15 }}>Prepaid year</span>
          <span className="text-zinc-900 font-medium u-nums" style={{ fontSize: 20 }}>{money(preview.prepayTotal)}</span>
        </div>
        <div className="text-ink-secondary" style={{ fontSize: 13, marginTop: 4 }}>
          {coverageLine(preview)} · {money(preview.perVisit)} each · starts {friendlyDate(preview.termStart)}
        </div>
        {Number(preview.discountAmount) > 0 && (
          <div className="text-zinc-900" style={{ fontSize: 13, marginTop: 4 }}>
            Includes the {preview.discountLabel} prepay discount — {money(preview.discountAmount)} off.
          </div>
        )}
        {preview.setupFee?.waivedWithPrepay && (
          <div className="text-zinc-900" style={{ fontSize: 13, marginTop: 4 }}>
            {money(preview.setupFee.amount)} setup fee waived.
          </div>
        )}
      </div>

      {supersedes.length > 0 && (
        <div className="border border-hairline border-zinc-200 bg-zinc-50 rounded-sm" style={{ padding: 12, marginBottom: 12 }}>
          <div className="u-label text-ink-secondary" style={{ marginBottom: 4 }}>Replaces</div>
          {supersedes.map((inv) => (
            <div key={inv.id} className="text-zinc-900" style={{ fontSize: 13 }}>
              {inv.invoiceNumber || 'Invoice'} — {money(inv.total)} ({inv.status})
              {inv.lines.length > 0 && (
                <span className="text-ink-secondary">
                  {' '}· {inv.lines.map((li) => li.description).join(' + ')}
                </span>
              )}
            </div>
          ))}
          <div className="text-ink-secondary" style={{ fontSize: 12, marginTop: 6 }}>
            Voided once the prepay is collected — or once you send the prepay invoice. Never on cancel, so backing
            out leaves this visit billing exactly as it does now.
          </div>
        </div>
      )}

      {actionError && (
        <div className="text-alert-fg" style={{ fontSize: 13, marginBottom: 10 }}>{actionError}</div>
      )}

      <button
        type="button"
        disabled={busyNow}
        onClick={() => mint({ chargeInPerson: true })}
        className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-60"
        style={{ padding: '13px 16px', fontSize: 15 }}
      >
        {busy === 'charge' ? 'Creating…' : `Collect ${money(preview.prepayTotal)} now`}
      </button>
      <button
        type="button"
        disabled={busyNow}
        onClick={() => mint({ chargeInPerson: false })}
        className="w-full rounded-full border border-zinc-300 text-zinc-900 font-medium u-focus-ring disabled:opacity-60"
        style={{ padding: '13px 16px', fontSize: 15, marginTop: 8 }}
      >
        {busy === 'send' ? 'Sending…' : 'Send the invoice instead'}
      </button>
      <button
        type="button"
        disabled={busyNow}
        onClick={onClose}
        className="w-full text-ink-secondary font-medium u-focus-ring disabled:opacity-60"
        style={{ padding: '12px 16px', fontSize: 14, marginTop: 4 }}
      >
        Cancel
      </button>
    </Shell>
  );
}
