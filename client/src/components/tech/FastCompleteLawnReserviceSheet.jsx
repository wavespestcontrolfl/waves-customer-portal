// client/src/components/tech/FastCompleteLawnReserviceSheet.jsx
//
// Fast Complete for LAWN RE-SERVICES (lawn_re_service, the free between-visit
// lawn callback): one phone screen instead of the long typed lawn form. It
// shares its frame, header, saved view, note, product picker, amount entry and
// footer with the pest and Tree & Shrub sheets (FastCompleteParts.jsx) and
// their /complete submit (hooks/useFastCompleteSubmit.js).
//
// The visit stays a TYPED one_time_lawn_treatment completion: the sheet sends
// that type's structuredFindings through the full /admin/dispatch/:id/complete,
// so every server rule still runs. The sheet asks for the type's only required
// field (lawn condition) plus what the tech was treating for and how heavy the
// weeds were; it sends nothing else (no work_completed, photos, lawn
// assessment, scores or follow-up).
//
// Nothing is assumed applied. The products this property's last lawn visit
// recorded are SUGGESTION tiles, off until tapped; an amount fills only from
// what that visit recorded (labeled "last time"), else it is blank and
// required. "+ Other product" adds any catalog product.
//
// Each row carries the method the tech really used, never a guess. A last-visit
// tile starts on the method that visit recorded (when the server offers it); an
// added product, or a tile with no usable recorded method, starts with none and
// Complete waits for a tap. The methods come from the server's context (exactly
// what /complete accepts for a lawn row, with its own verdict on which need a
// measured area). A row whose method needs square feet asks for them, prefilled
// only from a fact and labeled: what that product recorded last time, else the
// property's lawn size. Otherwise blank and required. Spot rows send no area.
//
// Customer text: the sheet sends the full typed form's own default (completion
// text on, pay link on), minus the review ask the owner kept off re-services.
// customerRecapMode is NOT sent: the fixed recap text is pest-only by design.
//
// Context, visit identity and the catalog come from GET
// /admin/dispatch/:id/lawn-reservice/fast-context (404 {enabled:false} when the
// gate is off, 409 when the visit is no longer a lawn re-service: this visit
// then needs the full form).
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { recapVisitIdentity } from '../../hooks/useServiceRecapDraft';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import {
  UNIT_CHOICES, amountText, categoryLabel, hasAmount, isOutOfStock, measureUnit, productUnits, seededAmount, stockHolds,
} from '../../lib/fast-complete-products';
import { submittedAmount } from '../../lib/measure-units';
import { WarningIcon } from './FastCompleteProductPicker';
import {
  AmountEntry, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, SavedView,
  SheetHeader, VisitNote, toggleInSet, useProductPicker, visitChangedSinceSchedule,
} from './FastCompleteParts';
import { Button, ActionFeedback, Input, cn } from '../ui';
import '../../styles/tech-workflow.css';

// The typed form's option lists (server/services/project-types.js
// one_time_lawn_treatment findingsFields): the server rejects any value outside
// them. The sheet's test pins these against the server's lists.
export const TURF_ISSUE_OPTIONS = [
  'Chinch bug damage', 'Sod webworm signs', 'Armyworm signs', 'Grub activity',
  'Large patch', 'Gray leaf spot', 'Dollarweed', 'Sedge', 'Crabgrass',
  'Broadleaf weeds', 'Drought stress', 'Scalping', 'Excess shade', 'Compaction', 'Pet damage',
];
export const WEED_PRESSURE_OPTIONS = ['None observed', 'Light', 'Moderate', 'Heavy'];
export const LAWN_CONDITION_OPTIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Recovering', 'Stressed'];

// The completion text the full typed form posts by default for this visit
// (SchedulePage: sendSms starts true; includePayLink is true whenever there is
// no invoice to link). The review ask is the one flag that differs: the owner
// kept it off re-services (the pest sheet's rule), so it is false here.
const CUSTOMER_TEXT_FLAGS = { sendCompletionSms: true, requestReview: false, includePayLink: true };

