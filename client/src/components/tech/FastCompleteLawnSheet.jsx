// client/src/components/tech/FastCompleteLawnSheet.jsx
//
// Fast Complete for LAWN visits (GATE_LAWN_FAST_COMPLETE; lawn report rebuild
// Phase 5, plan PR-D). A lawn visit is a quick job: photos, one pass, done.
// It shares its frame, header, saved view, note, tip picker, amount rows,
// product picker and footer with the pest, Tree & Shrub and lawn re-service
// sheets (FastCompleteParts.jsx) and their /complete submit
// (hooks/useFastCompleteSubmit.js).
//
// Admin Dispatch mounts it (the technician portal is being retired). Every
// lawn visit type may open it. A recurring program visit starts with the
// plan's products already on, amounts filled; any other visit starts with no
// products. The sheet sends no customer message of its own: completion runs
// the existing flow with the full form's default text flags.
//
// What blocks Complete is only what the server enforces, said in plain words
// at the foot of the sheet:
//  - a CONFIRMED lawn assessment (photos, Analyze lawn, then confirm what the
//    read found: the shared LawnAssessmentCompletionBlock, the same step the
//    full form uses, including its evidence review);
//  - square feet for a sprayed or spread product (the server refuses a
//    broadcast row without them);
//  - the lawn condition on a one-time lawn visit (typed findings the server
//    requires);
//  - a mowing height outside 0.5 to 8 inches when one is typed.
// The photo minimum is a hint only. A product with no amount is noted, never
// blocked.
//
// The submit echoes the context back (GET /admin/dispatch/:id/lawn-fast/
// context): `expectedVisit` is the context's WHOLE `service` object,
// `lawnFast.visitType` its visit type, `lawnAssessmentId` the confirmed
// assessment. A visit the server calls ineligible (or 404/409 on the context)
// hands over to the full form, as it always opened before.
//
// Watering: POST .../lawn-fast/watering-preview, debounced, shows what the
// customer report would say for the products picked.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import LawnAssessmentCompletionBlock from '../lawn/LawnAssessmentCompletionBlock';
import { LAWN_FINDINGS_TYPE } from '../../lib/lawn-fast-complete';
import { detectServiceCategory } from '../../lib/service-colors';
import { LAWN_DEFAULT_AREAS } from '../../lib/lawn-completion';
import { defaultApplicationMethodForLine, normalizeApplicationMethod } from '../../lib/product-rate-prefill';
import {
  UNIT_CHOICES, amountText, categoryLabel, hasAmount, measureUnit, productUnits, seededAmount, stockHolds,
} from '../../lib/fast-complete-products';
import { submittedAmount } from '../../lib/measure-units';
import {
  AmountRow, CLOSED_VISIT_STATUSES, isSendableRateUnit, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, ProductTileButton,
  SavedView, SheetHeader, TipSection, VisitNote, methodLabel, techTipsOf, unitLabel, useProductPicker, useTipLibrary, visitChangedSinceSchedule, withFreshStock,
} from './FastCompleteParts';
import { Button, ActionFeedback, Input } from '../ui';
import '../../styles/tech-workflow.css';

// The one-time lawn form's condition list (project-types.js
// one_time_lawn_treatment lawn_condition). The sheet's test pins it to the
// server's list.
export const LAWN_CONDITION_OPTIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Recovering', 'Stressed'];

// How a lawn product went down, as the "How" chips offer it. A row can also
// carry another method from the plan or the catalog; it shows as its own chip.
const METHOD_CHOICES = [
  { value: 'broadcast_spray', label: 'Broadcast spray' },
  { value: 'granular_broadcast', label: 'Granular' },
  { value: 'spot_treatment', label: 'Spot treatment' },
];
// THE table of what /complete requires per application method for a lawn
// product (complete-scheduled-service.js, the service_products loop):
//  - perimeter_spray: positive linear feet, areaUnit 'linear_ft'
//    (requiresLinearFtForReportApplication, error linear_ft_required);
//  - broadcast_spray, granular_broadcast: positive square feet, areaUnit 'sqft'
//    (requiresSqftForReportApplication on the lawn line, error area_sqft_required);
//  - every other method (spot_treatment, soil_drench, foliar_spray, bait_placement,
//    station_check, fog_ulv, trunk_injection, pin_stream): nothing.
// A row's method is normalized the way the server normalizes it, so a raw
// catalog value ("Broadcast", "perimeter band") lands on the same entry. The
// footer reason, the area box and the body all read this one table.
export const METHOD_REQUIREMENTS = {
  perimeter_spray: { unit: 'linear_ft', label: 'Linear feet treated', noun: 'linear feet' },
  broadcast_spray: { unit: 'sqft', label: 'Area treated (sq ft)', noun: 'square feet' },
  granular_broadcast: { unit: 'sqft', label: 'Area treated (sq ft)', noun: 'square feet' },
};
export const requirementOf = (row) => METHOD_REQUIREMENTS[normalizeApplicationMethod(row.method)] || null;
const needsArea = (row) => requirementOf(row) !== null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Real WaveGuard member tiers (complete-scheduled-service.js isWaveGuardLawnCompletion).
const WAVEGUARD_TIERS = new Set(['Bronze', 'Silver', 'Gold', 'Platinum']);

