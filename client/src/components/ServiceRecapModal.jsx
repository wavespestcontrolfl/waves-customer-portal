// client/src/components/ServiceRecapModal.jsx
//
// Lightweight "Service Recap" modal for pest_control services — the slim
// alternative to the heavy CreateProjectModal "project report". Used on
// the tech portal (TechHomePage).
//
// It is a thin UI over the recap-only completion path:
//   GET  /admin/dispatch/:id/pest-recap/context   (timeline + catalog)
//   POST /admin/dispatch/:id/pest-recap/draft      (AI customer copy)
//   POST /admin/dispatch/:id/pest-recap            (complete, no bill)
//
// The `request(path, options)` prop is the surface's fetch helper
// (adminFetch on admin; a bearer-token wrapper on tech). It must resolve
// to parsed JSON and throw on non-2xx — matching adminFetch's contract.
import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import { defaultApplicationMethodForLine, resolveRatePrefill } from '../lib/product-rate-prefill';
import { isPestDefaultMixVisit, pestDefaultMixSelections } from '../lib/pest-default-mix';
import useServiceRecapDraft from '../hooks/useServiceRecapDraft';
import { createPortal } from 'react-dom';
import useModalFocus from '../hooks/useModalFocus';
import useLockBodyScroll from '../hooks/useLockBodyScroll';
import { UiSurface, Button, Field, Input, Textarea, Checkbox, ActionFeedback } from './ui';
import '../styles/tech-workflow.css';

// Timeline status -> { label, icon }. Only the events that matter to a
// recap; anything else falls through to a generic row.
const TIMELINE_LABELS = {
  en_route: { label: 'En route', icon: '🚐' },
  on_site: { label: 'Arrived on site', icon: '📍' },
  completed: { label: 'Completed', icon: '✅' },
  confirmed: { label: 'Confirmed', icon: '🗓️' },
  rescheduled: { label: 'Rescheduled', icon: '🔁' },
  cancelled: { label: 'Cancelled', icon: '🚫' },
  skipped: { label: 'Skipped', icon: '⏭️' },
};

// Catalog rate prefill for a selected product — the SHARED resolver
// CompletionPanel uses (lib/product-rate-prefill.js), so the same visit and
// product prefill the same rate on either completion path: verified per-1k
// rate first, then the pest 4-oz perimeter house default, then a per-basis
// display default's LOW bound in its label-native unit ("0.1 g/spot"). The
// recap path is server-gated to pest control, so the service line is fixed.
// The value is only a STARTING point: the tech edits/confirms it before
// submit, and only the submitted value is recorded.
function catalogRatePrefill(p, serviceType) {
  if (!p) return null;
  const applicationMethod = defaultApplicationMethodForLine(p, 'pest', { serviceType });
  const resolved = resolveRatePrefill(p, { applicationMethod, serviceLine: 'pest' });
  const rate = Number(resolved.rate);
  if (!Number.isFinite(rate) || rate <= 0 || !resolved.rateUnit) return null;
  // The label ceiling for the inline high-rate warning (codex P1 r18):
  // per-basis bands carry their upper bound from the resolver; per-1,000
  // rates use the verified catalog max. Neither applies to the 4-oz house
  // default (its 'oz' unit is not the catalog rate's basis).
  const maxRaw = resolved.perBasisUnit
    ? resolved.labelMaxRate
    : resolved.usePestSprayDefault
      ? null
      : parseFloat(String(p.max_label_rate_per_1000 ?? ''));
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
  return { rate: String(rate), unit: resolved.rateUnit, ...(max != null ? { max } : {}) };
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    });
  } catch { return ''; }
}

