// client/src/components/tech/FastCompleteSheet.jsx
//
// Fast Complete — a one-screen, no-scrolling completion for PEST RE-SERVICE
// visits (server/services/re-service.js: pest_re_service, a free
// between-visit callback). Owner ask: today's forms are "too long and
// laborious for techs" for a job that is, in practice, a quick spot check.
//
// Records only: products used (prefilled from the house pest mix), pests
// targeted, where, and activity seen — then submits the FULL completion
// endpoint (POST /admin/dispatch/:id/complete → completeScheduledService),
// NOT /pest-recap: the full path records per-product targets, amounts and
// areas for the FDACS application record; the recap path drops them. A
// "Full form" escape hatch always reaches today's ServiceRecapModal so
// nothing is lost if the one-screen flow doesn't fit.
//
// Product catalog: reused from the SAME context endpoint ServiceRecapModal
// already loads (GET /admin/dispatch/:id/pest-recap/context) — no new
// server surface for the picker.
import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { pestDefaultMixSelections } from '../../lib/pest-default-mix';
import { shouldResetCompletionIdempotencyKey } from '../../lib/completion-idempotency';
import { UiSurface, Button, Field, Input, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

// House pest mix totals are all in whole/fractional ounces (pest-default-mix.js)
// — 'oz' is a valid, ambiguous-dimension unit on the server's shared
// rate-unit allowlist (inventory-units.js), so it needs no per-product
// catalog lookup to resolve.
const DEFAULT_MIX_UNIT = 'oz';
// Same six totals units the full completion form offers (SchedulePage's
// STANDARD_AMOUNT_UNIT_OPTIONS), all on the server's VALID_RATE_UNITS list.
const AMOUNT_UNITS = ['oz', 'fl_oz', 'ml', 'g', 'lb', 'gal'];
const unitLabel = (unit) => String(unit || '').replace(/_/g, ' ');
const hasAmount = (row) => Number(row.totalAmount) > 0;

// The one application method this screen ever submits: no linear-ft/sqft
// field fits on one screen, and spot_treatment is the one method that
// requires neither (requiredApplicationArea, server-mirrored in
// complete-scheduled-service.js's requires*ForReportApplication).
const SUBMIT_APPLICATION_METHOD = 'spot_treatment';

const PEST_CHIPS = ['Ants', 'Roaches', 'Spiders', 'Silverfish', 'Wasps', 'Earwigs'];
const PEST_CHIPS_MORE = ['Fleas', 'Crickets', 'Centipedes', 'Other'];
const AREA_CHIPS = ['Inside', 'Outside', 'Garage'];
const ACTIVITY_LEVELS = [
  { value: 'none', label: 'None', rating: 0 },
  { value: 'light', label: 'Light', rating: 2 },
  { value: 'moderate', label: 'Moderate', rating: 3 },
  { value: 'heavy', label: 'Heavy', rating: 5 },
];

function genIdempotencyKey() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `fastcomplete_${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function toggleInSet(set, value) {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

// One tile, shared by every section (products / pests / where / activity /
// the add-product picker) — a real button, aria-pressed, 44px min touch
// target via the shared Button component's `touch` density.
function Chip({ label, pressed, onClick, className, disabled }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn('tech-visit-action tech-visit-product', className)}
      {...(pressed != null ? { 'aria-pressed': pressed } : {})}
      onClick={onClick}
      disabled={disabled}
    >
      {label}
    </Button>
  );
}

export default function FastCompleteSheet({ service, request, onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;

  // One key per sheet open, reused across a resubmit (double-tap, a network
  // retry) so the server's completion-attempt claim can dedupe instead of
  // minting a second completion from two client requests.
  const idempotencyKeyRef = useRef(null);
  if (!idempotencyKeyRef.current) idempotencyKeyRef.current = genIdempotencyKey();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [catalog, setCatalog] = useState([]);
  // { productId, name, totalAmount (number or the typed string), amountUnit, active }
  const [productRows, setProductRows] = useState([]);
  const [editAmounts, setEditAmounts] = useState(false);
  const [showAddProduct, setShowAddProduct] = useState(false);
  const [addProductQuery, setAddProductQuery] = useState('');

  const [pests, setPests] = useState(() => new Set());
  const [showMorePests, setShowMorePests] = useState(false);
  const [areas, setAreas] = useState(() => new Set());
  const [activity, setActivity] = useState('');
  const [note, setNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const submitInFlight = useRef(false);
  // The exact body of an attempt whose outcome is unknown (network drop,
  // 5xx). The server refuses a reused key with a changed payload, so until
  // that attempt resolves the form locks and Retry resends this body as-is.
  const pendingBodyRef = useRef(null);
  const [retryPending, setRetryPending] = useState(false);
  // An earlier attempt left this visit partly saved under a different
  // payload (the server's resume check refuses a changed body even on a new
  // key). This sheet can't finish it; the full form's recovery path can.
  const [needsFullForm, setNeedsFullForm] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await request(`${base}/pest-recap/context`);
        if (!active) return;
        const products = Array.isArray(data?.products) ? data.products : [];
        setCatalog(products);
        const mix = pestDefaultMixSelections(products);
        setProductRows(mix.map(({ product, totalAmount }) => ({
          productId: product.id, name: product.name, totalAmount, amountUnit: DEFAULT_MIX_UNIT, active: true,
        })));
      } catch (err) {
        if (active) setLoadError(err?.message || 'Failed to load products');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [base, request]);

  const toggleProductActive = useCallback((productId) => {
    setProductRows((prev) => prev.map((row) => (
      row.productId === productId ? { ...row, active: !row.active } : row
    )));
  }, []);

  const updateRow = useCallback((productId, patch) => {
    setProductRows((prev) => prev.map((row) => (row.productId === productId ? { ...row, ...patch } : row)));
  }, []);

  // An added product has no house-mix total, so the amount editor opens and
  // Complete stays blocked until the tech enters what they used; the amount
  // feeds the application record and the inventory deduction.
  const addProduct = useCallback((product) => {
    setProductRows((prev) => (
      prev.some((row) => row.productId === product.id)
        ? prev.map((row) => (row.productId === product.id ? { ...row, active: true } : row))
        : [...prev, { productId: product.id, name: product.name, totalAmount: '', amountUnit: DEFAULT_MIX_UNIT, active: true }]
    ));
    setEditAmounts(true);
    setShowAddProduct(false);
    setAddProductQuery('');
  }, []);

  const addableProducts = useMemo(() => {
    const already = new Set(productRows.map((row) => row.productId));
    const q = addProductQuery.trim().toLowerCase();
    return catalog
      .filter((p) => !already.has(p.id) && (!q || String(p.name || '').toLowerCase().includes(q)))
      .slice(0, 40);
  }, [catalog, productRows, addProductQuery]);

  const togglePest = useCallback((label) => setPests((prev) => toggleInSet(prev, label)), []);
  const toggleArea = useCallback((label) => setAreas((prev) => toggleInSet(prev, label)), []);

  const activeProducts = productRows.filter((row) => row.active);
  const missingAmount = activeProducts.find((row) => !hasAmount(row));
  const missingReason = !activeProducts.length
    ? 'Select at least one product.'
    : missingAmount ? `Enter the amount for ${missingAmount.name}.`
      : !pests.size ? 'Select at least one pest.' : !activity ? 'Select activity seen.' : '';

  // An unconfirmed attempt holds the sheet open: closing or switching forms
  // would drop the exact body a retry has to resend.
  const close = useCallback(() => { if (!submitting && !retryPending) onClose?.(); }, [submitting, retryPending, onClose]);
  closeRef.current = close;

  const handleSubmit = useCallback(async () => {
    if (submitInFlight.current || (missingReason && !pendingBodyRef.current)) return;
    submitInFlight.current = true;
    setSubmitting(true);
    setError('');
    const targets = [...pests];
    // Where is recorded on each product row too: service_products'
    // application_area comes only from the row (the full form sends the same
    // comma-joined string), so the application record keeps the location.
    const applicationArea = [...areas].join(', ');
    const body = pendingBodyRef.current || {
      idempotencyKey: idempotencyKeyRef.current,
      visitOutcome: 'completed',
      products: activeProducts.map((row) => ({
        productId: row.productId,
        applicationMethod: SUBMIT_APPLICATION_METHOD,
        targets,
        totalAmount: Number(row.totalAmount),
        amountUnit: row.amountUnit,
        ...(applicationArea ? { applicationArea } : {}),
      })),
      areasServiced: [...areas],
      clientPestRating: ACTIVITY_LEVELS.find((a) => a.value === activity)?.rating ?? null,
      technicianNotes: note.trim(),
      // The customer recap text ships in a later Fast Complete PR; until
      // then this path sends none. No review ask on a re-service (adopted
      // 2026-09-26), and a free callback never carries a pay link.
      sendCompletionSms: false,
      requestReview: false,
      includePayLink: false,
    };
    try {
      await request(`${base}/complete`, { method: 'POST', body: JSON.stringify(body) });
      pendingBodyRef.current = null;
      setRetryPending(false);
      const productNames = activeProducts.map((p) => p.name).join(', ');
      setDone({ summary: `${productNames} · ${targets.join(', ')}` });
    } catch (err) {
      if (err?.status === 409 && err?.code === 'service_already_completed') {
        // Terminal, not uncertain: an earlier attempt (a lost response, or
        // another device) already saved this visit, so every retry would
        // get the same answer. Treat it as saved and let the tech move on.
        pendingBodyRef.current = null;
        setRetryPending(false);
        setDone({ summary: 'This visit was already saved.' });
      } else if (err?.status === 409 && ['completion_resume_payload_mismatch', 'idempotency_key_mismatch'].includes(err?.code)) {
        pendingBodyRef.current = null;
        setRetryPending(false);
        setNeedsFullForm(true);
        setError('An earlier try partly saved this visit. Open the full form to finish it.');
      } else if (shouldResetCompletionIdempotencyKey(err)) {
        // A definitive rejection: the tech corrects the form and the
        // resubmit starts a new attempt under a fresh key.
        idempotencyKeyRef.current = genIdempotencyKey();
        pendingBodyRef.current = null;
        setRetryPending(false);
        setError(err?.message || 'Completion failed');
      } else {
        // Outcome unknown: keep the key AND the body so Retry replays or
        // resumes the same attempt instead of tripping the payload check.
        pendingBodyRef.current = body;
        setRetryPending(true);
        setError(`${err?.message || 'Completion failed'} We couldn't confirm it saved. Tap Retry to send the same completion again.`);
      }
      setSubmitting(false);
      submitInFlight.current = false;
    }
  }, [base, request, missingReason, activeProducts, pests, areas, activity, note]);

  // Nothing is editable while a save is in flight or its outcome is unknown.
  const locked = retryPending || submitting || needsFullForm;

  return createPortal(
    <UiSurface
      density="touch"
      className={cn('tech-visit-surface tech-visit-overlay', isMobile && 'tech-visit-overlay--fullscreen')}
      onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) close(); }}
    >
      <section
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn('tech-visit-dialog', isMobile && 'tech-visit-dialog--fullscreen')}
      >
        <header className="tech-visit-header">
          <div>
            <h2 id={titleId} className="tech-visit-title">{done ? 'Re-service complete' : 'Complete re-service'}</h2>
            <p className="tech-visit-muted">
              {service?.customerName || 'Customer'}{service?.serviceType ? ` · ${service.serviceType}` : ''}
            </p>
          </div>
          {!done && (
            <Button variant="ghost" className="tech-visit-action" onClick={onFullForm} disabled={submitting || retryPending}>Full form</Button>
          )}
          <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={close} disabled={submitting || retryPending} aria-label="Close">×</Button>
        </header>

        {done ? (
          <div className="tech-visit-body">
            <div className="tech-visit-card">
              <p className="tech-visit-muted">{[service?.address, service?.timeLabel].filter(Boolean).join(' · ') || 'This visit'}</p>
              <p>{done.summary}</p>
            </div>
            <div className="tech-visit-actions">
              <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={() => onCompleted?.()}>Next stop</Button>
            </div>
          </div>
        ) : loading ? (
          <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>
        ) : loadError ? (
          <ActionFeedback error className="tech-visit-feedback tech-visit-loading">{loadError}</ActionFeedback>
        ) : showAddProduct ? (
          <div className="tech-visit-body">
            <AddProductPanel
              products={addableProducts}
              query={addProductQuery}
              setQuery={setAddProductQuery}
              onPick={addProduct}
              onBack={() => { setShowAddProduct(false); setAddProductQuery(''); }}
            />
          </div>
        ) : (
          <>
            <div className="tech-visit-body">
              <fieldset className="tech-visit-form" disabled={locked}>
              <div className="tech-visit-section-head">
                <h3 className="tech-visit-section-title">Products used</h3>
                <Button type="button" variant="ghost" className="tech-visit-action" aria-pressed={editAmounts} onClick={() => setEditAmounts((on) => !on)}>
                  {editAmounts ? 'Done' : 'Edit amounts'}
                </Button>
              </div>
              <div className="tech-visit-tile-grid">
                {productRows.map((row) => (
                  <Chip disabled={locked}
                    key={row.productId}
                    label={hasAmount(row) ? `${row.name} — ${row.totalAmount} ${unitLabel(row.amountUnit)}` : `${row.name} — amount?`}
                    pressed={row.active}
                    onClick={() => toggleProductActive(row.productId)}
                    className={!row.active ? 'tech-visit-product--off' : undefined}
                  />
                ))}
                <Chip disabled={locked} label="+ Add product" onClick={() => setShowAddProduct(true)} />
              </div>
              {editAmounts && activeProducts.map((row) => (
                <AmountRow key={row.productId} row={row} onChange={(patch) => updateRow(row.productId, patch)} />
              ))}

              <h3 className="tech-visit-section-title">Pests targeted</h3>
              <div className="tech-visit-tile-grid">
                {PEST_CHIPS.map((label) => (
                  <Chip disabled={locked} key={label} label={label} pressed={pests.has(label)} onClick={() => togglePest(label)} />
                ))}
                {showMorePests
                  ? PEST_CHIPS_MORE.map((label) => (
                    <Chip disabled={locked} key={label} label={label} pressed={pests.has(label)} onClick={() => togglePest(label)} />
                  ))
                  : <Chip disabled={locked} label="More" onClick={() => setShowMorePests(true)} />}
              </div>

              <h3 className="tech-visit-section-title">Where</h3>
              <div className="tech-visit-tile-grid">
                {AREA_CHIPS.map((label) => (
                  <Chip disabled={locked} key={label} label={label} pressed={areas.has(label)} onClick={() => toggleArea(label)} />
                ))}
              </div>

              <h3 className="tech-visit-section-title">Activity seen</h3>
              <div className="tech-visit-tile-grid">
                {ACTIVITY_LEVELS.map((level) => (
                  <Chip disabled={locked} key={level.value} label={level.label} pressed={activity === level.value} onClick={() => setActivity(level.value)} />
                ))}
              </div>

              <Field label="Note (optional)" className="tech-visit-field">
                <Input className="tech-visit-control" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything for the next visit" />
              </Field>
              </fieldset>

              {submitting &&<ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
            </div>
            <footer className="tech-visit-footer">
              {error && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{error}</ActionFeedback>}
              {missingReason && !retryPending && <p className="tech-visit-muted" role="status">{missingReason}</p>}
              <div className="tech-visit-actions">
                <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={handleSubmit} loading={submitting} disabled={needsFullForm || (!!missingReason && !retryPending)}>
                  {retryPending ? 'Retry' : 'Complete re-service'}
                </Button>
              </div>
            </footer>
          </>
        )}
      </section>
    </UiSurface>,
    document.body,
  );
}