// Mowing height the server accepts (turf_height_invalid outside it).
const MIN_HEIGHT_IN = 0.5;
const MAX_HEIGHT_IN = 8;

// The completion text the full form posts by default (SchedulePage: send the
// text, ask for the review on its automatic timing, include the pay link).
const CUSTOMER_TEXT_FLAGS = { sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' };

// ── plain words for the server's refusals ───────────────────────────────────
// The shared submit hook sorts each failure (saved, correctable, retry,
// terminal) by status and code; these only replace the words the tech reads.
const PROPERTY_CHECK_MESSAGE = 'We could not check this lawn assessment against this visit. Try again, or retake the photos and confirm again.';
const STOCK_LOCKOUT_MESSAGE = 'A product is out of stock. Update inventory, tap Check stock, then complete again.';
const PROPERTY_SCOPE_MESSAGE = 'This lawn check was made for a different property than this visit. Retake the photos, then analyze and confirm again.';
const REFUSAL_MESSAGES = {
  lawn_fast_disabled: 'The quick lawn sheet is off right now. Open the full form.',
  lawn_fast_not_eligible: 'This visit needs the full form.',
  visit_identity_changed: 'This visit changed since you opened it. Close it and open it again from the schedule.',
  lawn_fast_expected_visit_required: 'Close this sheet and open the visit again from the schedule. The sheet must confirm it is the same visit.',
  lawn_fast_assessment_required: 'Analyze the lawn photos and confirm the assessment first.',
  lawn_assessment_unconfirmed: 'Confirm the lawn assessment, then tap Complete again.',
  completion_profile_lookup_failed: 'We could not check this visit type.',
  lawn_fast_visit_type_unavailable: 'We could not check this visit type.',
  lawn_fast_not_found: 'This visit was not found. Close the sheet and reload the schedule.',
  typed_findings_required: 'This visit needs the full form.',
  area_sqft_required: 'Enter the square feet treated for each sprayed or spread product.',
  linear_ft_required: 'Enter the linear feet treated for each perimeter product.',
  waveguard_inventory_lockout: STOCK_LOCKOUT_MESSAGE,
};

export function plainRefusalMessage(err) {
  if (err?.code === 'lawn_fast_assessment_required' && (err?.details?.reason === 'property_scope' || err?.reason === 'property_scope')) {
    return PROPERTY_SCOPE_MESSAGE;
  }
  return REFUSAL_MESSAGES[err?.code] || null;
}

// The request the submit hook uses: same call, but a refusal the server named
// carries the sheet's plain message (status and code stay, so the hook sorts it
// as it always does).
function plainErrors(request) {
  return async (path, options) => {
    try {
      return await request(path, options);
    } catch (err) {
      const message = plainRefusalMessage(err);
      if (message && err) err.message = message;
      throw err;
    }
  };
}

// ── context ─────────────────────────────────────────────────────────────────

// Reasons that are a failed read, not this visit's eligibility: a retry fixes them.
const RETRYABLE_REASONS = new Set(['profile_unavailable']);

const EMPTY_CONTEXT = {
  loading: true, loadError: '', blockedReason: '', handoff: false, visit: null, raw: null,
  visitType: null, turfHeightCapture: false, planned: [], plannedUnavailable: null, assessment: null, photoStatus: null,
  findingsType: null, stockAdvisory: undefined,
};

// Why the live context can't be completed here, or '' when it can.
function blockedReasonFor(data, service) {
  const visit = data?.service || {};
  if (visitChangedSinceSchedule(visit, service) || serviceChangedSinceSchedule(visit, service)) return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  return '';
}

const plannedItemsOf = (data) => (Array.isArray(data?.plannedProducts?.items) ? data.plannedProducts.items.filter((item) => item?.productId) : []);
const assessmentOf = (data) => (data?.assessment && typeof data.assessment === 'object' ? data.assessment : { exists: false, id: null, confirmed: false });

const LOAD_ERROR = 'Couldn’t load this visit. Try again.';

// What each entry of the context's `readFailures` means for the sheet:
//  - billing_mode: the visit type could not be read (`visitType: 'unknown'`). No
//    submit can succeed (503 while the read fails, visit_identity_changed once it
//    recovers), so it is a retryable load failure and the form is not shown.
//  - assessment: the latest assessment could not be read. Advisory: the photo step
//    looks the assessment up itself, and the server checks it again at submit.
//  - assessment_property_check: the context marks any confirmed assessment
//    unusable (`unusableReason: 'property_check_failed'`); the sheet will not send
//    it and asks for a retake.
//  - planned_products: the planned list is empty and `plannedProductsUnavailable`
//    says so; the sheet shows a note and the technician adds what was applied.
//  - photo_status and turf_height_flag: advisory only (no photo hint; no height box).
// Every other failure is a thrown read (HTTP 500) and is a load error already.
function visitTypeUnreadable(data) {
  const failures = Array.isArray(data?.readFailures) ? data.readFailures : [];
  return !data?.visitType || data.visitType === 'unknown' || failures.includes('billing_mode');
}

// `findingsType` decides the lawn-condition requirement, from the context ONLY.
// null means "no typed findings" (a recurring visit) and is a real answer; the
// KEY being absent (`'findingsType' in data` is false) means an older server
// during a deploy, and the sheet cannot decide, so the full form opens.
// `stockAdvisory`, when the context carries it, wins over the schedule row.
const findingsTypeUndecidable = (data) => !('findingsType' in data)
  || (data.findingsType !== null && data.findingsType !== LAWN_FINDINGS_TYPE);
const optionalContextFields = (data) => ({
  findingsType: data.findingsType ?? null,
  stockAdvisory: typeof data?.stockAdvisory === 'boolean' ? data.stockAdvisory : undefined,
});

const sameText = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
// The visit's service type or catalog service differs from the row the tech
// tapped (the office changed it since the schedule loaded). A routed value that
// is absent gives no verdict, as the shared property check does.
function serviceChangedSinceSchedule(visit, service) {
  const type = service?.routedServiceType;
  const catalog = service?.routedCatalogServiceId;
  return !!((type != null && visit?.serviceType != null && !sameText(type, visit.serviceType))
    || (catalog != null && visit?.catalogServiceId != null && String(catalog) !== String(visit.catalogServiceId)));
}

function contextFrom(data, service) {
  if (data?.eligible !== true && RETRYABLE_REASONS.has(data?.reason)) {
    return { ...EMPTY_CONTEXT, loading: false, loadError: LOAD_ERROR };
  }
  const blockedReason = blockedReasonFor(data, service);
  // The server says this visit does not use the quick sheet: the full form opens.
  if (data?.eligible !== true && !blockedReason) return { ...EMPTY_CONTEXT, loading: false, handoff: true };
  // An older server that does not say the findings type: hand over, never guess.
  if (!blockedReason && data?.eligible === true && findingsTypeUndecidable(data)) return { ...EMPTY_CONTEXT, loading: false, handoff: true };
  if (!blockedReason && visitTypeUnreadable(data)) return { ...EMPTY_CONTEXT, loading: false, loadError: LOAD_ERROR };
  return {
    loading: false,
    loadError: '',
    blockedReason,
    handoff: false,
    visit: data?.service || {},
    // The context's whole `service` object, echoed back as `expectedVisit`.
    raw: data?.service || null,
    visitType: data?.visitType ?? null,
    turfHeightCapture: data?.turfHeightCapture === true,
    planned: plannedItemsOf(data),
    plannedUnavailable: data?.plannedProductsUnavailable || null,
    assessment: assessmentOf(data),
    photoStatus: data?.photoStatus || null,
    ...optionalContextFields(data),
  };
}

function useLawnFastContext({ base, request, service }) {
  const [ctx, setCtx] = useState(EMPTY_CONTEXT);
  // Bumped by Try again: the same read, run once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setCtx(EMPTY_CONTEXT);
    request(`${base}/lawn-fast/context`)
      .then((data) => { if (active) setCtx(contextFrom(data, service)); })
      .catch((err) => {
        if (!active) return;
        // 404 (gate off, visit gone) and 409: the full form opens, as it always did.
        if (err?.status === 404 || err?.status === 409) setCtx({ ...EMPTY_CONTEXT, loading: false, handoff: true });
        else setCtx({ ...EMPTY_CONTEXT, loading: false, loadError: err?.message || 'Failed to load this visit' });
      });
    return () => { active = false; };
  }, [base, request, attempt, service?.routedCustomerId, service?.routedScheduledDate, service?.routedPropertyId, service?.routedAddress]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...ctx, retry };
}

