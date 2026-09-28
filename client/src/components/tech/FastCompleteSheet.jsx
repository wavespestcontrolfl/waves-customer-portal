// client/src/components/tech/FastCompleteSheet.jsx
//
// Fast Complete — a one-screen completion for PEST RE-SERVICE visits
// (server/services/re-service.js: pest_re_service, a free between-visit
// callback). Owner ask: today's forms are "too long and laborious for techs"
// for what is, in practice, a quick targeted treatment.
//
// The visit note leads the sheet: the tech talks (or types), adds photos, and
// may pick ONE tip for the customer (owner ruling 2026-09-28: one per service
// visit, chosen from that visit's options). Photos are staged against the
// visit through the existing photo manager and promoted at completion.
//
// Records only what the application record needs for the HOUSE PEST MIX
// (Taurus SC, Atticus Talak 7.9 F, LESCO 90/10 surfactant — lib/pest-default-mix.js): which of
// those went down, their amounts and rates, pests targeted, where, how, and
// the activity seen when the server keeps a tech rating. Any other product
// goes through the full completion screen, which owns per-product
// method/unit rules for the whole catalog. Then it submits the FULL
// completion endpoint (POST /admin/dispatch/:id/complete →
// completeScheduledService), NOT /pest-recap: the full path records
// per-product method, targets, amounts, rates and areas. "Full form" (and
// "+ Other product") opens the full completion screen — the Dispatch
// CompletionPanel — before any attempt may have reached the server.
//
// The layout is compact (three/four-across choice rows, the note behind a
// tap) so the choices fit a typical phone screen; the Complete button is
// pinned in the footer either way.
//
// Product catalog and visit identity come from the SAME context endpoint
// ServiceRecapModal loads (GET /admin/dispatch/:id/pest-recap/context).
import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import { createPortal } from 'react-dom';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { pestDefaultMixSelections } from '../../lib/pest-default-mix';
import { defaultApplicationMethodForLine, resolveRatePrefill } from '../../lib/product-rate-prefill';
import { shouldResetCompletionIdempotencyKey } from '../../lib/completion-idempotency';
import { recapVisitIdentity } from '../../hooks/useServiceRecapDraft';
import { rankTechTips, techTipSubtext, techTipSentLabel } from '../../lib/tech-tips';
import DictationButton from './DictationButton';
import TechServicePhotosModal from './TechServicePhotosModal';
import { UiSurface, Button, Field, Input, Textarea, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

// Fallback amount unit when the resolver names none.
const DEFAULT_MIX_UNIT = 'oz';
// Same six totals units the full completion form offers (SchedulePage's
// STANDARD_AMOUNT_UNIT_OPTIONS), all on the server's VALID_RATE_UNITS list.
const AMOUNT_UNITS = ['oz', 'fl_oz', 'ml', 'g', 'lb', 'gal'];
const unitLabel = (unit) => String(unit || '').replace(/_/g, ' ');
const hasAmount = (row) => Number(row.totalAmount) > 0;

// How the SPRAY products went down. Spot treatment needs no measured area;
// a perimeter spray records its linear feet (the application record's area
// and the server's perimeter-footage check).
const METHOD_CHOICES = [
  { value: 'spot_treatment', label: 'Spot treatment' },
  { value: 'perimeter_spray', label: 'Perimeter spray' },
];
const SPRAY_METHODS = new Set(METHOD_CHOICES.map((choice) => choice.value));

const PEST_CHIPS = ['Ants', 'Roaches', 'Spiders', 'Silverfish', 'Wasps', 'Earwigs'];
const PEST_CHIPS_MORE = ['Fleas', 'Crickets', 'Centipedes', 'Other'];
const AREA_CHIPS = ['Inside', 'Outside', 'Garage'];
// Four taps on the server's 0–5 pest-pressure scale. Labels come from the
// server's active scale (tech-rating-allowed) so the tap means what the
// report will say; these are only the fallback.
const ACTIVITY_LEVELS = [
  { value: 'none', label: 'None', rating: 0 },
  { value: 'light', label: 'Light', rating: 2 },
  { value: 'moderate', label: 'Moderate', rating: 3 },
  { value: 'heavy', label: 'Heavy', rating: 5 },
];
// Tips shown before the tech searches or opens the whole list.
const TIP_PREVIEW_COUNT = 4;
// Mirrors MAX_CUSTOM_TIP_CHARS (server tip-library.js): the server rejects a
// longer line, never trims it.
const CUSTOM_TIP_MAX_CHARS = 240;
const MIC_PALETTE = { accent: '#e2e8f0', muted: '#334155', red: '#ef4444', card: '#1e293b' };
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);
const dayOf = (value) => String(value || '').slice(0, 10);
// Letters and digits only: the row's address is built in SQL and the live
// one from fields, so spacing and punctuation may differ, but a different
// unit never matches ("apt 4" vs "apt 5").
const addressKey = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Whether the tapped row's property is no longer the live visit's. The row's
// property id decides: a move to another unit at the same street is another
// property. A visit never stamped with one (null on both sides) falls back to
// the whole address, unit included. A row without the fields (an older
// payload) gives no verdict.
function propertyMoved(service, visit) {
  const routedId = service?.routedPropertyId;
  if (routedId !== undefined) {
    if (String(routedId ?? '') !== String(visit?.propertyId ?? '')) return true;
    if (routedId != null) return false;
  }
  const live = visit?.address;
  if (!service?.routedAddress || !live?.line1) return false;
  return addressKey(service.routedAddress) !== addressKey([live.line1, live.line2, live.city, live.state, live.zip].join(' '));
}

