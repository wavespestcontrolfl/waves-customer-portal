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
      const err = new Error(msg);
      // A status means the SERVER answered — the request definitively did not
      // commit. No status (network drop, timeout) means the outcome is
      // UNKNOWN, and money paths must not compensate as if it failed.
      err.status = r.status;
      throw err;
    }
    return r.json();
  });
}

// Prepay-invoice status classification for the abort path. Explicit
// allowlists (Codex P0 r3): "anything not draft/sent/overdue" wrongly read
// void/refunded as a successful collection, which skipped the restore and
// reported success over a customer who paid nothing.
const PREPAY_SETTLED_STATUSES = ['paid', 'prepaid', 'processing'];
const PREPAY_TERMINAL_UNPAID_STATUSES = ['void', 'cancelled', 'canceled', 'refunded'];

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
  // Set when the switch stopped mid-way and the operator has to finish by
  // hand: a restore that failed, an ambiguous network outcome, or a prepay
  // void that refused. { title, message, detail, voided } — `voided` powers
  // the Restore button (idempotent server-side, so retries are safe).
  const [recovery, setRecovery] = useState(null);
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
      if (e.status) {
        // The server answered: nothing was voided, nothing minted, nothing
        // charged — the visit still bills as it did. Surface the reason.
        setActionError(e.message || 'Could not retire the per-application invoice');
      } else {
        // Network drop: the void may or may not have committed. The
        // supersede endpoint is idempotent (a retry re-reports already-voided
        // rows without re-voiding), so a Restore here is safe either way.
        setRecovery({
          title: 'Connection dropped mid-switch',
          message: `The request to retire the per-application invoice didn\u2019t come back \u2014 it may or may not have gone through. Nothing was charged. Tap Restore to put ${customerName}\u2019s invoice back (safe either way), then try the switch again.`,
          detail: e.message,
          voided: supersedes,
        });
      }
      setBusy('');
      return;
    }
    let result;
    try {
      result = await adminFetch(`/admin/customers/${customerId}/annual-prepay-invoice`, {
        method: 'POST',
        body: JSON.stringify({ ...preview.mintPayload, chargeInPerson }),
      });
    } catch (e) {
      if (e.status) {
        // Definite server rejection — the mint did not commit. Put the
        // per-application invoice back.
        const undo = await undoSupersede(voided);
        setActionError(
          `${e.message || 'Could not create the prepay invoice'}.`
          + (voided.length === 0
            ? ''
            : undo.ok
              ? ' The per-application invoice was restored \u2014 nothing changed.'
              : ' The per-application invoice could NOT be restored \u2014 this visit has no invoice behind it. Rebuild it from Invoices.'),
        );
      } else {
        // AMBIGUOUS: the mint may have committed server-side (Codex P0 r3).
        // Auto-restoring here could park a fresh per-application invoice
        // beside a live prepay invoice — the exact both-payable state this
        // flow exists to prevent. Hand it to the operator instead.
        setRecovery({
          title: 'Connection dropped mid-switch',
          message: `The prepay invoice request didn\u2019t come back \u2014 it may exist in Invoices. Check there first: if a ${money(preview.prepayTotal)} prepay invoice was created, void or collect it from Invoices; if not, tap Restore to put ${customerName}\u2019s per-application invoice back.`,
          detail: e.message,
          voided,
        });
      }
      setBusy('');
      return;
    }
    try {
      const invoice = result?.invoice;
      if (!invoice?.id) {
        setActionError('The prepay invoice did not come back in the response \u2014 check Invoices before retrying.');
        return;
      }
      if (chargeInPerson) {
        setCollecting({ invoice, voided });
        return;
      }
      // The mint returns 201 even when the SMS/email leg failed. A prepay
      // invoice the customer never received, with their per-application one
      // already retired, would leave them with no bill at all. Order matters
      // (Codex P0 r3): void the undelivered prepay FIRST — restoring before
      // that void would put two live invoices on the account.
      if (result?.delivery && result.delivery.ok === false) {
        try {
          await adminFetch(`/admin/invoices/${invoice.id}/void`, { method: 'POST' });
        } catch (voidErr) {
          setRecovery({
            title: 'Undelivered prepay invoice needs a hand',
            message: `The ${money(preview.prepayTotal)} prepay invoice (${invoice.invoice_number || 'see Invoices'}) could not be delivered, and cancelling it also failed. Void it from Invoices FIRST, then tap Restore to put the per-application invoice back.`,
            detail: voidErr.message,
            voided,
          });
          return;
        }
        const undo = await undoSupersede(voided);
        if (!undo.ok) {
          setRecovery({
            title: 'This visit has no invoice behind it',
            message: `The undelivered prepay invoice was cancelled, but ${customerName}\u2019s per-application invoice could not be put back. Completing this visit would bill less than it should. Retry the restore, or rebuild it from Invoices.`,
            detail: undo.failed[0]?.error,
            voided,
          });
          return;
        }
        setActionError(
          `The prepay invoice could NOT be delivered${result.delivery.error ? ` (${result.delivery.error})` : ''} and was cancelled. `
          + 'The per-application invoice was restored \u2014 nothing changed. Try again, or send the prepay from Customer 360.',
        );
        return;
      }
      finish(invoice, { collected: false });
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
        // Explicit allowlists (Codex P0 r3): only genuinely settled statuses
        // count as a collection. A prepay someone ELSE voided/refunded in the
        // gap is a terminal UNPAID state — treat it as this abort having
        // already half-happened: skip the (impossible) void and go straight
        // to restoring the per-application invoice.
        if (fresh && PREPAY_SETTLED_STATUSES.includes(status)) {
          setCollecting(null);
          finish(invoice, { collected: true });
          return;
        }
        if (!(fresh && PREPAY_TERMINAL_UNPAID_STATUSES.includes(status))) {
          await adminFetch(`/admin/invoices/${invoice.id}/void`, { method: 'POST' });
        }
      } catch (e) {
        setCollecting(null);
        setRecovery({
          title: 'Uncollected prepay invoice needs a hand',
          message: `The prepay invoice was created but not collected, and cancelling it failed. Void ${invoice.invoice_number || 'it'} from Invoices FIRST, then tap Restore to put the per-application invoice back.`,
          detail: e.message,
          voided,
        });
        setBusy('');
        return;
      }
      const undo = await undoSupersede(voided);
      setBusy('');
      setCollecting(null);
      if (!undo.ok) {
        // The loud one: the visit now has NO invoice behind it.
        setRecovery({
          title: 'This visit has no invoice behind it',
          message: `The prepay was cancelled, but ${customerName}\u2019s per-application invoice could not be put back. Completing this visit would bill less than it should. Retry the restore, or rebuild it from Invoices.`,
          detail: undo.failed[0]?.error,
          voided,
        });
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

  // ── Recovery: the switch stopped mid-way ────────────────────────────────
  if (recovery) {
    return (
      <Shell>
        <div className="text-alert-fg font-medium" style={{ fontSize: 15, marginBottom: 8 }}>
          {recovery.title}
        </div>
        <div className="text-zinc-900" style={{ fontSize: 13, marginBottom: 10 }}>
          {recovery.message}
        </div>
        {recovery.detail && (
          <div className="text-ink-secondary" style={{ fontSize: 12, marginBottom: 14 }}>
            {recovery.detail}
          </div>
        )}
        <div className="flex gap-2">
          {recovery.voided?.length > 0 && (
            <button
              type="button"
              disabled={busy === 'restore'}
              onClick={async () => {
                setBusy('restore');
                const undo = await undoSupersede(recovery.voided);
                setBusy('');
                if (undo.ok) { setRecovery(null); onSaved?.(); onClose?.(); }
                else setRecovery({ ...recovery, detail: undo.failed[0]?.error || recovery.detail });
              }}
              className="flex-1 rounded-full bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-60"
              style={{ padding: '12px 16px', fontSize: 14 }}
            >
              {busy === 'restore' ? 'Restoring\u2026' : 'Restore invoice'}
            </button>
          )}
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