// ── products ────────────────────────────────────────────────────────────────

// A row for a catalog product. `planned` carries the plan's amount, unit and
// method; an added product has none and starts on its own default method.
function productRow(product, { planned = null, added = false }) {
  const rawMethod = planned?.applicationMethod || defaultApplicationMethodForLine(product, 'lawn');
  // Held the way the server reads it, so the requirements table finds it.
  const method = normalizeApplicationMethod(rawMethod) || rawMethod;
  const own = productUnits(product, { method });
  const amount = Number(planned?.amount);
  const plannedDimension = measureUnit(planned?.amountUnit, own.dimension)
    ? own.dimension
    : Object.keys(UNIT_CHOICES).find((name) => measureUnit(planned?.amountUnit, name));
  let dimension = own.dimension;
  let seeded = { amount: '', unit: own.unit };
  if (plannedDimension && amount > 0) {
    dimension = plannedDimension;
    seeded = seededAmount(amount, measureUnit(planned.amountUnit, plannedDimension));
  }
  return {
    product,
    productId: product.id,
    name: product.name,
    added,
    planned: !!planned,
    // A planned product starts applied; the tech turns off what was not.
    active: !!planned,
    method,
    // The planned or catalog method stays on offer for the life of the row.
    originalMethod: method,
    dimension,
    totalAmount: seeded.amount,
    amountUnit: seeded.unit,
    fromPlan: seeded.amount !== '',
    area: '',
    areaFrom: '',
    // The plan's own rate (ratePer1000 in rateUnit), only in a unit /complete
    // accepts. Nobody types a rate on this sheet: an untouched planned row sends
    // this exactly as the plan gave it, and the first change to the row's amount,
    // amount unit, method or plan-seeded area (rateChanged) drops it.
    planRate: planned && Number(planned.ratePer1000) > 0 && isSendableRateUnit(planned.rateUnit)
      ? { rate: Number(planned.ratePer1000), unit: String(planned.rateUnit).trim() }
      : null,
    rateChanged: false,
    // The square feet the context's planned item carries (preferred), if any.
    plannedSqft: planned && Number(planned.treatedSqft) > 0 && (!planned.areaUnit || planned.areaUnit === 'sqft') ? Number(planned.treatedSqft) : null,
  };
}