// Why the live context can't be completed here, or '' when it can: the
// schedule row the tech tapped may be stale, so the loaded visit must still
// be that visit (same customer, day and property), still an open pest
// re-service, and still eligible for the short form (not typed or
// project-backed).
function blockedReasonFor(context, service) {
  const visit = context?.service || {};
  const movedCustomer = service?.routedCustomerId && visit.customerId
    && String(service.routedCustomerId) !== String(visit.customerId);
  const movedDay = service?.routedScheduledDate && visit.scheduledDate
    && dayOf(service.routedScheduledDate) !== dayOf(visit.scheduledDate);
  const movedProperty = propertyMoved(service, visit);
  if (movedCustomer || movedDay || movedProperty) return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  if (visit.serviceKey !== 'pest_re_service') return 'This visit is no longer a pest re-service. Use the full form.';
  if (CLOSED_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  if (context?.eligible !== true) return 'This visit needs the full form.';
  return '';
}

// "123 Oak St, Bradenton" from the context's resolved address.
function liveAddressLine(address) {
  if (!address || typeof address !== 'object') return '';
  return [[address.line1, address.line2].filter(Boolean).join(' '), address.city].filter(Boolean).join(', ');
}

// Every /complete failure lands in one of four outcomes:
//  saved       — the visit is already saved: this or an earlier attempt
//                committed (a lost response, another device, or a partly
//                finished earlier try whose changed body the resume check
//                refuses — completion_resume_payload_mismatch is only
//                answered once a record exists; the office's Billing
//                Recovery finishes those).
//  correctable — a definitive pre-commit rejection: fix and resubmit under a
//                fresh key (the full form's shared rule).
//  retry       — outcome unknown or still running (network drop, 5xx, an
//                attempt pending or finishing its side effects): resend the
//                SAME body under the SAME key so the server replays/resumes.
//  terminal    — a conflict no retry can fix (a future-dated, closed or
//                changed visit, or an idempotency_key_mismatch, which the
//                server also answers for pending/failed attempts with no
//                record, so it is never proof of a save): show it and let
//                the tech leave.
const SAVED_CODES = new Set(['service_already_completed', 'completion_resume_payload_mismatch']);
const IN_PROGRESS_CODES = new Set(['service_completion_pending', 'completion_pending', 'completion_side_effects_running']);
function completionFailureOutcome(err) {
  const status = Number(err?.status);
  if (status === 409 && SAVED_CODES.has(err?.code)) return 'saved';
  if (shouldResetCompletionIdempotencyKey(err)) return 'correctable';
  if (!Number.isFinite(status) || status >= 500 || (status === 409 && IN_PROGRESS_CODES.has(err?.code))) return 'retry';
  return 'terminal';
}

function outcomeMessage(outcome, err) {
  if (outcome === 'retry') {
    return `${err?.message || 'Completion failed'} We couldn't confirm it saved. Tap Retry to send the same completion again.`;
  }
  if (err?.code === 'idempotency_key_mismatch') {
    return 'Another completion for this visit is in progress or was changed. Close and reopen it from the schedule to see where it stands.';
  }
  return err?.message || 'Completion failed';
}

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

// A house-mix row keeps its catalog product: its method comes from the
// catalog (the shared pest resolver) unless it is a spray, which follows the
// How row; its rate AND amount unit are resolved at the method actually
// submitted — the same resolver the full form seeds the mix with — so the
// record's method, rate and unit agree. What the tech typed wins.
function productRow(product, serviceType, totalAmount) {
  return {
    product,
    productId: product.id,
    name: product.name,
    totalAmount,
    catalogMethod: defaultApplicationMethodForLine(product, 'pest', { serviceType }),
    rateInput: null,
    amountUnitInput: null,
    active: true,
  };
}

function rowMethod(row, sprayMethod) {
  return SPRAY_METHODS.has(row.catalogMethod) ? sprayMethod : row.catalogMethod;
}

// The row's rate at its submitted method, plus the label ceiling the recap
// editor warns against: per-basis bands carry their upper bound; per-1,000
// rates use the verified catalog max; the 4-oz house default has none.
function rowRate(row, sprayMethod) {
  const resolved = resolveRatePrefill(row.product, { applicationMethod: rowMethod(row, sprayMethod), serviceLine: 'pest' });
  const prefill = Number(resolved.rate) > 0 && resolved.rateUnit ? String(Number(resolved.rate)) : '';
  const maxRaw = resolved.perBasisUnit
    ? resolved.labelMaxRate
    : resolved.usePestSprayDefault ? null : parseFloat(String(row.product?.max_label_rate_per_1000 ?? ''));
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
  return {
    rate: row.rateInput ?? prefill,
    rateUnit: resolved.rateUnit || '',
    max,
    amountUnit: row.amountUnitInput ?? (resolved.amountUnit || DEFAULT_MIX_UNIT),
  };
}

// Every requirement the application record needs, in screen order.
function missingRequirement(form, rows, ratingAllowed, dictationPending) {
  const active = rows.filter((row) => row.active);
  const missingAmount = active.find((row) => !hasAmount(row));
  const needsLinearFt = active.some((row) => rowMethod(row, form.method) === 'perimeter_spray');
  return [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [!active.length, 'Select at least one product.'],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [!form.pests.size, 'Select at least one pest.'],
    [form.pests.has('Other') && !form.otherPest.trim(), 'Name the other pest.'],
    [!form.areas.size, 'Select where you treated.'],
    [needsLinearFt && !(Number(form.linearFt) > 0), 'Enter the linear feet you sprayed.'],
    [ratingAllowed && !form.activity, 'Select activity seen.'],
  ].find(([missing]) => missing)?.[1] || '';
}

function targetsOf(form) {
  return [...form.pests].map((pest) => (pest === 'Other' ? form.otherPest.trim() : pest));
}

// One tip per service visit: a library pick OR the tech's own line, never
// both. null when the picker never loaded, so nothing the tech could not see
// freezes onto the report.
function techTipsOf(form, tipsAvailable) {
  if (!tipsAvailable) return null;
  const custom = form.customTip.trim();
  return custom ? { ids: [], custom } : { ids: form.tipId ? [form.tipId] : [], custom: null };
}

function completionBody(form, rows, { visitIdentity, ratingAllowed, tipsAvailable }) {
  const targets = targetsOf(form);
  // Where rides each product row too: service_products.application_area
  // comes only from the row (the full form sends the same comma-joined string).
  const applicationArea = [...form.areas].join(', ');
  return {
    visitOutcome: 'completed',
    ...(visitIdentity ? { expectedVisit: visitIdentity } : {}),
    products: rows.filter((row) => row.active).map((row) => {
      const applicationMethod = rowMethod(row, form.method);
      const { rate, rateUnit, amountUnit } = rowRate(row, form.method);
      return {
        productId: row.productId,
        applicationMethod,
        targets,
        totalAmount: Number(row.totalAmount),
        amountUnit,
        applicationArea,
        ...(Number(rate) > 0 && rateUnit ? { rate: Number(rate), rateUnit } : {}),
        ...(applicationMethod === 'perimeter_spray' ? { areaValue: Number(form.linearFt), areaUnit: 'linear_ft' } : {}),
      };
    }),
    areasServiced: [...form.areas],
    ...(ratingAllowed ? { clientPestRating: ACTIVITY_LEVELS.find((a) => a.value === form.activity)?.rating ?? null } : {}),
    technicianNotes: form.note.trim(),
    techTips: techTipsOf(form, tipsAvailable),
    // The customer recap text ships in a later Fast Complete PR; until then
    // this path sends none. No review ask on a re-service (adopted
    // 2026-09-26), and a free callback never carries a pay link.
    sendCompletionSms: false,
    requestReview: false,
    includePayLink: false,
  };
}

// The context + rating contract for this visit. The routed schedule row can
// be stale: the context is re-checked to still be an open pest re-service
// before anything can be completed here.
function useFastCompleteContext({ base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress }) {
  const [ctx, setCtx] = useState({
    loading: true, loadError: '', blockedReason: '', rows: [], visitIdentity: null, visit: null,
    rating: { allowed: false, scaleLabels: null },
    tips: null,
  });
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [data, ratingContract, tipLibrary] = await Promise.all([
          request(`${base}/pest-recap/context`),
          // A failed read keeps the rating off: never send a rating the
          // server may drop, or show a scale it may not use.
          request(`${base}/tech-rating-allowed`).catch(() => null),
          // A failed read, or the tips gate off, hides the picker.
          request(`${base}/tech-tips`).catch(() => null),
        ]);
        if (!active) return;
        const visit = data?.service || {};
        const products = Array.isArray(data?.products) ? data.products : [];
        setCtx({
          loading: false,
          loadError: '',
          blockedReason: blockedReasonFor(data, { routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress }),
          visit,
          rows: pestDefaultMixSelections(products).map(({ product, totalAmount }) => productRow(product, serviceType, totalAmount)),
          visitIdentity: recapVisitIdentity(visit),
          rating: { allowed: ratingContract?.allowed === true, scaleLabels: ratingContract?.scaleLabels || null },
          tips: tipLibrary?.available === true ? tipLibrary : null,
        });
      } catch (err) {
        if (active) setCtx((prev) => ({ ...prev, loading: false, loadError: err?.message || 'Failed to load products' }));
      }
    })();
    return () => { active = false; };
  }, [base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress]);
  return ctx;
}

