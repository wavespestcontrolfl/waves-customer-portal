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
// 2026-08-12 ruling waives that fee, so the prepaid year SUPERSEDES it.
//
// That retirement happens FIRST, server-side, before any prepay invoice
// exists (Codex P0: voiding after the tender leaves a minutes-long window
// where BOTH invoices are payable and the customer could pay each):
//   1. POST …/prepay-switch/supersede — re-derives the set server-side and
//      voids it. A refusal here has changed nothing and charged nothing.
//   2. mint the prepay invoice, then collect it (or send the pay link).
//   3. If the mint fails, or the operator backs out of the tender, POST
//      …/prepay-switch/undo re-mints an equivalent draft from the voided
//      row's own line items — the visit bills what it billed before, under a
//      new invoice number — and the uncollected prepay invoice is voided so
//      its payment_pending term can't suppress billing.
// A failed undo is loud: the operator must know this visit currently has no
// invoice behind it.

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
  // Set when an aborted switch could NOT put the per-application invoice
  // back — the visit is left with nothing to bill, which the operator must
  // know before completing it.
  const [restoreFailed, setRestoreFailed] = useState(null);
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

  // Step 1 — retire the per-application invoice SERVER-side. The server
  // re-derives the set itself (the client's list is display only) and refuses
  // as a whole if anything changed since the preview. Returns the voided rows
  // so the undo can restore them; throws with the server's reason otherwise.
  const supersedeFirst = async () => {
    if (supersedes.length === 0) return [];
    const result = await adminFetch(`/admin/schedule/${visitId}/prepay-switch/supersede`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    return Array.isArray(result?.voided) ? result.voided : [];
  };

  // Step 3 — the switch didn't complete: put the per-application invoice back
  // (re-minted server-side from the voided row's own amounts, new number).
  const undoSupersede = async (voided) => {
    if (!voided || voided.length === 0) return { ok: true, failed: [] };
    try {
      const result = await adminFetch(`/admin/schedule/${visitId}/prepay-switch/undo`, {
        method: 'POST',
        body: JSON.stringify({ voidedInvoiceIds: voided.map((v) => v.id) }),
      });
      const failed = Array.isArray(result?.failed) ? result.failed : [];
      return { ok: failed.length === 0, failed };
    } catch (e) {
      return { ok: false, failed: voided.map((v) => ({ ...v, error: e.message || 'restore failed' })) };
    }
  };

  const finish = (invoice, { collected }) => {
    onSaved?.();
    setDone({ invoice, collected });
  };

  const mint = async ({ chargeInPerson }) => {
    if (!preview?.eligible || !customerId) return;
    setBusy(chargeInPerson ? 'charge' : 'send');
    setActionError('');
    let voided = [];
    try {
      voided = await supersedeFirst();
    } catch (e) {
      // Nothing was minted and nothing charged — the visit still bills as it
      // did. Surface the server's reason and stop.
      setActionError(e.message || 'Could not retire the per-application invoice');
      setBusy('');
      return;
    }
    try {
      const result = await adminFetch(`/admin/customers/${customerId}/annual-prepay-invoice`, {
        method: 'POST',
        body: JSON.stringify({ ...preview.mintPayload, chargeInPerson }),
      });
      const invoice = result?.invoice;
      if (!invoice?.id) throw new Error('The prepay invoice did not come back — check Invoices before retrying');
      if (chargeInPerson) {
        setCollecting({ invoice, voided });
        return;
      }
      // The mint returns 201 even when the SMS/email leg failed. A prepay
      // invoice the customer never received, with their per-application one
      // already retired, would leave them with no bill at all — put it back.
      if (result?.delivery && result.delivery.ok === false) {
        const undo = await undoSupersede(voided);
        setActionError(
          `The ${money(preview.prepayTotal)} prepay invoice was created (${invoice.invoice_number || 'see Invoices'}) but could NOT be delivered`
          + `${result.delivery.error ? `: ${result.delivery.error}` : '.'} `
          + (undo.ok
            ? 'The per-application invoice was restored. Resend the prepay invoice from Invoices when you\u2019re ready.'
            : 'The per-application invoice could NOT be restored either — this visit has no invoice behind it. Rebuild it from Invoices.'),
        );
        return;
      }
      finish(invoice, { collected: false });
    } catch (e) {
      const undo = await undoSupersede(voided);
      setActionError(
        `${e.message || 'Could not create the prepay invoice'}.`
        + (voided.length === 0
          ? ''
          : undo.ok
            ? ' The per-application invoice was restored — nothing changed.'
            : ' The per-application invoice could NOT be restored — this visit has no invoice behind it. Rebuild it from Invoices.'),
      );
    } finally {
      setBusy('');
    }
  };

  // ── In-person tender ────────────────────────────────────────────────────
  if (collecting) {
    const { invoice, voided } = collecting;
    // Abort: void the uncollected prepay invoice (cancelling its
    // payment_pending term) AND put the per-application invoice back, so the
    // visit bills exactly what it billed before the operator tapped in.
    const abortAndClose = async () => {
      setBusy('abort');
      try {
        const fresh = await adminFetch(`/admin/invoices/${invoice.id}`).catch(() => null);
        const status = String(fresh?.status || '').toLowerCase();
        // Settled in the gap (webhook lag, captured PaymentIntent, credit
        // auto-applied) — that's a successful collection, not an abort.
        if (fresh && !['draft', 'sent', 'overdue'].includes(status)) {
          setCollecting(null);
          finish(invoice, { collected: true });
          return;
        }
        await adminFetch(`/admin/invoices/${invoice.id}/void`, { method: 'POST' });
      } catch (e) {
        setCollecting(null);
        setActionError(`The prepay invoice was created but not collected, and cancelling it failed: ${e.message}. Void ${invoice.invoice_number || 'it'} from Invoices — until then this customer's visits are held against an uncollected prepay.`);
        setBusy('');
        return;
      }
      const undo = await undoSupersede(voided);
      setBusy('');
      setCollecting(null);
      if (!undo.ok) {
        // The loud one: the visit now has NO invoice behind it.
        setRestoreFailed(undo.failed);
        return;
      }
      onSaved?.();
      onClose?.();
    };
    const collected = () => {
      setCollecting(null);
      finish(invoice, { collected: true });
    };
    return (
      <MobilePaymentSheet
        desktopVisible
        hideInvoiceTender
        service={{ customerId, customerName }}
        invoiceId={invoice.id}
        invoiceToken={invoice.token}
        amount={Number(invoice.total) || 0}
        onClose={abortAndClose}
        onChargeSuccess={collected}
        onPrepaidRecorded={collected}
      />
    );
  }

  // ── Undo failed: the visit is left with nothing to bill ─────────────────
  if (restoreFailed) {
    return (
      <Shell>
        <div className="text-alert-fg font-medium" style={{ fontSize: 15, marginBottom: 8 }}>
          This visit has no invoice behind it
        </div>
        <div className="text-zinc-900" style={{ fontSize: 13, marginBottom: 10 }}>
          The prepay was cancelled, but {restoreFailed.map((inv) => inv.invoiceNumber || 'the per-application invoice').join(', ')}{' '}
          could not be put back. Completing this visit will bill {customerName} the per-visit price only — the
          setup fee is gone. Rebuild the invoice from Invoices before completing.
        </div>
        <div className="text-ink-secondary" style={{ fontSize: 12, marginBottom: 14 }}>
          {restoreFailed[0]?.error}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy === 'restore'}
            onClick={async () => {
              setBusy('restore');
              const undo = await undoSupersede(restoreFailed);
              setBusy('');
              if (undo.ok) { setRestoreFailed(null); onSaved?.(); onClose?.(); }
              else setRestoreFailed(undo.failed);
            }}
            className="flex-1 rounded-full bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-60"
            style={{ padding: '12px 16px', fontSize: 14 }}
          >
            {busy === 'restore' ? 'Retrying…' : 'Retry restore'}
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
            Voided the moment you tap below, so it can’t be paid while you collect. Back out and an identical
            invoice is put straight back (new number) — this visit keeps billing exactly as it does now.
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
