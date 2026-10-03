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
import { isSendableRateUnit } from './FastCompleteSheet';
import { prefillRateCeiling, resolveRatePrefill } from '../../lib/product-rate-prefill';
import {
  LAWN_TARGET_SUGGESTIONS, NUTRITION_TARGET_SUGGESTIONS, productControlsTargets, productTargetsNutrition,
} from '../../lib/lawn-targets';
import {
  AmountEntry, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, RecoveredCompletion, SavedView,
  SheetHeader, VisitNote, toggleInSet, useProductPicker, visitChangedSinceSchedule,
} from './FastCompleteParts';
import { Button, ActionFeedback, Input, Select, cn } from '../ui';
import '../../styles/tech-workflow.css';

// The typed form's option lists (server/services/project-types.js
// one_time_lawn_treatment findingsFields): the server rejects any value outside
// them. The sheet's test pins these against the server's lists.
export const TURF_ISSUE_OPTIONS = [
  'Chinch bug damage', 'Sod webworm signs', 'Armyworm signs', 'Grub activity',
  'Large patch', 'Gray leaf spot', 'Dollarweed', 'Sedge', 'Crabgrass',
  'Broadleaf weeds', 'Drought stress', 'Scalping', 'Excess shade', 'Compaction', 'Pet damage',
];
// The Treating-for issues a product can be applied against, and the target
// name each records (service_products.targets → the compliance ledger's
// target_pest). Every name is one of the full form's LAWN_TARGET_SUGGESTIONS. The rest of the list (drought stress, scalping, shade,
// compaction, pet damage) are conditions, never an application's target.
const TARGET_NAME_BY_ISSUE = {
  'Chinch bug damage': 'Southern chinch bugs',
  'Sod webworm signs': 'Tropical sod webworms',
  'Armyworm signs': 'Fall armyworms',
  'Grub activity': 'White grubs',
  'Large patch': 'Large patch',
  'Gray leaf spot': 'Gray leaf spot',
  Dollarweed: 'Dollarweed',
  Sedge: 'Nutsedge / sedge',
  Crabgrass: 'Crabgrass',
  'Broadleaf weeds': 'Broadleaf weeds',
};
// The full completion form's own rules (lib/lawn-targets.js), never a second
// category policy: a fertilizer-family row records optional nutrition goals;
// any other target-bearing product (herbicide, insecticide, termiticide, bait,
// a product with no category, ...) must record what it was applied against;
// adjuvants, surfactants, soil products and growth regulators record none.
const isNutritionRow = (row) => productTargetsNutrition(row.product);
const isPesticideRow = (row) => !isNutritionRow(row) && productControlsTargets(row.product);
// The visit's selected issues a product can target, in option order.
const targetIssuesOf = (form) => TURF_ISSUE_OPTIONS.filter((issue) => TARGET_NAME_BY_ISSUE[issue] && form.issues.has(issue));
// A row's targets as sent: only issues still selected for the visit (a chip
// the tech later clears drops off every row).
const rowTargetIssues = (row, form) => targetIssuesOf(form).filter((issue) => (row.targets || []).includes(issue));
// Every target a pesticide row records, as canonical names: its picked
// Treating-for issues, then any other target picked on the row.
const rowTargetNames = (row, form) => [...new Set([
  ...rowTargetIssues(row, form).map((issue) => TARGET_NAME_BY_ISSUE[issue]),
  ...(row.otherTargets || []),
])];

// The targets a row sends: a pesticide row's required targets, a fertilizer
// row's optional purposes, nothing for anything else.
const rowSentTargets = (row, form) => {
  if (isPesticideRow(row)) return rowTargetNames(row, form);
  return isNutritionRow(row) ? row.purposes || [] : [];
};

// Where the work was done: the typed form's spot_treatment_areas options (the
// server rejects anything else). Sent as the findings value and as each product
// row's applicationArea, the way the pest sheet sends its Where.
export const AREA_OPTIONS = [
  'Entire lawn', 'Front lawn', 'Back lawn', 'Side lawns', 'Landscape beds',
  'Thin / stressed turf areas', 'Weed breakthrough areas', 'Insect activity areas',
  'Disease-affected areas', 'Along driveway / sidewalk', 'Fence line',
  'Slope / drainage area', 'Other',
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
    // The rate that visit recorded for this product, good only at that method.
    lastRate: !added && Number(last?.applicationRate) > 0
      ? { rate: Number(last.applicationRate), rateUnit: String(last.rateUnit || '').trim(), method: last.method || '' }
      : null,
    rateInput: null,
    otherTargets: [],
    // Fertilizer-family rows' optional nutrition goals (their targets).
    purposes: [],
    // Where this product went down: the row's own spot_treatment_areas chips.
    areas: [],
  }, ctx);
}