// One completion attempt at a time, settled into the four outcomes above.
function useFastCompleteSubmit({ base, request }) {
  const keyRef = useRef(null);
  if (!keyRef.current) keyRef.current = genIdempotencyKey();
  const pendingBodyRef = useRef(null);
  const inFlight = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [failure, setFailure] = useState(null);
  const [done, setDone] = useState(null);

  const submit = useCallback(async (buildBody, summary) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    const body = pendingBodyRef.current || { idempotencyKey: keyRef.current, ...buildBody() };
    try {
      await request(`${base}/complete`, { method: 'POST', body: JSON.stringify(body) });
      pendingBodyRef.current = null;
      setFailure(null);
      setDone({ summary });
      // Saved: the done view can be dismissed (Close, Escape, backdrop).
      setSubmitting(false);
      inFlight.current = false;
    } catch (err) {
      const outcome = completionFailureOutcome(err);
      pendingBodyRef.current = outcome === 'retry' ? body : null;
      if (outcome === 'correctable') keyRef.current = genIdempotencyKey();
      if (outcome === 'saved') {
        setFailure(null);
        setDone({ summary: 'This visit was already saved. The office will finish anything still pending.' });
      } else {
        setFailure(outcome === 'correctable' ? null : outcome);
        setError(outcomeMessage(outcome, err));
      }
      setSubmitting(false);
      inFlight.current = false;
    }
  }, [base, request]);

  return { submitting, error, failure, done, submit, retryPending: failure === 'retry', hasPendingBody: () => !!pendingBodyRef.current };
}