// A product on the sheet. `last` is the amount the server says the last lawn
// visit recorded: the only thing an amount ever starts from, in the unit it
// was recorded in. Anything else leaves it blank for the tech.
function productRow(product, { last = null, added = false, ctx }) {
  const own = productUnits(product, { method: '' });
  const lastAmount = Number(last?.totalAmount);
  // Read last time's unit in the product's own measure first: a bare "oz" is a
  // fluid ounce for a liquid and a weight ounce for a dry product. Only a unit
  // that belongs to another measure (a "lb" on a liquid row) moves the row.
  const lastDimension = measureUnit(last?.amountUnit, own.dimension)
    ? own.dimension
    : Object.keys(UNIT_CHOICES).find((name) => measureUnit(last?.amountUnit, name));
  let dimension = own.dimension;
  let seeded = { amount: '', unit: own.unit };
  if (lastDimension && lastAmount > 0) {
    dimension = lastDimension;
    seeded = seededAmount(lastAmount, measureUnit(last.amountUnit, lastDimension));
  }
  // The recorded method, only when the server offers it; otherwise none.
  const method = ctx.methods.some((choice) => choice.value === last?.method) ? last.method : '';
  // The area that product recorded last time, in square feet only.
  const areaLast = last?.areaUnit === 'sqft' && Number(last.areaValue) > 0 ? Number(last.areaValue) : null;
  return withAreaSeed({
    product,
    productId: product.id,
    name: product.name,
    added,
    active: false,
    dimension,
    totalAmount: seeded.amount,
    amountUnit: seeded.unit,
    fromLast: seeded.amount !== '',
    method,
    areaLast,
    area: '',
    areaFrom: '',
  }, ctx);
}

const methodChoice = (ctx, value) => ctx.methods.find((choice) => choice.value === value) || null;
const needsSqft = (ctx, row) => methodChoice(ctx, row.method)?.requiresSqft === true;

// A row whose method needs square feet and has none yet starts from a fact:
// what the product recorded last time, else the property's lawn size. Nothing
// else is ever filled in; the tech's own entry is never replaced.
function withAreaSeed(row, ctx) {
  if (!needsSqft(ctx, row) || row.area !== '') return row;
  if (row.areaLast) return { ...row, area: String(row.areaLast), areaFrom: 'last time' };
  if (Number(ctx.lawnSqft) > 0) return { ...row, area: String(Number(ctx.lawnSqft)), areaFrom: 'lawn size' };
  return row;
}

// Why the live context can't be completed here, or '' when it can.
function blockedReasonFor(data, service) {
  const visit = data?.service || {};
  if (visitChangedSinceSchedule(visit, service)) return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  if (data?.eligible !== true) return 'This visit needs the full form.';
  return '';
}

// The suggestion rows: what the last lawn visit recorded, each starting off.
// The server already dropped products the catalog no longer has.
function lastVisitRows(products, lastVisit, ctx) {
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const seen = new Set();
  const rows = [];
  for (const item of Array.isArray(lastVisit?.products) ? lastVisit.products : []) {
    const id = String(item?.productId);
    const product = byId.get(id);
    if (!product || seen.has(id)) continue;
    seen.add(id);
    rows.push(productRow(product, { last: item, ctx }));
  }
  return rows;
}

// Reasons that are a failed read, not this visit's eligibility: a retry fixes them.
const RETRYABLE_REASONS = new Set(['catalog_unavailable', 'profile_unavailable']);

const EMPTY_CONTEXT = {
  loading: true, loadError: '', blockedReason: '', rows: [], products: [], methods: [], lawnSqft: null, lastVisit: null, customerRequest: null,
  visitIdentity: null, visit: null,
};

