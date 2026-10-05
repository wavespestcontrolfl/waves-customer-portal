// client/src/components/tech/FastCompleteLawnSheet.jsx
//
// Fast Complete for LAWN visits (GATE_LAWN_FAST_COMPLETE; lawn report rebuild
// Phase 5, plan PR-D). A lawn visit is a quick job: talk, photos, one tap.
// Owner 2026-10-04, working real visits: the technician speaks the note,
// takes the photos, the planned products are already on, and one tap completes.
// The screen, top to bottom:
//  1. "Tell me about the visit": the note with the mic (shared VisitNote);
//  2. Lawn photos: the shot list and Analyze lawn; after the read, the four
//     scores in one row (each one the technician may change until Confirm),
//     Confirm assessment and Retake (the shared LawnAssessmentCompletionBlock
//     in its compact mode: no Fungus control / Thatch condition tiles, no lawn
//     evidence review; four named photo slots; the optional Lawn length box
//     under the photos when the server asks for it). Confirm sends the default keep-all
//     review, as the full form's button does;
//  3. Products used: the plan's products, each with its method and amount
//     (change the method or the amount, remove, or add one from the catalog: an
//     inline "Search products" box, one tap adds the row; the box lists lawn
//     products only). The method is one dropdown, the common three first (Spot
//     treatment, Broadcast spray, Granular broadcast), offered by the context
//     (`methods`), the lawn re-service sheet's own control read as a dropdown
//     (owner 2026-10-05); a planned row starts on the protocol's own application
//     mode, an added one on its category's default.
//     Under the rows, "Also in October's protocol" (ProtocolAddOns): the month's
//     protocol window products the sheet does not carry yet, one tap each
//     (the context's `protocolWindow`; on a recurring visit the window's
//     plan defaults are the planned rows, so only its opt-in products are
//     offered; on any other visit every window product is). A tapped product
//     opens on the protocol's own method and is figured at the protocol's rate.
//     Nobody types an amount on a fast complete (owner 2026-10-05): a row with no
//     plan quantity is figured from the catalog's rate per 1,000 sq ft times
//     the area it goes down on (derivedAmount), and says so under the box; a
//     typed amount wins. No area box:
//     every lawn visit treats the whole lawn, so a sprayed or spread product
//     goes down on its own planned area or the visit property's saved
//     whole-lawn area (/complete requires one);
//  4. Customer home (the pest sheet's three choices, preset to not home, full
//     access), then Tips from your tech (optional, one tip);
//  5. Blog post for the customer (optional, GATE_REPORT_BLOG_POST);
//  6. Treatment zone map (optional, a closed row that opens the tracer);
//  7. one Complete lawn visit button. While it is off, its label says the one
//     thing missing: Add a photo, Analyze the photos, Confirm the assessment,
//     Add the products applied. The first three it does itself (the photo
//     step's own handlers, same disabled rules); the rest wait on the tech.
// No Full form button, watering preview, findings picker or
// evidence review: the report prints its own watering instructions, and
// /complete takes a visit with none of them. The submit shares its frame,
// header, saved view, note, tip picker, amount rows, product picker and footer
// with the pest, Tree & Shrub and lawn re-service sheets (FastCompleteParts.jsx)
// and their /complete submit (hooks/useFastCompleteSubmit.js).
//
// Admin Dispatch mounts it. Every lawn visit type may open it. A recurring
// program visit starts with the plan's products on, amounts filled; any other
// visit starts with no products. The sheet sends no customer message of its
// own: completion runs the existing flow with the full form's default text
// flags.
//
// What blocks Complete is only what the server enforces, said in plain words:
//  - a CONFIRMED lawn assessment (photos, Analyze lawn, Confirm assessment);
//  - at least one product, a rule of this sheet (Add the products applied);
//  - the lawn area for a sprayed or spread product (the server refuses a
//    broadcast row without square feet; the planned row's own area, else the
//    property's saved lawn area);
//  - the lawn condition on a one-time lawn visit (typed findings the server
//    requires);
//  - a Lawn length the server would refuse (only a typed one, outside 0.5 to 8 in).
// A product with no amount is noted, never blocked.
//
// The submit echoes the context back (GET /admin/dispatch/:id/lawn-fast/
// context): `expectedVisit` is the context's WHOLE `service` object,
// `lawnFast.visitType` its visit type, `lawnAssessmentId` the confirmed
// assessment. A visit the server calls ineligible (or 404/409 on the context)
// is handed to the parent once through `onFullForm`; the sheet itself never
// shows a Full form button.
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import LawnAssessmentCompletionBlock from '../lawn/LawnAssessmentCompletionBlock';
import { LAWN_FINDINGS_TYPE } from '../../lib/lawn-fast-complete';
import { detectServiceCategory } from '../../lib/service-colors';
import { LAWN_DEFAULT_AREAS, recordedLawnArea } from '../../lib/lawn-completion';
import { defaultApplicationMethodForLine, isPerBasisUnit, normalizeApplicationMethod, resolveRatePrefill } from '../../lib/product-rate-prefill';
import {
  UNIT_CHOICES, categoryLabel, hasAmount, measureUnit, productUnits, seededAmount, stockHolds,
} from '../../lib/fast-complete-products';
import { isMlUnit, submittedAmount } from '../../lib/measure-units';
import { tipsCalledForByNote } from '../../lib/tech-tips';
import {
  AmountRow, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, MethodSection, OtherProductButton,
  SavedView, TipSection, VisitNote, methodChoicesOf, methodLabel, rateUnitForRecord, techTipsOf, unitLabel, useProductPicker, useTipLibrary, visitChangedSinceSchedule, withFreshStock,
} from './FastCompleteParts';
import { BlogPostSection, CustomerHomeSection, DEFAULT_CUSTOMER_HOME, useBlogPostOffer } from './FastCompleteReport';
import TechTreatmentZoneModal from './TechTreatmentZoneModal';
import PropertyServiceAreas from './PropertyServiceAreas';
import { elapsedSince } from '../../lib/on-site-time';
import { Button, ActionFeedback } from '../ui';
import '../../styles/tech-workflow.css';

// Mowing height the server accepts (turf_height_invalid outside it).
const MIN_HEIGHT_IN = 0.5;
const MAX_HEIGHT_IN = 8;

// The one-time lawn form's condition list (project-types.js
// one_time_lawn_treatment lawn_condition). The sheet's test pins it to the
// server's list.
export const LAWN_CONDITION_OPTIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Recovering', 'Stressed'];

// THE table of what /complete requires per application method for a lawn
// product (complete-scheduled-service.js, the service_products loop):
//  - perimeter_spray: positive linear feet, areaUnit 'linear_ft'
//    (requiresLinearFtForReportApplication, error linear_ft_required);
//  - broadcast_spray, granular_broadcast: positive square feet, areaUnit 'sqft'
//    (requiresSqftForReportApplication on the lawn line, error area_sqft_required);
//  - every other method (spot_treatment, soil_drench, foliar_spray, bait_placement,
//    station_check, fog_ulv, trunk_injection, pin_stream): nothing.
// A row's method is normalized the way the server normalizes it, so a raw
// catalog value ("Broadcast", "perimeter band") lands on the same entry.
export const METHOD_REQUIREMENTS = {
  perimeter_spray: { unit: 'linear_ft', noun: 'linear feet' },
  broadcast_spray: { unit: 'sqft', noun: 'square feet' },
  granular_broadcast: { unit: 'sqft', noun: 'square feet' },
};
export const requirementOf = (row) => METHOD_REQUIREMENTS[normalizeApplicationMethod(row.method)] || null;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Real WaveGuard member tiers (complete-scheduled-service.js isWaveGuardLawnCompletion).
const WAVEGUARD_TIERS = new Set(['Bronze', 'Silver', 'Gold', 'Platinum']);