// One tile — a real button, aria-pressed, 44px min touch target via the
// shared Button component's `touch` density.
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

function ChoiceSection({ title, action, columns = 2, children }) {
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">{title}</h3>
        {action}
      </div>
      <div className={cn('tech-visit-tile-grid', `tech-visit-tile-grid--${columns}`)}>{children}</div>
    </section>
  );
}

export default function FastCompleteSheet({ service, request, onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const ctx = useFastCompleteContext({
    base,
    request,
    serviceType: service?.serviceType,
    routedCustomerId: service?.routedCustomerId,
    routedScheduledDate: service?.routedScheduledDate,
    routedPropertyId: service?.routedPropertyId,
    routedAddress: service?.routedAddress,
  });
  const submission = useFastCompleteSubmit({ base, request });
  const { submitting, done } = submission;

  // Dismissing a saved sheet refreshes the schedule like "Next stop" does,
  // so a missed socket update can't leave the visit showing as open.
  // Any dismissal the schedule may be stale for asks the parent to refresh:
  // a sheet blocked on a stale or changed visit, or an attempt whose outcome
  // is unknown or refused (it may have saved), so reopening routes from the
  // live schedule rather than the same old row.
  const close = useCallback(() => {
    if (submitting) return;
    if (done) onCompleted?.();
    else onClose?.(ctx.blockedReason || submission.failure ? { refresh: true } : undefined);
  }, [submitting, done, ctx.blockedReason, submission.failure, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved, or refused
  // for good; the recap modal (Full form) can't resume a /complete attempt,
  // so it is offered only before one may have reached the server.
  const locked = submitting || submission.failure !== null;

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
            {/* The LIVE visit once loaded, so the tech sees whose property
                this completion records against. */}
            <p className="tech-visit-muted">
              {ctx.visit?.customerName || service?.customerName || 'Customer'}{service?.serviceType ? ` · ${service.serviceType}` : ''}
            </p>
            {liveAddressLine(ctx.visit?.address) && <p className="tech-visit-muted">{liveAddressLine(ctx.visit.address)}</p>}
          </div>
          {!done && (
            <Button variant="ghost" className="tech-visit-action" onClick={onFullForm} disabled={locked}>Full form</Button>
          )}
          <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={close} disabled={submitting} aria-label="Close">×</Button>
        </header>
        <SheetBody service={service} request={request} ctx={ctx} submission={submission} locked={locked} onCompleted={onCompleted} onFullForm={onFullForm} />
      </section>
    </UiSurface>,
    document.body,
  );
}

function SheetBody({ service, request, ctx, submission, locked, onCompleted, onFullForm }) {
  if (submission.done) {
    return (
      <div className="tech-visit-body">
        <div className="tech-visit-card">
          <p className="tech-visit-muted">{[service?.address, service?.timeLabel].filter(Boolean).join(' · ') || 'This visit'}</p>
          <p>{submission.done.summary}</p>
        </div>
        <div className="tech-visit-actions">
          <Button className="tech-visit-action tech-visit-complete tech-visit-wide" onClick={() => onCompleted?.()}>Next stop</Button>
        </div>
      </div>
    );
  }
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  const stop = ctx.loadError || ctx.blockedReason;
  if (stop) return <ActionFeedback error={!!ctx.loadError} className="tech-visit-feedback tech-visit-loading">{stop}</ActionFeedback>;
  return <FastCompleteForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} onFullForm={onFullForm} />;
}

function FastCompleteForm({ service, request, ctx, submission, locked, onFullForm }) {
  const [rows, setRows] = useState(ctx.rows);
  const [editAmounts, setEditAmounts] = useState(false);
  const [form, setForm] = useState(() => ({
    pests: new Set(), otherPest: '', areas: new Set(), method: 'spot_treatment', linearFt: '', activity: '', note: '',
    tipId: '', customTip: '',
  }));
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);
  const tipsAvailable = !!ctx.tips;
  const [dictationPending, setDictationPending] = useState(false);

  const updateRow = useCallback((productId, patch) => {
    setRows((prev) => prev.map((row) => (row.productId === productId ? { ...row, ...patch } : row)));
  }, []);
  // A rate typed for one spray method doesn't carry to another.
  const chooseMethod = useCallback((next) => {
    setField('method', next);
    setRows((prev) => prev.map((row) => (SPRAY_METHODS.has(row.catalogMethod) ? { ...row, rateInput: null } : row)));
  }, [setField]);

  const missingReason = missingRequirement(form, rows, ctx.rating.allowed, dictationPending);
  const submit = () => {
    if (missingReason && !submission.hasPendingBody()) return;
    const names = rows.filter((row) => row.active).map((row) => row.name).join(', ');
    submission.submit(
      () => completionBody(form, rows, { visitIdentity: ctx.visitIdentity, ratingAllowed: ctx.rating.allowed, tipsAvailable }),
      `${names} · ${targetsOf(form).join(', ')}`,
    );
  };

  return (
    <>
      <div className="tech-visit-body">
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={setDictationPending} serviceId={service?.id} locked={locked} />
          <PhotosSection serviceId={service?.id} customerName={ctx.visit?.customerName || service?.customerName} request={request} locked={locked} />
          <ProductsSection
            rows={rows}
            method={form.method}
            editAmounts={editAmounts}
            locked={locked}
            onToggleEdit={() => setEditAmounts((on) => !on)}
            onToggleRow={(row) => updateRow(row.productId, { active: !row.active })}
            onUpdateRow={updateRow}
            onOtherProduct={onFullForm}
          />
          <PestsSection form={form} setField={setField} locked={locked} />
          <ChoiceSection title="Where" columns={3}>
            {AREA_CHIPS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.areas.has(label)} onClick={() => setField('areas', toggleInSet(form.areas, label))} />
            ))}
          </ChoiceSection>
          <MethodSection form={form} rows={rows} setField={setField} chooseMethod={chooseMethod} locked={locked} />
          {ctx.rating.allowed && (
            <ChoiceSection title="Activity seen" columns={4}>
              {ACTIVITY_LEVELS.map((level) => (
                <Chip disabled={locked} key={level.value} label={ctx.rating.scaleLabels?.[level.rating] || level.label} pressed={form.activity === level.value} onClick={() => setField('activity', level.value)} />
              ))}
            </ChoiceSection>
          )}
          {tipsAvailable && (
            <TipSection
              library={ctx.tips}
              tipId={form.tipId}
              customTip={form.customTip}
              locked={locked}
              onPick={(id) => setForm((prev) => ({ ...prev, tipId: prev.tipId === id ? '' : id, customTip: '' }))}
              onCustom={(value) => setForm((prev) => ({ ...prev, customTip: value, tipId: value.trim() ? '' : prev.tipId }))}
            />
          )}
        </fieldset>
        {submission.submitting && <ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
      </div>
      <footer className="tech-visit-footer">
        {submission.error && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{submission.error}</ActionFeedback>}
        {missingReason && !submission.failure && <p className="tech-visit-muted" role="status">{missingReason}</p>}
        <div className="tech-visit-actions">
          <Button
            className="tech-visit-action tech-visit-complete tech-visit-wide"
            onClick={submit}
            loading={submission.submitting}
            disabled={submission.failure === 'terminal' || (!!missingReason && !submission.retryPending)}
          >
            {submission.retryPending ? 'Retry' : 'Complete re-service'}
          </Button>
        </div>
      </footer>
    </>
  );
}

