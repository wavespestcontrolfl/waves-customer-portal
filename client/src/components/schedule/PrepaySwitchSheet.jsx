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
// The switch itself is ONE server transaction (POST …/prepay-switch): the
// per-application draft is CAS-voided and the prepay invoice + term minted
// atomically, so there is no instant where the old invoice is void without
// the prepay existing, and none where both are payable. This sheet only
// decides what happens AROUND that commit:
// COLLECT-ONLY by owner ruling (2026-08-12): an on-site switch means the
// card is in hand, so the minted invoice goes straight to the tender sheet
// and settles in minutes — no pay link, no days-long unpaid-prepay limbo.
// "Send them the invoice instead" lives where it always did: Customer 360 →
// Annual prepay. Backing out of the tender voids the prepay (cancelling its
// payment_pending term) and POST …/prepay-switch/undo re-mints the
// per-application draft from the voided row's own line items (new number);
// the undo is idempotent and refuses while a live prepay term stands, so a
// stale abort can never double-bill. A failed restore is loud: the operator
// must know this visit currently has no invoice behind it.

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

  // Restore the per-application invoice after a switch that didn't complete
  // (re-minted server-side from the voided row's own amounts, new number).
  // Idempotent, provenance-bound, and refused while a live prepay term
  // stands — safe to offer even when the state is uncertain.
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

  const finish = (invoice) => {
    onSaved?.();
    setDone({ invoice });
  };

  const mint = async () => {
    if (!preview?.eligible || !customerId) return;
    setBusy('charge');
    setActionError('');
    let result;
    try {
      // ONE atomic server operation: CAS-void the superseded draft + mint
      // the prepay invoice and term, all recomputed server-side under the
      // locks. Collect-only — the response goes straight to the tender.
      result = await adminFetch(`/admin/schedule/${visitId}/prepay-switch`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (e) {
      if (e.status) {
        // The server answered: the transaction did not commit, so nothing
        // was voided and nothing minted. The visit still bills as it did.
        setActionError(e.message || 'Could not switch this visit to annual prepay');
      } else {
        // Network drop: the atomic commit may or may not have landed. A
        // RETRY is safe (a committed first attempt fails the server's
        // overlap assert instead of minting twice), and Restore is safe
        // (the undo refuses while a live prepay term stands).
        setRecovery({
          title: 'Connection dropped mid-switch',
          message: 'The switch request didn\u2019t come back. Close this and try again \u2014 if it then reports an annual prepay already exists, the switch DID go through: find the prepay invoice in Invoices. Restore below puts the per-application invoice back, and is automatically refused if the prepay is live.',
          detail: e.message,
          voided: supersedes,
        });
      }
      setBusy('');
      return;
    }
    setBusy('');
    const invoice = result?.invoice;
    const voided = Array.isArray(result?.voided) ? result.voided : [];
    if (!invoice?.id) {
      setActionError('The prepay invoice did not come back in the response \u2014 check Invoices before retrying.');
      return;
    }
    setCollecting({ invoice, voided });
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
          finish(invoice);
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
      finish(invoice);
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
          Annual prepay collected
        </div>
        <div className="text-ink-secondary" style={{ fontSize: 13, marginBottom: 14 }}>
          {customerName} is on annual prepay — the year's visits are marked prepaid as the payment settles.
          {supersedes.length > 0 ? ' The per-application invoice for this visit was voided.' : ''}
        </div>
        {/* The payment path stamps coverage before it returns, so completing
            next is what the operator should do — and it behaves differently
            now (no invoice, prepay-specific text). Say so rather than leaving
            them to discover it. */}
        <div className="text-zinc-900" style={{ fontSize: 13, marginBottom: 14 }}>
          Complete the visit next: it cuts no invoice and texts the service report as covered by the annual
          prepaid plan.
        </div>
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
        onClick={() => mint()}
        className="w-full rounded-full bg-zinc-900 text-white font-medium u-focus-ring disabled:opacity-60"
        style={{ padding: '13px 16px', fontSize: 15 }}
      >
        {busy === 'charge' ? 'Creating…' : `Collect ${money(preview.prepayTotal)} now`}
      </button>
      <div className="text-ink-secondary" style={{ fontSize: 12, marginTop: 8, textAlign: 'center' }}>
        Collecting now is the only on-site path — to send a pay-by-link invoice instead, use Customer 360 → Annual prepay.
      </div>
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