// The rate a row records: the plan's, for a planned row nobody has changed, and
// nothing else (no typed rate, no catalog default, no recomputing: a nutrient
// rate such as lb N cannot be got back from the product amount). So there is no
// unit to get wrong. Added products, changed rows, plans with no rate and
// units /complete does not accept all record none.
const plannedRateOf = (row) => (row.planned && !row.rateChanged ? row.planRate : null);

// Read-only, on an untouched planned row: "Planned rate: 0.4 fl oz per 1,000 sq ft".
const plannedRateText = (rate) => `Planned rate: ${rate.rate} ${unitLabel(rate.unit)} per 1,000 sq ft`;

// AmountRow shows a rate box only when it is given a rate unit; this sheet never does.
const NO_RATE = { rate: '', rateUnit: '', max: null };

// A sprayed or spread row with no area yet starts from the square feet the
// context's planned item carries (the server sends `treatedSqft` whenever the
// plan has one; null leaves the box for the technician). Linear feet are never
// seeded. Nothing else is filled in, and the tech's own entry is never replaced.
function withAreaSeed(row) {
  if (requirementOf(row)?.unit !== 'sqft' || row.area !== '') return row;
  return row.plannedSqft > 0 ? { ...row, area: String(row.plannedSqft), areaFrom: 'from the lawn plan' } : row;
}

// One id, one planned product, however the plan lists it: the FIRST entry wins
// (the full form's lawnPlanSelections keeps the first too). Ids compare
// lower-case, as the server lowercases them. The rendered tiles and the skipped
// list both come from this, so they can never disagree.
export function uniquePlanned(items) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const id = String(item?.productId || '').toLowerCase();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function plannedRows(ctx, catalog) {
  const byId = new Map((catalog || []).map((product) => [String(product.id).toLowerCase(), product]));
  return uniquePlanned(ctx.planned).map((item) => withAreaSeed(productRow(
    byId.get(String(item.productId).toLowerCase()) || { id: item.productId, name: item.name || 'Planned product' },
    { planned: item },
  )));
}

function useProductRows(ctx, catalog) {
  const [rows, setRows] = useState(() => plannedRows(ctx, catalog));
  const updateRow = useCallback((productId, patch) => {
    setRows((prev) => prev.map((row) => {
      if (row.productId !== productId) return row;
      const next = {
        ...row,
        ...patch,
        // An amount the tech changed is no longer the plan's; an area the tech
        // typed is no longer a fact the sheet filled in.
        ...('totalAmount' in patch || 'amountUnit' in patch ? { fromPlan: false } : {}),
        ...('area' in patch ? { areaFrom: '' } : {}),
        // The plan's rate no longer describes the row once its amount, unit, method
        // or plan-seeded area moves. (An area the plan never gave, typed for the
        // first time, changes nothing the rate stood on.)
        ...(['totalAmount', 'amountUnit', 'method'].some((key) => key in patch) || ('area' in patch && row.areaFrom) ? { rateChanged: true } : {}),
      };
      if (!('method' in patch)) return next;
      // An area belongs to the unit of the method it was entered for.
      const moved = requirementOf(row)?.unit !== requirementOf(next)?.unit;
      return withAreaSeed(moved ? { ...next, area: '', areaFrom: '' } : next);
    }));
  }, []);
  const addProduct = useCallback((product) => {
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      { ...withAreaSeed(productRow(product, { added: true })), active: true },
    ]));
  }, []);
  const removeRow = useCallback((productId) => setRows((prev) => prev.filter((row) => row.productId !== productId)), []);
  // A fresh stock read changes each row's stock on hand, nothing the tech set.
  const applyStock = useCallback((fresh) => {
    setRows((prev) => prev.map((row) => ({ ...row, product: withFreshStock(row.product, fresh) })));
  }, []);
  return { rows, updateRow, addProduct, removeRow, applyStock };
}

// ── watering preview ────────────────────────────────────────────────────────

const PREVIEW_DELAY_MS = 400;