// The completion text the full form posts by default (SchedulePage: send the
// text, ask for the review on its automatic timing, include the pay link).
const CUSTOMER_TEXT_FLAGS = { sendCompletionSms: true, requestReview: true, includePayLink: true, reviewTiming: 'auto' };

// ── plain words for the server's refusals ───────────────────────────────────
// The shared submit hook sorts each failure (saved, correctable, retry,
// terminal) by status and code; these only replace the words the tech reads.
// The sheet has no Full form button, so none of them points to one.
const PROPERTY_CHECK_MESSAGE = 'We could not check this lawn assessment against this visit. Try again, or retake the photos and confirm again.';
const STOCK_LOCKOUT_MESSAGE = 'A product is out of stock. Update inventory, tap Check stock, then complete again.';
const PROPERTY_SCOPE_MESSAGE = 'This lawn check was made for a different property than this visit. Retake the photos, then analyze and confirm again.';
const NOT_ON_THIS_SHEET_MESSAGE = 'This visit cannot be completed on this sheet. Close it and tell the office.';
const REFUSAL_MESSAGES = {
  lawn_fast_disabled: 'The quick lawn sheet is off right now. Close it and tell the office.',
  lawn_fast_not_eligible: NOT_ON_THIS_SHEET_MESSAGE,
  visit_identity_changed: 'This visit changed since you opened it. Close it and open it again from the schedule.',
  lawn_fast_expected_visit_required: 'Close this sheet and open the visit again from the schedule. The sheet must confirm it is the same visit.',
  lawn_fast_assessment_required: 'Analyze the lawn photos and confirm the assessment first.',
  lawn_assessment_unconfirmed: 'Confirm the lawn assessment, then tap Complete again.',
  completion_profile_lookup_failed: 'We could not check this visit type.',
  lawn_fast_visit_type_unavailable: 'We could not check this visit type.',
  lawn_fast_not_found: 'This visit was not found. Close the sheet and reload the schedule.',
  typed_findings_required: NOT_ON_THIS_SHEET_MESSAGE,
  area_sqft_required: 'The lawn area is missing for a sprayed or spread product. Tell the office.',
  property_service_area_changed: 'This property\u2019s lawn area changed. We reloaded it. Tap Complete again.',
  linear_ft_required: 'A perimeter product needs linear feet, which this sheet does not take. Tell the office.',
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
// A completion refused because the property's areas changed under the sheet
// (`property_service_area_changed`) also reads the areas again, once, through
// `onAreaChanged`, so the next tap sends the current version.
function plainErrors(request, onAreaChanged) {
  return async (path, options) => {
    try {
      return await request(path, options);
    } catch (err) {
      const message = plainRefusalMessage(err);
      if (message && err) err.message = message;
      if (err?.code === 'property_service_area_changed') onAreaChanged?.current?.();
      throw err;
    }
  };
}

// ── context ─────────────────────────────────────────────────────────────────

// Reasons that are a failed read, not this visit's eligibility: a retry fixes them.
const RETRYABLE_REASONS = new Set(['profile_unavailable']);

const EMPTY_CONTEXT = {
  loading: true, loadError: '', blockedReason: '', handoff: false, visit: null, raw: null,
  visitType: null, turfHeightCapture: false, planned: [], plannedUnavailable: null, assessment: null, methods: [], protocolWindow: null,
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
const protocolWindowOf = (data) => {
  const window = data?.protocolWindow;
  if (!window || typeof window !== 'object' || !Array.isArray(window.products)) return null;
  const products = window.products.filter((item) => item?.productId);
  return products.length ? { title: window.title || null, month: Number(window.month) || null, products } : null;
};
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
//  - photo_status and turf_height_flag: advisory only, and the sheet shows neither.
// Every other failure is a thrown read (HTTP 500) and is a load error already.
function visitTypeUnreadable(data) {
  const failures = Array.isArray(data?.readFailures) ? data.readFailures : [];
  return !data?.visitType || data.visitType === 'unknown' || failures.includes('billing_mode');
}

// `findingsType` decides the lawn-condition requirement, from the context ONLY.
// null means "no typed findings" (a recurring visit) and is a real answer; the
// KEY being absent (`'findingsType' in data` is false) means an older server
// during a deploy, and the sheet cannot decide, so the visit is handed over.
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
  // The server says this visit does not use the quick sheet: the parent opens the full form.
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
    // The methods a row may take (the server's list; the common three when it has none).
    methods: methodChoicesOf(data),
    // This month's protocol window ({ title, month, products }), or null.
    protocolWindow: protocolWindowOf(data),
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
        // 404 (gate off, visit gone) and 409: handed to the parent, as it always was.
        if (err?.status === 404 || err?.status === 409) setCtx({ ...EMPTY_CONTEXT, loading: false, handoff: true });
        else setCtx({ ...EMPTY_CONTEXT, loading: false, loadError: err?.message || 'Failed to load this visit' });
      });
    return () => { active = false; };
  }, [base, request, attempt, service?.routedCustomerId, service?.routedScheduledDate, service?.routedPropertyId, service?.routedAddress]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...ctx, retry };
}

// ── products ────────────────────────────────────────────────────────────────

// The plan's quantity as the row starts: the plan's own measure and amount
// when the plan gave one in a unit the row's measures know (a small liquid dose
// in spoons), else the product's own measure with an empty box.
function plannedSeed(planned, own) {
  const amount = Number(planned?.amount);
  const dimension = measureUnit(planned?.amountUnit, own.dimension)
    ? own.dimension
    : Object.keys(UNIT_CHOICES).find((name) => measureUnit(planned?.amountUnit, name));
  if (!dimension || !(amount > 0)) return { dimension: own.dimension, amount: '', unit: own.unit };
  return { dimension, ...seededAmount(amount, measureUnit(planned.amountUnit, dimension)) };
}

// The plan's own rate (ratePer1000 in rateUnit), in the record's spelling of
// a unit /complete accepts ("fl oz" is sent as fl_oz); null when the plan
// carries none, or one the record refuses (mL, percent_solution).
function plannedRate(planned) {
  const unit = planned && Number(planned.ratePer1000) > 0 ? rateUnitForRecord(planned.rateUnit) : null;
  return unit ? { rate: Number(planned.ratePer1000), unit } : null;
}

// A row for a catalog product. `planned` carries the plan's amount, unit and
// method; `protocol` (an entry of the month's window, see ProtocolAddOns) its
// method and rate; an added product has none and starts on its own default method.
function productRow(product, { planned = null, added = false, protocol = null }) {
  const rawMethod = planned?.applicationMethod || protocol?.applicationMethod || defaultApplicationMethodForLine(product, 'lawn');
  // Held the way the server reads it, so the requirements table finds it.
  const method = normalizeApplicationMethod(rawMethod) || rawMethod;
  const seeded = plannedSeed(planned, productUnits(product, { method }));
  return {
    product,
    productId: product.id,
    name: product.name,
    added,
    planned: !!planned,
    // The window entry this row came from, if any: the protocol is the
    // authority on its rate (a nutrient target is not a rate; the catalog's
    // generic rate never stands in for it).
    protocol: protocol ? { ratePer1000: Number(protocol.ratePer1000) || null, rateUnit: protocol.rateUnit || null } : null,
    method,
    dimension: seeded.dimension,
    totalAmount: seeded.amount,
    amountUnit: seeded.unit,
    fromPlan: seeded.amount !== '',
    // Nobody types a rate on this sheet: an untouched planned row sends the
    // plan's exactly as the plan gave it, and the first change to the row's
    // amount or amount unit (rateChanged) drops it.
    planRate: plannedRate(planned),
    rateChanged: false,
    // The square feet the context's planned item carries, if any.
    plannedSqft: planned && Number(planned.treatedSqft) > 0 && (!planned.areaUnit || planned.areaUnit === 'sqft') ? Number(planned.treatedSqft) : null,
  };
}