// What decides a row's method and area: the server's offered methods and the
// property's lawn size (a positive number, else none).
function methodContext(data) {
  return {
    methods: (Array.isArray(data?.methods) ? data.methods : []).filter((choice) => choice?.value),
    lawnSqft: Number(data?.lawnSqft) > 0 ? Number(data.lawnSqft) : null,
  };
}

function contextFrom(data, service) {
  if (data?.eligible !== true && RETRYABLE_REASONS.has(data?.reason)) {
    return { ...EMPTY_CONTEXT, loading: false, loadError: 'Couldn’t load this visit’s products. Try again.' };
  }
  const products = (Array.isArray(data?.products) ? data.products : []).filter(Boolean);
  const base = methodContext(data);
  return {
    loading: false,
    loadError: '',
    blockedReason: blockedReasonFor(data, service),
    visit: data?.service || {},
    products,
    ...base,
    rows: lastVisitRows(products, data?.lastVisit, base),
    lastVisit: data?.lastVisit && typeof data.lastVisit === 'object' ? data.lastVisit : null,
    customerRequest: data?.customerRequest && typeof data.customerRequest === 'object' ? data.customerRequest : null,
    visitIdentity: recapVisitIdentity(data?.service),
  };
}

function useLawnContext({ base, request, service }) {
  const [ctx, setCtx] = useState(EMPTY_CONTEXT);
  // Bumped by Try again: the same read, run once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setCtx(EMPTY_CONTEXT);
    request(`${base}/lawn-reservice/fast-context`)
      .then((data) => { if (active) setCtx(contextFrom(data, service)); })
      .catch((err) => {
        if (!active) return;
        // 404 {enabled:false}: the gate is off. 409: no longer a lawn re-service.
        if (err?.status === 404 || err?.status === 409) setCtx((prev) => ({ ...prev, loading: false, blockedReason: 'This visit needs the full form.' }));
        else setCtx((prev) => ({ ...prev, loading: false, loadError: err?.message || 'Failed to load this visit' }));
      });
    return () => { active = false; };
  }, [base, request, attempt, service?.routedCustomerId, service?.routedScheduledDate, service?.routedPropertyId, service?.routedAddress]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // The stock on hand the server has now, for a product restocked while the
  // sheet is open; nothing else is re-read. Resolves to the fresh rows by id.
  const refreshStock = useCallback(async () => {
    const data = await request(`${base}/lawn-reservice/fast-context`);
    return new Map((Array.isArray(data?.products) ? data.products : []).map((product) => [String(product.id), product]));
  }, [base, request]);
  return { ...ctx, retry, refreshStock };
}

// The tech's own taps on the sheet's products. One product, one row.
function useProductRows(ctx) {
  const [rows, setRows] = useState(ctx.rows);
  const lastAmounts = useMemo(() => {
    const amounts = {};
    for (const p of Array.isArray(ctx.lastVisit?.products) ? ctx.lastVisit.products : []) {
      if (p?.productId != null && Number(p.totalAmount) > 0 && p.amountUnit) amounts[String(p.productId)] = p;
    }
    return amounts;
  }, [ctx.lastVisit]);
  const updateRow = useCallback((productId, patch) => {
    setRows((prev) => prev.map((row) => {
      if (row.productId !== productId) return row;
      const next = {
        ...row,
        ...patch,
        // An amount the tech changed is no longer last time's; an area the
        // tech typed is no longer a fact the sheet filled in.
        ...('totalAmount' in patch || 'amountUnit' in patch ? { fromLast: false } : {}),
        ...('area' in patch ? { areaFrom: '' } : {}),
      };
      return 'method' in patch ? withAreaSeed(next, ctx) : next;
    }));
  }, [ctx]);
  const addProduct = useCallback((product) => {
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      { ...productRow(product, { last: lastAmounts[String(product.id)] || null, added: true, ctx }), active: true },
    ]));
  }, [lastAmounts, ctx]);
  const removeRow = useCallback((productId) => setRows((prev) => prev.filter((row) => row.productId !== productId)), []);
  // A fresh stock read changes each row's stock on hand, nothing the tech set.
  const applyStock = useCallback((fresh) => {
    setRows((prev) => prev.map((row) => {
      const latest = fresh.get(String(row.productId));
      return latest ? { ...row, product: { ...row.product, inventory_on_hand: latest.inventory_on_hand, inventory_unit: latest.inventory_unit } } : row;
    }));
  }, []);
  return { rows, updateRow, addProduct, removeRow, applyStock };
}

