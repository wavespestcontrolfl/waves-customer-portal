// Mobile-first "Complete Service" sheet.
//
// Replaces the post-payment CompletionPanel as the *primary* mobile entry
// point for active visits (status ∈ scheduled/en_route/on_site). One scroll,
// no tabs. Tech writes notes, picks products, optionally collects payment,
// and submits — backend handles invoice + recap SMS + review request
// atomically via POST /admin/dispatch/:serviceId/complete.
//
// Amendments folded in vs the original mockup:
//   - Customer recap preview is separate from technician notes (different
//     audiences). Recap auto-generates from notes + observations + products
//     and is editable inline before send.
//   - No autofocus on the notes field — keyboard pop-up over a fresh sheet
//     hides the rest of the form.
//   - "No products applied" reason picker (when 0 products on a treatment
//     service). Inspection/follow-up service categories accept notes alone.
//   - Observations chips are visible by default (operationally important,
//     not buried in an accordion). "All clear" is mutually exclusive.
//   - Follow-up needed surfaces a note field so the office sees consequences.
//   - Smart review-request suppression: OFF when customer concern, follow-up,
//     or no-products reason is set.
//   - Payment language uses "Collect payment" (covers card/cash/check/Tap).
//   - Final CTA label is dynamic: "Complete & Send Recap" / "Complete &
//     Charge & Send Recap" / "Complete Service" depending on send + payment.
//   - Header shows full name, send toasts use first name.
//   - Drafts autosave to localStorage every 800ms — survives sheet close,
//     network drop, accidental swipe-away.
//   - Submits include an X-Idempotency-Key header (UUID per attempt) so a
//     double-tap or post-failure retry can't double-fire SMS / invoice /
//     payment side effects once the backend honors it.
//
// Backend body shape matches the legacy CompletionPanel (server already
// accepts these fields):
//   { technicianNotes, products[], sendCompletionSms, requestReview,
//     formResponses{observations, recommendations, customerRecap},
//     soilTemp?, soilPh?, soilMoisture?, thatchMeasurement?,
//     noProductsReason?, followUpNote? }

import { useEffect, useMemo, useRef, useState } from 'react';
import { TIMEZONE } from '../../lib/timezone';
import MobileCheckoutSheet from './MobileCheckoutSheet';

const API_BASE = import.meta.env.VITE_API_URL || '/api';

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(text || `HTTP ${r.status}`);
    }
    return r.json();
  });
}