// The rate a row records: the plan's, for a planned row nobody has changed;
// the rate a figured amount was figured FROM (derivedRate, the protocol's or
// the catalog's per 1,000 sq ft in its base unit), so the application's rate
// is on the record for the annual-limit checks; and nothing else (no typed
// rate, no recomputing: a nutrient rate such as lb N cannot be got back from
// the product amount). Typed amounts, changed planned rows, plans with no rate
// and units /complete does not accept all record none.
// A figured amount's own rate comes first: a planned row the plan gave a rate
// but no quantity for is figured from the catalog, and records THAT rate, never
// the plan's beside an amount the plan did not give.
const rateOf = (row) => row.derivedRate || (row.planned && !row.rateChanged ? row.planRate : null);

// AmountRow shows a rate box only when it is given a rate unit; this sheet never does.
const NO_RATE = { rate: '', rateUnit: '', max: null };

// Every lawn visit treats the whole lawn (owner 2026-10-04), so nobody types an
// area. /complete still requires square feet for a sprayed or spread row. Two
// figures, kept apart:
//  - the WHOLE-LAWN area: the visit property's recorded lawn area
//    (recordedLawnArea of the property-areas read, the full form's own rule), or
//    the area the technician set for this visit when the property has none
//    recorded. The lawn-fast context carries no whole-lawn field (its planned
//    items hold only each product's own area), and a planned product's area is
//    NOT it: the plan engine multiplies the lawn size by a per-product area
//    factor (a spot treatment is a fraction of the lawn);
//  - a planned product's OWN area (`plannedSqft`): that row's area, and only that
//    row's.
// A row submits its own area, else the whole-lawn area, else none (the sheet then
// says so and never invents one). An added product has no area of its own, so it
// takes the whole-lawn area. Linear feet (perimeter) are never known here.
//
// The property areas follow the full form's lifecycle (SchedulePage:
// propertyAreasRefreshing / propertyAreasSettledFor, read by the shared
// PropertyServiceAreas): Complete waits for the first answer, and after a
// completion is refused as `property_service_area_changed` it waits for a FRESH
// version. A failed refresh keeps the hold (PropertyServiceAreas shows the error
// with Retry); it never turns into "no area, go ahead" with the stale fence gone.
function usePropertyAreaLifecycle() {
  const [data, setData] = useState(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [settled, setSettled] = useState(false);
  const [visitArea, setVisitArea] = useState(null);
  const onMeasurements = useCallback((result) => {
    setData(result);
    if (result) { setRefreshing(false); setFailed(false); setSettled(true); }
  }, []);
  const onUnavailable = useCallback(({ failed: readFailed = false } = {}) => {
    setSettled(true);
    setFailed(readFailed);
    if (!readFailed) setRefreshing(false);
  }, []);
  const refresh = useCallback(() => { setRefreshing(true); setFailed(false); setRefreshToken((n) => n + 1); }, []);
  // The whole-lawn area: the technician's visit area when set, else the recorded one.
  const recorded = Number(recordedLawnArea(data?.areas?.lawn)) > 0 ? Number(recordedLawnArea(data.areas.lawn)) : null;
  const typedArea = visitArea !== null && Number(visitArea) > 0 ? Number(visitArea) : null;
  const wholeLawn = visitArea !== null ? typedArea : recorded;
  return {
    data, refreshToken, refreshing, failed, settled, visitArea, setVisitArea, onMeasurements, onUnavailable, refresh,
    wholeLawn, explicit: visitArea !== null && typedArea !== null,
    blocked: refreshing || !settled,
  };
}
const areaOf = (row, wholeLawn) => {
  const requirement = requirementOf(row);
  if (requirement?.unit !== 'sqft') return null;
  return row.plannedSqft || wholeLawn || null;
};

// The amount a row is figured at when nobody typed one and the plan gave none
// (owner 2026-10-05: a fast complete never asks the tech to work this out):
// the rate per 1,000 sq ft (the protocol's for a row from the month's window,
// else the catalog's) times the area the row goes down on, in the rate's own
// unit (spoons for a small liquid dose, as every seeded amount).
// The area is the one the row submits (its sqft method's); a planned spot row
// goes down on the plan's own area. No area, a per-basis rate (per gallon, per
// acre, per spot), a rate in mL or a rate in another measure than the row's
// figures nothing, and the box stays empty. Returns { amount, unit, note } or
// null; `note` is the working, read under the box.
// One measure's units against its base (fl oz; grams; each), for a figured
// amount read in the unit the tech picked.
const UNIT_SCALE = {
  liquid: { tsp: 1 / 6, fl_oz: 1, gal: 128 },
  weight: { g: 1, oz: 28.3495, lb: 453.592 },
  count: { each: 1 },
};
function convertAmount(amount, from, to, dimension) {
  const scale = UNIT_SCALE[dimension];
  if (!scale || !(from in scale) || !(to in scale)) return null;
  return amount * (scale[from] / scale[to]);
}

// The rate a row is figured at, { rate, base } (base = the rate's own unit
// before any "/"), or null when there is none the sheet can figure from: a
// row from the month's window takes the protocol's own rate and nothing else
// (a nutrient target such as lb N is not a rate per 1,000, and the catalog's
// generic rate never stands in for the protocol's); any other row takes the
// catalog's. A per-basis rate (per gallon, per acre, per spot) or one in mL
// figures nothing.
function figuringRate(row) {
  const source = row.protocol
    ? { rate: row.protocol.ratePer1000, rateUnit: row.protocol.rateUnit }
    : resolveRatePrefill(row.product, { applicationMethod: row.method, serviceLine: 'lawn' });
  const rate = Number(source?.rate);
  const rateUnit = String(source?.rateUnit || '').trim();
  if (!(rate > 0) || !rateUnit || isPerBasisUnit(rateUnit) || isMlUnit(rateUnit)) return null;
  // The base in the record's own spelling ("fl oz" and "fl_oz" are one unit;
  // shared/rate-units.json spells it fl_oz), so the figured rate is sendable.
  const base = rateUnit.split('/')[0].trim().toLowerCase().replace(/\s+/g, '_');
  return { rate, base };
}

// The area a row is figured on: the one it submits for a sqft method; a
// planned spot row's own plan area; else none.
const figuringArea = (row, lawnSqft) => (requirementOf(row)?.unit === 'sqft' ? areaOf(row, lawnSqft) : (row.planned ? row.plannedSqft : null));

function derivedAmount(row, lawnSqft) {
  if (row.amountPicked || row.fromPlan) return null;
  const area = figuringArea(row, lawnSqft);
  const figured = figuringRate(row);
  if (!(area > 0) || !figured) return null;
  const { rate, base } = figured;
  const unit = measureUnit(base, row.dimension);
  if (!unit) return null;
  // In the unit the tech picked for the row (unitPicked), else the rate's own
  // (spoons for a small liquid dose). Rounded ONCE, after that conversion, to
  // the precision the record keeps for the unit (three decimals for fl oz and
  // gal, as submittedAmount sends them; two for spoons and dry weights): a
  // two-decimal pre-round in fl oz would zero a tiny dose (0.004 fl oz) and
  // the record would disagree with the box.
  const inBase = rate * (area / 1000);
  const shown = row.unitPicked
    ? { amount: convertAmount(inBase, unit, row.amountUnit, row.dimension), unit: row.amountUnit }
    : seededAmount(inBase, unit);
  if (shown.amount == null) return null;
  const places = shown.unit === 'fl_oz' || shown.unit === 'gal' ? 1000 : 100;
  const amount = Math.round(shown.amount * places) / places;
  if (!(amount > 0)) return null;
  return {
    amount,
    unit: shown.unit,
    // The rate on the record, in its base unit (the plan's own shape).
    rate: rateUnitForRecord(base) ? { rate, unit: rateUnitForRecord(base) } : null,
    note: `${rate} ${unitLabel(base)} per 1,000 sq ft × ${area.toLocaleString('en-US')} sq ft`,
  };
}

// A row as the sheet reads, checks and sends it: its figured amount in place
// of an empty box. The tech's own entry and the plan's quantity pass through.
function withDerivedAmount(row, lawnSqft) {
  const derived = derivedAmount(row, lawnSqft);
  return derived ? { ...row, totalAmount: derived.amount, amountUnit: derived.unit, derivedNote: derived.note, derivedRate: derived.rate } : row;
}

// One id, one planned product, however the plan lists it: the FIRST entry wins
// (the full form's lawnPlanSelections keeps the first too). Ids compare
// lower-case, as the server lowercases them. The rendered rows and the skipped
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
  return uniquePlanned(ctx.planned).map((item) => productRow(
    byId.get(String(item.productId).toLowerCase()) || { id: item.productId, name: item.name || 'Planned product' },
    { planned: item },
  ));
}