const methodChoice = (ctx, value) => ctx.methods.find((choice) => choice.value === value) || null;
const needsSqft = (ctx, row) => methodChoice(ctx, row.method)?.requiresSqft === true;

// The row's rate, the way the pest sheet resolves it (FastCompleteSheet rowRate)
// but for the lawn line and the row's own method. Order: what that product
// recorded last time (only while the row is on the method it was recorded at,
// labeled "last time"), then the catalog's label rate, else blank. The unit is
// the recorded one when /complete accepts it, else the label's own; a unit
// /complete would refuse (or one in mL) leaves the row without a rate. An
// added product has a rate only in its label's own unit and only what the tech
// types. A rate is never required: it is sent when it is above zero with a unit.
function rowRate(row) {
  const resolved = resolveRatePrefill(row.product, { applicationMethod: row.method, serviceLine: 'lawn' });
  const labelUnit = String(row.product?.default_unit || row.product?.rate_unit || '').trim();
  const labelRate = !(row.added && !labelUnit);
  const last = row.lastRate && row.lastRate.method === row.method && isSendableRateUnit(row.lastRate.rateUnit) ? row.lastRate : null;
  const rateUnit = last ? last.rateUnit : (labelRate && isSendableRateUnit(resolved.rateUnit) ? resolved.rateUnit : '');
  let prefill = '';
  let from = '';
  if (last) { prefill = String(last.rate); from = 'last time'; }
  else if (!row.added && Number(resolved.rate) > 0 && rateUnit) prefill = String(Number(resolved.rate));
  const max = prefillRateCeiling(resolved, row.product);
  return { rate: row.rateInput ?? prefill, rateUnit, max, from: row.rateInput == null ? from : '' };
}

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
  loading: true, loadError: '', blockedReason: '', rows: [], products: [], methods: [], lawnSqft: null, stockAdvisory: false, lastVisit: null, customerRequest: null,
  visitIdentity: null, visit: null,
};