function ProductsSection({ rows, method, editAmounts, locked, onToggleEdit, onToggleRow, onUpdateRow, onOtherProduct }) {
  return (
    <>
    <ChoiceSection
      title="Products used"
      action={(
        <Button type="button" variant="ghost" className="tech-visit-action" aria-pressed={editAmounts} onClick={onToggleEdit}>
          {editAmounts ? 'Done' : 'Edit amounts'}
        </Button>
      )}
    >
      {rows.map((row) => (
        <Chip
          disabled={locked}
          key={row.productId}
          label={hasAmount(row) ? `${row.name} — ${row.totalAmount} ${unitLabel(rowRate(row, method).amountUnit)}` : `${row.name} — amount?`}
          pressed={row.active}
          onClick={() => onToggleRow(row)}
          className={!row.active ? 'tech-visit-product--off' : undefined}
        />
      ))}
      {/* Any product beyond the house mix completes through the full
          completion screen, which records its method, amount and area. */}
      <Chip disabled={locked} label="+ Other product" onClick={onOtherProduct} />
    </ChoiceSection>
    {editAmounts && rows.filter((row) => row.active).map((row) => (
      <AmountRow key={row.productId} row={row} rate={rowRate(row, method)} onChange={(patch) => onUpdateRow(row.productId, patch)} />
    ))}
    </>
  );
}