function useProductRows(ctx, catalog) {
  const [rows, setRows] = useState(() => plannedRows(ctx, catalog));
  const updateRow = useCallback((productId, patch) => {
    setRows((prev) => prev.map((row) => {
      if (row.productId !== productId) return row;
      // A unit change on a row whose amount is figured (nothing typed, no plan
      // quantity) keeps the figure: the row remembers the unit (unitPicked) and
      // derivedAmount figures in it. Only a typed number is the tech's amount.
      const unitOnly = 'amountUnit' in patch && !('totalAmount' in patch) && !row.amountPicked && !row.fromPlan;
      if (unitOnly) return { ...row, amountUnit: patch.amountUnit, unitPicked: true };
      return {
        ...row,
        ...patch,
        // An amount the tech changed is no longer the plan's, and the plan's
        // rate no longer describes the row.
        ...('totalAmount' in patch || 'amountUnit' in patch ? { fromPlan: false, rateChanged: true } : {}),
        // The plan's per-1,000 rate was given at the plan's method: a row moved
        // to another method records no rate (the amount the tech typed stays).
        ...('method' in patch && patch.method !== row.method ? { rateChanged: true } : {}),
      };
    }));
  }, []);
  const addProduct = useCallback((product, { protocol = null } = {}) => {
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      productRow(product, { added: true, protocol }),
    ]));
  }, []);
  const removeRow = useCallback((productId) => setRows((prev) => prev.filter((row) => row.productId !== productId)), []);
  // A fresh stock read changes each row's stock on hand, nothing the tech set.
  const applyStock = useCallback((fresh) => {
    setRows((prev) => prev.map((row) => ({ ...row, product: withFreshStock(row.product, fresh) })));
  }, []);
  return { rows, updateRow, addProduct, removeRow, applyStock };
}

// ── what is missing, and the body ───────────────────────────────────────────

// The three reasons that read as the button's own label (owner 2026-10-04).
export const ADD_PHOTO = 'Add a photo';
export const ANALYZE_PHOTOS = 'Analyze the photos';
export const CONFIRM_ASSESSMENT = 'Confirm the assessment';
// The full form's own wording for a visit with no product (SchedulePage).
export const ADD_PRODUCTS = 'Products applied required';
const LABEL_REASONS = new Set([ADD_PHOTO, ANALYZE_PHOTOS, CONFIRM_ASSESSMENT, ADD_PRODUCTS]);

const unusableMessage = (reason) => (reason === 'property_check_failed' ? PROPERTY_CHECK_MESSAGE : PROPERTY_SCOPE_MESSAGE);
// Optional: only a typed length outside the server's range holds Complete.
const heightProblem = (height) => height != null && !(height >= MIN_HEIGHT_IN && height <= MAX_HEIGHT_IN);

// What the bottom button does while its label is a photo-step the block can do:
// the block's handle runs the step, and the block's own report (`progress`)
// says whether the step may run now. While it analyzes or confirms the button
// shows the in-flow button's busy text and is off. Anything else (a dictation
// still running, the products, a typed value out of range) is no action: the
// button keeps its label and stays off, as before.
// What the footer button is right now. While a step the bar can do stands (and no
// submit failed or awaits a retry) the button IS that step: its label and click,
// with no reason held against it; a busy step shows its busy text as the disabled
// button's label. Otherwise it is Complete, held by the reason as before.
function footerFor({ barAction, missingReason, submission, submit }) {
  const complete = { missingReason, reasonInButton: LABEL_REASONS.has(missingReason), label: 'Complete service', onSubmit: submit };
  if (!barAction || !missingReason || submission.failure || submission.retryPending) return complete;
  if (barAction.disabled) return { ...complete, missingReason: barAction.label, reasonInButton: true };
  return { missingReason: null, reasonInButton: false, label: barAction.label, onSubmit: barAction.onClick };
}

function barActionFor({ missingReason, dictationPending, progress, block }) {
  if (dictationPending) return null;
  if (progress.analyzing) return { label: 'Analyzing...', disabled: true };
  if (progress.confirming) return { label: 'Confirming...', disabled: true };
  const step = {
    [ADD_PHOTO]: ['canAddPhoto', 'openPhotoPicker'],
    [ANALYZE_PHOTOS]: ['canAnalyze', 'analyze'],
    [CONFIRM_ASSESSMENT]: ['canConfirm', 'confirm'],
  }[missingReason];
  if (!step) return null;
  const [can, run] = step;
  return { label: missingReason, disabled: !progress[can], onClick: () => block.current?.[run]() };
}

function missingRequirement({ form, rows, lawnSqft, areaHold, gaugeHeightIn, photos, assessed, assessmentId, assessmentReady, ctx, unusable, typed, dictationPending, stockRow }) {
  // A method that needs an area needs a positive one, from the plan.
  const missingArea = rows.find((row) => requirementOf(row) && !(areaOf(row, lawnSqft) > 0));
  const [, reason = ''] = [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [assessmentReady === false, 'Wait for the lawn check to finish.'],
    [unusable, unusableMessage(ctx.assessment?.unusableReason)],
    [!assessmentId && !assessed && photos === 0, ADD_PHOTO],
    [!assessmentId && !assessed, ANALYZE_PHOTOS],
    [!assessmentId, CONFIRM_ASSESSMENT],
    [!rows.length, ADD_PRODUCTS],
    [areaHold, areaHold],
    [missingArea, missingArea && (requirementOf(missingArea).unit === 'linear_ft'
      ? `${missingArea.name} needs linear feet, which this sheet does not take. Tell the office.`
      : `The lawn area is not on file for ${missingArea.name}. Tell the office.`)],
    [ctx.turfHeightCapture && heightProblem(gaugeHeightIn), `Lawn length must be between ${MIN_HEIGHT_IN} and ${MAX_HEIGHT_IN} inches.`],
    [stockRow, stockRow && `${stockRow.name} shows 0 in stock. Update inventory, then tap Check stock.`],
    [typed && !form.condition, 'Pick the lawn condition.'],
  ].find(([missing]) => missing) || [];
  return reason;
}