const inOptionOrder = (options, set) => options.filter((option) => set.has(option)).join(', ');

function missingRequirement({ form, rows, ctx, dictationPending }) {
  const active = rows.filter((row) => row.active);
  const outOfStock = active.find((row) => stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const missingAmount = active.find((row) => !hasAmount(row));
  // Every active row needs the method the tech used, and square feet when that
  // method needs them. Nothing is defaulted.
  const missingMethod = active.find((row) => !methodChoice(ctx, row.method));
  const missingArea = active.find((row) => needsSqft(ctx, row) && !(Number(row.area) > 0));
  const [, reason = ''] = [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [!active.length, 'Select at least one product.'],
    [outOfStock, outOfStock && `${outOfStock.name} shows 0 in stock. Update inventory, then tap Check stock.`],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [missingMethod, missingMethod && `Pick how ${missingMethod.name} went down.`],
    [missingArea, missingArea && `Enter the square feet treated for ${missingArea.name}.`],
    [!form.issues.size, 'Select what you treated for.'],
    [!form.pressure, 'Select the weed pressure.'],
    [!form.condition, 'Select the lawn condition.'],
  ].find(([missing]) => missing) || [];
  return reason;
}

function completionBody({ form, rows, ctx }) {
  return {
    visitOutcome: 'completed',
    ...(ctx.visitIdentity ? { expectedVisit: ctx.visitIdentity } : {}),
    products: rows.filter((row) => row.active).map((row) => {
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      return {
        productId: row.productId,
        applicationMethod: row.method,
        totalAmount,
        amountUnit,
        targets: [],
        // Only a method /complete needs an area for sends one.
        ...(needsSqft(ctx, row) ? { areaValue: Number(row.area), areaUnit: 'sqft' } : {}),
      };
    }),
    structuredFindings: {
      type: 'one_time_lawn_treatment',
      values: {
        lawn_condition: form.condition,
        weed_pressure: form.pressure,
        turf_issues: inOptionOrder(TURF_ISSUE_OPTIONS, form.issues),
      },
    },
    technicianNotes: form.note.trim(),
    ...CUSTOMER_TEXT_FLAGS,
  };
}

export default function FastCompleteLawnReserviceSheet({ service, request, onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const ctx = useLawnContext({ base, request, service });
  const submission = useFastCompleteSubmit({ base, request });
  const { submitting, done } = submission;
  // A recorded dictation clip is still being taken or transcribed. The full
  // form is another page and carries nothing over, so Full form and "+ Other
  // product" wait for it, like Complete.
  const [dictationPending, setDictationPending] = useState(false);

  // Any dismissal the schedule may be stale for asks the parent to refresh: a
  // sheet blocked on a stale or changed visit, or an attempt whose outcome is
  // unknown or refused (it may have saved).
  const close = useCallback(() => {
    if (submitting) return;
    if (done) onCompleted?.();
    else onClose?.(ctx.blockedReason || submission.failure ? { refresh: true } : undefined);
  }, [submitting, done, ctx.blockedReason, submission.failure, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved or refused for
  // good; the full form can't resume a /complete attempt.
  const locked = submitting || submission.failure !== null;

  return (
    <FastCompleteFrame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} onDismiss={close}>
      <SheetHeader titleId={titleId} title={done ? 'Lawn re-service complete' : 'Complete lawn re-service'} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, ctx, submission, locked, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile }) {
  if (submission.done) return <SavedView service={service} summary={submission.done.summary} onCompleted={onCompleted} />;
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  if (ctx.loadError) {
    return (
      <div className="tech-visit-body">
        <ActionFeedback error className="tech-visit-feedback tech-visit-loading">{ctx.loadError}</ActionFeedback>
        <div className="tech-visit-actions">
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={ctx.retry}>Try again</Button>
        </div>
      </div>
    );
  }
  if (ctx.blockedReason) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">{ctx.blockedReason}</ActionFeedback>;
  return <LawnForm service={service} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={onDictationPending} onFullForm={onFullForm} isMobile={isMobile} />;
}

function LawnForm({ ctx, service, submission, locked, dictationPending, onDictationPending, onFullForm, isMobile }) {
  const products = useProductRows(ctx);
  const { rows } = products;
  const [form, setForm] = useState({ note: '', issues: new Set(), pressure: '', condition: '' });
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);
  const picker = useProductPicker({
    products: ctx.products,
    commonProducts: [],
    rows,
    locked: locked || dictationPending,
    isMobile,
    onFullForm,
    onPick: products.addProduct,
  });

  const missingReason = missingRequirement({ form, rows, ctx, dictationPending });
  // "Update inventory, then tap Check stock": the tech re-reads the stock here
  // instead of closing the sheet and losing the note and taps.
  const stockRow = rows.find((row) => row.active && stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const [checkingStock, setCheckingStock] = useState(false);
  const checkStock = async () => {
    setCheckingStock(true);
    try {
      products.applyStock(await ctx.refreshStock());
    } catch {
      // The hold stays; the tech can check again.
    }
    setCheckingStock(false);
  };
  const submit = () => {
    if (missingReason && !submission.hasPendingBody()) return;
    const names = rows.filter((row) => row.active).map((row) => row.name).join(', ');
    submission.submit(
      () => completionBody({ form, rows, ctx }),
      `${names} · ${inOptionOrder(TURF_ISSUE_OPTIONS, form.issues)}`,
    );
  };

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          <CustomerRequest request={ctx.customerRequest} />
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
          <ProductsSection ctx={ctx} products={products} locked={locked} other={picker.button} popover={picker.popover} />
          <ChoiceSection title="Treating for" columns={2}>
            {TURF_ISSUE_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.issues.has(label)} onClick={() => setField('issues', toggleInSet(form.issues, label))} />
            ))}
          </ChoiceSection>
          <ChoiceSection title="Pressure seen" columns={2}>
            {WEED_PRESSURE_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.pressure === label} onClick={() => setField('pressure', label)} />
            ))}
          </ChoiceSection>
          <ChoiceSection title="Lawn condition" columns={3}>
            {LAWN_CONDITION_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.condition === label} onClick={() => setField('condition', label)} />
            ))}
          </ChoiceSection>
        </fieldset>
        {submission.submitting && <ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
      </div>
      <CompleteFooter
        submission={submission}
        missingReason={missingReason}
        warn={!!stockRow}
        label="Complete lawn re-service"
        onSubmit={submit}
        coverProps={picker.coverProps}
      >
        {stockRow && !locked && (
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={checkingStock} onClick={checkStock}>Check stock</Button>
        )}
      </CompleteFooter>
      {picker.sheet}
    </div>
  );
}