function PestsSection({ form, setField, locked }) {
  const [showMore, setShowMore] = useState(false);
  const toggle = (label) => setField('pests', toggleInSet(form.pests, label));
  return (
    <>
      <ChoiceSection
        title="Pests targeted"
        columns={3}
        action={!showMore && <Button type="button" variant="ghost" className="tech-visit-action" onClick={() => setShowMore(true)}>More</Button>}
      >
        {(showMore ? [...PEST_CHIPS, ...PEST_CHIPS_MORE] : PEST_CHIPS).map((label) => (
          <Chip disabled={locked} key={label} label={label} pressed={form.pests.has(label)} onClick={() => toggle(label)} />
        ))}
      </ChoiceSection>
      {form.pests.has('Other') && (
        <Field label="Which pest?" className="tech-visit-field">
          <Input className="tech-visit-control" value={form.otherPest} onChange={(e) => setField('otherPest', e.target.value)} placeholder="e.g. palmetto bugs" />
        </Field>
      )}
    </>
  );
}

function MethodSection({ form, rows, setField, chooseMethod, locked }) {
  const needsLinearFt = rows.some((row) => row.active && rowMethod(row, form.method) === 'perimeter_spray');
  return (
    <>
      <ChoiceSection title="How">
        {METHOD_CHOICES.map((choice) => (
          <Chip disabled={locked} key={choice.value} label={choice.label} pressed={form.method === choice.value} onClick={() => chooseMethod(choice.value)} />
        ))}
      </ChoiceSection>
      {needsLinearFt && (
        <Field label="Linear ft sprayed" className="tech-visit-field">
          <Input className="tech-visit-control" type="number" inputMode="decimal" min="0" step="any" value={form.linearFt} onChange={(e) => setField('linearFt', e.target.value)} />
        </Field>
      )}
    </>
  );
}