function AmountRow({ row, onChange }) {
  const inputId = useId();
  return (
    <div className="tech-visit-amount-row">
      <label htmlFor={inputId} className="tech-visit-amount-label">{row.name}</label>
      <Input
        id={inputId}
        className="tech-visit-control"
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        value={row.totalAmount ?? ''}
        onChange={(e) => onChange({ totalAmount: e.target.value })}
      />
      <select
        className="ui-control tech-visit-control"
        aria-label={`Unit for ${row.name}`}
        value={row.amountUnit || DEFAULT_MIX_UNIT}
        onChange={(e) => onChange({ amountUnit: e.target.value })}
      >
        {AMOUNT_UNITS.map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}
      </select>
    </div>
  );
}

function AddProductPanel({ products, query, setQuery, onPick, onBack }) {
  return (
    <>
      <Button type="button" variant="ghost" className="tech-visit-action" onClick={onBack}>← Back</Button>
      <Field label="Search products" className="tech-visit-field">
        <Input className="tech-visit-control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Product name" autoFocus />
      </Field>
      <div className="tech-visit-tile-grid">
        {products.length === 0
          ? <p className="tech-visit-muted">No matching products.</p>
          : products.map((product) => <Chip key={product.id} label={product.name} onClick={() => onPick(product)} />)}
      </div>
    </>
  );
}