// Why the customer booked the callback, in their words, when they gave any.
function CustomerRequest({ request }) {
  const text = String(request?.text || '').trim();
  const pests = Array.isArray(request?.pests) ? request.pests.filter(Boolean) : [];
  if (!text && !pests.length) return null;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">They said</h3>
      </div>
      {text && <p>{`“${text}”`}</p>}
      {pests.length > 0 && <p className="tech-visit-muted">{pests.join(', ')}</p>}
    </section>
  );
}

// The last lawn visit's products as suggestions, then anything the tech adds.
function ProductsSection({ ctx, products, locked, other, popover }) {
  const { rows, updateRow, removeRow } = products;
  const hint = ctx.lastVisit ? 'Tap what you applied' : 'Add what you applied';
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
        <span className="tech-visit-muted">{hint}</span>
      </div>
      {!rows.length && <p className="tech-visit-muted">No earlier lawn visit products on record. Add what you applied.</p>}
      <div className="tech-visit-tile-grid">
        {rows.map((row) => (
          <ProductTile key={row.productId} row={row} locked={locked} onClick={() => updateRow(row.productId, { active: !row.active })} />
        ))}
      </div>
      {rows.filter((row) => row.active).map((row) => (
        <ProductEditor key={row.productId} row={row} methods={ctx.methods} sqft={needsSqft(ctx, row)} locked={locked} onChange={(patch) => updateRow(row.productId, patch)} onRemove={() => removeRow(row.productId)} />
      ))}
      <OtherProductButton {...other} popover={popover} />
    </section>
  );
}