// What the customer report would say about watering for these products. Asked
// again, after a short pause, whenever the product set changes.
function useWateringPreview({ base, request, productIds }) {
  const key = productIds.join(',');
  const [state, setState] = useState({ status: 'idle', data: null });
  useEffect(() => {
    if (!key) {
      setState({ status: 'idle', data: null });
      return undefined;
    }
    let active = true;
    setState({ status: 'loading', data: null });
    const timer = setTimeout(() => {
      request(`${base}/lawn-fast/watering-preview`, { method: 'POST', body: JSON.stringify({ productIds: key.split(',') }) })
        .then((data) => { if (active) setState({ status: 'ready', data }); })
        .catch(() => { if (active) setState({ status: 'failed', data: null }); });
    }, PREVIEW_DELAY_MS);
    return () => { active = false; clearTimeout(timer); };
  }, [key, base, request]);
  return state;
}

// ── what is missing, and the body ───────────────────────────────────────────

const unusableMessage = (reason) => (reason === 'property_check_failed' ? PROPERTY_CHECK_MESSAGE : PROPERTY_SCOPE_MESSAGE);
const heightProblem = (height) => height != null && !(height >= MIN_HEIGHT_IN && height <= MAX_HEIGHT_IN);

function missingRequirement({ form, rows, ctx, assessmentId, assessmentReady, unusable, gaugeHeightIn, typed, dictationPending, stockRow }) {
  const active = rows.filter((row) => row.active);
  // From the one methods table: a method that needs an area needs a positive one.
  const missingArea = active.find((row) => needsArea(row) && !(Number(row.area) > 0));
  const [, reason = ''] = [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [assessmentReady === false, 'Wait for the lawn check to finish.'],
    [unusable, unusableMessage(ctx.assessment?.unusableReason)],
    [!assessmentId, 'Take your photos, tap Analyze lawn, then confirm the assessment. Complete turns on after that.'],
    [ctx.turfHeightCapture && heightProblem(gaugeHeightIn), `Lawn length must be between ${MIN_HEIGHT_IN} and ${MAX_HEIGHT_IN} inches.`],
    [missingArea, missingArea && `Enter the ${requirementOf(missingArea).noun} treated for ${missingArea.name}.`],
    [stockRow, stockRow && `${stockRow.name} shows 0 in stock. Update inventory, then tap Check stock.`],
    [typed && !form.condition, 'Pick the lawn condition.'],
  ].find(([missing]) => missing) || [];
  return reason;
}

function completionBody({ form, rows, ctx, assessmentId, gaugeHeightIn, typed, tipsAvailable }) {
  const active = rows.filter((row) => row.active);
  // Plan defaults the tech turned off or removed: the lawn actuals ledger
  // records them as skipped (id and name only, no reason asked).
  // The server wants each product once (ids lower-case), a uuid, and a name of
  // at most 180 characters.
  const on = new Set(active.map((row) => String(row.productId).toLowerCase()));
  const skipped = uniquePlanned(ctx.planned)
    .filter((item) => !on.has(String(item.productId).toLowerCase()))
    .map((item) => ({
      productId: String(item.productId).toLowerCase(),
      productName: String(item.name || rows.find((row) => String(row.productId).toLowerCase() === String(item.productId).toLowerCase())?.name || '').trim().slice(0, 180),
    }))
    .filter((item) => item.productName && UUID_RE.test(item.productId));
  return {
    visitOutcome: 'completed',
    // The context's service object, every key, nulls included.
    expectedVisit: ctx.raw,
    lawnFast: { visitType: ctx.visitType },
    lawnAssessmentId: assessmentId,
    products: active.map((row) => {
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      const planRate = plannedRateOf(row);
      return {
        productId: row.productId,
        applicationMethod: row.method,
        ...(hasAmount(row) ? { totalAmount, amountUnit } : {}),
        ...(planRate ? { rate: planRate.rate, rateUnit: planRate.unit } : {}),
        // A plan product goes on the plan's default areas, as the full form sends it.
        ...(row.planned ? { applicationArea: LAWN_DEFAULT_AREAS.join(', ') } : {}),
        ...(needsArea(row) ? { areaValue: Number(row.area), areaUnit: requirementOf(row).unit } : {}),
        targets: [],
      };
    }),
    ...(skipped.length ? { lawnProtocolCompletion: { skippedProducts: skipped } } : {}),
    ...(ctx.turfHeightCapture ? { manualHeightIn: gaugeHeightIn } : {}),
    ...(typed ? { structuredFindings: { type: LAWN_FINDINGS_TYPE, values: { lawn_condition: form.condition } } } : {}),
    technicianNotes: form.note.trim(),
    techTips: techTipsOf(form, tipsAvailable),
    ...CUSTOMER_TEXT_FLAGS,
  };
}

// ── the sheet ───────────────────────────────────────────────────────────────