const TIER_DISCOUNT = { bronze: 0, silver: 0.10, gold: 0.15, platinum: 0.20 };
function tierLabel(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatTime(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return '';
  const m = hhmm.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return '';
  const h24 = parseInt(m[1], 10);
  const mm = m[2];
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const ap = h24 < 12 ? 'AM' : 'PM';
  return `${h12}:${mm} ${ap}`;
}

function mapDeepLink(address) {
  if (!address) return '';
  const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const encoded = encodeURIComponent(address);
  return isIos ? `maps://?q=${encoded}` : `https://www.google.com/maps/search/?api=1&query=${encoded}`;
}

function uuid() {
  // Crypto.randomUUID is available in all Vite-targeted browsers; the
  // fallback covers older test environments. The key is opaque to the
  // server today — it's purely a forward-compatible header so the backend
  // can short-circuit duplicate completion attempts when it's wired up.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'k_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Service categories that legitimately ship with no product application.
// Treatment services require either a product line or an explicit reason.
const NON_TREATMENT_TYPES = /inspection|estimate|consult|follow.?up|callback|assessment/i;

// No-product reasons aren't all equivalent. The `outcome` field shapes
// downstream UI (CTA label, review suppression):
//   complete   → finish + send recap normally
//   no_review  → finish, but suppress the review request automatically
//   incomplete → close visit + create follow-up; no charge, no review,
//                CTA flips to "Close Visit & Create Follow-up"
const NO_PRODUCT_REASONS = [
  { label: 'Inspection only', outcome: 'complete' },
  { label: 'Customer declined', outcome: 'no_review' },
  { label: 'Weather prevented treatment', outcome: 'incomplete' },
  { label: 'Unable to access property', outcome: 'incomplete' },
  { label: 'Follow-up only', outcome: 'complete' },
  { label: 'Other', outcome: 'complete' },
];

const OBSERVATION_CHIPS = [
  { key: 'all_clear', label: 'All clear', exclusive: true },
  { key: 'pest_activity', label: 'Pest activity' },
  { key: 'weeds_spreading', label: 'Weeds spreading' },
  { key: 'customer_concern', label: 'Customer concern' },
  { key: 'follow_up_needed', label: 'Follow-up needed' },
];

function generateRecap({ customerFirstName, serviceType, notes, observations, products }) {
  // Build a customer-friendly default — the tech can override before send.
  // Kept short on purpose: SMS-grade copy reads better in 2 lines than 4.
  const name = customerFirstName || 'there';
  const svc = serviceType || 'service';
  const productLine = products.length
    ? `Products applied: ${products.map((p) => p.name).join(', ')}.`
    : '';
  const concern = observations.includes('customer_concern')
    ? ' We noted your concern and will follow up.'
    : '';
  const followUp = observations.includes('follow_up_needed')
    ? ' A follow-up visit will be scheduled.'
    : '';
  const techNote = notes && notes.trim().length > 0 ? ` ${notes.trim()}` : '';
  return `Hi ${name}, we just finished your ${svc.toLowerCase()} visit.${productLine ? ' ' + productLine : ''}${techNote}${concern}${followUp} — Waves`;
}

export default function MobileCompleteServiceSheet({
  service,
  products: catalog,
  recentProducts,    // optional — last 30d most-used for this tech, used to seed quick-add
  onClose,
  onSubmit,          // (serviceId, body, { idempotencyKey }) => Promise
  onChargeRequested, // (service) => void — opens MobileCheckoutSheet path
}) {
  const draftKey = service?.id ? `waves:complete_draft:${service.id}` : null;

  const [notes, setNotes] = useState('');
  const [selectedProducts, setSelectedProducts] = useState([]); // [{productId, name, rate, rateUnit}]
  const [observations, setObservations] = useState([]); // string[]
  const [followUpNote, setFollowUpNote] = useState('');
  const [noProductsReason, setNoProductsReason] = useState('');
  const [noProductsActive, setNoProductsActive] = useState(false); // secondary section reveal
  const [recapEdited, setRecapEdited] = useState(false);
  const [recapDraft, setRecapDraft] = useState('');
  const [recapAiState, setRecapAiState] = useState('idle'); // idle | loading | ok | error
  const [recapStaleAfterEdit, setRecapStaleAfterEdit] = useState(false);
  const recapAbortRef = useRef(null);
  const recapDebounceRef = useRef(null);
  const [sendSms, setSendSms] = useState(true);
  const [requestReview, setRequestReview] = useState(true);
  const [reviewManualOverride, setReviewManualOverride] = useState(false);
  const [soilTemp, setSoilTemp] = useState('');
  const [soilPh, setSoilPh] = useState('');
  const [soilMoisture, setSoilMoisture] = useState('');
  const [thatchMeasurement, setThatchMeasurement] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [paymentCollected, setPaymentCollected] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const idempotencyKeyRef = useRef(null);

  // ── Derived state ───────────────────────────────────────────────────────
  const tier = service?.waveguardTier ? String(service.waveguardTier).toLowerCase() : null;
  const pct = tier && TIER_DISCOUNT[tier] != null ? TIER_DISCOUNT[tier] : 0;
  const rawPrice = service?.estimatedPrice != null ? Number(service.estimatedPrice) : null;
  const price = rawPrice != null ? rawPrice : Number(service?.monthlyRate || 0);
  const total = Math.max(0, price - Math.round(price * pct * 100) / 100);
  const prepaidAmt = service?.prepaidAmount != null ? Number(service.prepaidAmount) : 0;
  const isPrepaid = prepaidAmt > 0;
  const coveredByMembership = !!tier && (rawPrice === 0 || rawPrice == null);
  const hasAutoPay = !!service?.hasSavedCard || !!service?.autoPayEnabled;
  const isLawnService = /lawn|fertili|weed|sod|grass|turf/i.test(service?.serviceType || '');
  const isNonTreatment = NON_TREATMENT_TYPES.test(service?.serviceType || '');

  const customerFirstName = (service?.customerName || '').split(' ')[0] || '';
  const customerFullName = service?.customerName || 'Customer';
  const startTime = formatTime(service?.windowStart);
  const dur = service?.estimatedDuration ? `${service.estimatedDuration} mins` : '';

  // Quick-add list: tech's recent + customer's last visit + catalog defaults.
  // Server may pass `recentProducts` in any of those shapes; fall back to a
  // small slice of the catalog so this never renders empty.
  const quickProducts = useMemo(() => {
    const seed = Array.isArray(recentProducts) && recentProducts.length
      ? recentProducts.slice(0, 6)
      : (Array.isArray(catalog) ? catalog.slice(0, 6) : []);
    return seed.map((p) => ({
      productId: p.id || p.productId || p.product_id,
      name: p.name || p.product_name,
      defaultRate: p.default_rate || p.defaultRate || '',
      defaultUnit: p.default_rate_unit || p.defaultUnit || 'oz',
    }));
  }, [recentProducts, catalog]);

  // Resolve the chosen no-product reason → outcome. Drives both the CTA
  // label (incomplete visits become "Close Visit & Create Follow-up") and
  // automatic review suppression for declined / weather / access cases.
  const reasonOutcome = useMemo(() => {
    if (!noProductsReason) return null;
    return NO_PRODUCT_REASONS.find((r) => r.label === noProductsReason)?.outcome || 'complete';
  }, [noProductsReason]);
  const isIncompleteVisit = reasonOutcome === 'incomplete';

  // Smart review-request suppression — client-side signals only. Backend
  // can still decline (e.g. opt-out, no mobile, last-90d guard) but the UI
  // shouldn't even ask once we know it'll lead to a bad customer moment.
  // Reasons with a non-"complete" outcome (declined / weather / access)
  // suppress automatically; "Inspection only" / "Follow-up only" don't.
  const reviewAutoOff = useMemo(() => {
    if (observations.includes('customer_concern')) return 'customer concern flagged';
    if (observations.includes('follow_up_needed')) return 'follow-up needed';
    if (reasonOutcome && reasonOutcome !== 'complete') {
      if (reasonOutcome === 'incomplete') return 'visit incomplete';
      if (reasonOutcome === 'no_review') return 'customer declined';
    }
    return null;
  }, [observations, reasonOutcome]);

  useEffect(() => {
    if (reviewAutoOff && !reviewManualOverride) setRequestReview(false);
  }, [reviewAutoOff, reviewManualOverride]);

  // ── Draft autosave / restore ────────────────────────────────────────────
  useEffect(() => {
    if (!draftKey) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.notes) setNotes(d.notes);
      if (Array.isArray(d.selectedProducts)) setSelectedProducts(d.selectedProducts);
      if (Array.isArray(d.observations)) setObservations(d.observations);
      if (d.followUpNote) setFollowUpNote(d.followUpNote);
      if (d.noProductsReason) setNoProductsReason(d.noProductsReason);
      if (d.soilTemp) setSoilTemp(d.soilTemp);
      if (d.soilPh) setSoilPh(d.soilPh);
      if (d.soilMoisture) setSoilMoisture(d.soilMoisture);
      if (d.thatchMeasurement) setThatchMeasurement(d.thatchMeasurement);
      if (d.recapDraft) { setRecapDraft(d.recapDraft); setRecapEdited(true); }
      if (typeof d.sendSms === 'boolean') setSendSms(d.sendSms);
    } catch { /* corrupt draft, ignore */ }
  }, [draftKey]);

  useEffect(() => {
    if (!draftKey) return;
    const t = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          notes, selectedProducts, observations, followUpNote, noProductsReason,
          soilTemp, soilPh, soilMoisture, thatchMeasurement,
          recapDraft: recapEdited ? recapDraft : '',
          sendSms,
          ts: Date.now(),
        }));
      } catch { /* quota exceeded */ }
    }, 800);
    return () => clearTimeout(t);
  }, [draftKey, notes, selectedProducts, observations, followUpNote, noProductsReason,
      soilTemp, soilPh, soilMoisture, thatchMeasurement, recapDraft, recapEdited, sendSms]);

  // ── Recap text ──────────────────────────────────────────────────────────
  const computedRecap = useMemo(() => generateRecap({
    customerFirstName,
    serviceType: service?.serviceType,
    notes,
    observations,
    products: selectedProducts,
  }), [customerFirstName, service?.serviceType, notes, observations, selectedProducts]);

  const recapToSend = recapEdited ? recapDraft : computedRecap;

  // AI recap generation — Claude FAST tier via /admin/dispatch/recap-preview.
  // Fires when notes are substantive AND a product (or no-products reason)
  // is set. 1000ms debounce after the last relevant change; cancels
  // in-flight requests on input change so a slow earlier draft never
  // overwrites a fresher one.
  function generateAiRecap() {
    if (!sendSms) return;                              // no recap will be sent
    if (recapEdited && !recapStaleAfterEdit) return;   // tech edited — don't clobber
    if (isIncompleteVisit) return;                     // incomplete visits get no recap
    if (notes.trim().length < 15) return;
    if (selectedProducts.length === 0 && !noProductsReason) return;

    if (recapAbortRef.current) recapAbortRef.current.abort();
    const ctrl = new AbortController();
    recapAbortRef.current = ctrl;
    setRecapAiState('loading');
    fetch(`${API_BASE}/admin/dispatch/recap-preview`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${localStorage.getItem('waves_admin_token')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        technicianNotes: notes,
        products: selectedProducts.map((p) => ({ name: p.name })),
        observations,
        customerFirstName,
        serviceType: service?.serviceType,
      }),
      signal: ctrl.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text().catch(() => `${r.status}`));
        return r.json();
      })
      .then((data) => {
        if (data?.recap && typeof data.recap === 'string') {
          setRecapDraft(data.recap);
          setRecapEdited(true);
          setRecapStaleAfterEdit(false);
          setRecapAiState('ok');
        } else {
          setRecapAiState('error');
        }
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        // Soft failure — template recap stays visible + editable. Tech can
        // still complete the visit; we just couldn't draft polished copy.
        setRecapAiState('error');
      });
  }

  useEffect(() => {
    if (recapDebounceRef.current) clearTimeout(recapDebounceRef.current);
    recapDebounceRef.current = setTimeout(generateAiRecap, 1000);
    return () => {
      if (recapDebounceRef.current) clearTimeout(recapDebounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, selectedProducts.length, noProductsReason, observations.join(','), sendSms, isIncompleteVisit]);

  // Stale-draft signal: after a manual edit, any change to inputs flags the
  // draft so the UI can offer "Regenerate" rather than silently clobbering.
  useEffect(() => {
    if (recapEdited && !recapStaleAfterEdit) setRecapStaleAfterEdit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, selectedProducts.length, observations.join(',')]);

  // ── Handlers ────────────────────────────────────────────────────────────
  function toggleObservation(key) {
    const meta = OBSERVATION_CHIPS.find((c) => c.key === key);
    setObservations((prev) => {
      const has = prev.includes(key);
      if (has) return prev.filter((k) => k !== key);
      // Exclusive ("All clear") clears others; selecting any other clears
      // the exclusive flag — both directions enforce mutual exclusivity.
      if (meta?.exclusive) return [key];
      return [...prev.filter((k) => {
        const m = OBSERVATION_CHIPS.find((c) => c.key === k);
        return !m?.exclusive;
      }), key];
    });
  }

  function toggleQuickProduct(p) {
    setSelectedProducts((prev) => {
      const idx = prev.findIndex((x) => x.productId === p.productId);
      if (idx >= 0) return prev.filter((_, i) => i !== idx);
      return [...prev, {
        productId: p.productId,
        name: p.name,
        rate: p.defaultRate || '',
        rateUnit: p.defaultUnit || 'oz',
      }];
    });
  }

  function removeProduct(productId) {
    setSelectedProducts((prev) => prev.filter((p) => p.productId !== productId));
  }

  // ── Submit gating ───────────────────────────────────────────────────────
  const notesOk = notes.trim().length > 0;
  const productsOk = selectedProducts.length > 0
    || (isNonTreatment && notesOk)
    || (!!noProductsReason);
  const canSubmit = notesOk && productsOk && !submitting;
  const needsNoProductReason = !isNonTreatment
    && selectedProducts.length === 0
    && !noProductsReason;

  // ── Dynamic CTA label ───────────────────────────────────────────────────
  // Incomplete-visit path (weather / can't access) skips invoice + recap +
  // review and explicitly closes the visit with a follow-up flag instead.
  const willCharge = !coveredByMembership && !isPrepaid && hasAutoPay && total > 0 && !paymentCollected;
  const ctaLabel = submitting
    ? 'Completing…'
    : isIncompleteVisit
      ? 'Close Visit & Create Follow-up'
      : !sendSms
        ? 'Complete Service'
        : willCharge
          ? 'Complete, Charge & Send Recap'
          : 'Complete & Send Recap';

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitError('');
    setSubmitting(true);
    if (!idempotencyKeyRef.current) idempotencyKeyRef.current = uuid();
    try {
      // Incomplete visits (weather / can't access) bypass recap + review
      // entirely — no customer-facing message goes out, and the visit is
      // recorded so the office can spin up the follow-up. The reason is
      // forwarded so the backend can branch on it.
      const sendRecap = sendSms && !isIncompleteVisit;
      const reviewFinal = requestReview && !isIncompleteVisit;
      const body = {
        technicianNotes: notes.trim(),
        products: selectedProducts.map((p) => ({
          productId: p.productId,
          rate: p.rate ? Number(p.rate) : undefined,
          rateUnit: p.rateUnit || 'oz',
        })),
        sendCompletionSms: sendRecap,
        requestReview: reviewFinal,
        formResponses: {
          observations,
          customerRecap: sendRecap ? recapToSend : '',
        },
      };
      if (followUpNote.trim()) body.followUpNote = followUpNote.trim();
      if (noProductsReason) {
        body.noProductsReason = noProductsReason;
        body.visitOutcome = reasonOutcome; // complete | no_review | incomplete
      }
      if (isLawnService) {
        if (soilTemp) body.soilTemp = parseFloat(soilTemp);
        if (soilPh) body.soilPh = parseFloat(soilPh);
        if (soilMoisture) body.soilMoisture = parseFloat(soilMoisture);
        if (thatchMeasurement) body.thatchMeasurement = parseFloat(thatchMeasurement);
      }
      if (onSubmit) {
        await onSubmit(service.id, body, { idempotencyKey: idempotencyKeyRef.current });
      } else {
        await adminFetch(`/admin/dispatch/${service.id}/complete`, {
          method: 'POST',
          headers: { 'X-Idempotency-Key': idempotencyKeyRef.current },
          body: JSON.stringify(body),
        });
      }
      // Drop the draft only on success. If we throw, the user keeps the
      // form and can retry — same idempotency key reused so any partial
      // backend effect collapses to one once honoring is wired up.
      if (draftKey) localStorage.removeItem(draftKey);
      onClose?.({ completed: true, customerFirstName });
    } catch (err) {
      setSubmitError(err.message || 'Could not complete service.');
      setSubmitting(false);
    }
  }

  if (!service) return null;

  // Reuse styling tokens from MobileAppointmentDetailSheet — Roboto cascade,
  // bold by default, body data rows weight 500.
  const rootStyle = { fontFamily: 'Roboto, system-ui, sans-serif', fontWeight: 700 };
  const dataRowStyle = { fontSize: 15, fontWeight: 500 };
  const sectionTitleStyle = { fontSize: 20, marginBottom: 10 };

  return (
    <div className="fixed inset-0 z-[100] bg-white overflow-y-auto" style={rootStyle}>
      {/* Top bar */}
      <div
        className="sticky top-0 bg-white flex items-center justify-between gap-3 px-4 border-b border-hairline border-zinc-200 z-10"
        style={{ height: 56, paddingTop: 'env(safe-area-inset-top, 0)' }}
      >
        <button
          type="button"
          onClick={() => onClose?.({ completed: false })}
          aria-label="Close"
          className="inline-flex items-center justify-center bg-transparent text-ink-primary u-focus-ring"
          style={{ width: 44, height: 44, fontSize: 18, lineHeight: 1, border: 'none', cursor: 'pointer' }}
        >
          ✕
        </button>
        <div className="flex-1 text-center text-zinc-900 truncate" style={{ fontSize: 16 }}>
          {customerFullName}
        </div>
        <button
          type="button"
          onClick={() => onClose?.({ completed: false, edit: true })}
          className="bg-transparent text-ink-secondary u-focus-ring"
          style={{ fontSize: 13, padding: '0 8px', height: 44, border: 'none', cursor: 'pointer' }}
        >
          Reschedule
        </button>
      </div>

      <div className="px-4 pt-4 pb-32 mx-auto" style={{ maxWidth: 560 }}>
        {/* Header card */}
        <section>
          <div className="text-zinc-900" style={dataRowStyle}>{service.serviceType || '—'}</div>
          <div className="text-zinc-900" style={{ ...dataRowStyle, marginTop: 2 }}>
            {startTime}{startTime && dur ? ' · ' : ''}{dur}
          </div>
          {service.address && (
            <div className="flex items-start justify-between gap-3 mt-2">
              <div className="flex-1 min-w-0">
                <div className="text-zinc-900" style={{ ...dataRowStyle, lineHeight: 1.3 }}>
                  {service.address.split(',')[0]}
                </div>
                <div className="text-zinc-900" style={{ ...dataRowStyle, marginTop: 2 }}>
                  {service.address.split(',').slice(1).join(',').trim()}
                </div>
              </div>
              <a
                href={mapDeepLink(service.address)}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Maps"
                className="inline-flex items-center justify-center bg-transparent text-ink-primary u-focus-ring"
                style={{ width: 40, height: 40, fontSize: 18, textDecoration: 'none', color: '#18181B', border: 'none' }}
              >
                ➤
              </a>
            </div>
          )}
          {coveredByMembership && (
            <div className="mt-3 inline-block text-zinc-900 px-2 py-1" style={{ fontSize: 12, background: '#F4F4F5', borderRadius: 4 }}>
              WaveGuard {tierLabel(tier)}
            </div>
          )}
          {isPrepaid && (
            <div className="mt-3 inline-block text-zinc-900 px-2 py-1" style={{ fontSize: 12, background: '#F4F4F5', borderRadius: 4 }}>
              Prepaid ${prepaidAmt.toFixed(2)}
            </div>
          )}
        </section>

        {/* Notes */}
        <section className="mt-8">
          <div className="text-zinc-900" style={sectionTitleStyle}>Notes</div>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={5}
            placeholder="What did you do today?"
            className="w-full bg-white border-hairline border-zinc-300 rounded-sm px-3 py-3 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
            style={{ fontSize: 15, fontWeight: 500, resize: 'vertical', minHeight: 120, fontFamily: 'inherit' }}
          />
        </section>

        {/* Products */}
        <section className="mt-8">
          <div className="text-zinc-900" style={sectionTitleStyle}>Products applied</div>

          {/* Quick-add chips */}
          {quickProducts.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-3">
              {quickProducts.map((p) => {
                const selected = selectedProducts.some((x) => x.productId === p.productId);
                return (
                  <button
                    key={p.productId}
                    type="button"
                    onClick={() => toggleQuickProduct(p)}
                    className="font-medium u-focus-ring"
                    style={{
                      padding: '8px 12px',
                      borderRadius: 4,
                      border: `1px solid ${selected ? '#18181B' : '#D4D4D8'}`,
                      background: selected ? '#18181B' : '#fff',
                      color: selected ? '#fff' : '#18181B',
                      fontSize: 13,
                      cursor: 'pointer',
                    }}
                  >
                    {selected ? '✓ ' : '+ '}{p.name}
                  </button>
                );
              })}
            </div>
          )}

          {/* Selected product rows */}
          {selectedProducts.map((p) => (
            <div key={p.productId} className="flex items-center justify-between gap-3 py-2 border-b border-hairline border-zinc-200">
              <div className="flex-1 min-w-0">
                <div className="text-zinc-900 truncate" style={dataRowStyle}>{p.name}</div>
                <div className="flex items-center gap-2 mt-1">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={p.rate}
                    onChange={(e) => setSelectedProducts((prev) => prev.map((x) => x.productId === p.productId ? { ...x, rate: e.target.value } : x))}
                    className="font-medium border-hairline border-zinc-300 rounded-sm px-2 py-1 text-zinc-900"
                    style={{ width: 80, fontSize: 13, fontFamily: 'inherit' }}
                    placeholder="rate"
                  />
                  <span className="text-zinc-900" style={{ fontSize: 13, fontWeight: 500 }}>{p.rateUnit}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => removeProduct(p.productId)}
                className="bg-transparent text-ink-secondary u-focus-ring"
                style={{ fontSize: 22, lineHeight: 1, width: 32, height: 32, border: 'none', cursor: 'pointer' }}
                aria-label={`Remove ${p.name}`}
              >
                −
              </button>
            </div>
          ))}

          {/* "No products applied" path is a quiet secondary action — the
              full reason picker only appears once the tech taps to expand
              it, so the screen doesn't equate the no-product path with
              the normal product path. */}
          {!isNonTreatment && selectedProducts.length === 0 && !noProductsActive && !noProductsReason && (
            <button
              type="button"
              onClick={() => setNoProductsActive(true)}
              className="bg-transparent text-ink-secondary u-focus-ring mt-3"
              style={{ fontSize: 13, padding: 0, border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
            >
              No products applied
            </button>
          )}

          {!isNonTreatment && selectedProducts.length === 0 && (noProductsActive || noProductsReason) && (
            <div className="mt-3">
              <div className="text-zinc-900 mb-2" style={{ fontSize: 13 }}>
                Reason:
              </div>
              <div className="flex flex-wrap gap-2">
                {NO_PRODUCT_REASONS.map((r) => {
                  const selected = noProductsReason === r.label;
                  return (
                    <button
                      key={r.label}
                      type="button"
                      onClick={() => {
                        setNoProductsReason(selected ? '' : r.label);
                        if (selected) setNoProductsActive(false);
                      }}
                      className="font-medium u-focus-ring"
                      style={{
                        padding: '6px 10px',
                        borderRadius: 4,
                        border: `1px solid ${selected ? '#18181B' : '#D4D4D8'}`,
                        background: selected ? '#18181B' : '#fff',
                        color: selected ? '#fff' : '#18181B',
                        fontSize: 12,
                        cursor: 'pointer',
                      }}
                    >
                      {r.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        {/* Observations */}
        <section className="mt-8">
          <div className="text-zinc-900" style={sectionTitleStyle}>Observations</div>
          <div className="flex flex-wrap gap-2">
            {OBSERVATION_CHIPS.map((c) => {
              const selected = observations.includes(c.key);
              return (
                <button
                  key={c.key}
                  type="button"
                  onClick={() => toggleObservation(c.key)}
                  className="font-medium u-focus-ring"
                  style={{
                    padding: '8px 12px',
                    borderRadius: 4,
                    border: `1px solid ${selected ? '#18181B' : '#D4D4D8'}`,
                    background: selected ? '#18181B' : '#fff',
                    color: selected ? '#fff' : '#18181B',
                    fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {c.label}
                </button>
              );
            })}
          </div>

          {observations.includes('follow_up_needed') && (
            <div className="mt-3">
              <div className="text-zinc-900 mb-2" style={{ fontSize: 13 }}>
                Follow-up note (the office will see this):
              </div>
              <textarea
                value={followUpNote}
                onChange={(e) => setFollowUpNote(e.target.value)}
                rows={2}
                placeholder="What needs to happen next?"
                className="w-full bg-white border-hairline border-zinc-300 rounded-sm px-3 py-2 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
                style={{ fontSize: 14, fontWeight: 500, resize: 'vertical', minHeight: 60, fontFamily: 'inherit' }}
              />
            </div>
          )}
        </section>

        {/* Soil metrics — lawn only */}
        {isLawnService && (
          <section className="mt-8">
            <div className="text-zinc-900" style={sectionTitleStyle}>Soil readings</div>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Temp °F', val: soilTemp, set: setSoilTemp },
                { label: 'pH', val: soilPh, set: setSoilPh },
                { label: 'Moisture %', val: soilMoisture, set: setSoilMoisture },
                { label: 'Thatch in', val: thatchMeasurement, set: setThatchMeasurement },
              ].map((f) => (
                <div key={f.label}>
                  <label className="text-zinc-900 block mb-1" style={{ fontSize: 12 }}>{f.label}</label>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    value={f.val}
                    onChange={(e) => f.set(e.target.value)}
                    className="font-medium w-full border-hairline border-zinc-300 rounded-sm px-3 py-2 text-zinc-900"
                    style={{ fontSize: 14, fontFamily: 'inherit' }}
                  />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Customer recap preview — only when SMS will actually go out, and
            never on incomplete-visit closures (those follow a different path). */}
        {sendSms && !isIncompleteVisit && (
          <section className="mt-8">
            <div className="text-zinc-900" style={sectionTitleStyle}>Customer recap</div>
            <div className="text-zinc-900 mb-2" style={{ fontSize: 13 }}>
              {customerFirstName} will receive this. Internal notes stay private.
            </div>
            <textarea
              value={recapToSend}
              onChange={(e) => {
                setRecapDraft(e.target.value);
                setRecapEdited(true);
                setRecapStaleAfterEdit(false); // tech is editing now; don't flag stale until next input change
              }}
              rows={3}
              className="w-full bg-white border-hairline border-zinc-300 rounded-sm px-3 py-2 text-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900 focus:border-zinc-900"
              style={{ fontSize: 14, fontWeight: 500, resize: 'vertical', minHeight: 80, fontFamily: 'inherit' }}
              placeholder={recapAiState === 'loading' ? 'Drafting…' : 'Write the message the customer will receive.'}
            />
            <div className="flex items-center justify-between mt-1 gap-3">
              <span className="text-ink-secondary" style={{ fontSize: 12 }}>
                {recapAiState === 'loading' && 'Drafting with AI…'}
                {recapAiState === 'error' && 'Couldn’t draft. Write one manually or turn off SMS.'}
                {recapAiState === 'ok' && recapStaleAfterEdit && 'Notes changed since this draft.'}
              </span>
              {(recapStaleAfterEdit || recapAiState === 'error') && (
                <button
                  type="button"
                  onClick={() => { setRecapStaleAfterEdit(true); generateAiRecap(); }}
                  className="bg-transparent text-zinc-900 u-focus-ring"
                  style={{ fontSize: 12, padding: 0, border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
                >
                  Regenerate draft
                </button>
              )}
            </div>
          </section>
        )}

        {/* Send options */}
        <section className="mt-8">
          <div className="text-zinc-900" style={sectionTitleStyle}>Send</div>
          <label className="flex items-center justify-between py-2 cursor-pointer">
            <span className="text-zinc-900" style={dataRowStyle}>
              Send recap SMS to {customerFirstName}
            </span>
            <input
              type="checkbox"
              checked={sendSms}
              onChange={(e) => setSendSms(e.target.checked)}
              style={{ width: 20, height: 20, accentColor: '#18181B' }}
            />
          </label>
          <label className="flex items-center justify-between py-2 cursor-pointer">
            <span className="text-zinc-900" style={dataRowStyle}>
              Request review
            </span>
            <input
              type="checkbox"
              checked={requestReview}
              onChange={(e) => { setRequestReview(e.target.checked); setReviewManualOverride(true); }}
              disabled={!sendSms}
              style={{ width: 20, height: 20, accentColor: '#18181B' }}
            />
          </label>
          {reviewAutoOff && !reviewManualOverride && (
            <div className="text-ink-secondary" style={{ fontSize: 12, marginTop: 2 }}>
              Auto-suppressed: {reviewAutoOff}
            </div>
          )}
        </section>

        {/* Payment status */}
        <section className="mt-8">
          <div className="text-zinc-900" style={sectionTitleStyle}>Payment</div>
          {coveredByMembership ? (
            <div className="text-zinc-900" style={dataRowStyle}>
              Covered by WaveGuard {tierLabel(tier)} — no charge today.
            </div>
          ) : isPrepaid ? (
            <div className="text-zinc-900" style={dataRowStyle}>
              Prepaid ${prepaidAmt.toFixed(2)} — no charge today.
            </div>
          ) : paymentCollected ? (
            <div className="text-zinc-900" style={dataRowStyle}>
              ✓ Payment collected — ${total.toFixed(2)}.
            </div>
          ) : hasAutoPay ? (
            <div className="text-zinc-900" style={dataRowStyle}>
              Will auto-charge ${total.toFixed(2)} on completion.
            </div>
          ) : (
            <div>
              <div className="text-zinc-900 mb-2" style={dataRowStyle}>
                Amount due: ${total.toFixed(2)}
              </div>
              <button
                type="button"
                onClick={() => {
                  if (onChargeRequested) onChargeRequested(service);
                  else setShowCheckout(true);
                }}
                className="font-medium u-focus-ring rounded-sm bg-white text-zinc-900 border-hairline border-zinc-900"
                style={{ padding: '12px 18px', fontSize: 15, cursor: 'pointer' }}
              >
                Collect payment
              </button>
            </div>
          )}
        </section>

        {/* Submit error surface */}
        {submitError && (
          <div className="mt-6 px-3 py-3 rounded-sm" style={{ background: '#FEF2F2', border: '1px solid #FCA5A5', color: '#991B1B', fontSize: 13 }}>
            Couldn't complete service: {submitError}. Your notes are saved — try again.
          </div>
        )}
      </div>

      {/* Sticky bottom CTA */}
      <div
        className="fixed left-0 right-0 bottom-0 bg-white border-t border-hairline border-zinc-200 px-4 py-3"
        style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0) + 12px)', maxWidth: 560, margin: '0 auto' }}
      >
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit || needsNoProductReason}
          className="font-bold w-full rounded-sm bg-zinc-900 text-white u-focus-ring disabled:opacity-50"
          style={{ padding: '14px 20px', fontSize: 16, border: 'none', cursor: canSubmit && !needsNoProductReason ? 'pointer' : 'not-allowed' }}
        >
          {ctaLabel}
        </button>
        {(!canSubmit || needsNoProductReason) && (
          <div className="text-ink-secondary text-center mt-2" style={{ fontSize: 12 }}>
            {(() => {
              // Tiered messaging: a soft prompt before the tech has done
              // anything, then specific guidance once they've started.
              if (!notesOk && selectedProducts.length === 0 && !noProductsReason) {
                return 'Add notes and either select a product or mark no products applied.';
              }
              if (!notesOk) return 'Add a note to continue.';
              if (needsNoProductReason) return 'Choose a product or pick a "no products applied" reason.';
              return null;
            })()}
          </div>
        )}
      </div>

      {/* Inline checkout (used only if parent didn't supply onChargeRequested) */}
      {showCheckout && (
        <MobileCheckoutSheet
          service={service}
          onClose={() => setShowCheckout(false)}
          onChargeSuccess={() => { setShowCheckout(false); setPaymentCollected(true); }}
        />
      )}
    </div>
  );
}