// A product tile names what goes on the record. A suggestion starts off.
function ProductTile({ row, locked, onClick }) {
  const outOfStock = row.active && isOutOfStock(row.product);
  let detail = 'Tap if applied';
  if (row.active) detail = hasAmount(row) ? amountText(row.totalAmount, row.amountUnit) : 'How much?';
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn('tech-visit-action tech-visit-product tech-visit-product-tile', {
        'tech-visit-product--off': !row.active,
        'tech-visit-product--added': row.added && row.active,
        'tech-visit-product--stock': outOfStock,
      })}
      disabled={locked}
      aria-pressed={row.active}
      onClick={onClick}
    >
      <span className="tech-visit-product-name">{row.name}</span>
      <span className="sr-only"> — </span>
      <span className="tech-visit-product-amount">{detail}</span>
      {outOfStock && (
        <>
          {' '}
          <span className="tech-visit-stock-flag"><WarningIcon />0 in stock</span>
        </>
      )}
    </Button>
  );
}

// An applied product: how much (blank until the tech enters it, or last
// time's amount, labeled), how it went down (the tech's tap), and the area
// when that method needs one.
function ProductEditor({ row, methods, sqft, locked, onChange, onRemove }) {
  const nameId = useId();
  const amountId = useId();
  const methodId = useId();
  const areaId = useId();
  return (
    <div role="group" aria-labelledby={nameId} className="tech-product-editor">
      <div className="tech-product-editor-head">
        <h4 id={nameId} className="tech-product-editor-name">{row.name}</h4>
        <span className="tech-visit-muted">{[categoryLabel(row.product), row.added ? 'added by you' : 'last visit'].filter(Boolean).join(' · ')}</span>
      </div>
      <AmountEntry id={amountId} row={row} locked={locked} onChange={onChange} />
      {row.fromLast && <p className="tech-visit-muted">last time</p>}
      <div>
        <span id={methodId} className="tech-product-editor-label">How</span>
        <div role="group" aria-labelledby={methodId} className="tech-visit-tile-grid">
          {methods.map((choice) => (
            <Chip disabled={locked} key={choice.value} label={choice.label} pressed={row.method === choice.value} onClick={() => onChange({ method: choice.value })} />
          ))}
        </div>
      </div>
      {sqft && (
        <div>
          <label htmlFor={areaId} className="tech-product-editor-label">Area treated (sq ft)</label>
          <Input
            id={areaId}
            className="tech-visit-control tech-product-amount-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            disabled={locked}
            value={row.area}
            onChange={(e) => onChange({ area: e.target.value })}
          />
          {row.areaFrom && <p className="tech-visit-muted">{row.areaFrom}</p>}
        </div>
      )}
      {row.added && (
        <div className="tech-product-editor-actions">
          <Button type="button" variant="secondary" className="tech-visit-action tech-product-remove" disabled={locked} onClick={onRemove}>Remove</Button>
        </div>
      )}
    </div>
  );
}