// What decides a row's method and area: the server's offered methods and the
// property's lawn size (a positive number, else none).
function methodContext(data) {
  return {
    methods: (Array.isArray(data?.methods) ? data.methods : []).filter((choice) => choice?.value),
    lawnSqft: Number(data?.lawnSqft) > 0 ? Number(data.lawnSqft) : null,
    // WaveGuard lawn callbacks: the server records a 0-stock shortfall as an
    // advisory and completes, so the sheet shows the flag but never holds.
    stockAdvisory: data?.stockAdvisory === true,
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
      // A rate typed for one method doesn't carry to another.
      if ('method' in patch && patch.method !== row.method) next.rateInput = null;
      return 'method' in patch ? withAreaSeed(next, ctx) : next;
    }));
  }, [ctx]);
  // A product turned on with no Where yet starts from the first active row that
  // has one, as plain editable chips; they are never synced after that.
  const activate = useCallback((productId) => {
    setRows((prev) => {
      const seed = prev.find((row) => row.active && row.areas.length)?.areas || [];
      return prev.map((row) => (row.productId === productId
        ? { ...row, active: true, areas: row.areas.length ? row.areas : [...seed] }
        : row));
    });
  }, []);
  const addProduct = useCallback((product) => {
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      {
        ...productRow(product, { last: lastAmounts[String(product.id)] || null, added: true, ctx }),
        active: true,
        areas: [...(prev.find((row) => row.active && row.areas.length)?.areas || [])],
      },
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
  return { rows, updateRow, activate, addProduct, removeRow, applyStock };
}

const toggleInList = (list, value) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
const inOptionOrder = (options, set) => options.filter((option) => set.has(option)).join(', ');

function missingRequirement({ form, rows, ctx, dictationPending }) {
  const active = rows.filter((row) => row.active);
  const outOfStock = !ctx.stockAdvisory && active.find((row) => stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const missingAmount = active.find((row) => !hasAmount(row));
  // Every active row needs the method the tech used, and square feet when that
  // method needs them. Nothing is defaulted.
  const missingMethod = active.find((row) => !methodChoice(ctx, row.method));
  const missingArea = active.find((row) => needsSqft(ctx, row) && !(Number(row.area) > 0));
  // A pest-control product needs what it was applied against; nothing else does.
  const pesticideRows = active.filter(isPesticideRow);
  const missingTarget = pesticideRows.find((row) => !rowTargetNames(row, form).length);
  // Treating for (turf_issues) is optional visit context: the server does not
  // require it, and the application facts it would vouch for are each
  // pesticide row's own targets, required above. A fertilizer-only visit or
  // one whose targets come from Other target never has to invent an issue.
  const missingWhere = active.find((row) => !row.areas.length);
  const [, reason = ''] = [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [!active.length, 'Select at least one product.'],
    [outOfStock, outOfStock && `${outOfStock.name} shows 0 in stock. Update inventory, then tap Check stock.`],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [missingMethod, missingMethod && `Pick how ${missingMethod.name} went down.`],
    [missingArea, missingArea && `Enter the square feet treated for ${missingArea.name}.`],
    [missingTarget, missingTarget && `Pick what ${missingTarget.name} was for.`],
    [missingWhere, missingWhere && `Pick where ${missingWhere.name} went.`],
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
      const { rate, rateUnit } = rowRate(row);
      return {
        productId: row.productId,
        applicationMethod: row.method,
        totalAmount,
        amountUnit,
        // Where this product went down, comma-joined in option order.
        applicationArea: inOptionOrder(AREA_OPTIONS, new Set(row.areas)),
        // Only a rate the tech can see and /complete accepts.
        ...(Number(rate) > 0 && rateUnit ? { rate: Number(rate), rateUnit } : {}),
        // What this product was applied against, picked on its own row:
        // service_products.targets feeds the compliance ledger's target_pest
        // and the report's per-product facts. A non-pesticide row sends none.
        targets: rowSentTargets(row, form),
        // Only a method /complete needs an area for sends one.
        ...(needsSqft(ctx, row) ? { areaValue: Number(row.area), areaUnit: 'sqft' } : {}),
      };
    }),
    structuredFindings: {
      type: 'one_time_lawn_treatment',
      values: {
        lawn_condition: form.condition,
        weed_pressure: form.pressure,
        // Not a server-required field: omitted when no Treating-for chip is picked.
        ...(form.issues.size ? { turf_issues: inOptionOrder(TURF_ISSUE_OPTIONS, form.issues) } : {}),
        // The union of every active product's Where, in option order.
        spot_treatment_areas: inOptionOrder(AREA_OPTIONS, new Set(rows.filter((row) => row.active).flatMap((row) => row.areas))),
      },
    },
    technicianNotes: form.note.trim(),
    ...CUSTOMER_TEXT_FLAGS,
  };
}