// The visit note leads the sheet. The mic appends what the tech says; on a
// phone without speech recognition it records a clip for server transcription
// (DictationButton's upload fallback), and renders nothing where neither works.
function VisitNote({ note, onChange, onDictated, onDictationPending, serviceId, locked }) {
  const noteId = useId();
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title"><label htmlFor={noteId}>Tell me about the visit</label></h3>
      </div>
      <div className="tech-visit-note-row">
        <DictationButton onAppend={onDictated} onPendingChange={onDictationPending} palette={MIC_PALETTE} size={48} title="Talk about the visit" disabled={locked} uploadServiceId={serviceId} />
        <Textarea
          id={noteId}
          className="tech-visit-control"
          rows={3}
          value={note}
          onChange={(e) => onChange(e.target.value)}
          placeholder="What you treated, where, and what you saw"
        />
      </div>
    </section>
  );
}

// Photos are staged against the visit by the existing photo manager and
// promoted into the service record at completion. Optional here.
function PhotosSection({ serviceId, customerName, request, locked }) {
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(null);
  const loadCount = useCallback(async () => {
    try {
      const data = await request(`/tech/services/${serviceId}/photos`);
      setCount(Array.isArray(data?.photos) ? data.photos.length : null);
    } catch {
      // The count is a convenience; the photo manager reports its own errors.
      setCount(null);
    }
  }, [request, serviceId]);
  useEffect(() => { void loadCount(); }, [loadCount]);
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Photos</h3>
        <span className="tech-visit-muted">{count ? `${count} added` : 'Optional'}</span>
      </div>
      <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={() => setOpen(true)} disabled={locked}>
        {count ? 'Add or view photos' : 'Add photos'}
      </Button>
      {open && (
        <TechServicePhotosModal
          serviceId={serviceId}
          customerName={customerName}
          onClose={() => { setOpen(false); void loadCount(); }}
        />
      )}
    </section>
  );
}

// What the picker says beside a tip: already covered by the customer's
// saved settings, or when it last went out to this customer.
function tipMark(tip, library) {
  if (tip.condition === 'irrigation_on_file' && library?.conditions?.irrigation_on_file === true) return 'already on file';
  const day = library?.lastSent?.[tip.id];
  return day ? techTipSentLabel(day) : null;
}