export default function ServiceRecapModal({
  service,
  request,
  onClose,
  onCompleted,
}) {
  const serviceId = service?.id;
  const base = `/admin/dispatch/${serviceId}/pest-recap`;

  const [loading, setLoading] = useState(true);
  const [ctx, setCtx] = useState(null);
  const [loadError, setLoadError] = useState('');

  const [note, setNote] = useState('');
  const [selected, setSelected] = useState(() => new Set());
  // productId -> { rate: string, unit: string }. Seeded from the rate
  // already recorded on the visit (reopen) or the catalog prefill
  // (fresh selection); the tech edits it before submit.
  const [rates, setRates] = useState(() => ({}));
  const [message, setMessage] = useState('');
  const [sendText, setSendText] = useState(true);

  const [drafting, setDrafting] = useState(false);
  // F2 (ratified Q13): windowed comms context on the AI draft — default CHECKED.
  const [includeComms, setIncludeComms] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Synchronous re-entrancy guard: a fast double-tap can fire handleSubmit
  // twice before `submitting` re-renders the disabled button. The server is
  // idempotent regardless, but this avoids the redundant second request.
  const submitInFlight = useRef(false);
  // True unless a context load failure means the checkbox list cannot
  // enumerate the recorded state at all — only then does the submission
  // drop authority (productsConfirmed) entirely (codex P1 r11/r13/r15).
  const selectionAuthoritative = useRef(true);
  // Recorded products that matched NO active catalog row (renamed or
  // deactivated since the visit). The submission stays authoritative and
  // names these for the server to PRESERVE — dropping authority for the
  // whole set would let a deselected VISIBLE product survive the partial
  // path (codex P1 r16).
  const unrepresentedProducts = useRef([]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await request(`${base}/context`);
        if (!active) return;
        setCtx(data);
        if (data?.existingRecord?.technician_notes) setNote(data.existingRecord.technician_notes);
        // Pre-select chemicals already recorded on this visit, matched to the
        // catalog by name, so re-sending/editing a recap preserves them
        // instead of starting empty (which would wipe the product history).
        const recorded = data?.existingRecord?.products || [];
        // A failed recorded-products load means the picker cannot speak
        // for what was applied — fail closed, never authoritative
        // (codex P1 r13). Same for a failed service-record lookup (codex
        // P1 r15): "no record" reported over a transient error must not
        // authorize an empty replacement of a real completed visit.
        if (data?.existingRecord?.productsLoadFailed || data?.existingRecordLoadFailed) {
          selectionAuthoritative.current = false;
        }
        if (recorded.length && !Array.isArray(data?.products)) {
          selectionAuthoritative.current = false;
        }
        if (recorded.length && Array.isArray(data?.products)) {
          // Stable catalog id first (codex P2 r16: a rename between
          // visits must not read as a different product), name fallback
          // for rows recorded before product_id was captured.
          const byId = new Map(
            data.products.map((p) => [String(p.id), p]),
          );
          const byName = new Map(
            data.products.map((p) => [String(p.name || '').trim().toLowerCase(), p]),
          );
          const preselect = new Set();
          const seededRates = {};
          recorded.forEach((rp) => {
            const cat = (rp.product_id != null ? byId.get(String(rp.product_id)) : null)
              || byName.get(String(rp.product_name || '').trim().toLowerCase());
            if (!cat) {
              // Recorded product not representable in the picker — name
              // it for server-side preservation; the rest of the
              // selection stays authoritative.
              if (rp.product_name) unrepresentedProducts.current.push(rp.product_name);
              return;
            }
            preselect.add(cat.id);
            // The rate RECORDED on the visit outranks the catalog prefill —
            // reopening a recap must show (and re-submit) what was applied,
            // not rewrite it to the current catalog default.
            if (rp.application_rate != null && Number(rp.application_rate) > 0) {
              // A recorded rate missing its unit (legacy rows) falls back
              // to the catalog unit — an empty unit would hide the rate
              // editor while rate_confirmed still marked the field
              // deliberate, and the server would read that as a clear
              // (codex P1 r11).
              const prefill = catalogRatePrefill(cat, data?.service?.serviceType);
              const unit = rp.rate_unit || prefill?.unit || '';
              seededRates[cat.id] = {
                rate: String(rp.application_rate),
                unit,
                // The label ceiling only applies in its own unit.
                ...(prefill?.max != null && prefill.unit === unit ? { max: prefill.max } : {}),
              };
            } else {
              const prefill = catalogRatePrefill(cat, data?.service?.serviceType);
              if (prefill) seededRates[cat.id] = prefill;
            }
          });
          if (preselect.size) {
            setSelected(preselect);
            setRates(seededRates);
          }
        }
        // Default pest tank mix (owner 2026-08-29, shared with
        // CompletionPanel via lib/pest-default-mix — codex P1 on #3611):
        // a FRESH recurring general-pest or pest re-service recap
        // pre-selects Taurus SC, Talstar P, and the non-ionic surfactant
        // so the primary field-tech completion starts from the house mix
        // too. Rates seed exactly as a manual tap would; this lane
        // records no amounts, so the 4/4/0.25-oz totals live only on the
        // full completion form. Never seeds over an existing record
        // (reopen/resend must preserve what was applied) and fails
        // closed on a failed record lookup, same as the recorded-
        // products path above. Everything stays deselectable/editable.
        if (
          !data?.existingRecord &&
          !data?.existingRecordLoadFailed &&
          Array.isArray(data?.products) &&
          isPestDefaultMixVisit({
            ...(service || {}),
            serviceType: service?.serviceType || data?.service?.serviceType,
          })
        ) {
          const mixSelect = new Set();
          const mixRates = {};
          pestDefaultMixSelections(data.products).forEach(({ product }) => {
            mixSelect.add(product.id);
            const prefill = catalogRatePrefill(product, data?.service?.serviceType);
            if (prefill) mixRates[product.id] = prefill;
          });
          if (mixSelect.size) {
            setSelected(mixSelect);
            setRates(mixRates);
          }
        }
        if (!data?.service?.hasPhone) setSendText(false);
      } catch (err) {
        if (active) setLoadError(err?.message || 'Failed to load recap');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [base, request]);

  const products = ctx?.products || [];
  const productById = useMemo(() => {
    const m = new Map();
    products.forEach((p) => m.set(p.id, p));
    return m;
  }, [products]);

  const [restoredNames, setRestoredNames] = useState({});
  const missingSelections = [...selected].filter((id) => !productById.has(id));
  const draft = useServiceRecapDraft(serviceId, !loading && !loadError, {
    note, message, rates, sendText, includeComms,
    selectedProducts: [...selected].map((id) => ({ id, name: productById.get(id)?.name || restoredNames[id] || String(id) })),
  });
  const restoreDraft = () => {
    const saved = draft.candidate;
    setNote(saved.note || '');
    setMessage(saved.message || '');
    setRates(saved.rates || {});
    setSendText(saved.sendText === true && !!ctx?.service?.hasPhone);
    setIncludeComms(saved.includeComms !== false);
    setSelected(new Set(saved.selectedProducts.map((p) => p.id)));
    setRestoredNames(Object.fromEntries(saved.selectedProducts.map((p) => [p.id, p.name])));
    draft.restored();
  };
  const close = () => {
    if (submitInFlight.current) return;
    if (draft.storageError && !window.confirm('This draft is not saved on this device. Close and lose these changes?')) return;
    onClose?.();
  };

  const toggleProduct = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // Seed the editable rate on first selection only — a re-toggle
        // keeps whatever the tech already typed.
        setRates((prevRates) => {
          if (prevRates[id]) return prevRates;
          const prefill = catalogRatePrefill(productById.get(id), ctx?.service?.serviceType);
          return prefill ? { ...prevRates, [id]: prefill } : prevRates;
        });
      }
      return next;
    });
  }, [ctx, productById]);

  const setRateValue = useCallback((id, value) => {
    setRates((prev) => ({ ...prev, [id]: { ...(prev[id] || { unit: '' }), rate: value } }));
  }, []);

  const handleDraft = useCallback(async () => {
    setDrafting(true);
    setError('');
    try {
      const data = await request(`${base}/draft`, {
        method: 'POST',
        body: JSON.stringify({
          technicianNotes: note,
          // Tech-chosen solutions feed the AI recap prompt (owner directive
          // 2026-07-21) — context only, the prompt keeps product names out
          // of the customer copy.
          products: [...selected]
            .map((id) => productById.get(id))
            .filter(Boolean)
            .map((p) => ({ name: p.name, product_category: p.category })),
          includeCustomerComms: includeComms,
        }),
      });
      if (data?.recap) setMessage(data.recap);
    } catch (err) {
      setError(err?.message || 'Draft failed');
    } finally {
      setDrafting(false);
    }
  }, [base, note, includeComms, request, selected, productById]);

  const handleSubmit = useCallback(async () => {
    if (submitInFlight.current || draft.candidate || missingSelections.length) return;
    const willSend = sendText && !!message.trim() && !!ctx?.service?.hasPhone;
    if (willSend) {
      const name = ctx?.service?.customerName || 'the customer';
       
      if (!window.confirm(`Text this recap to ${name}?\n\n${message.trim()}`)) return;
    }
    submitInFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      const productPayload = [...selected]
        .map((id) => productById.get(id))
        .filter(Boolean)
        .map((p) => {
          // Technician-confirmed rate from the editable field. Cleared or
          // unresolvable -> no rate submitted; rate_confirmed tells the
          // server the field state is deliberate (a cleared rate is an
          // edit, not a legacy client's omission — codex P1 r9), so the
          // server must NOT restore a previously recorded rate.
          const entry = rates[p.id];
          const rate = entry ? parseFloat(entry.rate) : NaN;
          const hasRate = Number.isFinite(rate) && rate > 0 && !!entry?.unit;
          return {
            // The selected catalog row's id, so the server records
            // service_products.product_id and the compliance ledger keys
            // on the exact product instead of a name-pattern match
            // (codex P1 r9: "Advion Cockroach Gel" vs "... Gel Bait").
            product_id: p.id,
            product_name: p.name,
            product_category: p.category,
            active_ingredient: p.active_ingredient,
            moa_group: p.moa_group,
            // Confirm the rate field only when it was actually shown (the
            // editor renders per-unit) or a rate is being sent — never
            // vouch for a field the technician couldn't see (codex P1
            // r11); unconfirmed omission keeps the server's
            // preserve-prior behavior.
            rate_confirmed: hasRate || !!entry?.unit,
            ...(hasRate ? { application_rate: rate, rate_unit: entry.unit } : {}),
          };
        });
      const result = await request(base, {
        method: 'POST',
        body: JSON.stringify({
          technicianNotes: note,
          products: productPayload,
          // The selection state is deliberate (recorded products are
          // pre-selected on open), so an empty set is a full deselection,
          // not a resend-only omission — unless the context load failed,
          // in which case the server keeps its preserve-on-omission
          // behavior (codex P1 r11). Recorded products the picker could
          // not represent are named for preservation instead of dropping
          // authority for the whole set (codex P1 r16).
          productsConfirmed: selectionAuthoritative.current,
          ...(selectionAuthoritative.current && unrepresentedProducts.current.length
            ? { productsPreserve: unrepresentedProducts.current }
            : {}),
          customerRecap: message,
          sendSms: willSend,
        }),
      });
      draft.finish();
      onCompleted?.(result);
    } catch (err) {
      setError(err?.message || 'Could not complete recap');
      setSubmitting(false);
      submitInFlight.current = false;
    }
  }, [base, ctx, draft, message, missingSelections.length, note, onCompleted, productById, rates, request, selected, sendText]);

  useLockBodyScroll(true);
  const dialogRef = useModalFocus(true, close);
  const titleId = useId();
  const timeline = (ctx?.timeline || []).filter((t) => t.to_status !== 'pending');
  const willSend = sendText && !!message.trim() && !!ctx?.service?.hasPhone;

  return createPortal(
    <UiSurface density="touch" className="tech-visit-surface tech-visit-overlay" onClick={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) close();
    }}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="tech-visit-dialog">
        <header className="tech-visit-header">
          <div>
            <h2 id={titleId} className="tech-visit-title">Service Recap</h2>
            <p className="tech-visit-muted">{service?.customerName || ctx?.service?.customerName || 'Customer'}{service?.serviceType ? ` · ${service.serviceType}` : ''}</p>
          </div>
          <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={close} disabled={submitting} aria-label="Close">×</Button>
        </header>
        <div className="tech-visit-body">
          {loading ? <ActionFeedback className="tech-visit-feedback">Loading…</ActionFeedback> : loadError ? (
            <ActionFeedback error className="tech-visit-feedback">{loadError}</ActionFeedback>
          ) : <>
            {draft.candidate && <div className="tech-visit-card">
              <ActionFeedback className="tech-visit-feedback">A saved draft is available for this visit.</ActionFeedback>
              <div className="tech-visit-actions">
                <Button className="tech-visit-action tech-visit-primary" onClick={restoreDraft}>Restore draft</Button>
                <Button variant="secondary" className="tech-visit-action" onClick={draft.discard}>Discard draft</Button>
              </div>
            </div>}
            {draft.saved && <ActionFeedback className="tech-visit-feedback">Draft saved on this device. Not submitted.</ActionFeedback>}
            {draft.storageError && <ActionFeedback error className="tech-visit-feedback">{draft.storageError}</ActionFeedback>}
            <fieldset disabled={submitting || !!draft.candidate} className="tech-visit-form">
              {timeline.length > 0 && <div className="tech-visit-card">
                {timeline.map((t, i) => {
                  const meta = TIMELINE_LABELS[t.to_status] || { label: t.to_status, icon: '•' };
                  return <div key={i} className="tech-visit-timeline-row"><span><span aria-hidden="true">{meta.icon} </span>{meta.label}</span><span className="tech-visit-muted">{fmtTime(t.transitioned_at)}</span></div>;
                })}
              </div>}
              <Field label="What did you do?" className="tech-visit-field">
                <Textarea className="tech-visit-control" value={note} onChange={(e) => setNote(e.target.value)} rows={3}
                  placeholder="Quick internal note — areas treated, what you found, anything for the next visit." />
              </Field>
              <RecapProducts products={products} selected={selected} rates={rates} productById={productById} toggleProduct={toggleProduct} setRateValue={setRateValue} />
              {missingSelections.map((id) => <div key={id} className="tech-visit-card">
                <ActionFeedback error className="tech-visit-feedback">Unavailable product from draft: {restoredNames[id] || id}. Review the actual treatment before completing.</ActionFeedback>
                <Button variant="secondary" className="tech-visit-action" onClick={() => toggleProduct(id)}>Remove {restoredNames[id] || id}</Button>
              </div>)}
              <RecapMessage message={message} setMessage={setMessage} drafting={drafting} handleDraft={handleDraft}
                includeComms={includeComms} setIncludeComms={setIncludeComms} sendText={sendText} setSendText={setSendText} hasPhone={!!ctx?.service?.hasPhone} />
              {error && <ActionFeedback error className="tech-visit-feedback">{error}</ActionFeedback>}
              <div className="tech-visit-actions">
                <Button variant="secondary" className="tech-visit-action" onClick={close} disabled={submitting}>Cancel</Button>
                <Button className="tech-visit-action tech-visit-complete" onClick={handleSubmit} loading={submitting} disabled={!!missingSelections.length}>
                  {willSend ? 'Complete & Send' : 'Complete Service'}
                </Button>
              </div>
              {submitting && <ActionFeedback className="tech-visit-feedback">Saving completion… Keep this visit open.</ActionFeedback>}
            </fieldset>
          </>}
        </div>
      </section>
    </UiSurface>, document.body,
  );
}