function completionBody({ form, rows, ctx, assessmentId, gaugeHeightIn, lawnSqft, propertyAreas, explicitArea, typed, tipsAvailable }) {
  // Plan defaults the tech removed: the lawn actuals ledger records them as
  // skipped (id and name only, no reason asked).
  // The server wants each product once (ids lower-case), a uuid, and a name of
  // at most 180 characters.
  const on = new Set(rows.map((row) => String(row.productId).toLowerCase()));
  const skipped = uniquePlanned(ctx.planned)
    .filter((item) => !on.has(String(item.productId).toLowerCase()))
    .map((item) => ({
      productId: String(item.productId).toLowerCase(),
      productName: String(item.name || '').trim().slice(0, 180),
    }))
    .filter((item) => item.productName && UUID_RE.test(item.productId));
  return {
    visitOutcome: 'completed',
    // The context's service object, every key, nulls included.
    expectedVisit: ctx.raw,
    lawnFast: { visitType: ctx.visitType },
    lawnAssessmentId: assessmentId,
    products: rows.map((row) => {
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      const planRate = rateOf(row);
      const requirement = requirementOf(row);
      return {
        productId: row.productId,
        applicationMethod: row.method,
        ...(hasAmount(row) ? { totalAmount, amountUnit } : {}),
        ...(planRate ? { rate: planRate.rate, rateUnit: planRate.unit } : {}),
        // A plan product goes on the plan's default areas, as the full form sends it.
        ...(row.planned ? { applicationArea: LAWN_DEFAULT_AREAS.join(', ') } : {}),
        ...(requirement ? { areaValue: areaOf(row, lawnSqft), areaUnit: requirement.unit } : {}),
        targets: [],
      };
    }),
    ...(skipped.length ? { lawnProtocolCompletion: { skippedProducts: skipped } } : {}),
    // The visit's coverage, frozen on the record the way the full form's is: the
    // property this visit is at, the version of its areas the sheet read, and
    // the lawn area the products went down on. Only while the areas were read.
    // The server takes it only for a visit it reads as a lawn service (snapshotVisitArea).
    ...(propertyAreas?.version && propertyAreas.propertyId && lawnSqft > 0 && detectServiceCategory(ctx.visit?.serviceType) === 'lawn'
      ? { propertyServiceArea: { propertyId: propertyAreas.propertyId, version: propertyAreas.version, kind: 'lawn', treatedSqft: lawnSqft, ...(explicitArea ? { explicitVisitArea: true } : {}) } }
      : {}),
    ...(ctx.turfHeightCapture ? { manualHeightIn: gaugeHeightIn } : {}),
    ...(typed ? { structuredFindings: { type: LAWN_FINDINGS_TYPE, values: { lawn_condition: form.condition } } } : {}),
    technicianNotes: form.note.trim(),
    // Who was home, as the pest sheet sends it (the same field, the same values).
    customerInteraction: form.customerHome,
    techTips: techTipsOf(form, tipsAvailable),
    // The blog post for the customer: its id; the server checks it is live and
    // freezes its title and link on the report.
    ...(form.blogPost ? { blogPostId: form.blogPost.id } : {}),
    ...CUSTOMER_TEXT_FLAGS,
  };
}

// ── the sheet ───────────────────────────────────────────────────────────────

const INERT = { 'aria-hidden': true, inert: '' };

// The top bar of the full form's mobile Complete service page (SchedulePage,
// the sticky bar): a round back arrow, the centred title, and the Details pill.
// Details opens the appointment details sheet (price edit, reschedule, cancel),
// the same one the full form's button opens; it is shown when the parent passes
// onViewDetails.
function LawnSheetHeader({ titleId, title, showDetails, detailsDisabled, onDetails, backDisabled, onBack }) {
  return (
    <header className="tech-lawn-header">
      <button type="button" className="tech-lawn-back" aria-label="Back" disabled={backDisabled} onClick={onBack}>←</button>
      <h2 id={titleId} className="tech-lawn-title">{title}</h2>
      {showDetails
        ? <button type="button" className="tech-lawn-details" disabled={detailsDisabled} onClick={onDetails}>Details</button>
        : <span className="tech-lawn-details-spacer" aria-hidden="true" />}
    </header>
  );
}