// The tips on screen: search results, the whole list, or the short list,
// with the pick always kept in view. `noMatch` is about the search alone, so
// a pinned pick never hides that a search found nothing.
function visibleTips(allTips, { query, showAll, tipId }) {
  const listed = query ? rankTechTips(allTips, query) : showAll ? allTips : allTips.slice(0, TIP_PREVIEW_COUNT);
  const pinned = tipId && !listed.some((tip) => tip.id === tipId) ? allTips.find((tip) => tip.id === tipId) : null;
  return { tips: pinned ? [pinned, ...listed] : listed, noMatch: !!query && !listed.length };
}

function TipOption({ tip, library, pressed, locked, onPick }) {
  return (
    <Button
      type="button"
      variant="secondary"
      className="tech-visit-action tech-visit-tip"
      aria-pressed={pressed}
      onClick={() => onPick(tip.id)}
      disabled={locked}
    >
      <span>
        {tip.label}
        <span className="tech-visit-tip-copy">{[techTipSubtext(tip.copy), tipMark(tip, library)].filter(Boolean).join(' · ')}</span>
      </span>
    </Button>
  );
}

// One tip per service visit, from this visit's options: a short list first,
// the whole list behind "Show all", search across all of it, or the tech's
// own line. Only the id (or the typed line) goes on the wire; the server
// resolves and freezes the copy.
function TipSection({ library, tipId, customTip, locked, onPick, onCustom }) {
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [writing, setWriting] = useState(false);
  const allTips = useMemo(
    () => (library?.groups || []).flatMap((group) => group.tips || []),
    [library],
  );
  const q = query.trim().toLowerCase();
  const { tips: visible, noMatch } = visibleTips(allTips, { query: q, showAll, tipId });
  const hasPick = !!tipId || !!customTip.trim();
  const writingOwn = writing || !!customTip;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Tip for the customer</h3>
        <span className="tech-visit-muted">{hasPick ? '1 picked' : 'Pick 1 (optional)'}</span>
      </div>
      <Field label="Search tips" className="tech-visit-field">
        <Input className="tech-visit-control" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="e.g. ants, porch light" />
      </Field>
      <div className="tech-visit-tip-list">
        {visible.map((tip) => (
          <TipOption key={tip.id} tip={tip} library={library} pressed={tip.id === tipId} locked={locked} onPick={onPick} />
        ))}
        {noMatch && <p className="tech-visit-muted">No tips match.</p>}
      </div>
      <div className="tech-visit-tile-grid">
        {!q && allTips.length > TIP_PREVIEW_COUNT && (
          <Chip disabled={locked} label={showAll ? 'Show fewer' : 'Show all'} onClick={() => setShowAll((on) => !on)} />
        )}
        {!writingOwn && <Chip disabled={locked} label="Write your own" onClick={() => setWriting(true)} />}
      </div>
      {writingOwn && (
        <Field label="Your own tip (one sentence)" className="tech-visit-field">
          <Input className="tech-visit-control" value={customTip} maxLength={CUSTOM_TIP_MAX_CHARS} onChange={(e) => onCustom(e.target.value)} placeholder="Goes on the report as a note from you" />
        </Field>
      )}
    </section>
  );
}

function AmountRow({ row, rate, onChange }) {
  const inputId = useId();
  const rateId = useId();
  const units = AMOUNT_UNITS.includes(rate.amountUnit) ? AMOUNT_UNITS : [...AMOUNT_UNITS, rate.amountUnit];
  const overLabel = rate.max != null && parseFloat(rate.rate) > rate.max;
  return (
    <div className="tech-visit-amount-block">
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
          value={rate.amountUnit}
          onChange={(e) => onChange({ amountUnitInput: e.target.value })}
        >
          {units.map((unit) => <option key={unit} value={unit}>{unitLabel(unit)}</option>)}
        </select>
      </div>
      {rate.rateUnit ? (
        <div className="tech-visit-amount-row">
          <label htmlFor={rateId} className="tech-visit-amount-label">{`${row.name} rate`}</label>
          <Input
            id={rateId}
            className="tech-visit-control"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={rate.rate ?? ''}
            onChange={(e) => onChange({ rateInput: e.target.value })}
          />
          <span className="tech-visit-amount-label">{unitLabel(rate.rateUnit)}</span>
        </div>
      ) : null}
      {overLabel && <p className="tech-visit-warning" role="status">&gt; label max {rate.max}</p>}
    </div>
  );
}