export default function FastCompleteLawnReserviceSheet({ service, request, operatorId, onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const ctx = useLawnContext({ base, request, service });
  const submission = useFastCompleteSubmit({ base, request, serviceId: service?.id, operatorId });
  const { recovering, submitting, done } = submission;
  // A recorded dictation clip is still being taken or transcribed. The full
  // form is another page and carries nothing over, so Full form and "+ Other
  // product" wait for it, like Complete.
  const [dictationPending, setDictationPending] = useState(false);

  // Any dismissal the schedule may be stale for asks the parent to refresh: a
  // sheet blocked on a stale or changed visit, or an attempt whose outcome is
  // unknown or refused (it may have saved).
  const close = useCallback(() => {
    if (recovering || submitting) return;
    if (done) onCompleted?.();
    else onClose?.(ctx.blockedReason || submission.failure ? { refresh: true } : undefined);
  }, [recovering, submitting, done, ctx.blockedReason, submission.failure, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved or refused for
  // good; the full form can't resume a /complete attempt.
  const locked = recovering || submitting || submission.failure !== null;

  return (
    <FastCompleteFrame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} onDismiss={close}>
      <SheetHeader titleId={titleId} title={done ? 'Lawn re-service complete' : 'Complete lawn re-service'} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, ctx, submission, locked, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile }) {
  if (submission.done) return <SavedView service={service} summary={submission.done.summary} notice={submission.done.notice} onCompleted={onCompleted} />;
  if (submission.recovering) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Checking for an unfinished completion…</ActionFeedback>;
  if (submission.restored) return <RecoveredCompletion submission={submission} />;
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
  // Clearing a Treating-for chip also clears it as a target on every product
  // row, so picking it again never revives an old per-row choice.
  const toggleIssue = (label) => {
    if (form.issues.has(label)) {
      for (const row of products.rows) {
        if ((row.targets || []).includes(label)) products.updateRow(row.productId, { targets: row.targets.filter((item) => item !== label) });
      }
    }
    setField('issues', toggleInSet(form.issues, label));
  };
  const { rows } = products;
  const [form, setForm] = useState({ note: '', issues: new Set(), pressure: '', condition: '' });
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);
  const lastVisitCommon = useMemo(() => (Array.isArray(ctx.lastVisit?.products) ? ctx.lastVisit.products : [])
    .map((p) => ({ productId: p.productId, usualUnit: p.amountUnit || null, usualAmount: p.totalAmount ?? null })), [ctx.lastVisit]);
  const picker = useProductPicker({
    line: 'lawn',
    products: ctx.products,
    // The last lawn visit's products lead the picker, with their recorded amount.
    commonProducts: lastVisitCommon,
    rows,
    locked: locked || dictationPending,
    isMobile,
    onFullForm,
    onPick: products.addProduct,
  });

  const missingReason = missingRequirement({ form, rows, ctx, dictationPending });
  // "Update inventory, then tap Check stock": the tech re-reads the stock here
  // instead of closing the sheet and losing the note and taps.
  const stockRow = !ctx.stockAdvisory && rows.find((row) => row.active && stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
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
      [names, inOptionOrder(TURF_ISSUE_OPTIONS, form.issues)].filter(Boolean).join(' · '),
    );
  };

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          <CustomerRequest request={ctx.customerRequest} />
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
          <ProductsSection ctx={ctx} form={form} products={products} locked={locked} other={picker.button} popover={picker.popover} />
          <ChoiceSection title="Treating for" columns={2}>
            {TURF_ISSUE_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.issues.has(label)} onClick={() => toggleIssue(label)} />
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
function ProductsSection({ ctx, form, products, locked, other, popover }) {
  const { rows, updateRow, activate, removeRow } = products;
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
          <ProductTile key={row.productId} row={row} locked={locked} onClick={() => (row.active ? updateRow(row.productId, { active: false }) : activate(row.productId))} />
        ))}
      </div>
      {rows.filter((row) => row.active).map((row) => (
        <ProductEditor key={row.productId} row={row} methods={ctx.methods} sqft={needsSqft(ctx, row)} targetIssues={isPesticideRow(row) ? targetIssuesOf(form) : null} rate={rowRate(row)} locked={locked} onChange={(patch) => updateRow(row.productId, patch)} onRemove={() => removeRow(row.productId)} />
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
// time's amount, labeled), then one section per fact the record needs: how it
// went down, the rate, what it was for, the area and where.
function ProductEditor({ row, methods, sqft, targetIssues, rate, locked, onChange, onRemove }) {
  const nameId = useId();
  const amountId = useId();
  const part = { row, locked, onChange };
  return (
    <div role="group" aria-labelledby={nameId} className="tech-product-editor">
      <div className="tech-product-editor-head">
        <h4 id={nameId} className="tech-product-editor-name">{row.name}</h4>
        <span className="tech-visit-muted">{[categoryLabel(row.product), row.added ? 'added by you' : 'last visit'].filter(Boolean).join(' · ')}</span>
      </div>
      <AmountEntry id={amountId} row={row} locked={locked} onChange={onChange} />
      {row.fromLast && <p className="tech-visit-muted">last time</p>}
      <RateSection {...part} rate={rate} />
      <MethodSection {...part} methods={methods} />
      {targetIssues && <TargetsSection {...part} targetIssues={targetIssues} />}
      {!targetIssues && isNutritionRow(row) && <PurposeSection {...part} />}
      {sqft && <SqftSection {...part} />}
      <WhereSection {...part} />
      {row.added && (
        <div className="tech-product-editor-actions">
          <Button type="button" variant="secondary" className="tech-visit-action tech-product-remove" disabled={locked} onClick={onRemove}>Remove</Button>
        </div>
      )}
    </div>
  );
}

function RateSection({ row, rate, locked, onChange }) {
  const rateId = useId();
  if (!rate.rateUnit) return null;
  const overLabel = rate.max != null && parseFloat(rate.rate) > rate.max;
  return (
    <div>
      <label htmlFor={rateId} className="tech-product-editor-label">{`${row.name} rate`}</label>
      <div className="tech-product-editor-amount">
        <Input
          id={rateId}
          className="tech-visit-control tech-product-amount-input"
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          disabled={locked}
          value={rate.rate ?? ''}
          onChange={(e) => onChange({ rateInput: e.target.value })}
        />
        <span className="tech-visit-muted">{String(rate.rateUnit).replace(/_/g, ' ')}</span>
      </div>
      {rate.from && <p className="tech-visit-muted">{rate.from}</p>}
      {overLabel && <p className="tech-visit-warning" role="status">&gt; label max {rate.max}</p>}
    </div>
  );
}

function MethodSection({ row, methods, locked, onChange }) {
  const methodId = useId();
  // An older context without `common` shows every method as a button.
  const hasCommon = methods.some((choice) => choice.common);
  const common = hasCommon ? methods.filter((choice) => choice.common) : methods;
  const more = hasCommon ? methods.filter((choice) => !choice.common) : [];
  return (
    <div>
      <span id={methodId} className="tech-product-editor-label">How</span>
      <div role="group" aria-labelledby={methodId} className="tech-visit-tile-grid">
        {common.map((choice) => (
          <Chip disabled={locked} key={choice.value} label={choice.label} pressed={row.method === choice.value} onClick={() => onChange({ method: choice.value })} />
        ))}
      </div>
      {more.length > 0 && (
        <Select
          aria-label={`More methods for ${row.name}`}
          className="tech-visit-control"
          disabled={locked}
          value={more.some((choice) => choice.value === row.method) ? row.method : ''}
          onChange={(e) => { if (e.target.value) onChange({ method: e.target.value }); }}
        >
          <option value="">More methods</option>
          {more.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
        </Select>
      )}
      <p className="tech-visit-muted">Perimeter spray? Use Full form.</p>
    </div>
  );
}

// A pesticide row's required targets: the visit's Treating-for issues as chips,
// plus any other target the full form offers as a removable chip.
function TargetsSection({ row, targetIssues, locked, onChange }) {
  const forId = useId();
  const others = row.otherTargets || [];
  return (
    <div>
      <span id={forId} className="tech-product-editor-label">For</span>
      <div role="group" aria-labelledby={forId} className="tech-visit-tile-grid">
        {targetIssues.map((issue) => (
          <Chip disabled={locked} key={issue} label={issue} pressed={(row.targets || []).includes(issue)} onClick={() => onChange({ targets: toggleInList(row.targets || [], issue) })} />
        ))}
      </div>
      <div role="group" aria-label={`Other targets for ${row.name}`} className="tech-visit-tile-grid">
        {others.map((name) => (
          <Chip disabled={locked} key={name} label={name} pressed onClick={() => onChange({ otherTargets: others.filter((item) => item !== name) })} />
        ))}
      </div>
      <Select
        aria-label={`Other target for ${row.name}`}
        className="tech-visit-control"
        disabled={locked}
        value=""
        onChange={(e) => {
          const name = e.target.value;
          if (name && !others.includes(name)) onChange({ otherTargets: [...others, name] });
        }}
      >
        <option value="">Other target</option>
        {LAWN_TARGET_SUGGESTIONS.map((name) => <option key={name} value={name}>{name}</option>)}
      </Select>
    </div>
  );
}

// A fertilizer-family row's optional nutrition goals, sent as its targets.
function PurposeSection({ row, locked, onChange }) {
  const purposeId = useId();
  const purposes = row.purposes || [];
  return (
    <div>
      <span id={purposeId} className="tech-product-editor-label">Purpose (optional)</span>
      <div role="group" aria-labelledby={purposeId} className="tech-visit-tile-grid">
        {NUTRITION_TARGET_SUGGESTIONS.map((goal) => (
          <Chip disabled={locked} key={goal} label={goal} pressed={purposes.includes(goal)} onClick={() => onChange({ purposes: toggleInList(purposes, goal) })} />
        ))}
      </div>
    </div>
  );
}

function SqftSection({ row, locked, onChange }) {
  const areaId = useId();
  return (
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
  );
}

// Where this product went down: its own chips, required, never synced from
// another row once the row exists.
function WhereSection({ row, locked, onChange }) {
  const whereId = useId();
  return (
    <div>
      <span id={whereId} className="tech-product-editor-label">Where</span>
      <div role="group" aria-labelledby={whereId} className="tech-visit-tile-grid">
        {AREA_OPTIONS.map((label) => (
          <Chip disabled={locked} key={label} label={label} pressed={row.areas.includes(label)} onClick={() => onChange({ areas: toggleInList(row.areas, label) })} />
        ))}
      </div>
    </div>
  );
}