function RecapProducts({ products, selected, rates, productById, toggleProduct, setRateValue }) {
  const rateRows = [...selected].map((id) => ({ id, product: productById.get(id), entry: rates[id] })).filter((row) => row.product && row.entry?.unit);
  return <>
    <h3 className="tech-visit-section-title">Products applied</h3>
    {products.length === 0 ? <p className="tech-visit-muted">No products in catalog.</p> : <div className="tech-visit-products">
      {products.map((product) => <Button key={product.id} variant="secondary" className="tech-visit-action tech-visit-product" aria-pressed={selected.has(product.id)} onClick={() => toggleProduct(product.id)}>
        {selected.has(product.id) && <span aria-hidden="true">✓ </span>}{product.name}
      </Button>)}
    </div>}
    {rateRows.length > 0 && <div className="tech-visit-card">
      <h3 className="tech-visit-section-title">Application rates (adjust to what you applied)</h3>
      {rateRows.map(({ id, product, entry }) => <Field key={id} label={`Application rate for ${product.name}`} className="tech-visit-field"
        help={<span className="tech-visit-muted">{entry.unit}</span>}
        error={entry.max != null && parseFloat(entry.rate) > entry.max ? <span className="tech-visit-warning">&gt; label max {entry.max}</span> : undefined}>
        <Input className="tech-visit-control" type="number" inputMode="decimal" min="0" step="any" value={entry.rate} onChange={(e) => setRateValue(id, e.target.value)} />
      </Field>)}
    </div>}
  </>;
}

function RecapMessage({ message, setMessage, drafting, handleDraft, includeComms, setIncludeComms, sendText, setSendText, hasPhone }) {
  return <>
    <Field label="Message to customer" className="tech-visit-field">
      <Textarea className="tech-visit-control" value={message} onChange={(e) => setMessage(e.target.value)} rows={4}
        placeholder="The recap your customer receives. Tap “Draft with AI” to generate from your note, then edit." />
    </Field>
    <Button variant="secondary" className="tech-visit-action" onClick={handleDraft} loading={drafting}>✨ Draft with AI</Button>
    <label className="ui-choice-label tech-visit-choice">
      <Checkbox className="tech-visit-checkbox" checked={includeComms} onChange={(e) => setIncludeComms(e.target.checked)} />
      <span>Include recent customer calls/texts/emails</span>
    </label>
    <label className="ui-choice-label tech-visit-choice">
      <Checkbox className="tech-visit-checkbox" checked={sendText && hasPhone} disabled={!hasPhone} onChange={(e) => setSendText(e.target.checked)} />
      <span>Text this recap to the customer</span>
    </label>
    {!hasPhone && <p className="tech-visit-muted">No mobile number on file — recap will be saved without texting.</p>}
  </>;
}