// The customer block under the full form's title: the name as a link to the
// customer, then address (directions), phone (call) and email (mail), each an
// underlined link as there. The schedule row carries name, address and phone; the
// email is read from the customer, as the full form does.
function CustomerContact({ service, visit, request }) {
  const customerId = service?.customerId || service?.routedCustomerId || null;
  const [email, setEmail] = useState('');
  useEffect(() => {
    let live = true;
    setEmail('');
    if (!customerId) return undefined;
    request(`/admin/customers/${customerId}`)
      .then((data) => { if (live) setEmail(data?.customer?.email || ''); })
      .catch(() => { if (live) setEmail(''); });
    return () => { live = false; };
  }, [request, customerId]);
  const name = visit?.customerName || service?.customerName || 'Customer';
  const address = service?.fullAddress || service?.address || '';
  return (
    <div className="tech-lawn-contact">
      {customerId
        ? <a className="tech-lawn-name" href={`/admin/customers?customerId=${encodeURIComponent(customerId)}`}>{name}</a>
        : <div className="tech-lawn-name">{name}</div>}
      {address ? <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`} target="_blank" rel="noopener noreferrer">{address}</a> : null}
      {service?.customerPhone ? <a href={`tel:${service.customerPhone}`}>{service.customerPhone}</a> : null}
      {email ? <a href={`mailto:${email}`} style={{ wordBreak: 'break-word' }}>{email}</a> : null}
    </div>
  );
}

// "Time on-site", as the full form's Complete service page shows it: a small
// label over the live elapsed time since check-in (h:mm:ss), ticking every
// second. The page shows the card only when the visit has a check-in time, and so
// does this: no check-in time, no card. `onSiteAt` is that time (the on-site
// status-log entry, else checkInTime; see lib/on-site-time.js), passed by Dispatch.
function TimeOnSite({ since }) {
  const [elapsed, setElapsed] = useState(() => elapsedSince(since));
  useEffect(() => {
    setElapsed(elapsedSince(since));
    const iv = setInterval(() => setElapsed(elapsedSince(since)), 1000);
    return () => clearInterval(iv);
  }, [since]);
  if (!since) return null;
  return (
    <section className="tech-visit-choice-section tech-visit-on-site" aria-label="Time on-site">
      <h3 className="tech-visit-section-title">Time on-site</h3>
      <p className="tech-visit-on-site-time">{elapsed}</p>
    </section>
  );
}

export default function FastCompleteLawnSheet({ service, request, catalog = [], onClose, onCompleted, onFullForm, onViewDetails }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const ctx = useLawnFastContext({ base, request, service });
  // The visit's own property areas (read by PropertyServiceAreas, in the form) and
  // their hold: see usePropertyAreaLifecycle. A refused completion starts a refresh.
  const propertyAreas = usePropertyAreaLifecycle();
  const reloadAreas = useRef(null);
  reloadAreas.current = propertyAreas.refresh;
  const submitRequest = useMemo(() => plainErrors(request, reloadAreas), [request]);
  const submission = useFastCompleteSubmit({ base, request: submitRequest });
  const { submitting, done } = submission;
  // A recorded dictation clip is still being taken or transcribed. "+ Other
  // product" and Complete wait for it, so the words are not missed.
  const [dictationPending, setDictationPending] = useState(false);
  // The treatment zone tracer opens over the sheet, which is inert meanwhile.
  const [overlay, setOverlay] = useState(null);

  // The server says this visit does not use this sheet: the parent opens the
  // full form, once. (No button on the sheet leads there.)
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
  // Nothing is editable while a save is in flight, unresolved or refused for good.
  const locked = submitting || submission.failure !== null;

  return (
    <FastCompleteFrame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} dialogClassName="tech-lawn-sheet" onDismiss={close} hiddenProps={overlay ? INERT : undefined} overlay={overlay}>
      <LawnSheetHeader titleId={titleId} title={done ? 'Service complete' : 'Complete service'} showDetails={!done && !!onViewDetails} detailsDisabled={submitting || dictationPending} onDetails={() => onViewDetails?.()} backDisabled={submitting} onBack={close} />
      <SheetBody service={service} request={request} catalog={catalog} ctx={ctx} propertyAreas={propertyAreas} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={setDictationPending} onOverlay={setOverlay} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, catalog, ctx, propertyAreas, submission, locked, dictationPending, onDictationPending, onOverlay, onCompleted, onFullForm, isMobile }) {
  if (submission.done) return <SavedView service={service} summary={submission.done.summary} onCompleted={() => onCompleted?.(submission.done.response || null)} />;
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  if (ctx.handoff) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Opening the full form…</ActionFeedback>;
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
  return <LawnFastForm service={service} request={request} catalog={catalog} ctx={ctx} propertyAreas={propertyAreas} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={onDictationPending} onOverlay={onOverlay} onFullForm={onFullForm} isMobile={isMobile} />;
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
  // Counts the photo step's settles after its first lookup: each analysis or
  // confirm that finishes. The server ranks tips from the visit's newest
  // assessment row, which only changes then (a new unconfirmed row at the end
  // of an analysis, a confirmed one at confirm), so this is the tips' read key.
  const [settles, setSettles] = useState(0);
  const onConfirmed = useCallback((id) => {
    setBlockId(id || null);
    // The step clears the id when it mounts too; only a clear after its first
    // lookup settled is a retake.
    if (!id && settled.current) setRetaking(true);
  }, []);
  const onReady = useCallback((value) => {
    if (value === true && settled.current) setSettles((n) => n + 1);
    if (value !== false) settled.current = true;
    setReady(value);
  }, []);
  const contextId = ctxAssessment?.confirmed === true && ctxAssessment.id && !ctxAssessment.unusableReason ? ctxAssessment.id : null;
  const assessmentId = blockId || (!retaking && ready === 'failed' ? contextId : null);
  return { assessmentId, assessmentReady: ready, settles, onConfirmed, onReady };
}

// Zero stock holds Complete unless the server is known to let it through:
// negative inventory is allowed only for a real WaveGuard tier lawn completion
// (isWaveGuardLawnCompletion). The context's answer wins; else the schedule row.
// A product with no amount deducts nothing, so it never holds. Check stock
// reads the catalog again for a product restocked while the sheet is open.
function useStockHold({ ctx, service, rows, products, request }) {
  const stockAdvisory = typeof ctx.stockAdvisory === 'boolean'
    ? ctx.stockAdvisory
    : WAVEGUARD_TIERS.has(service?.waveguardTier) && detectServiceCategory(service?.serviceType) === 'lawn';
  const stockRow = !stockAdvisory
    && rows.find((row) => hasAmount(row) && stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
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

function LawnFastForm({ service, request, catalog, ctx, propertyAreas, submission, locked, dictationPending, onDictationPending, onOverlay, onFullForm, isMobile }) {
  const base = `/admin/dispatch/${service?.id}`;
  // From the context's findingsType only (the live profile), never the schedule row.
  const typed = ctx.findingsType === LAWN_FINDINGS_TYPE;
  const products = useProductRows(ctx, catalog);
  // The whole-lawn area: this visit property's recorded lawn area (or the area
  // the technician set when none is recorded), never a planned product's own
  // (possibly partial) area and never the customer-wide turf profile (at a
  // secondary property that can be the primary's lawn).
  const lawnSqft = propertyAreas.wholeLawn;
  // Every reader of the rows (Complete's checks, the stock hold, the body, the
  // cards) sees the figured amounts; only the tech's entries live in state.
  const rows = useMemo(() => products.rows.map((row) => withDerivedAmount(row, lawnSqft)), [products.rows, lawnSqft]);
  // Why the property areas hold Complete: the first read has not answered, or a
  // refresh after a refused completion has not brought a fresh version yet (or
  // failed: PropertyServiceAreas shows the error with Retry).
  let areaHold = '';
  if (!propertyAreas.settled) areaHold = 'Checking the lawn area\u2026';
  else if (propertyAreas.refreshing) areaHold = propertyAreas.failed ? 'The property areas did not reload. Tap Retry, then Complete.' : 'Reloading the property areas\u2026';
  const [form, setForm] = useState({ note: '', condition: '', tipId: '', customTip: '', blogPost: null, customerHome: DEFAULT_CUSTOMER_HOME });
  // The optional lawn length (inches), the full form's own box; null until typed.
  const [gaugeHeightIn, setGaugeHeightIn] = useState(null);
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);

  // The photo step reports back: the confirmed assessment's id (null until
  // there is one), whether a lookup, analysis or confirm is in flight, and how
  // many photos are held / whether an analysis result is on screen.
  const { assessmentId, assessmentReady, settles, onConfirmed, onReady } = useConfirmedAssessment(ctx.assessment);
  const [progress, setProgress] = useState({ photos: 0, assessed: false });
  const block = useRef(null);
  // The tips are ranked by this visit's assessment, so they are read again each
  // time an analysis or confirm settles.
  const tips = useTipLibrary({ base, request, refreshKey: settles });
  // Tips the note calls for lead the picker: "chinch bugs" in the note lifts the
  // chinch tip above the photo-finding order the server sent.
  const noteTipIds = useMemo(() => tipsCalledForByNote((tips?.groups || []).flatMap((g) => g.tips || []), form.note), [tips, form.note]);
  const tipsAvailable = !!tips;
  // The blog post search is offered while the server answers available.
  const blog = useBlogPostOffer({ base, request });
  const blockService = useMemo(() => ({ id: service?.id, customerId: ctx.raw?.customerId ?? service?.routedCustomerId ?? null }), [service?.id, service?.routedCustomerId, ctx.raw?.customerId]);
  // A confirmed assessment the report would reject (made for the visit's
  // former property) does not count until the tech analyzes again.
  const unusable = !!assessmentId && !!ctx.assessment?.unusableReason && String(assessmentId) === String(ctx.assessment.id);
  const [traced, setTraced] = useState(false);

  const { stockRow, checkingStock, checkStock } = useStockHold({ ctx, service, rows, products, request });

  const picker = useProductPicker({
    line: 'lawn',
    products: catalog,
    commonProducts: [],
    rows,
    locked: locked || dictationPending,
    isMobile,
    // With no catalog to pick from (a one-time visit with no planned rows, or the
    // plan unavailable) "+ Other product" hands the visit to the full form.
    onFullForm,
    onPick: products.addProduct,
    // With a catalog the search sits in the Products section: no sheet to open.
    inline: true,
  });

  const missingReason = missingRequirement({ form, rows, lawnSqft, areaHold, gaugeHeightIn, photos: progress.photos, assessed: progress.assessed, assessmentId, assessmentReady, ctx, unusable, typed, dictationPending, stockRow });
  const barAction = barActionFor({ missingReason, dictationPending, progress, block });
  const submit = () => {
    if (missingReason && !submission.hasPendingBody()) return;
    const names = rows.map((row) => row.name).join(', ');
    submission.submit(
      () => completionBody({ form, rows, ctx, assessmentId, gaugeHeightIn, lawnSqft, propertyAreas: propertyAreas.data, explicitArea: propertyAreas.explicit, typed, tipsAvailable }),
      [names, 'Lawn assessment confirmed'].filter(Boolean).join(' · '),
    );
  };
  // The tracer opens over the sheet, as the pest sheet's does.
  const openTracer = () => onOverlay(
    <TechTreatmentZoneModal
      serviceId={service.id}
      expectedPropertyId={ctx.visit && 'propertyId' in ctx.visit ? ctx.visit.propertyId : undefined}
      customerName={ctx.visit?.customerName || service?.customerName || 'Customer'}
      address={service.routedAddress || service.address || ''}
      lat={service.lat}
      lng={service.lng}
      lawnMode
      // A visit completed elsewhere while the map is open must refuse this
      // save (the row-lock check), as the Fast Complete report flow does.
      openVisitOnly
      onClose={() => onOverlay(null)}
      onSaved={() => setTraced(true)}
    />,
  );

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <CustomerContact service={service} visit={ctx.visit} request={request} />
        <TimeOnSite since={service?.onSiteAt} />
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} micInside />
          <section className="tech-visit-choice-section">
            <div className="tech-visit-section-head">
              <h3 className="tech-visit-section-title">Lawn assessment</h3>
            </div>
            <LawnAssessmentCompletionBlock
              ref={block}
              compact
              service={blockService}
              request={request}
              disabled={locked || dictationPending}
              onConfirmed={onConfirmed}
              onReady={onReady}
              onProgress={setProgress}
              showGaugeReading={ctx.turfHeightCapture}
              gaugeHeightIn={gaugeHeightIn}
              onGaugeHeight={setGaugeHeightIn}
              technicianNotes={form.note}
            />
          </section>
          <ProductsSection ctx={ctx} rows={rows} products={products} catalog={catalog} lawnSqft={lawnSqft} locked={locked || dictationPending} other={picker.button} popover={picker.popover} inlineSearch={picker.inlineSearch} />
          <PropertyServiceAreas
            request={request}
            serviceId={service?.id}
            serviceLine="lawn"
            disabled={locked || dictationPending}
            visitArea={propertyAreas.visitArea}
            refreshToken={propertyAreas.refreshToken}
            onMeasurements={propertyAreas.onMeasurements}
            onUnavailable={propertyAreas.onUnavailable}
            onVisitAreaChange={propertyAreas.setVisitArea}
          />
          {typed && (
            <ChoiceSection title="Lawn condition" columns={3}>
              {LAWN_CONDITION_OPTIONS.map((label) => (
                <Chip disabled={locked} key={label} label={label} pressed={form.condition === label} onClick={() => setField('condition', label)} />
              ))}
            </ChoiceSection>
          )}
          <CustomerHomeSection value={form.customerHome} locked={locked} onChange={(value) => setField('customerHome', value)} />
          {tipsAvailable && (
            <TipSection
              quiet
              library={tips}
              priorityTipIds={noteTipIds}
              priorityOrdered
              tipId={form.tipId}
              customTip={form.customTip}
              locked={locked}
              onPick={(id) => setForm((prev) => ({ ...prev, tipId: prev.tipId === id ? '' : id, customTip: '' }))}
              onCustom={(value) => setForm((prev) => ({ ...prev, customTip: value, tipId: value.trim() ? '' : prev.tipId }))}
            />
          )}
          {blog.available && (
            <BlogPostSection quiet search={blog.search} value={form.blogPost} locked={locked} onChange={(post) => setField('blogPost', post)} />
          )}
          {service.traceEligible !== false && (
            <section className="tech-visit-choice-section" aria-label="Treatment zone map">
              <div className="tech-visit-section-head">
                <h3 className="tech-visit-section-title">Treatment zone map</h3>
                {traced && <span className="tech-visit-muted">Saved</span>}
              </div>
              <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked || dictationPending} onClick={openTracer}>
                {traced ? 'Change the treated lawn outline' : 'Outline the treated lawn'}
              </Button>
            </section>
          )}
        </fieldset>
        {submission.submitting && <ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
      </div>
      <CompleteFooter
        submission={submission}
        {...footerFor({ barAction, missingReason, submission, submit })}
        warn={!!stockRow}
        coverProps={picker.coverProps}
      >
        {(stockRow || submission.error === STOCK_LOCKOUT_MESSAGE) && !locked && (
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={checkingStock} onClick={checkStock}>Check stock</Button>
        )}
      </CompleteFooter>
      {picker.sheet}
    </div>
  );
}

// ── products ────────────────────────────────────────────────────────────────

// Each product on the sheet: the plan's, or one the tech added. The method and
// the amount can change and any product can go (a removed plan product is
// recorded as skipped). No area and no rate box.
function ProductsSection({ ctx, rows, products, catalog, lawnSqft, locked, other, popover, inlineSearch }) {
  const { updateRow, removeRow, addProduct } = products;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
      </div>
      {ctx.plannedUnavailable && !rows.some((row) => row.planned) && (
        <p className="tech-visit-muted" role="status">The planned products could not be loaded. Add what you applied.</p>
      )}
      {rows.map((row) => (
        <ProductEditor key={row.productId} row={row} methods={ctx.methods} lawnSqft={lawnSqft} locked={locked} onChange={(patch) => updateRow(row.productId, patch)} onRemove={() => removeRow(row.productId)} />
      ))}
      <ProtocolAddOns window={ctx.protocolWindow} visitType={ctx.visitType} rows={rows} catalog={catalog} locked={locked} onAdd={addProduct} />
      {inlineSearch || <OtherProductButton {...other} popover={popover} />}
    </section>
  );
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// The protocol's trigger key as the tech reads it: the known keys in plain
// words, any other key with its underscores opened up.
const TRIGGER_WORDS = {
  active_large_patch: 'Active large patch',
  gray_leaf_spot: 'Gray leaf spot',
  gray_leaf_spot_second_product: 'Gray leaf spot, second product',
  grubs_or_mole_crickets: 'Grubs or mole crickets',
  chinch_20_to_25_per_sqft: 'Chinch bugs, 20 to 25 per sq ft',
  chinch_second_product_or_caterpillars: 'Chinch bugs (second product) or caterpillars',
  caterpillars: 'Caterpillars',
  dry_spots: 'Dry spots',
  repeat_sedge: 'Repeat sedge',
  mapped_take_all_spring_1: 'Mapped take-all, first spring treatment',
  mapped_take_all_spring_2: 'Mapped take-all, second spring treatment',
  mapped_take_all_fall_1: 'Mapped take-all, first fall treatment',
  mapped_large_patch: 'Mapped large patch',
  mapped_large_patch_with_artavia: 'Mapped large patch, with Artavia',
  mapped_large_patch_with_velista_and_take_all_fall_2: 'Mapped large patch (with Velista) or fall take-all',
  large_patch_next_application_after_artavia: 'Large patch, the application after Artavia',
};
const triggerWords = (key) => {
  if (!key) return '';
  if (TRIGGER_WORDS[key]) return TRIGGER_WORDS[key];
  const text = String(key).replace(/_/g, ' ').trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
};
// The role, for an entry with no trigger: "Weed spots" for a post-emergent spot.
const ROLE_WORDS = {
  post_emergent_spot: 'Weed spots', adjuvant_spot: 'With the weed spray', fungicide_spot: 'Fungus spots',
  insecticide_spot: 'Insect spots', insect_curative: 'Insect curative', wetting_agent_spot: 'Dry spots',
};
const rateWords = (item) => (item.ratePer1000 > 0 && item.rateUnit ? `${item.ratePer1000} ${unitLabel(item.rateUnit)} per 1,000 sq ft` : '');

// The protocol's operating gates on a product, as the tech reads them: the
// known keys in plain words, any other key with its underscores opened up
// and its value after it. trigger, tankMixWith and the annual counter are
// read elsewhere (or are bookkeeping) and are not repeated here.
const GATE_WORDS = {
  spreaderVisitOnly: () => 'spreader visit only',
  postAppIrrigation: () => 'water in after',
  stressGate: () => 'not on stressed turf',
  minDistanceFromWaterFt: (v) => `keep ${v} ft from water`,
  applyAlone: () => 'apply alone',
  sunnyTurfOnly: () => 'sunny turf only',
  noWaterIn: () => 'do not water in',
  delayWateringHours: (v) => `hold watering ${v} h`,
  recheckDays: (v) => `recheck in ${v} days`,
  novToMarOnly: () => 'Nov to Mar only',
  requiresZeroNP: () => 'no N or P',
  blackoutSensitive: () => 'blackout sensitive',
  northPortBlocked: () => 'not in North Port',
  holdForTropicalWatch: () => 'hold under a tropical watch',
  rateRange: (v) => `label ${v}`,
  concentration: (v) => `${v}`,
  paleTurfRate: (v) => `pale turf ${v}`,
  targetN: (v) => `target ${v}`,
  targetK2O: (v) => `target ${v}`,
};
const GATE_KEYS_READ_ELSEWHERE = new Set(['trigger', 'tankMixWith', 'annualCounter']);
function gateWords(gates) {
  if (!gates || typeof gates !== 'object') return [];
  return Object.entries(gates)
    .filter(([key, value]) => !GATE_KEYS_READ_ELSEWHERE.has(key) && value !== false && value != null && value !== '')
    .map(([key, value]) => {
      if (GATE_WORDS[key]) return GATE_WORDS[key](value);
      const text = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
      return value === true ? text : `${text} ${typeof value === 'object' ? JSON.stringify(value) : value}`;
    });
}

// "Also in October's protocol": the month's window products the sheet does not
// carry yet, one tap each. On a recurring visit whose plan is on the sheet the
// window's plan defaults ARE the planned rows, so only the opt-in products are
// offered; with no planned row on (another visit type, the plan unavailable or
// its gates off) every window product is, the whole-lawn tool first. A product
// the catalog does not list (inactive) cannot be added and is left out; one
// already on the sheet is shown as such. Each line carries the protocol's
// trigger, tank mix, every operating gate, the method and the rate. Tapping
// adds the row on the protocol's method, figured at the protocol's rate.
function ProtocolAddOns({ window, visitType, rows, catalog, locked, onAdd }) {
  const titleId = useId();
  if (!window) return null;
  const byId = new Map((catalog || []).map((product) => [String(product.id).toLowerCase(), product]));
  const planOn = visitType === 'recurring' && rows.some((row) => row.planned);
  const items = window.products
    .filter((item) => !planOn || !item.defaultInPlan)
    .map((item) => ({ ...item, product: byId.get(String(item.productId).toLowerCase()) || null }))
    .filter((item) => item.product);
  if (!items.length) return null;
  const on = new Set(rows.map((row) => String(row.productId).toLowerCase()));
  const month = window.month ? MONTH_NAMES[window.month - 1] : null;
  // "Spot work" only when every offered product is spot work: a list that
  // carries a plan default or a broadcast product is not described as spots.
  const spotsOnly = items.every((item) => !item.defaultInPlan && item.applicationMethod === 'spot_treatment');
  return (
    <div className="tech-protocol-addons" role="group" aria-labelledby={titleId}>
      <div className="tech-protocol-addons-head">
        <h4 id={titleId} className="tech-protocol-addons-title">{month ? `Also in ${month}’s protocol` : 'Also in this month’s protocol'}</h4>
        <p className="tech-visit-muted">{spotsOnly ? 'Spot work for this visit. Tap what you applied.' : 'Tap what you applied.'}</p>
      </div>
      {items.map((item) => {
        const onSheet = on.has(String(item.productId).toLowerCase());
        const joined = [
          // A visit-specific substitution: offered as the substitute, named for the original.
          item.substituteFor ? `in place of ${item.substituteFor}` : '',
          triggerWords(item.trigger) || ROLE_WORDS[item.role] || '',
          item.tankMixWith ? `tank mix with ${item.tankMixWith}` : '',
          ...gateWords(item.gates),
          methodLabel(item.applicationMethod).toLowerCase(),
          rateWords(item),
        ].filter(Boolean).join(' · ');
        const why = joined.charAt(0).toUpperCase() + joined.slice(1);
        return (
          <div key={item.productId} className="tech-protocol-addon">
            <span className="tech-protocol-addon-text">
              <span className="tech-protocol-addon-name">{item.product.name}</span>
              <span className="tech-visit-muted">{onSheet ? 'On the sheet' : why}</span>
            </span>
            <Button
              type="button"
              variant="secondary"
              className="tech-visit-action tech-protocol-addon-add"
              aria-label={onSheet ? `${item.product.name} is on the sheet` : `Add ${item.product.name}`}
              disabled={locked || onSheet}
              onClick={() => onAdd(item.product, { protocol: item })}
            >
              {onSheet ? '✓' : 'Add'}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

// A product: its name, how it goes down (the method chips, and the area it will
// submit when the method needs one), the amount, and Remove.
function ProductEditor({ row, methods, lawnSqft, locked, onChange, onRemove }) {
  const nameId = useId();
  // The area this row will submit, named for what it is: "whole lawn" only when it
  // is the whole-lawn figure; a planned product's own smaller (or unchecked) area
  // is "planned area". Only a method that needs square feet shows one.
  const area = requirementOf(row)?.unit === 'sqft' ? areaOf(row, lawnSqft) : null;
  const areaText = area ? `${area === lawnSqft ? 'Whole lawn' : 'Planned area'}, ${area.toLocaleString('en-US')} sq ft` : null;
  return (
    <div role="group" aria-labelledby={nameId} className="tech-product-editor">
      <div className="tech-product-editor-head">
        <h4 id={nameId} className="tech-product-editor-name">{row.name}</h4>
        <span className="tech-visit-muted">{[categoryLabel(row.product), row.protocol ? 'from the protocol' : row.added ? 'added by you' : 'planned'].filter(Boolean).join(' · ')}</span>
      </div>
      <MethodSection row={row} methods={methods} locked={locked} onChange={onChange} layout="select" />
      {areaText && <p className="tech-visit-muted">{areaText}</p>}
      <AmountRow row={row} rate={NO_RATE} onChange={onChange} />
      {row.derivedNote && <p className="tech-visit-muted">{row.derivedNote}</p>}
      {!hasAmount(row) && <p className="tech-visit-muted" role="status">No amount entered. It is recorded without one.</p>}
      <div className="tech-product-editor-actions">
        <Button type="button" variant="secondary" className="tech-visit-action tech-product-remove" disabled={locked} onClick={onRemove}>Remove</Button>
      </div>
    </div>
  );
}