export default function FastCompleteLawnSheet({ service, request, catalog = [], onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const ctx = useLawnFastContext({ base, request, service });
  const submitRequest = useMemo(() => plainErrors(request), [request]);
  const submission = useFastCompleteSubmit({ base, request: submitRequest });
  const { submitting, done } = submission;
  // A recorded dictation clip is still being taken or transcribed. The full
  // form is another page and carries nothing over, so Full form and "+ Other
  // product" wait for it, like Complete.
  const [dictationPending, setDictationPending] = useState(false);

  // The server says this visit needs the full form: open it, once.
  const handedOff = useRef(false);
  useEffect(() => {
    if (ctx.handoff && !handedOff.current) {
      handedOff.current = true;
      onFullForm?.();
    }
  }, [ctx.handoff, onFullForm]);

  // Any dismissal the schedule may be stale for asks the parent to refresh: a
  // sheet blocked on a stale or changed visit, or an attempt whose outcome is
  // unknown or refused (it may have saved).
  const close = useCallback(() => {
    if (submitting) return;
    // The completion response rides along: admin Dispatch reads its invoice
    // fields to stage the payment handoff.
    if (done) onCompleted?.(done.response || null);
    else onClose?.(ctx.blockedReason || submission.failure ? { refresh: true } : undefined);
  }, [submitting, done, ctx.blockedReason, submission.failure, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved or refused for
  // good; the full form can't resume a /complete attempt.
  const locked = submitting || submission.failure !== null;

  return (
    <FastCompleteFrame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} onDismiss={close}>
      <SheetHeader titleId={titleId} title={done ? 'Lawn visit complete' : 'Complete lawn visit'} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} request={request} catalog={catalog} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, catalog, ctx, submission, locked, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile }) {
  if (submission.done) return <SavedView service={service} summary={submission.done.summary} onCompleted={() => onCompleted?.(submission.done.response || null)} />;
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  if (ctx.handoff) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Opening the full form…</ActionFeedback>;
  if (ctx.loadError) {
    return (
      <div className="tech-visit-body">
        <ActionFeedback error className="tech-visit-feedback tech-visit-loading">{ctx.loadError}</ActionFeedback>
        <div className="tech-visit-actions">
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={ctx.retry}>Try again</Button>
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={onFullForm}>Open the full form</Button>
        </div>
      </div>
    );
  }
  if (ctx.blockedReason) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">{ctx.blockedReason}</ActionFeedback>;
  return <LawnFastForm service={service} request={request} catalog={catalog} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={onDictationPending} onFullForm={onFullForm} isMobile={isMobile} />;
}

// The photo step's report of the confirmed assessment, plus the context's own
// confirmed id as a fallback. When the step's detail lookup FAILS (it then learned
// nothing), a usable confirmed assessment from the context stands, so the tech is
// not told to retake. It stops standing the moment a retake starts (new photos,
// Analyze, Retake: the step reports no confirmed id after its first lookup) and
// is never used when the context calls it unusable.
function useConfirmedAssessment(ctxAssessment) {
  const [blockId, setBlockId] = useState(null);
  const [ready, setReady] = useState(false);
  const [retaking, setRetaking] = useState(false);
  const settled = useRef(false);
  const onConfirmed = useCallback((id) => {
    setBlockId(id || null);
    // The step clears the id when it mounts too; only a clear after its first
    // lookup settled is a retake.
    if (!id && settled.current) setRetaking(true);
  }, []);
  const onReady = useCallback((value) => {
    if (value !== false) settled.current = true;
    setReady(value);
  }, []);
  const contextId = ctxAssessment?.confirmed === true && ctxAssessment.id && !ctxAssessment.unusableReason ? ctxAssessment.id : null;
  const assessmentId = blockId || (!retaking && ready === 'failed' ? contextId : null);
  return { assessmentId, assessmentReady: ready, retaking, onConfirmed, onReady };
}

// Zero stock holds Complete unless the server is known to let it through:
// negative inventory is allowed only for a real WaveGuard tier lawn completion
// (isWaveGuardLawnCompletion). The context's answer wins; else the schedule row.
// A product with no amount deducts nothing, so it never holds. Check stock reads
// the catalog again for a product restocked while the sheet is open.
function useStockHold({ ctx, service, rows, products, request }) {
  const stockAdvisory = typeof ctx.stockAdvisory === 'boolean'
    ? ctx.stockAdvisory
    : WAVEGUARD_TIERS.has(service?.waveguardTier) && detectServiceCategory(service?.serviceType) === 'lawn';
  const stockRow = !stockAdvisory
    && rows.find((row) => row.active && hasAmount(row) && stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const [checkingStock, setCheckingStock] = useState(false);
  const checkStock = async () => {
    setCheckingStock(true);
    try {
      const data = await request('/admin/dispatch/products/catalog');
      products.applyStock(new Map((Array.isArray(data?.products) ? data.products : []).map((product) => [String(product.id), product])));
    } catch {
      // The hold stays; the tech can check again.
    }
    setCheckingStock(false);
  };
  return { stockRow, checkingStock, checkStock };
}

function LawnFastForm({ service, request, catalog, ctx, submission, locked, dictationPending, onDictationPending, onFullForm, isMobile }) {
  const base = `/admin/dispatch/${service?.id}`;
  // From the context's findingsType only (the live profile), never the schedule row.
  const typed = ctx.findingsType === LAWN_FINDINGS_TYPE;
  const products = useProductRows(ctx, catalog);
  const { rows } = products;
  const [form, setForm] = useState({ note: '', condition: '', tipId: '', customTip: '' });
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);
  const tips = useTipLibrary({ base, request });
  const tipsAvailable = !!tips;

  // The photo step reports back: the confirmed assessment's id (null until
  // there is one) and whether a lookup, analysis or confirm is in flight.
  const { assessmentId, assessmentReady, retaking, onConfirmed, onReady } = useConfirmedAssessment(ctx.assessment);
  const [gaugeHeightIn, setGaugeHeightIn] = useState(null);
  const blockService = useMemo(() => ({ id: service?.id, customerId: ctx.raw?.customerId ?? service?.routedCustomerId ?? null }), [service?.id, service?.routedCustomerId, ctx.raw?.customerId]);
  // A confirmed assessment the report would reject (made for the visit's
  // former property) does not count until the tech analyzes again.
  const unusable = !!assessmentId && !!ctx.assessment?.unusableReason && String(assessmentId) === String(ctx.assessment.id);
  // The server's own warning for a saved assessment below the photo minimum. The
  // photo step hides its hint once an assessment is confirmed, so it shows here;
  // never while the step's own hint is up (no assessment, or a retake).
  const photoAdvisory = !retaking && !!assessmentId && String(assessmentId) === String(ctx.assessment?.id)
    ? ctx.photoStatus?.warning || ''
    : '';

  const { stockRow, checkingStock, checkStock } = useStockHold({ ctx, service, rows, products, request });

  const picker = useProductPicker({
    line: 'lawn',
    products: catalog,
    commonProducts: [],
    rows,
    locked: locked || dictationPending,
    isMobile,
    onFullForm,
    onPick: products.addProduct,
  });

  const missingReason = missingRequirement({ form, rows, ctx, assessmentId, assessmentReady, unusable, gaugeHeightIn, typed, dictationPending, stockRow });
  const submit = () => {
    if (missingReason && !submission.hasPendingBody()) return;
    const names = rows.filter((row) => row.active).map((row) => row.name).join(', ');
    submission.submit(
      () => completionBody({ form, rows, ctx, assessmentId, gaugeHeightIn, typed, tipsAvailable }),
      [names, 'Lawn assessment confirmed'].filter(Boolean).join(' · '),
    );
  };
  const activeIds = useMemo(() => rows.filter((row) => row.active).map((row) => String(row.productId)).sort(), [rows]);

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          <section className="tech-visit-choice-section">
            <div className="tech-visit-section-head">
              <h3 className="tech-visit-section-title">Lawn photos</h3>
              <span className="tech-visit-muted">Photos, Analyze lawn, then confirm</span>
            </div>
            <div className="tech-visit-light-card">
              <LawnAssessmentCompletionBlock
                service={blockService}
                request={request}
                disabled={locked || dictationPending}
                onConfirmed={onConfirmed}
                onReady={onReady}
                showGaugeReading={ctx.turfHeightCapture}
                gaugeHeightIn={gaugeHeightIn}
                onGaugeHeight={setGaugeHeightIn}
                technicianNotes={form.note}
              />
            </div>
            {photoAdvisory && <p className="tech-visit-muted" role="status">{photoAdvisory}</p>}
          </section>
          <ProductsSection ctx={ctx} products={products} locked={locked || dictationPending} other={picker.button} popover={picker.popover} />
          <WateringPreview base={base} request={request} productIds={activeIds} />
          {typed && (
            <ChoiceSection title="Lawn condition" columns={3}>
              {LAWN_CONDITION_OPTIONS.map((label) => (
                <Chip disabled={locked} key={label} label={label} pressed={form.condition === label} onClick={() => setField('condition', label)} />
              ))}
            </ChoiceSection>
          )}
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
          {tipsAvailable && (
            <TipSection
              library={tips}
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
      <CompleteFooter
        submission={submission}
        missingReason={missingReason}
        warn={!!stockRow}
        label="Complete lawn visit"
        onSubmit={submit}
        coverProps={picker.coverProps}
      >
        {(stockRow || submission.error === STOCK_LOCKOUT_MESSAGE) && !locked && (
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={checkingStock} onClick={checkStock}>Check stock</Button>
        )}
        {submission.failure === 'terminal' && (
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={onFullForm}>Open the full form</Button>
        )}
      </CompleteFooter>
      {picker.sheet}
    </div>
  );
}

// ── products ────────────────────────────────────────────────────────────────

function ProductsSection({ ctx, products, locked, other, popover }) {
  const { rows, updateRow, removeRow } = products;
  const planned = rows.some((row) => row.planned);
  let hint = 'Add what you applied';
  if (planned) hint = 'Planned products are on. Turn off what you did not use';
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
        <span className="tech-visit-muted">{hint}</span>
      </div>
      {ctx.plannedUnavailable && !planned && (
        <p className="tech-visit-muted" role="status">The planned products could not be loaded. Add what you applied.</p>
      )}
      {!rows.length && !ctx.plannedUnavailable && (
        <p className="tech-visit-muted">No products yet. Add what you applied, or none if you applied nothing.</p>
      )}
      <div className="tech-visit-tile-grid">
        {rows.map((row) => (
          <ProductTile key={row.productId} row={row} locked={locked} onClick={() => updateRow(row.productId, { active: !row.active })} />
        ))}
      </div>
      {rows.filter((row) => row.active).map((row) => (
        <ProductEditor key={row.productId} row={row} locked={locked} onChange={(patch) => updateRow(row.productId, patch)} onRemove={() => removeRow(row.productId)} />
      ))}
      <OtherProductButton {...other} popover={popover} />
    </section>
  );
}

function ProductTile({ row, locked, onClick }) {
  let detail = 'Tap if applied';
  if (row.active) detail = hasAmount(row) ? amountText(row.totalAmount, row.amountUnit) : 'No amount yet';
  return (
    <ProductTileButton
      row={row}
      detail={detail}
      off={!row.active}
      added={row.added && row.active}
      ariaProps={{ 'aria-pressed': row.active }}
      disabled={locked}
      onClick={onClick}
    />
  );
}

// An applied product: the amount, how it went down, and the square feet when
// the way it went down needs them.
function ProductEditor({ row, locked, onChange, onRemove }) {
  const nameId = useId();
  const areaId = useId();
  const methodId = useId();
  // The row's original method (planned or catalog) is always among the choices,
  // last when it is not one of the three, so a mis-tap can be undone.
  const choices = METHOD_CHOICES.some((choice) => choice.value === row.originalMethod)
    ? METHOD_CHOICES
    : [...METHOD_CHOICES, { value: row.originalMethod, label: methodLabel(row.originalMethod) }];
  return (
    <div role="group" aria-labelledby={nameId} className="tech-product-editor">
      <div className="tech-product-editor-head">
        <h4 id={nameId} className="tech-product-editor-name">{row.name}</h4>
        <span className="tech-visit-muted">{[categoryLabel(row.product), row.added ? 'added by you' : 'planned'].filter(Boolean).join(' · ')}</span>
      </div>
      <div>
        <AmountRow row={row} rate={NO_RATE} onChange={onChange} />
        {row.fromPlan && <p className="tech-visit-muted">Planned amount</p>}
        {plannedRateOf(row) && <p className="tech-visit-muted">{plannedRateText(plannedRateOf(row))}</p>}
        {!hasAmount(row) && <p className="tech-visit-muted" role="status">No amount entered. It is recorded without one.</p>}
        <div>
          <span id={methodId} className="tech-product-editor-label">How</span>
          <div role="group" aria-labelledby={methodId} className="tech-visit-tile-grid">
            {choices.map((choice) => (
              <Chip disabled={locked} key={choice.value} label={choice.label} pressed={row.method === choice.value} onClick={() => onChange({ method: choice.value })} />
            ))}
          </div>
        </div>
        {needsArea(row) && (
          <div>
            <label htmlFor={areaId} className="tech-product-editor-label">{requirementOf(row).label}</label>
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
    </div>
  );
}

// ── watering ────────────────────────────────────────────────────────────────

// What the customer report would say about watering. Times are labeled "if
// completed now" while the visit is still open. When the server could not build
// the instruction (`omitted`), nothing is guessed: a neutral note stands in.
function WateringPreview({ base, request, productIds }) {
  const preview = useWateringPreview({ base, request, productIds });
  if (preview.status === 'idle') return null;
  const data = preview.data;
  let body;
  if (preview.status === 'loading') {
    body = <p className="tech-visit-muted" role="status">Checking the watering instruction…</p>;
  } else if (preview.status === 'failed' || (Array.isArray(data?.omitted) && data.omitted.length > 0)) {
    body = <p className="tech-visit-muted" role="status">The watering instruction is not shown here. The customer report has its own.</p>;
  } else if (data?.sentence || data?.mowHold?.line) {
    const lines = data.sentence ? [data.sentence] : [];
    body = (
      <>
        {/* New-sod mode: the report prints its fixed new-sod lines, so say why. */}
        {typeof data.newSod?.note === 'string' && data.newSod.note && (
          <p className="tech-visit-muted" data-testid="lawn-fast-new-sod-note">{data.newSod.note}</p>
        )}
        {lines.map((line) => <p key={line} className="tech-visit-promise-text">{line}</p>)}
        {data.mowHold?.line && <p className="tech-visit-promise-text">{data.mowHold.line}</p>}
        {Array.isArray(data.provisional) && data.provisional.includes('completionTime') && (
          <p className="tech-visit-muted">Times are if completed now.</p>
        )}
      </>
    );
  } else {
    return null;
  }
  return (
    <section className="tech-visit-choice-section" aria-label="Watering after this visit">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Watering after this visit</h3>
      </div>
      {body}
    </section>
  );
}
