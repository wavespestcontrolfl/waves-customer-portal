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
//     Under the rows, "Also in October's protocol" (ProtocolAddOns): the plan's
//     own opt-in products for this window (the context's `plannedProducts.addOns`,
//     built by the same plan as the planned rows: the visit's substitute, the
//     plan's mix, method and gate notes), one tap each. A tapped product opens as
//     a row seeded from its plan item, so it figures like a planned row; it is
//     never recorded as a skipped plan product. Recurring program visits only,
//     under the completion-defaults gates (owner 2026-10-06).
//     Nobody types an amount on a fast complete (owner 2026-10-05): a row with no
//     plan quantity is figured from the catalog's rate per 1,000 sq ft times
//     the area it goes down on (derivedAmount), and says so under the box; a
//     typed amount wins. No area box:
//     every lawn visit treats the whole lawn, so a sprayed or spread product
//     goes down on its own planned area or the visit property's saved
//     whole-lawn area (/complete requires one);
//     With the context's `spotRules` (GATE_LAWN_SPOT_RULES, owner 2026-10-08) a
//     spot-treatment row takes its area from the tech instead: quick sizes
//     (100 / 250 / 500 / 1,000 sq ft) or a typed number, which figures the
//     amount the same way, goes to /complete as areaValue (sqft), and is
//     required (or a typed amount) before Complete. The weed products the
//     protocol ties together are ONE "Weed spots" entry (the context's
//     `plannedProducts.weedMix`, decided on the server: the yearly cap, the
//     surfactant by temperature) whose rows share one area control.
//     With the context's `troubleAreas` (GATE_LAWN_TROUBLE_AREAS, owner 2026-10-09) every
//     spot row also asks WHERE on the lawn (a closed list from the server, one tap, under
//     the area; the Weed spots and Chinch entries take the place in the same tap that adds
//     them, and a lawn's single known trouble area of the row's type is the default place).
//     A place the yearly limits close for the row is off with the limit's words; Complete
//     waits for a place the way it waits for an area, and goes to /complete as areaPlace.
//     A "Known trouble areas" line above the guide cards shows the lawn's areas, each with
//     Clear and one confirm. Lib: lib/lawn-trouble-places.js; parts: LawnSpotPlace.jsx.
//     With the context's `treatmentGuide` (GATE_LAWN_TREATMENT_GUIDE, owner 2026-10-08),
//     once the assessment is confirmed the sheet asks the server for "Suggested from
//     this lawn": one card per photo finding (the finding, the check to do first, the
//     product, one tap), between the plan's rows and the protocol add-ons. The rules
//     live on the server; the sheet only renders the cards and performs their taps, and
//     the completion carries which cards showed and what the tech did (`lawnFast.
//     treatmentGuide`). Nothing is added by itself.
//     With the context's `newSod` (GATE_LAWN_NEW_SOD_NOTE, owner 2026-10-09) the sheet opens with
//     a "New sod, day N" banner (LawnSodParts.jsx) and applies the server's new-sod holds: a line a
//     hold covers is not pre-selected but listed greyed under "Held for new sod" with its reason
//     (the technician can still add it by hand, with a warning on the row), a part-of-lawn record
//     keeps the lines on with a "Skip the new sod" note, the October pre-emergent bag is replaced by
//     the server's LESCO 24-0-11 line, and the banner's "Sod mowed twice and does not lift" tick
//     saves the rooted day and reads the holds again. Every rule and word is the server's
//     (lib/lawn-sod-sheet.js only reads them); what is logged is still whatever rows are selected.
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
import { completionInvoiceFields } from '../../lib/completion-invoice-fields';
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
  AmountRow, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, EmbeddedPartFrame, FastCompleteFrame, MethodSection, OtherProductButton,
  RecoveredCompletion, SavedView, TipSection, VisitNote, methodChoicesOf, rateUnitForRecord, refusalWithoutContext, submissionHolds,
  methodLabel, techTipsOf, unitLabel, useDictationSources, useProductPicker, usePartBusy, useSharedNoteForm, useTipLibrary, useWriteTracking, visitChangedSinceSchedule, withFreshStock,
} from './FastCompleteParts';
import { BlogPostSection, CustomerHomeSection, DEFAULT_CUSTOMER_HOME, useBlogPostOffer } from './FastCompleteReport';
import TechTreatmentZoneModal from './TechTreatmentZoneModal';
import { KnownTroubleAreas, PlaceAddButtons, PlaceControl } from './LawnSpotPlace';
import { HeldLines, SodBanner } from './LawnSodParts';
import { newSodOf, sodAddLook, sodLineOf, sodRowNote, sodWords, splitHeldPlanned } from '../../lib/lawn-sod-sheet';
import SpotTargetControl from './LawnSpotTarget';
import { spotTargetsOf, targetBodyFields } from '../../lib/lawn-spot-target';
import { RowMixHelp, WeedMixHelp, useMixHelp } from './LawnMixHelp';
import { gallonsBodyFields, mixHelpOf, withGallonsArea } from '../../lib/lawn-mix-help';
import { knownPlacesOfType, troubleAreasOf, troubleTypeOfRow, withClearedTakeAll, withPlace } from '../../lib/lawn-trouble-places';
import PropertyServiceAreas from './PropertyServiceAreas';
import { elapsedSince } from '../../lib/on-site-time';
import CallBridgeLink from '../admin/CallBridgeLink';
import { useCanAccessCalls } from '../../hooks/useStaffCallAccess';
import { Button, ActionFeedback, Input } from '../ui';
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
function plainErrors(request, onAreaChanged, onPlaceRefused) {
  return async (path, options) => {
    try {
      return await request(path, options);
    } catch (err) {
      const message = plainRefusalMessage(err);
      if (message && err) err.message = message;
      if (err?.code === 'property_service_area_changed') onAreaChanged?.current?.();
      // GATE_LAWN_TROUBLE_AREAS: a place the limits close, or a take-all place that is no longer mapped, refreshes the place maps, so the chip closes without a reload.
      if (err?.code === 'lawn_place_limit' || err?.code === 'lawn_place_not_mapped') onPlaceRefused?.current?.(err);
      throw err;
    }
  };
}

// ── context ─────────────────────────────────────────────────────────────────

// Reasons that are a failed read, not this visit's eligibility: a retry fixes them.
const RETRYABLE_REASONS = new Set(['profile_unavailable']);

const EMPTY_CONTEXT = {
  loading: true, loadError: '', blockedReason: '', handoff: false, visit: null, raw: null,
  visitType: null, turfHeightCapture: false, planned: [], addOns: [], addOnsMonth: null, plannedUnavailable: null, assessment: null, methods: [],
  findingsType: null, stockAdvisory: undefined, spotRules: false, weedMix: null, treatmentGuide: false, lawnReportTies: false, lawnReportFacts: false, chinch: null, guidedProductIds: [], takeAllProductIds: [], troubleAreas: null, newSod: null,
};

// Why the live context can't be completed here, or '' when it can.
function blockedReasonFor(data, service) {
  const visit = data?.service || {};
  if (visitChangedSinceSchedule(visit, service) || serviceChangedSinceSchedule(visit, service)) return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  return '';
}

const plannedItemsOf = (data) => (Array.isArray(data?.plannedProducts?.items) ? data.plannedProducts.items.filter((item) => item?.productId) : []);
const addOnsOf = (data) => (Array.isArray(data?.plannedProducts?.addOns) ? data.plannedProducts.addOns.filter((item) => item?.productId) : []);
// The server's weed-spot decision (GATE_LAWN_SPOT_RULES), or null: an older or dark server sends none.
const weedMixOf = (data) => {
  const mix = data?.spotRules === true ? data?.plannedProducts?.weedMix : null;
  return mix && Array.isArray(mix.productIds) && Array.isArray(mix.groupProductIds) ? mix : null;
};
// The standing "Chinch bugs found at the edge of damage" offer (GATE_LAWN_TREATMENT_GUIDE): the add-on its tap opens
// (null when the limits leave nothing to add) and the line that says why, or null.
// GATE_LAWN_TROUBLE_AREAS: the same decision at each place of the lawn, `{ [placeId]: { item, note, unreadableIds } }`, or null.
const chinchByPlace = (chinch) => {
  if (!chinch?.byPlace || typeof chinch.byPlace !== 'object' || Array.isArray(chinch.byPlace)) return null;
  return Object.fromEntries(Object.entries(chinch.byPlace).map(([place, decision]) => [place, {
    item: decision?.item?.productId ? decision.item : null,
    note: decision?.note || null,
    unreadableIds: Array.isArray(decision?.unreadableIds) ? decision.unreadableIds : [],
    ...(Array.isArray(decision?.blockedIds) ? { blockedIds: decision.blockedIds } : {}),
    ...(decision?.amountBlocked === true ? { amountBlocked: true } : {}),
  }]));
};
const chinchShape = (chinch) => {
  const item = chinch?.item?.productId ? chinch.item : null;
  const rungIds = Array.isArray(chinch?.rungIds) ? chinch.rungIds : [];
  const unreadableIds = Array.isArray(chinch?.unreadableIds) ? chinch.unreadableIds : [];
  const byPlace = chinchByPlace(chinch);
  const chinchOnlyIds = Array.isArray(chinch?.chinchOnlyIds) ? chinch.chinchOnlyIds : null;
  return item || chinch?.note ? { item, note: chinch.note || null, rungIds, unreadableIds, ...(byPlace ? { byPlace } : {}), ...(chinchOnlyIds ? { chinchOnlyIds } : {}) } : null;
};
const chinchOf = (data) => chinchShape(data?.treatmentGuide === true ? data?.plannedProducts?.chinch : null);
const assessmentOf = (data) => (data?.assessment && typeof data.assessment === 'object' ? data.assessment : { exists: false, id: null, confirmed: false });

const LOAD_ERROR = 'Couldn’t load this visit. Try again.';
// The tick saved, but the holds could not be read again.
// GATE_LAWN_NEW_SOD_NOTE capability signal: this sheet understands the context's `newSod`, so the server may hold products back,
// add the swap bag and offer the rooted tick. Sent on the context reads that feed the holds and on the tick. A context read
// without it is the legacy context, so the sheet then has no holds to show.
const SOD_AWARE = 'sodAware=1';
const SOD_BUSY_MESSAGE = 'Checking the new sod holds. Wait a moment.';
const SOD_RECORD_STALE_CODES = ['sod_record_changed', 'sod_not_this_home'];
const SOD_UNSURE_MESSAGE = 'The sheet could not confirm the save. Tap the box again.';
const SOD_REOPEN_MESSAGE = 'Saved. The sheet could not reload the holds. Close this visit and open it again.';
// The parts of the context that come from the visit's plan: the re-read after the rooted tick replaces them together.
const PLAN_CONTEXT_FIELDS = ['planned', 'addOns', 'addOnsMonth', 'plannedUnavailable', 'weedMix', 'chinch', 'guidedProductIds', 'takeAllProductIds', 'troubleAreas', 'mixHelp'];
// A context re-read the sheet can rebuild from: the visit still takes this sheet, the plan was read, the sod record was checked.
const sodRereadUsable = (next) => !!next && !next.loadError && !next.handoff && !next.blockedReason && !next.plannedUnavailable && !next.newSod?.unavailable;
const SOD_REREAD_MESSAGE = 'Saved. The sheet could not reload the holds. Tap the box again.';

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
//  - new_sod: the home's sod record could not be read; the context then carries `newSod: { unavailable }` and the
//    banner says so (never silently no holds).
//  - trouble_areas (the known areas could not be read: the line says so) and trouble_area_limits (what a limit closes
//    at a place could not be read: no place is shown closed, and /complete judges the place); neither holds the sheet.
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
  // Spot-area rules: only while the server says so, so an older server renders as before.
  spotRules: data?.spotRules === true,
  weedMix: weedMixOf(data),
  // The treatment guide: the server says the cards are on, and offers the chinch tap.
  treatmentGuide: data?.treatmentGuide === true,
  // The report ties are live (GATE_LAWN_REPORT_FACTS): the standing chinch tap is recorded as a find.
  lawnReportTies: data?.lawnReportTies === true,
  // The report facts are live: the spot rows whose area the technician recorded are named on the submit.
  lawnReportFacts: data?.lawnReportFacts === true,
  chinch: chinchOf(data),
  // The add-ons a guide card may own: their taps wait for the fresh guide.
  guidedProductIds: data?.treatmentGuide === true && Array.isArray(data?.plannedProducts?.guidedProductIds) ? data.plannedProducts.guidedProductIds : [],
  // GATE_LAWN_TROUBLE_AREAS: the closed list of places, the known trouble areas and what a limit closes where; null otherwise.
  troubleAreas: troubleAreasOf(data),
  takeAllProductIds: data?.treatmentGuide === true && Array.isArray(data?.plannedProducts?.takeAllProductIds) ? data.plannedProducts.takeAllProductIds : [],
  // GATE_LAWN_NEW_SOD_NOTE: the banner, the held lines and the rooted tick; null while the gate is off or the home has no hold today.
  newSod: newSodOf(data),
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
    // The plan's opt-in products for this window, and the visit's month (1-12).
    addOns: addOnsOf(data),
    addOnsMonth: Number(data?.plannedProducts?.month) || null,
    plannedUnavailable: data?.plannedProductsUnavailable || null,
    assessment: assessmentOf(data),
    // The methods a row may take (the server's list; the common three when it has none).
    methods: methodChoicesOf(data),
    ...optionalContextFields(data),
    // The closed lists of a spot fungicide / insecticide row's target (lib/lawn-spot-target.js).
    spotTargets: spotTargetsOf(data),
    // The amount for a full tank of each spot spray, and the gallons entry (GATE_LAWN_MIX_HELP; lib/lawn-mix-help.js).
    mixHelp: mixHelpOf(data),
  };
}

function useLawnFastContext({ base, request, service }) {
  const [ctx, setCtx] = useState(EMPTY_CONTEXT);
  // Bumped by Try again: the same read, run once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setCtx(EMPTY_CONTEXT);
    request(`${base}/lawn-fast/context?${SOD_AWARE}`)
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

// The Weed spots decision the guide read fresh (the plan and the limits are read again after
// Confirm): the object, null when the month has no weed group, or undefined when the answer carries
// none (then the context's stands).
function freshWeedMix(data) {
  if (data.weedMix === null) return null;
  const mix = data.weedMix;
  return mix && Array.isArray(mix.productIds) && Array.isArray(mix.groupProductIds) ? mix : undefined;
}

// GATE_LAWN_TROUBLE_AREAS: after /complete refused a place (refreshKey > 0) the reads name the spot products on the sheet, so the server reads
// their per-place limits too (a Search-added product outside the month's recipe is not in the opening seed). Nothing is added to any
// other request, so a sheet that was never refused sends exactly what it always did.
const searchedIdsQuery = (refreshKey, idsRef, lead) => (refreshKey && idsRef?.current?.length ? `${lead}productIds=${idsRef.current.join(',')}` : '');

// GATE_LAWN_TROUBLE_AREAS: what the guide's read found closed at each place, `{ [productId]: { [place]: message } }` (an empty entry =
// open everywhere), or undefined when the answer carries none (then the context's map stands).
const freshPlaceTypes = (data) => (data.placeBlockedTypes && typeof data.placeBlockedTypes === 'object' && !Array.isArray(data.placeBlockedTypes) ? data.placeBlockedTypes : undefined);
const freshPlaceBlocked = (data) => (data.placeBlocked && typeof data.placeBlocked === 'object' && !Array.isArray(data.placeBlocked) ? data.placeBlocked : undefined);

// The standing chinch tap's decision the guide read fresh (the limits are read again after Confirm):
// the offer, null when there is nothing to offer or say, or undefined when the answer carries none.
function freshChinch(data) {
  return 'chinch' in data ? chinchShape(data.chinch) : undefined;
}

// The ONE chinch decision the standing entry follows (the card is the guide's own): the guide's
// fresh one once it has read, so a cap reached since the sheet opened, or a failed fresh limit read,
// is never overruled by the context's older offer of Arena.
const effectiveChinch = (guide, ctx) => (guide && guide.chinch !== undefined ? guide.chinch : ctx.chinch);

// The ONE Weed spots decision the sheet follows: the guide's fresh one once it has read, else the
// context's from when the sheet opened. The weed entry, the weed card, the search exclusion, the
// surfactant note and the area exemptions all read this, so two offers never show.
const effectiveWeedMix = (guide, ctx) => (guide && guide.weedMix !== undefined ? guide.weedMix : ctx.weedMix);

// The treatment guide's cards (GATE_LAWN_TREATMENT_GUIDE) for the CONFIRMED assessment: read from
// the server each time a confirmed assessment appears, dropped when a retake clears it.
// `status`: 'idle' (no confirmed assessment, or the guide is off), 'pending' (asked, not answered),
// 'answered' (`guide` = { assessmentId, cards, weedMix, chinch }) or 'failed' (the read failed or
// the answer was malformed: the sheet then follows the context's decisions, as without a guide).
const GUIDE_KINDS = ['weeds', 'fungus', 'chinch', 'caterpillars', 'dry_spots'];
// GATE_LAWN_TROUBLE_AREAS: a weeds or chinch card can carry a decision per place (`byPlace`: { [placeId]: { productIds, items, note } }),
// and then owns every product any place takes.
const cardPlaceEntries = (card) => (card.byPlace && typeof card.byPlace === 'object' ? Object.entries(card.byPlace).filter(([, entry]) => Array.isArray(entry?.items) && entry.items.length) : []);
const cardAllIds = (card) => [...card.productIds, ...cardPlaceEntries(card).flatMap(([, entry]) => entry.items.map((item) => item.productId))];
const guideCardOk = (card) => !!card && GUIDE_KINDS.includes(card.kind) && typeof card.title === 'string' && Array.isArray(card.productIds) && Array.isArray(card.items);
// `planKey` counts the plan re-reads the sheet rebuilt from (the rooted tick): an answer read for an earlier plan is never kept.
function useTreatmentGuide({ base, request, enabled, assessmentId, refreshKey = 0, planKey = 0, idsRef = null }) {
  const [state, setState] = useState({ for: null, status: 'idle', guide: null });
  useEffect(() => {
    // No confirmed assessment (a retake, or the guide is off): an answer held for an earlier one is dropped, so it can never come back.
    if (!enabled || !assessmentId) { setState((prev) => (prev.for === null ? prev : { for: null, status: 'idle', guide: null })); return undefined; }
    let active = true;
    // A failed read keeps the answer the sheet has ONLY while that answer belongs to this same confirmed assessment; for a new one
    // it is a failed read like any other (the sheet then follows the context's opening values).
    const failed = () => setState((prev) => (refreshKey && prev.for === assessmentId && prev.status === 'answered' && prev.plan === planKey ? prev : { for: assessmentId, status: 'failed', guide: null, plan: planKey }));
    request(`${base}/lawn-fast/treatment-guide?assessmentId=${encodeURIComponent(assessmentId)}${searchedIdsQuery(refreshKey, idsRef, '&')}`)
      .then((data) => {
        if (!active) return;
        if (data?.v === 1 && Array.isArray(data.cards)) {
          setState({ for: assessmentId, status: 'answered', plan: planKey, guide: { assessmentId, takeAllProductIds: Array.isArray(data.takeAllProductIds) ? data.takeAllProductIds : undefined, placeBlocked: freshPlaceBlocked(data), placeBlockedTypes: freshPlaceTypes(data), cards: data.cards.filter(guideCardOk), weedMix: freshWeedMix(data), chinch: freshChinch(data), blockedProductIds: Array.isArray(data.blockedProductIds) ? data.blockedProductIds : [], unreadableProductIds: Array.isArray(data.unreadableProductIds) ? data.unreadableProductIds : [], unreadableNote: typeof data.unreadableNote === 'string' ? data.unreadableNote : '' } });
        } else failed();
      })
      .catch(() => { if (active) failed(); });
    return () => { active = false; };
  }, [base, request, enabled, assessmentId, refreshKey, planKey]);
  if (!enabled || !assessmentId) return { guide: null, status: 'idle' };
  // An answer for an earlier plan is not shown while the new read is on its way: the guide is pending until it settles.
  return state.for === assessmentId && state.plan === planKey ? { guide: state.guide, status: state.status } : { guide: null, status: 'pending' };
}

// The guide's cards and the tech's checks on them; a new assessment starts with nothing checked.
function useTreatmentGuideState({ base, request, enabled, assessmentId, unusable, refreshKey, planKey, idsRef }) {
  const { guide, status } = useTreatmentGuide({ base, request, enabled, assessmentId: unusable ? null : assessmentId, refreshKey, planKey, idsRef });
  const [checkedState, setCheckedState] = useState({ for: null, map: {} });
  const forId = guide?.assessmentId ?? null;
  const onGuideCheck = useCallback((kind, value) => setCheckedState((prev) => ({
    for: forId, map: { ...(prev.for === forId ? prev.map : {}), [kind]: value },
  })), [forId]);
  // The guide-governed taps wait for the answer (or for the read to fail, then the context's
  // decisions stand, as without a guide). Off for a visit without a guide.
  const locked = enabled && status !== 'answered' && status !== 'failed';
  return { guide, status, locked, guideChecks: checkedState.for === forId ? checkedState.map : {}, onGuideCheck };
}

// The note under a take-all fungicide row (it is added from the search only).
const TAKE_ALL_ROW_NOTE = 'Take-all fungicide is for mapped take-all areas only.';
// Under the row: the unreadable-limit warning first (when the limit read failed), then the take-all note.
function takeAllRowNote(gov, productId) {
  const id = String(productId).toLowerCase();
  if (!gov.takeAll.has(id)) return null;
  return [gov.unreadable.has(id) ? gov.unreadableNote : '', TAKE_ALL_ROW_NOTE].filter(Boolean).join(' ');
}

const lowerIds = (ids) => (ids || []).filter(Boolean).map((id) => String(id).toLowerCase());

// The products a visible guide card owns or holds: out of the generic add-ons list and the search,
// so the card's check is the only way in. A dismissed card releases its product ("looked and
// decided"); a held product (take-all, no trouble area on file) has no dismiss and stays out of the
// list; the search alone still reaches it (guideGovernance: takeAll).
function cardOwnedIds(guide, checks) {
  return lowerIds((guide?.cards || []).filter((card) => checks[card.kind] !== 'none')
    .flatMap((card) => [...cardAllIds(card), ...(card.heldProductIds || []), ...card.items.map((item) => item.productId)]));
}

// What the guide governs for this visit, and what the LATEST decision does with it. ONE invariant:
// a product that belongs to a guide-governed kind (the weed group, the chinch rungs, and the month's
// fungicide, caterpillar and dry-spot picks) may be ON the sheet only if the latest decision offers
// it. The entry or card the latest decision offers adds the program's own row; the search adds a plain
// row of any governed product a limit that was READ does not forbid (owner 2026-10-09). The latest
// decision is the fresh guide answer, or, when the read failed, the context's own decisions.
//   governed  every such product            offered  what the latest decision lets onto the sheet
//   hidden    kept out of the add-ons list (every governed product that is not released to the
//             generic list)                   locked   no decision yet: the taps wait
//   searchable  what the search lists of the governed products (searchReach)
// A pick is RELEASED to the generic list when nothing blocked or holds it and no visible card owns
// it: a clean answer with no finding for it ("the technician can still treat what he sees"), or a
// card he dismissed. A blocked pick (a limit or a city hold that was READ) never is.
// A product whose limit read FAILED is UNREADABLE, not blocked: its entry or card offers nothing (we
// cannot vouch for it), but it is released to the search (and, for a pick, the list) and a row of it
// is neither dropped nor holds Complete, because the sheet has no Full form control: hiding it would
// leave no way to record a real application. Completion records the visit and flags it to the office.
const NO_GOVERNANCE = { enabled: false, locked: false, governed: new Set(), offered: new Set(), hidden: new Set(), searchable: new Set(), takeAll: new Set(), unreadable: new Set(), unreadableNote: '', weedOffered: new Set(), chinchOffered: new Set() };

// Unreadable: what the guide reports (the answer), or what the context's decisions say (a failed read).
function unreadableIds({ guide, weedMix, chinch, weedGroup }) {
  return [
    ...lowerIds(guide?.unreadableProductIds),
    // The mix is withheld as a whole; the members not read as forbidding are released.
    ...(weedMix?.mode === 'unavailable' ? weedGroup.filter((id) => !lowerIds(weedMix.blockedIds).includes(id)) : []),
    // GATE_LAWN_TROUBLE_AREAS: a member whose limit could not be read at ANY place is released too, whatever the top-level mode.
    ...lowerIds(weedMix?.unreadableIds),
    ...lowerIds(chinch?.unreadableIds),
  ];
}

// The month's take-all fungicide ids (the fresh guide's, else the context's) and the ones the search may
// reach: once the decision is in, all but those a limit that was READ forbids.
function takeAllReach({ ctx, guide, settled, blocked }) {
  const takeAll = lowerIds(guide?.takeAllProductIds ?? ctx.takeAllProductIds);
  return { takeAll, searchOnly: settled ? takeAll.filter((id) => !blocked.includes(id)) : [] };
}

// The governed ids kept out of the add-ons list: not released to the generic list, or a card owns
// them; a take-all product the search may reach is not.
function hiddenIds({ governed, searchOnly, free, unreadable, owned }) {
  return governed.filter((id) => !searchOnly.includes(id) && ((!free.includes(id) && !unreadable.includes(id)) || owned.includes(id)));
}

// The weed-group and chinch products a limit that was READ forbids, by the context's own decisions (the
// rule the guide answer's blockedProductIds uses): the weed members read as forbidding when the mix is
// withheld, the whole group but what the tap adds once the lead is past its limit, and the chinch rungs
// a limit kept out. A product whose limit could not be read is not forbidden.
function readForbiddenIds({ weedMix, chinch }) {
  const unreadable = lowerIds([...(weedMix?.unreadableIds || []), ...(chinch?.unreadableIds || [])]);
  const adds = lowerIds(weedMix?.productIds);
  const weed = !weedMix ? [] : weedMix.mode === 'unavailable' ? lowerIds(weedMix.blockedIds)
    : weedMix.mode !== 'lead' ? lowerIds(weedMix.groupProductIds).filter((id) => !adds.includes(id)) : [];
  return [...weed, ...lowerIds(chinch?.blockedIds)].filter((id) => !unreadable.includes(id));
}

// Every lawn product is in the search (owner 2026-10-09): once the decision is in, the search reaches
// every governed product a limit that was READ does not forbid, whether or not an entry or a card also
// offers it. The row it opens is a plain row; the entry and the card still add the program's own rows.
// A product a check-only card holds (take-all found: check, do not treat) stays out as well.
function searchReach({ governed, settled, answered, blocked, cardHeld, weedMix, chinch }) {
  if (!settled) return [];
  const forbidden = [...(answered ? blocked : readForbiddenIds({ weedMix, chinch })), ...cardHeld];
  return governed.filter((id) => !forbidden.includes(id));
}

function guideGovernance({ ctx, guide, status, checks }) {
  if (!ctx.treatmentGuide) return NO_GOVERNANCE;
  const answered = status === 'answered' && !!guide;
  const settled = answered || status === 'failed';
  const fresh = answered ? guide : null;
  const cards = fresh?.cards || [];
  const weedMix = effectiveWeedMix(guide, ctx);
  const chinch = effectiveChinch(guide, ctx);
  const picks = lowerIds(ctx.guidedProductIds);
  // With places (GATE_LAWN_TROUBLE_AREAS) a decision is made at each place: a product offered at any place is offered.
  const chinchItem = lowerIds([chinch?.item?.productId, ...Object.values(chinch?.byPlace || {}).map((decision) => decision.item?.productId)]);
  const weedOffered = lowerIds([weedMix, ...Object.values(weedMix?.byPlace || {})]
    .filter((decision) => decision && ['lead', 'replacement'].includes(decision.mode)).flatMap((decision) => decision.productIds || []));
  const blocked = lowerIds(answered ? guide.blockedProductIds : []);
  const cardIds = lowerIds(cards.flatMap((card) => [...cardAllIds(card), ...card.items.map((item) => item.productId)]));
  const chinchCardIds = lowerIds(cards.filter((card) => card.kind === 'chinch').flatMap((card) => cardAllIds(card)));
  const weedGroup = lowerIds(weedMix?.groupProductIds);
  // Unreadable: what the guide reports (the answer), or what the context's decisions say (a failed read).
  const unreadable = settled ? unreadableIds({ guide: fresh, weedMix, chinch, weedGroup }) : [];
  // Take-all fungicide (preventive on mapped areas only, never curative on an unmapped lawn): never
  // released to the plain list, and no tap offers it. Once the decision is in, it is reachable by the
  // search alone, the deliberate way to record it for a known mapped lawn, unless a limit that was READ
  // forbids it. The row it opens carries TAKE_ALL_ROW_NOTE.
  const { takeAll, searchOnly } = takeAllReach({ ctx, guide: fresh, settled, blocked });
  // Held from the generic list: a check-only card's product, and every take-all product.
  const cardHeld = lowerIds(cards.flatMap((card) => card.heldProductIds || []));
  const held = [...cardHeld, ...takeAll];
  const free = settled ? picks.filter((id) => !blocked.includes(id) && !held.includes(id)) : [];
  const owned = cardOwnedIds(fresh, checks);
  const governed = [...picks, ...takeAll, ...weedGroup, ...lowerIds(chinch?.rungIds), ...chinchItem];
  // A take-all product the search may reach stays reachable whatever a check-only card holds.
  const searchable = [...searchReach({ governed, settled, answered, blocked, cardHeld, weedMix, chinch }), ...searchOnly];
  return {
    enabled: true,
    locked: !settled,
    governed: new Set(governed),
    offered: new Set([...weedOffered, ...chinchItem, ...cardIds, ...free, ...unreadable, ...searchOnly, ...searchable]),
    // Hidden from the add-ons list; a take-all product reachable by the search is not.
    hidden: new Set(hiddenIds({ governed, searchOnly, free, unreadable, owned })),
    // What the search lists of the governed products (searchReach).
    searchable: new Set(searchable),
    takeAll: new Set(takeAll),
    unreadable: new Set(unreadable),
    unreadableNote: answered ? guide.unreadableNote : '',
    weedOffered: new Set(weedOffered),
    chinchOffered: new Set([...chinchItem, ...chinchCardIds]),
  };
}

// The rows on the sheet the latest decision does not offer: a governed product it does not offer, or
// a row an entry opened (weeds, chinch) that its entry no longer offers.
function staleGuideRows(rows, gov) {
  return rows.filter((row) => {
    const id = String(row.productId).toLowerCase();
    // An unreadable product cannot be called forbidden: its row stays.
    if (gov.unreadable.has(id)) return false;
    return (gov.governed.has(id) && !gov.offered.has(id))
      || (row.guided === 'weeds' && !gov.weedOffered.has(id))
      || (row.guided === 'chinch' && !gov.chinchOffered.has(id));
  });
}

// The governance of the latest decision, and its reconciliation. Whenever a decision replaces an
// earlier one (answered to answered, answered to failed, failed to answered, and after a retake),
// every row the new decision does not offer is dropped and the tech is told (`removed`). A failed
// refresh falls back to the context's decisions, so what the context does not offer goes too. The
// first decision reconciles nothing: the taps were locked until it came.
function useGuideGovernance({ ctx, guide, status, checks, products }) {
  const gov = useMemo(() => guideGovernance({ ctx, guide, status, checks }), [ctx, guide, status, checks]);
  const [removed, setRemoved] = useState({ names: [], why: '' });
  const decided = useRef(false);
  const latest = useRef({});
  latest.current = { rows: products.rows, removeRows: products.removeRows, gov };
  useEffect(() => {
    if (status !== 'answered' && status !== 'failed') return;
    if (decided.current) {
      const stale = staleGuideRows(latest.current.rows, latest.current.gov);
      latest.current.removeRows(stale.map((row) => row.productId));
      setRemoved({ names: stale.map((row) => row.name), why: status === 'failed' ? 'The limits could not be checked.' : 'The limits changed.' });
    }
    decided.current = true;
  }, [guide, status]);
  return { gov, removed };
}

// Complete is held while the guide is still reading (the rows are judged against its answer), and
// by a governed row the latest decision does not offer (it should be impossible after the
// reconciliation; the sheet never completes with one).
function guideHoldReason({ gov, status, rows }) {
  if (!gov.enabled) return '';
  if (status === 'pending') return 'Wait for the lawn guide to finish.';
  const stale = staleGuideRows(rows, gov)[0];
  return stale ? `Remove ${stale.name}: it is not offered for this lawn right now.` : '';
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
// method (a planned row's, or a tapped protocol add-on's plan item); an added
// product has none and starts on its own default method.
// The guide card or entry that opened a row (weeds, chinch, fungus, caterpillars, dry_spots), or
// null; and the plan's notes for the product (a watering hold, a distance), which the row shows.
const guideRowFields = (planned, guided) => ({ guided: guided || null, gateNotes: planned?.gateNotes || [] });

function productRow(product, { planned = null, added = false, weedGroup = false, guided, spotRules = false }) {
  const rawMethod = planned?.applicationMethod || defaultApplicationMethodForLine(product, 'lawn');
  // Held the way the server reads it, so the requirements table finds it.
  const method = normalizeApplicationMethod(rawMethod) || rawMethod;
  // Under the spot rules a spot row never holds the plan's quantity: it is figured from the plan's
  // estimate of the spot area, and the tech's own area figures the amount instead.
  const spotRow = spotRules && normalizeApplicationMethod(method) === 'spot_treatment';
  const seeded = plannedSeed(spotRow ? { ...planned, amount: null } : planned, productUnits(product, { method }));
  return {
    product,
    productId: product.id,
    name: product.name,
    added,
    planned: !!planned,
    // A protocol add-on the tech tapped: seeded from its plan item like a
    // planned row, labelled for where it came from.
    fromProtocol: added && !!planned,
    // One of the Weed spots entry's rows: they share one area (weedArea).
    weedGroup,
    ...guideRowFields(planned, guided),
    // GATE_LAWN_TROUBLE_AREAS: how the row was opened (a guide card or a tech tap) and the place the opening tap named.
    method,
    dimension: seeded.dimension,
    totalAmount: seeded.amount,
    amountUnit: seeded.unit,
    fromPlan: seeded.amount !== '',
    // Nobody types a rate on this sheet: an untouched planned row sends the
    // plan's exactly as the plan gave it, and the first change to the row's
    // amount or amount unit (rateChanged) drops it.
    planRate: plannedRate(planned),
    // The plan item's rate as the server sent it, for a spot row's figuring (figuringRate).
    plannedRatePer1000: planned && Number(planned.ratePer1000) > 0 ? Number(planned.ratePer1000) : null,
    plannedRateUnit: planned?.rateUnit || null,
    rateChanged: false,
    // The plan's method and the square feet it gives at that method, if any:
    // the plan's area stands only while the row is on the plan's method.
    plannedMethod: planned ? method : null,
    plannedSqft: planned && Number(planned.treatedSqft) > 0 && (!planned.areaUnit || planned.areaUnit === 'sqft') ? Number(planned.treatedSqft) : null,
  };
}

// The rate a row records: the plan's, for a planned row nobody has changed;
// the rate a figured amount was figured FROM (derivedRate, the catalog's per
// 1,000 sq ft in its base unit), so the application's rate
// is on the record for the annual-limit checks; and nothing else (no typed
// rate, no recomputing: a nutrient rate such as lb N cannot be got back from
// the product amount). Typed amounts, changed planned rows, plans with no rate
// and units /complete does not accept all record none.
// A figured amount's own rate comes first: a planned row the plan gave a rate
// but no quantity for is figured from the catalog, and records THAT rate, never
// the plan's beside an amount the plan did not give.
// The plan's rate rides only a planned row on the plan's own method whose
// amount nobody changed: a method changed and changed back is the plan's
// method again (Codex #5993 r8).
const rateOf = (row) => row.derivedRate || (onPlannedMethod(row) && !row.rateChanged ? row.planRate : null);

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
// A planned row on the plan's own method. Moved to another method, the plan's
// area no longer describes where it goes down: a spot area is not a broadcast's
// whole lawn, and a broadcast area is not a spot's (Codex #5993 r6, r7).
const onPlannedMethod = (row) => row.planned && row.method === row.plannedMethod;
const areaOf = (row, wholeLawn) => {
  const requirement = requirementOf(row);
  if (requirement?.unit !== 'sqft') return null;
  return (onPlannedMethod(row) && row.plannedSqft) || wholeLawn || null;
};

// The amount a row is figured at when nobody typed one and the plan gave none
// (owner 2026-10-05: a fast complete never asks the tech to work this out):
// the catalog's rate per 1,000 sq ft times the area the row goes down on, in the rate's own
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
// before any "/"), or null when there is none the sheet can figure from: the
// catalog's. A per-basis rate (per gallon, per acre, per spot) or one in mL
// figures nothing.
function figuringRate(row) {
  // A spot row under the spot rules figures from the rate the program approved (the server
  // sends it on the plan item when the plan gave none); only a row whose protocol line has
  // none falls back to the catalog's. A unit the row cannot express still figures nothing.
  const program = (row.spotRule || row.sodSwap) && onPlannedMethod(row) && row.plannedRatePer1000 ? { rate: row.plannedRatePer1000, rateUnit: row.plannedRateUnit } : null;
  const source = program || resolveRatePrefill(row.product, { applicationMethod: row.method, serviceLine: 'lawn' });
  const rate = Number(source?.rate);
  const rateUnit = String(source?.rateUnit || '').trim();
  if (!(rate > 0) || !rateUnit || isPerBasisUnit(rateUnit) || isMlUnit(rateUnit)) return null;
  // The base in the record's own spelling ("fl oz" and "fl_oz" are one unit;
  // shared/rate-units.json spells it fl_oz), so the figured rate is sendable.
  const base = rateUnit.split('/')[0].trim().toLowerCase().replace(/\s+/g, '_');
  return { rate, base };
}

// The area a row is figured on: the one it submits for a sqft method; a
// planned spot row's own plan area while it is on the plan's method; else
// none, so a planned row moved to spot treatment figures nothing from the old
// plan area.
// A spot row under the spot rules is figured on the area the tech set for it (spotArea) and on
// no other: the plan's own spot estimate figures nothing there.
const figuringArea = (row, lawnSqft) => {
  if (row.spotRule) return row.spotArea > 0 ? row.spotArea : null;
  return requirementOf(row)?.unit === 'sqft' ? areaOf(row, lawnSqft) : (onPlannedMethod(row) ? row.plannedSqft : null);
};

function derivedAmount(row, lawnSqft) {
  // spotExempt: a rate that is not per area (the surfactant's percent of the tank) figures nothing.
  if (row.amountPicked || row.fromPlan || row.spotExempt) return null;
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
  // the record would disagree with the box. A spot-rule row's dry dose also
  // keeps three (0.028 oz per 1,000 sq ft on 100 sq ft is 0.003 oz, and
  // service_products.total_amount holds three); every other row is as before.
  const inBase = rate * (area / 1000);
  const shown = row.unitPicked
    ? { amount: convertAmount(inBase, unit, row.amountUnit, row.dimension), unit: row.amountUnit }
    : seededAmount(inBase, unit);
  if (shown.amount == null) return null;
  const places = shown.unit === 'fl_oz' || shown.unit === 'gal' || (row.spotRule && shown.unit !== 'tsp' && shown.unit !== 'tbsp') ? 1000 : 100;
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

// Spot-area quick sizes (sq ft) offered beside the typed box.
export const SPOT_AREA_SIZES = [100, 250, 500, 1000];

const sameId = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const positiveNumber = (value) => (Number(value) > 0 ? Number(value) : null);

// The spot rules for one row (the context's `spotRules`, owner 2026-10-08): a row whose
// method is spot treatment carries the area the tech set for it (a weed-mix row, the one
// shared `weedArea`; any other, its own `spotSqft`) and nothing else: a plan's estimate of
// a spot area is not the area treated. `spotExempt` marks a weed-mix member whose rate is not per area, which
// needs no area. Any other row, and every row without the rules, passes through untouched.
function withSpotArea(row, { spotRules, weedMix, weedArea }) {
  if (!spotRules || normalizeApplicationMethod(row.method) !== 'spot_treatment') return row;
  const typed = positiveNumber(row.weedGroup ? weedArea : row.spotSqft);
  return {
    ...row,
    // The plan's own quantity for a spot row is figured from its estimate of the spot area. Only an
    // amount the tech entered stands (amountEntered, kept in the stored row): anything else in the
    // box is the plan's, under whatever unit, and is dropped; the tech's area figures the amount.
    ...(row.amountEntered ? {} : { totalAmount: '', fromPlan: false }),
    spotRule: true,
    spotArea: typed || null,
    spotExempt: !!weedMix?.noAreaProductIds?.some((id) => sameId(id, row.productId)),
  };
}

// GATE_LAWN_TROUBLE_AREAS: every spot row (the ones withSpotArea marked) also carries its place: the tech's tap (the weed
// entry's rows share `weedPlace`), else the lawn's single known trouble area of its type, with the places the yearly limits
// close for it. See lib/lawn-trouble-places.js.
// The places a take-all row from the guide card may go on: the card's own mapped places, else the lawn's known take-all areas.
const takeAllPlacesOf = (guide, areas) => new Set(((guide?.cards || []).find((card) => Array.isArray(card.allowedPlaces))?.allowedPlaces) || (areas?.known || []).filter((area) => area.type === 'take_all').map((area) => area.place));

function withSpotPlaces(rows, { areas, weedMix, chinch, weedPlace, takeAll, takeAllPlaces }) {
  const weedRows = rows.filter((row) => row.spotRule && row.weedGroup);
  return rows.map((row) => (row.spotRule
    ? withPlace(row, { areas, chosen: row.weedGroup ? weedPlace : row.pickedPlace, weedMix, chinch, weedRows, takeAll, takeAllPlaces })
    : row));
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

// The rows of the given planned items, as a fresh sheet builds them (plan quantity, method, area).
// The server's swap bag line (LESCO 24-0-11 in place of the pre-emergent bag) carries its own rate and reason: `sodSwap`.
function rowsForPlanned(items, ctx, catalog) {
  const byId = new Map((catalog || []).map((product) => [String(product.id).toLowerCase(), product]));
  return items.map((item) => ({
    ...productRow(
      byId.get(String(item.productId).toLowerCase()) || { id: item.productId, name: item.name || 'Planned product' },
      { planned: item, spotRules: !!ctx.spotRules },
    ),
    sodSwap: item.sodSwap || null,
  }));
}

// GATE_LAWN_NEW_SOD_NOTE: a line a new-sod hold covers is not pre-selected (it is listed under "Held for new sod").
const plannedRows = (ctx, catalog) => rowsForPlanned(splitHeldPlanned(uniquePlanned(ctx.planned), ctx.newSod).start, ctx, catalog);

function useProductRows(ctx, catalog) {
  const spotRules = !!ctx.spotRules;
  const [rows, setRows] = useState(() => plannedRows(ctx, catalog));
  // The products the technician added, removed or changed himself this session (a later re-read of the holds leaves his choice alone).
  const touched = useRef(new Set());
  const updateRow = useCallback((productId, patch) => {
    touched.current.add(String(productId).toLowerCase());
    setRows((prev) => prev.map((row) => {
      if (row.productId !== productId) return row;
      // A unit change on a row whose amount is figured (nothing typed, no plan
      // quantity) keeps the figure: the row remembers the unit (unitPicked) and
      // derivedAmount figures in it. Only a typed number is the tech's amount.
      const unitOnly = 'amountUnit' in patch && !('totalAmount' in patch) && !row.amountPicked && !row.fromPlan;
      if (unitOnly) return { ...row, amountUnit: patch.amountUnit, unitPicked: true };
      // A row moved ONTO spot treatment under the spot rules drops the plan's quantity it still
      // holds, as a row created on it never had one (productRow).
      const toSpot = spotRules && row.fromPlan && !('totalAmount' in patch) && 'method' in patch && normalizeApplicationMethod(patch.method) === 'spot_treatment';
      if (toSpot) return { ...row, ...patch, totalAmount: '', fromPlan: false };
      return {
        ...row,
        ...patch,
        // An amount the tech changed is no longer the plan's, and the plan's
        // rate no longer describes the row.
        ...('totalAmount' in patch || 'amountUnit' in patch ? { fromPlan: false, rateChanged: true } : {}),
        // The tech typed (or dictated) this row's amount: the one amount a spot-rule row keeps.
        ...('totalAmount' in patch ? { amountEntered: patch.totalAmount !== '' && patch.totalAmount != null } : {}),
      };
    }));
  }, [spotRules]);
  const addProduct = useCallback((product, { planned = null, weedGroup = false, guided, source = null, place = '' } = {}) => {
    touched.current.add(String(product.id).toLowerCase());
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      // GATE_LAWN_TROUBLE_AREAS: how the row was opened (a guide card or a tech tap) and the place the opening tap named.
      { ...productRow(product, { added: true, planned, weedGroup, guided, spotRules }), troubleSource: source, pickedPlace: place },
    ]));
  }, [spotRules]);
  const removeRow = useCallback((productId) => {
    touched.current.add(String(productId).toLowerCase());
    setRows((prev) => prev.filter((row) => row.productId !== productId));
  }, []);
  // GATE_LAWN_NEW_SOD_NOTE: the rows after the holds were read again (the rooted tick). `start` is what a FRESH sheet would start
  // with now: the refreshed plan's lines the refreshed holds do not keep off. A row the technician has not touched follows it:
  // it leaves when the refreshed plan or holds no longer start with it, it takes the refreshed plan's quantity, and a released
  // line comes back. A product he added, removed or changed himself stays as he left it.
  const reconcilePlanned = useCallback((start) => {
    const lower = (id) => String(id).toLowerCase();
    const fresh = new Map(start.map((item) => [lower(item.productId), item]));
    setRows((prev) => {
      const mine = (row) => touched.current.has(lower(row.productId)) || row.added;
      const kept = prev.filter((row) => mine(row) || fresh.has(lower(row.productId)))
        .map((row) => (mine(row) ? row : rowsForPlanned([fresh.get(lower(row.productId))], ctx, catalog)[0]));
      const here = new Set(kept.map((row) => lower(row.productId)));
      const back = start.filter((item) => !here.has(lower(item.productId)) && !touched.current.has(lower(item.productId)));
      return [...kept, ...rowsForPlanned(back, ctx, catalog)];
    });
  }, [ctx, catalog]);
  const removeRows = useCallback((ids) => setRows((prev) => prev.filter((row) => !ids.includes(row.productId))), []);
  // A fresh stock read changes each row's stock on hand, nothing the tech set.
  const applyStock = useCallback((fresh) => {
    setRows((prev) => prev.map((row) => ({ ...row, product: withFreshStock(row.product, fresh) })));
  }, []);
  return { rows, updateRow, addProduct, removeRow, removeRows, applyStock, reconcilePlanned };
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
  // The bar's own step (Analyze, Confirm, ...), not the completion: never relabelled as a save.
  return { missingReason: null, reasonInButton: false, label: barAction.label, onSubmit: barAction.onClick, isAction: true };
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

// The place a row sits at, in the closed list's own words (the label rides the row's chips; the id is the fallback).
const areaLabelOf = (row) => row.placeLabels?.[row.place] || row.place;

// GATE_LAWN_NEW_SOD_NOTE: the server flags a visit whose planned products are ALL held by the new sod; only then may the
// sheet complete with no product (the server re-derives it at completion). Everything else Complete asks for still applies.
const noProductOkOf = (newSod) => newSod?.noProductAllowed === true && typeof newSod.noProductNote === 'string' && !!newSod.noProductNote;
// With no product on the sheet in that state the record says why, in the server's own sentence, after the technician's note.
const noProductNoteJoined = (note, rows, newSod) => {
  const text = String(note ?? '').trim();
  if (rows.length || !noProductOkOf(newSod)) return text;
  return text.includes(newSod.noProductNote) ? text : [text, newSod.noProductNote].filter(Boolean).join(' ');
};

function missingRequirement({ sodWait = '', noProductOk = false, form, rows, guideHold, lawnSqft, areaHold, gaugeHeightIn, photos, assessed, assessmentId, assessmentReady, ctx, unusable, typed, dictationPending, stockRow }) {
  // A method that needs an area needs a positive one, from the plan.
  const missingArea = rows.find((row) => requirementOf(row) && !(areaOf(row, lawnSqft) > 0));
  const missingSpot = rows.find((row) => row.spotRule && !row.spotExempt && !(row.spotArea > 0) && !hasAmount(row));
  // GATE_LAWN_TROUBLE_AREAS: a spot row goes where the yearly limits allow, and names its place.
  const closedPlace = rows.find((row) => row.placeRule && (row.placeBlock || row.placeNowhere));
  const missingPlace = rows.find((row) => row.placeRule && !row.place);
  const [, reason = ''] = [
    // GATE_LAWN_NEW_SOD_NOTE: the rooted tick is being saved, or the holds could not be read again after it.
    [sodWait, sodWait],
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [assessmentReady === false, 'Wait for the lawn check to finish.'],
    [unusable, unusableMessage(ctx.assessment?.unusableReason)],
    [!assessmentId && !assessed && photos === 0, ADD_PHOTO],
    [!assessmentId && !assessed, ANALYZE_PHOTOS],
    [!assessmentId, CONFIRM_ASSESSMENT],
    // GATE_LAWN_NEW_SOD_NOTE: the server says the new sod holds every planned product, so an empty list is honest.
    [!rows.length && !noProductOk, ADD_PRODUCTS],
    // The guide is still reading, or a row on the sheet is not offered for this lawn right now.
    [guideHold, guideHold],
    [areaHold, areaHold],
    [missingArea, missingArea && (requirementOf(missingArea).unit === 'linear_ft'
      ? `${missingArea.name} needs linear feet, which this sheet does not take. Tell the office.`
      : `The lawn area is not on file for ${missingArea.name}. Tell the office.`)],
    // A spot row needs the area treated or a typed amount (spot rules).
    [missingSpot, missingSpot && `Enter the area treated for ${missingSpot.name}.`],
    [closedPlace, closedPlace && (closedPlace.placeBlock ? `${closedPlace.name} cannot go on ${areaLabelOf(closedPlace)}. ${closedPlace.placeBlock}` : `Remove ${closedPlace.name}: ${closedPlace.placeNowhere}`)],
    [missingPlace, missingPlace && `Pick where on the lawn ${missingPlace.name} went.`],
    [ctx.turfHeightCapture && heightProblem(gaugeHeightIn), `Lawn length must be between ${MIN_HEIGHT_IN} and ${MAX_HEIGHT_IN} inches.`],
    [stockRow, stockRow && `${stockRow.name} shows 0 in stock. Update inventory, then tap Check stock.`],
    [typed && !form.condition, 'Pick the lawn condition.'],
  ].find(([missing]) => missing) || [];
  return reason;
}

// The guide's record: one entry per card the guide showed, plus the standing "Chinch bugs found at the edge of
// damage" tap. That entry has no card, but adding its product IS the technician's find, so the record says
// chinch: found, taken (the report ties it to the product in one sentence, GATE_LAWN_REPORT_FACTS). Null when
// the guide recorded nothing. Only while the server says the report ties are live: with that gate off the record is exactly what it was.
function guideRecordCards({ guideCards, guideChecks, rows, on, ctx, chinchTap = null }) {
  const cards = (guideCards || []).map((card) => guideRecordCard(card, { checks: guideChecks, on, rows }));
  // The row the technician's chinch tap is about: the one the entry (or the chinch card) opened, or the product
  // already on the sheet that he tapped "found" for. A product that is merely on the sheet is no find.
  const standing = ctx.treatmentGuide && ctx.lawnReportTies
    ? (rows.find((row) => row.guided === 'chinch') || (chinchTap && rows.find((row) => String(row.productId).toLowerCase() === chinchTap)) || null)
    : null;
  if (!standing) return guideCards ? cards : null;
  const own = cards.find((card) => card.kind === 'chinch');
  // With places the record also names the place the product went to (an extra field; the ids stay a flat list of the ids added).
  const place = own?.place || (standing.placeRule && standing.place) || null;
  const chinch = { kind: 'chinch', shown: true, checked: 'found', taken: true, productIds: own ? own.productIds : [String(standing.productId).toLowerCase()], ...(place ? { place } : {}) };
  return [...cards.filter((card) => card.kind !== 'chinch'), chinch];
}

// The sod record this sheet showed, and the planned classes it held. The server freezes the report's New sod card only while it still matches.
const sodEcho = (newSod) => (newSod?.sodLaidOn
  ? { sod: { laidOn: newSod.sodLaidOn, covers: newSod.covers, held: (newSod.plannedHeld || []).map((entry) => entry.kind) } }
  : {});

function completionBody({ newSod = null, form, rows, ctx, assessmentId, gaugeHeightIn, lawnSqft, propertyAreas, explicitArea, typed, tipsAvailable, guideCards = null, guideChecks = {}, chinchTap = null }) {
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
  const recordCards = guideRecordCards({ guideCards, guideChecks, rows, on, ctx, chinchTap });
  // The spot rows whose area the technician recorded as the spot's extent (the same rows that send it as areaValue
  // below); a row sized by a typed amount is not named, and its card says plain "Spot treatment".
  const recordedSpots = ctx.lawnReportFacts ? rows.filter((row) => row.spotRule && row.spotArea > 0).map((row) => String(row.productId).toLowerCase()) : [];
  const spotAreas = recordedSpots.length ? { v: 1, productIds: [...new Set(recordedSpots)] } : null;
  return {
    visitOutcome: 'completed',
    // The context's service object, every key, nulls included.
    expectedVisit: ctx.raw,
    // The guide's record (owner choice D4): which cards showed, what the tech checked, and whether
    // the card's product is on the sheet at completion. The server validates it and freezes it.
    lawnFast: {
      visitType: ctx.visitType,
      ...(recordCards ? { treatmentGuide: { v: 1, cards: recordCards } } : {}),
      ...(spotAreas ? { spotAreas } : {}),
      ...sodEcho(newSod),
    },
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
        // A spot row's area, as the full form sends the plan's treatedSqft (spot rules).
        ...(row.spotRule && row.spotArea > 0 ? { areaValue: row.spotArea, areaUnit: 'sqft' } : {}),
        // GATE_LAWN_TROUBLE_AREAS: where the spot went, and what the row was opened for (the server writes the lawn's trouble area from it).
        ...(row.placeRule && row.place ? { areaPlace: row.place, troubleType: troubleTypeOfRow(row), troubleSource: row.troubleSource || 'tech_tap' } : {}),
        // A spot fungicide / insecticide row's optional target (the server checks it against the row's type), and the chinch-find hint.
        ...targetBodyFields(row, ctx.spotTargets, { chinchTap }),
        // Gallons sprayed in place of an area: the server converts them with the product's staged carrier and records the area.
        ...gallonsBodyFields(row),
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
    technicianNotes: noProductNoteJoined(form.note, rows, newSod),
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
// The phone goes through the Waves call bridge for a login that may place
// customer calls (owner 2026-10-06): the server rings the caller's phone, then
// the customer sees the Waves number, never the caller's own cell. Any other
// login keeps the plain tel: link it had.
function CustomerContact({ service, visit, request }) {
  const canCall = useCanAccessCalls();
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
      {service?.customerPhone
        ? (canCall
          ? <CallBridgeLink styledButton className="tech-lawn-call" phone={service.customerPhone} customerName={name === 'Customer' ? '' : name} customerIdHint={customerId}>{service.customerPhone}</CallBridgeLink>
          : <a href={`tel:${service.customerPhone}`}>{service.customerPhone}</a>)
        : null}
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

// `onPrepared` (GATE_COMBO_FAST_COMPLETE; a part of a grouped stop): Complete hands the body it would have
// posted to onPrepared(serviceId, body) and posts nothing. `sharedNote` is the stop's one note: it stands
// in for this sheet's own, which hides. Without them the sheet is as it was.
export default function FastCompleteLawnSheet({ service, request, operatorId, catalog = [], onClose, onCompleted, onFullForm, onViewDetails, suspended = false, onPrepared, sharedNote, embedded }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  // As a part of a stop (embedded) the container owns focus, scroll lock and the frame.
  const dialogRef = useModalFocus(!embedded && !suspended, () => closeRef.current?.());
  useLockBodyScroll(!embedded);
  const Frame = embedded ? EmbeddedPartFrame : FastCompleteFrame;
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  // A part of a grouped stop (onPrepared) says so on every lawn-fast read: the server lifts its grouped-stop
  // refusal only for a stop it confirms as a combined stop (X-Combo-Stop is a request, never an authority).
  // Keyed on whether this is prepare mode, never on the callback's identity: a container that passes an inline
  // onPrepared must not recreate the request (the context would reload and the form would remount).
  const preparing = typeof onPrepared === 'function';
  const headerRequest = useMemo(() => (preparing
    ? (path, options = {}) => request(path, { ...options, ...(path.includes('/lawn-fast/') ? { headers: { ...options.headers, 'X-Combo-Stop': '1' } } : {}) })
    : request), [request, preparing]);
  // Every write (a sod rooted date, a cleared trouble area, a photo, Analyze, Confirm) counts as work in flight.
  const stopRequest = useWriteTracking(headerRequest, preparing);
  const ctx = useLawnFastContext({ base, request: stopRequest, service });
  // The visit's own property areas (read by PropertyServiceAreas, in the form) and
  // their hold: see usePropertyAreaLifecycle. A refused completion starts a refresh.
  const propertyAreas = usePropertyAreaLifecycle();
  const reloadAreas = useRef(null);
  reloadAreas.current = propertyAreas.refresh;
  const refreshPlaces = useRef(null);
  const submitRequest = useMemo(() => plainErrors(stopRequest, reloadAreas, refreshPlaces), [stopRequest]);
  // `sheet` tags a saved attempt as this sheet's: its findings type matches the
  // lawn re-service sheet's, and Tech Home cannot open this one.
  const submission = useFastCompleteSubmit({ base, request: submitRequest, serviceId: service?.id, operatorId, sheet: 'lawn_visit', invoiceFields: completionInvoiceFields(service), onPrepared });
  const { submitting, done } = submission;
  // A recorded dictation clip is still being taken or transcribed. "+ Other
  // product" and Complete wait for it, so the words are not missed.
  const [dictationPending, setDictationPending] = useState(false);
  // The treatment zone tracer opens over the sheet, which is inert meanwhile.
  const [overlay, setOverlay] = useState(null);
  usePartBusy('lawn', [submitting, dictationPending, overlay != null].some(Boolean));

  // The server says this visit does not use this sheet: the parent opens the
  // full form, once. (No button on the sheet leads there.) Not while a saved
  // attempt is checked for or shown: a fresh full-form completion would race it.
  const handedOff = useRef(false);
  const holdsSaved = submission.recovering || submission.restored;
  useEffect(() => {
    if (ctx.handoff && !handedOff.current && !holdsSaved) {
      handedOff.current = true;
      onFullForm?.();
    }
  }, [ctx.handoff, holdsSaved, onFullForm]);

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
  const locked = submissionHolds(submission);

  return (
    <Frame isMobile={isMobile} dialogRef={dialogRef} titleId={titleId} dialogClassName="tech-lawn-sheet" onDismiss={close} hiddenProps={overlay ? INERT : undefined} overlay={overlay} suspended={suspended}>
      <LawnSheetHeader titleId={titleId} title={done ? 'Service complete' : 'Complete service'} showDetails={!done && !!onViewDetails} detailsDisabled={submitting || dictationPending} onDetails={() => onViewDetails?.()} backDisabled={submitting} onBack={close} />
      <SheetBody operatorId={operatorId} service={service} request={stopRequest} catalog={catalog} ctx={ctx} propertyAreas={propertyAreas} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={setDictationPending} onOverlay={setOverlay} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} refreshPlaces={refreshPlaces} sharedNote={sharedNote} />
    </Frame>
  );
}

function SheetBody({ operatorId, service, request, catalog, ctx, propertyAreas, submission, locked, dictationPending, onDictationPending, onOverlay, onCompleted, onFullForm, isMobile, refreshPlaces, sharedNote }) {
  if (submission.done) return <SavedView service={service} summary={submission.done.summary} notice={submission.done.notice} onCompleted={() => onCompleted?.(submission.done.response || null)} />;
  if (submission.recovering) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Checking for an unfinished completion…</ActionFeedback>;
  if (submission.restored) return <RecoveredCompletion submission={submission} />;
  const refusal = refusalWithoutContext(submission, ctx);
  if (refusal) return refusal;
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
  return <LawnFastForm operatorId={operatorId} service={service} request={request} catalog={catalog} ctx={ctx} propertyAreas={propertyAreas} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={onDictationPending} onOverlay={onOverlay} onFullForm={onFullForm} isMobile={isMobile} refreshPlaces={refreshPlaces} sharedNote={sharedNote} />;
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

// Whether a row's dose signature (see dosesRef) holds an amount: [totalAmount, unit, area, rate].
const hadAmount = (signature) => { try { const [amount] = JSON.parse(signature); return amount !== null && amount !== undefined && amount !== ''; } catch { return false; } };

// What /complete refused, less the amount refusals whose row's dose is not the dose it was refused at; a count or interval refusal stays.
function pruneAmountRefusals(refused, doses) {
  const kept = Object.fromEntries(Object.entries(refused).map(([id, byPlace]) => [id, Object.fromEntries(Object.entries(byPlace).filter(([, e]) => e.dose === null || e.dose === doses[id]))]).filter(([, byPlace]) => Object.keys(byPlace).length));
  return JSON.stringify(kept) === JSON.stringify(refused) ? refused : kept;
}

// GATE_LAWN_TROUBLE_AREAS: reads the place maps again after /complete refused a place (400 lawn_place_limit). The context is read aside
// (the sheet is never reset): its troubleAreas, weed mix and chinch decision replace the opening ones where it carries them, and
// `tick` makes the treatment guide read again. A read that fails changes nothing. `slot` is the ref the submit's error handler calls.
// `planKey` counts the plan re-reads the sheet rebuilt from (the rooted tick): what a refresh read for an earlier plan is not laid over a newer one.
function usePlaceRefresh({ base, request, ctx, planKey = 0, slot, idsRef, dosesRef }) {
  const [tick, setTick] = useState(0);
  const [fresh, setFresh] = useState(null);
  // What /complete refused, `{ [productId]: { [place]: { message, dose } } }`: authoritative, merged into the blocked map at once and kept.
  // A refusal of the yearly AMOUNT depends on the dose the tech entered (`dose`: that row's amount, unit, area and rate then); a count or an
  // interval refusal does not (`dose` null), so only the amount kind is dropped when the dose changes (pruneRefused).
  const [refused, setRefused] = useState({});
  // The products whose dose changed since /complete last refused them. A yearly-AMOUNT block in ANY map (the opening context, a refresh,
  // the guide's answer) was judged at the program dose, so it stops closing a chip once that row's dose has moved (see problemAt).
  const [moved, setMoved] = useState([]);
  const lastDoses = useRef(null);
  const refresh = useCallback((err) => {
    const { productId, place, error, limitType } = err?.details || {};
    const id = String(productId || '').toLowerCase();
    if (id) setMoved((prev) => (prev.includes(id) ? prev.filter((other) => other !== id) : prev));
    const entry = { message: error || err?.message, dose: limitType === 'annual_max_rate' ? (dosesRef?.current?.[id] ?? '') : null, cardOnly: err?.code === 'lawn_place_not_mapped' };
    if (productId && place) setRefused((prev) => ({ ...prev, [id]: { ...prev[id], [place]: entry } }));
    setTick((n) => n + 1);
    const ids = searchedIdsQuery(1, idsRef, '?');
    // Sod-aware, as the sheet's own read: the weed mix and the chinch decision come back with the same holds.
    request(`${base}/lawn-fast/context${ids}${ids ? '&' : '?'}${SOD_AWARE}`)
      .then((data) => setFresh({ planKey, values: { troubleAreas: troubleAreasOf(data), weedMix: weedMixOf(data), chinch: chinchOf(data) } }))
      .catch(() => {});
  }, [base, request, planKey]);
  slot.current = refresh;
  const placeCtx = useMemo(() => ({ ...ctx, ...Object.fromEntries(Object.entries((fresh?.planKey === planKey && fresh.values) || {}).filter(([, value]) => value)) }), [ctx, fresh, planKey]);
  // Drops the amount refusals whose row's dose is not the dose it was refused at; never touches a count or interval refusal.
  const pruneRefused = useCallback((doses) => {
    const before = lastDoses.current;
    lastDoses.current = doses;
    // A row that had no amount yet gets its first one: that is the dose the maps judged, not a change of it.
    const changed = before ? Object.keys(doses).filter((id) => id in before && before[id] !== doses[id] && hadAmount(before[id])) : [];
    if (changed.length) setMoved((prev) => [...new Set([...prev, ...changed])]);
    setRefused((prev) => pruneAmountRefusals(prev, doses));
  }, []);
  const messages = useMemo(() => Object.fromEntries(Object.entries(refused).map(([id, byPlace]) => [id, Object.fromEntries(Object.entries(byPlace).map(([place, e]) => [place, e.message]))])), [refused]);
  // The refusals that hold for a guide-card row only (a take-all place that is not mapped), `{ [productId]: { [place]: true } }`.
  const refusedCard = useMemo(() => Object.fromEntries(Object.entries(refused).map(([id, byPlace]) => [id, Object.fromEntries(Object.entries(byPlace).filter(([, e]) => e.cardOnly).map(([place]) => [place, true]))])), [refused]);
  return { tick, placeCtx, refused: messages, refusedCard, moved, pruneRefused };
}

// The sheet's places: the context's closed list and known areas (less the ones cleared here), with what is closed where taken from the
// guide's fresh read once it has answered, else the context's.
function useSheetAreas({ placeCtx, guide, cleared, refused, refusedCard, moved }) {
  const base = placeCtx.troubleAreas;
  const fresh = guide?.placeBlocked;
  const freshTypes = guide?.placeBlockedTypes;
  return useMemo(() => (base ? { ...base, known: base.known.filter((area) => !cleared.includes(area.id)), blocked: { ...base.blocked, ...fresh }, blockedTypes: { ...base.blockedTypes, ...freshTypes }, refused, refusedCard, moved } : null), [base, fresh, freshTypes, cleared, refused, refusedCard, moved]);
}

// GATE_LAWN_NEW_SOD_NOTE: the holds as the server last said them, and the rooted tick. The tick reads the holds again
// (`sodFresh`; `undefined` = the context's own).
function useSodHolds({ ctx, service, request, base, reconcilePlanned }) {
  const [sodFresh, setSodFresh] = useState(undefined);
  // True from the tick until the holds are read again: the sheet does not complete on the rows of the old holds.
  const [sodBusy, setSodBusy] = useState(false);
  // The tick is saved but the sheet has not read the plan and the holds again: '' or the sentence that says what to do.
  const [sodStale, setSodStale] = useState('');
  const saved = useRef(false);
  // The plan parts of the context as the server last gave them (null = the context's own): the plan may have changed since the sheet opened.
  const [planFresh, setPlanFresh] = useState(null);
  // Counts the re-reads the sheet rebuilt from: the treatment guide reads again with each (its cards name the plan's products).
  const [rereads, setRereads] = useState(0);
  const saveSodRooted = useCallback(async (sodLaidOn) => {
    try {
      await request(`${base}/lawn-fast/sod-rooted?${SOD_AWARE}`, { method: 'POST', body: JSON.stringify({ sodLaidOn }) });
    } catch (err) {
      // No answer from the server (the connection dropped, or the answer could not be read): the tick may be saved. The sheet
      // waits as it does after a save; the tick is idempotent, so tapping again is safe.
      if (!err?.status) {
        saved.current = true;
        setSodStale(SOD_UNSURE_MESSAGE);
        throw new Error(SOD_UNSURE_MESSAGE);
      }
      // The server says the sod record this sheet shows is not the current one: the rows here are the old record's, and the
      // sheet does not complete on them. The server's own sentence says to reopen the visit.
      if (SOD_RECORD_STALE_CODES.includes(err.code)) setSodStale(err.message || SOD_REOPEN_MESSAGE);
      // The tick was saved on an earlier tap and the server no longer offers it (404): this sheet cannot read the holds again.
      if (!(saved.current && err.status === 404)) throw err;
      setSodStale(SOD_REOPEN_MESSAGE);
      throw new Error(SOD_REOPEN_MESSAGE);
    }
    // The tick is saved from here: until a re-read succeeds the rows on the sheet are the old holds' rows, and the sheet does
    // not complete on them (a line the tick released would be recorded as skipped). Ticking again reads again.
    saved.current = true;
    setSodStale(SOD_REREAD_MESSAGE);
    // The weed lines un-hold on this re-read: the server's own words, not a guess here.
    const next = await request(`${base}/lawn-fast/context?${SOD_AWARE}`).then((data) => contextFrom(data, service)).catch(() => null);
    // A re-read that failed, that could not read the plan, or that could not check the sod record says nothing: the rows and
    // the holds stay as they were (no line is released, none is removed).
    if (!sodRereadUsable(next)) throw new Error(SOD_REREAD_MESSAGE);
    saved.current = false;
    setSodStale('');
    setSodFresh(next.newSod);
    // The whole plan part of the sheet follows the re-read (the add-ons, the weed mix and the chinch decision with the lines),
    // and so do the rows: a released line comes back, a line the plan dropped or the holds now keep off leaves.
    setPlanFresh(Object.fromEntries(PLAN_CONTEXT_FIELDS.map((key) => [key, next[key]])));
    reconcilePlanned(splitHeldPlanned(uniquePlanned(next.planned), next.newSod).start);
    setRereads((n) => n + 1);
  }, [request, base, service, reconcilePlanned]);
  const confirmSodRooted = useCallback(async (sodLaidOn) => {
    setSodBusy(true);
    try { await saveSodRooted(sodLaidOn); } finally { setSodBusy(false); }
  }, [saveSodRooted]);
  const liveCtx = useMemo(() => (planFresh ? { ...ctx, ...planFresh } : ctx), [ctx, planFresh]);
  return { newSod: sodFresh !== undefined ? sodFresh : ctx.newSod, liveCtx, rereads, confirmSodRooted, sodWait: sodBusy ? SOD_BUSY_MESSAGE : sodStale };
}

function LawnFastForm({ operatorId, service, request, catalog, ctx, propertyAreas, submission, locked, dictationPending, onDictationPending, onOverlay, onFullForm, isMobile, refreshPlaces, sharedNote }) {
  const base = `/admin/dispatch/${service?.id}`;
  // From the context's findingsType only (the live profile), never the schedule row.
  const typed = ctx.findingsType === LAWN_FINDINGS_TYPE;
  const products = useProductRows(ctx, catalog);
  // GATE_LAWN_NEW_SOD_NOTE: the holds as the server last said them. The rooted tick reads the plan and the holds again;
  // `sheetCtx` is the context with the plan parts of that last read (the opening context until then).
  const { newSod, liveCtx: sheetCtx, rereads: sodRereads, confirmSodRooted, sodWait } = useSodHolds({ ctx, service, request, base, reconcilePlanned: products.reconcilePlanned });
  // The place maps, read again when /complete refuses a place (the context aside, and the guide below).
  const searchedIds = useRef([]);
  const dosesRef = useRef({});
  const { tick: placeTick, placeCtx, refused, refusedCard, moved, pruneRefused } = usePlaceRefresh({ base, request, ctx: sheetCtx, planKey: sodRereads, slot: refreshPlaces, idsRef: searchedIds, dosesRef });
  // The photo step reports back: the confirmed assessment's id (null until
  // there is one), whether a lookup, analysis or confirm is in flight.
  const { assessmentId, assessmentReady, settles, onConfirmed, onReady } = useConfirmedAssessment(ctx.assessment);
  // An assessment lookup, analysis or confirm in flight (the photo step reports ready = false meanwhile).
  usePartBusy('lawn-assessment', assessmentReady === false);
  // A confirmed assessment the report would reject (made for the visit's
  // former property) does not count until the tech analyzes again.
  const unusable = !!assessmentId && !!ctx.assessment?.unusableReason && String(assessmentId) === String(ctx.assessment.id);
  // The treatment guide's cards for the confirmed assessment (not one the report would reject), and
  // what the tech checked on each.
  // The technician's tap on "Chinch bugs found at the edge of damage" (the lowercased product id), so the find is
  // recorded even when the product was already on the sheet (it came from another card) and the tap adds no row.
  const [chinchTap, setChinchTap] = useState(null);
  const onChinchTap = useCallback((productId) => setChinchTap(String(productId).toLowerCase()), []);
  // GATE_LAWN_TROUBLE_AREAS: the known areas the tech cleared on this sheet (and where the take-all ones were): the take-all card follows them at once.
  const [clearedAreas, setClearedAreas] = useState([]);
  const [clearedPlaces, setClearedPlaces] = useState([]);
  const { guide: rawGuide, status: guideStatus, guideChecks, onGuideCheck } = useTreatmentGuideState({ base, request, enabled: ctx.treatmentGuide, assessmentId, unusable, refreshKey: placeTick + sodRereads, planKey: sodRereads, idsRef: searchedIds });
  const guide = useMemo(() => withClearedTakeAll(rawGuide, { known: placeCtx.troubleAreas?.known, clearedIds: clearedAreas, clearedPlaces }), [rawGuide, placeCtx, clearedAreas, clearedPlaces]);
  // What the latest decision lets onto the sheet (one invariant), and the rows it dropped.
  const { gov, removed: removedByGuide } = useGuideGovernance({ ctx: placeCtx, guide, status: guideStatus, checks: guideChecks, products });
  // The one Weed spots decision on screen (the guide's fresh read once it has answered).
  const weedMix = effectiveWeedMix(guide, placeCtx);
  // The whole-lawn area: this visit property's recorded lawn area (or the area
  // the technician set when none is recorded), never a planned product's own
  // (possibly partial) area and never the customer-wide turf profile (at a
  // secondary property that can be the primary's lawn).
  const lawnSqft = propertyAreas.wholeLawn;
  // Every reader of the rows (Complete's checks, the stock hold, the body, the
  // cards) sees the figured amounts; only the tech's entries live in state.
  // The weed mix's one shared area (spot rules): typed or picked once, it applies to every row of the entry.
  const [weedArea, setWeedArea] = useState('');
  // GATE_LAWN_TROUBLE_AREAS: the weed entry's one place (as its one area), and the known areas the tech cleared on this sheet.
  const [weedPlace, setWeedPlace] = useState('');
  // GATE_LAWN_MIX_HELP: the shared tank size and the weed entry's gallons sprayed.
  const mix = useMixHelp(sheetCtx.mixHelp, operatorId);
  const areas = useSheetAreas({ placeCtx, guide, cleared: clearedAreas, refused, refusedCard, moved });
  const clearArea = useCallback(async (id) => {
    await request(`${base}/lawn-fast/trouble-areas/${encodeURIComponent(id)}/clear`, { method: 'POST', body: JSON.stringify({}) });
    setClearedAreas((prev) => [...prev, id]);
    const gone = placeCtx.troubleAreas?.known?.find((area) => area.id === id);
    if (gone?.type === 'take_all') setClearedPlaces((prev) => [...prev, gone.place]);
  }, [request, base, placeCtx]);
  const chinchDecision = effectiveChinch(guide, placeCtx);
  const rows = useMemo(
    () => {
      const spotted = products.rows.map((row) => withGallonsArea(withSpotArea(row, { spotRules: ctx.spotRules, weedMix, weedArea }), mix));
      const placed = areas ? withSpotPlaces(spotted, { areas, weedMix, chinch: chinchDecision, weedPlace, takeAll: gov.takeAll, takeAllPlaces: takeAllPlacesOf(guide, areas) }) : spotted;
      return placed.map((row) => withDerivedAmount(row, lawnSqft));
    },
    [products.rows, lawnSqft, ctx.spotRules, weedMix, weedArea, mix.help, mix.weedGallons, areas, chinchDecision, weedPlace, gov.takeAll, guide],
  );
  // The spot products on the sheet, named to the server when a refused place is read again (see searchedIdsQuery).
  searchedIds.current = rows.filter((row) => row.placeRule).map((row) => String(row.productId));
  // Each spot row's dose (what the yearly amount depends on); an amount refusal ends when its row's dose changes.
  dosesRef.current = Object.fromEntries(rows.filter((row) => row.placeRule).map((row) => [String(row.productId).toLowerCase(), JSON.stringify([row.totalAmount, row.amountUnit, row.spotArea ?? null, row.derivedRate?.rate ?? null])]));
  const doseKey = JSON.stringify(dosesRef.current);
  useEffect(() => { pruneRefused(JSON.parse(doseKey)); }, [doseKey, pruneRefused]);
  // Why the property areas hold Complete: the first read has not answered, or a
  // refresh after a refused completion has not brought a fresh version yet (or
  // failed: PropertyServiceAreas shows the error with Retry).
  let areaHold = '';
  if (!propertyAreas.settled) areaHold = 'Checking the lawn area\u2026';
  else if (propertyAreas.refreshing) areaHold = propertyAreas.failed ? 'The property areas did not reload. Tap Retry, then Complete.' : 'Reloading the property areas\u2026';
  const [ownForm, setForm] = useState({ note: '', condition: '', tipId: '', customTip: '', blogPost: null, customerHome: DEFAULT_CUSTOMER_HOME });
  // A stop's one note (sharedNote) stands in for this sheet's own: Analyze, the tip ranking and the body read it.
  const form = useSharedNoteForm(ownForm, sharedNote);
  // The optional lawn length (inches), the full form's own box; null until typed.
  const [gaugeHeightIn, setGaugeHeightIn] = useState(null);
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const dictating = useDictationSources(onDictationPending);
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);

  // The photo step reports back: the confirmed assessment's id (null until
  // there is one), whether a lookup, analysis or confirm is in flight, and how
  // many photos are held / whether an analysis result is on screen.
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
  const [traced, setTraced] = useState(false);

  const { stockRow, checkingStock, checkStock } = useStockHold({ ctx, service, rows, products, request });

  // Every lawn product is in the search (owner 2026-10-09). The search leaves out only a governed product
  // a limit that was READ forbids (the lead at its yearly limit, a chinch rung at its limit) and, before
  // the guide has answered, every governed product: the taps wait, and so does the search.
  const searchCatalog = useMemo(() => {
    // With no guide for the visit the weed group follows the context's own decision.
    const held = gov.enabled ? [] : readForbiddenIds({ weedMix, chinch: null });
    const hidden = (product) => {
      const id = String(product.id).toLowerCase();
      return (gov.governed.has(id) && !gov.searchable.has(id)) || held.includes(id);
    };
    return held.length || gov.governed.size ? catalog.filter((product) => !hidden(product)) : catalog;
  }, [catalog, weedMix, gov]);
  const picker = useProductPicker({
    line: 'lawn',
    products: searchCatalog,
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

  const guideHold = guideHoldReason({ gov, status: guideStatus, rows });
  // GATE_LAWN_NEW_SOD_NOTE: while the rooted tick is saved and the holds are read again, the sheet waits (a released line is not yet back).
  const missingReason = missingRequirement({ sodWait, noProductOk: noProductOkOf(newSod), form, rows, guideHold, lawnSqft, areaHold, gaugeHeightIn, photos: progress.photos, assessed: progress.assessed, assessmentId, assessmentReady, ctx, unusable, typed, dictationPending, stockRow });
  const barAction = barActionFor({ missingReason, dictationPending, progress, block });
  const buildBody = () => completionBody({ newSod, form, rows, ctx: sheetCtx, assessmentId, gaugeHeightIn, lawnSqft, propertyAreas: propertyAreas.data, explicitArea: propertyAreas.explicit, typed, tipsAvailable, guideCards: guideCardsOf(guide), guideChecks, chinchTap });
  // Prepare mode: a part is prepared only while it could be prepared right now, exactly when nothing is missing
  // (the Complete button; the confirmed assessment, a product, the areas and stock are all in missingReason).
  const canPrepare = !missingReason;
  const submit = () => {
    if (missingReason && !submission.hasPendingBody()) return;
    const names = rows.map((row) => row.name).join(', ');
    submission.submit(buildBody, [names, 'Lawn assessment confirmed'].filter(Boolean).join(' · '), { valid: canPrepare });
  };
  // A part of a stop (prepare mode): a change behind the handed-over body, or a part that can no longer be prepared
  // (an unconfirmed assessment after an edit), revokes it.
  useEffect(() => { submission.revokeIfChanged(buildBody, { valid: canPrepare }); });
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
        <SodBanner newSod={newSod} onRooted={confirmSodRooted} locked={locked} dictationPending={dictationPending} />
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={dictating.note} serviceId={service?.id} locked={locked} micInside shared={sharedNote != null} />
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
              closeUpPrompt={!!ctx.treatmentGuide}
            />
          </section>
          <ProductsSection mix={mix} ctx={sheetCtx} newSod={newSod} weedMix={weedMix} chinch={chinchDecision} areas={areas} onClearArea={clearArea} weedPlace={weedPlace} onWeedPlace={setWeedPlace} gov={gov} removedByGuide={removedByGuide} rows={rows} products={products} catalog={catalog} lawnSqft={lawnSqft} weedArea={weedArea} onWeedArea={(value) => { setWeedArea(value); if (value) mix.setWeedGallons(''); }} guide={guide} guideChecks={guideChecks} onGuideCheck={onGuideCheck} chinchTap={chinchTap} onChinchTap={onChinchTap} locked={locked || dictationPending} other={picker.button} popover={picker.popover} inlineSearch={picker.inlineSearch} />
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
              sentLast={false}
              priorityOrdered
              tipId={form.tipId}
              customTip={form.customTip}
              locked={locked}
              onPick={(id) => setForm((prev) => ({ ...prev, tipId: prev.tipId === id ? '' : id, customTip: '' }))}
              onCustom={(value) => setForm((prev) => ({ ...prev, customTip: value, tipId: value.trim() ? '' : prev.tipId }))}
              mic={{ serviceId: service?.id, onPendingChange: dictating.tip }}
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
function ProductsSection({ mix = null, ctx, newSod = null, weedMix, chinch, areas = null, onClearArea, onWeedPlace, gov, removedByGuide = { names: [] }, rows, products, catalog, lawnSqft, weedArea, onWeedArea, guide = null, guideChecks = {}, onGuideCheck, chinchTap = null, onChinchTap, locked, other, popover, inlineSearch }) {
  const { updateRow, removeRow, addProduct } = products;
  // The weed mix's one area control sits under its first row.
  const areaHost = rows.find((row) => row.weedGroup && row.spotRule);
  const surfactantNote = weedMix?.surfactant;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
      </div>
      {ctx.plannedUnavailable && !rows.some((row) => row.planned) && (
        <p className="tech-visit-muted" role="status">The planned products could not be loaded. Add what you applied.</p>
      )}
      {newSod?.noWholeLawn && <p className="tech-visit-muted" role="status">{newSod.noWholeLawn}</p>}
      {rows.map((row) => (
        <React.Fragment key={row.productId}>
          <ProductEditor
            row={row}
            methods={ctx.methods}
            lawnSqft={lawnSqft}
            locked={locked}
            note={[
              surfactantNote && row.weedGroup && sameId(surfactantNote.productId, row.productId) ? surfactantNote.note : takeAllRowNote(gov, row.productId),
              row.sodSwap?.reason,
              sodRowNote(newSod, row.productId),
            ].filter(Boolean).join(' ') || null}
            onChange={(patch) => updateRow(row.productId, patch)}
            onRemove={() => removeRow(row.productId)}
          >
            <RowMixHelp row={row} mix={mix} locked={locked} onChange={(patch) => updateRow(row.productId, patch)} />
            {row.placeRule && !row.weedGroup && areas ? <PlaceControl areas={areas} row={row} locked={locked} onChange={(place) => updateRow(row.productId, { pickedPlace: place })} /> : null}
            <SpotTargetControl row={row} config={ctx.spotTargets} chinch={chinch} chinchTap={chinchTap} takeAll={gov.takeAll} locked={locked} onChange={(patch) => updateRow(row.productId, patch)} />
          </ProductEditor>
          {row === areaHost && (
            <SpotAreaControl title="Weed spots" value={weedArea} locked={locked} onChange={onWeedArea}>
              {row.placeRule && areas ? <PlaceControl areas={areas} row={row} title="Weed spots" locked={locked} onChange={onWeedPlace} /> : null}
              <WeedMixHelp mix={mix} rows={rows.filter((other) => other.weedGroup && other.spotRule)} surfactant={surfactantNote} locked={locked} onWeedArea={onWeedArea} />
            </SpotAreaControl>
          )}
        </React.Fragment>
      ))}
      {areas && <KnownTroubleAreas known={areas.known} unavailable={areas.knownUnavailable} locked={locked} clear={onClearArea} />}
      <TreatmentGuide newSod={newSod} guide={guide} checks={guideChecks} onCheck={onGuideCheck} rows={rows} catalog={catalog} locked={locked} onAdd={addProduct} areas={areas} onWeedPlace={onWeedPlace} />
      {removedByGuide.names.length > 0 && <p className="tech-visit-muted" role="status">{`Removed: ${removedByGuide.names.join(', ')}. ${removedByGuide.why}`}</p>}
      <HeldLines items={splitHeldPlanned(uniquePlanned(ctx.planned), newSod).held} newSod={newSod} rows={rows} catalog={catalog} locked={locked} onAdd={addProduct} />
      <ProtocolAddOns newSod={newSod} addOns={ctx.addOns} month={ctx.addOnsMonth} weedMix={weedMix} chinch={chinch} areas={areas} onWeedPlace={onWeedPlace} guideCards={guideCardsOf(guide)} guideChecks={guideChecks} gov={gov} rows={rows} catalog={catalog} locked={locked} onAdd={addProduct} markChinch={ctx.lawnReportTies ? { tapped: chinchTap, onTap: onChinchTap } : null} />
      {inlineSearch || <OtherProductButton {...other} popover={popover} />}
    </section>
  );
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// "Also in October's protocol": the plan's opt-in products for this window,
// one tap each. Every word on a line is the plan's: the visit's substitute
// ("in place of" the original), the protocol line, the gate notes, the method
// and the rate. A product the sheet's catalog does not list cannot be built
// into a row and is left out; one already on the sheet reads as such.
// The add-ons the sheet's catalog can build into rows, split into the ones listed on their
// own and the Weed spots entry's (the products the server grouped are listed only as that
// entry; an entry whose products the catalog cannot all build is left out, like any add-on).
function splitAddOns(addOns, weedMix, catalog) {
  const byId = new Map((catalog || []).map((product) => [String(product.id).toLowerCase(), product]));
  const withProduct = (addOns || [])
    .map((item) => ({ ...item, product: byId.get(String(item.productId).toLowerCase()) || null }))
    .filter((item) => item.product);
  const grouped = new Set((weedMix?.groupProductIds || []).map((id) => String(id).toLowerCase()));
  const weedItems = (weedMix?.productIds || []).map((id) => withProduct.find((item) => sameId(item.productId, id)));
  return {
    items: withProduct.filter((item) => !grouped.has(String(item.productId).toLowerCase())),
    weedEntry: weedMix && weedItems.every(Boolean) ? weedItems : null,
    withProduct,
  };
}

// GATE_LAWN_TROUBLE_AREAS: the places the Weed spots entry can add for, each with what that place takes (the server's decision at
// that place), or null (no places: the one tap as before). A known weed area's place leads.
function weedPlaceChoices({ weedMix, areas, withProduct }) {
  if (!areas || !weedMix?.byPlace) return null;
  const known = knownPlacesOfType(areas, 'weeds');
  return areas.places.map((place) => {
    const decision = weedMix.byPlace[place.id];
    if (!decision || !['lead', 'replacement'].includes(decision.mode)) return null;
    const items = (decision.productIds || []).map((id) => withProduct.find((item) => sameId(item.productId, id)));
    return items.length && items.every(Boolean) ? { ...place, items, known: known.has(place.id) } : null;
  }).filter(Boolean).sort((a, b) => Number(b.known) - Number(a.known));
}

// The places the chinch entry can add for (the product each place takes), or null.
function chinchPlaceChoices({ chinch, areas }) {
  if (!areas || !chinch?.byPlace) return null;
  const known = knownPlacesOfType(areas, 'chinch');
  return areas.places.map((place) => {
    const item = chinch.byPlace[place.id]?.item;
    return item ? { ...place, item, known: known.has(place.id) } : null;
  }).filter(Boolean).sort((a, b) => Number(b.known) - Number(a.known));
}

// What the add-ons group lists. A product a visible card owns is on the card, not here; a card the
// guide shows for the weed mix or the chinch bugs IS that entry, so it is not listed twice. Nothing
// to add (the limit is reached) is still said, as a line.
function addOnsView({ addOns, weedMix, chinch, guideCards, guideChecks, gov, catalog, areas = null }) {
  const split = splitAddOns(addOns, weedMix, catalog);
  const cardShown = (kind) => !!guideCards?.some((card) => card.kind === kind) && guideChecks[kind] !== 'none';
  return {
    // Before the guide has answered a governed product waits in the list; after, the ones the latest
    // decision does not release to the list are not listed.
    items: split.items.filter((item) => {
      const id = String(item.productId).toLowerCase();
      return !gov.takeAll.has(id) && (gov.locked || !gov.hidden.has(id));
    }),
    weedEntry: split.weedEntry,
    showWeed: !cardShown('weeds') && !!weedMix && (split.weedEntry?.length > 0 || (!weedMix.productIds.length && !!weedMix.note)),
    showChinch: !cardShown('chinch') && !!chinch,
    weedPlaces: weedPlaceChoices({ weedMix, areas, withProduct: split.withProduct }),
    chinchPlaces: chinchPlaceChoices({ chinch, areas }),
  };
}

function ProtocolAddOns({ newSod = null, addOns, month, weedMix = null, chinch = null, areas = null, onWeedPlace, guideCards = null, guideChecks = {}, gov = NO_GOVERNANCE, rows, catalog, locked, onAdd, markChinch = null }) {
  const titleId = useId();
  const { items, weedEntry, showWeed, showChinch, weedPlaces, chinchPlaces } = addOnsView({ addOns, weedMix, chinch, guideCards, guideChecks, gov, catalog, areas });
  const placeLabels = areas ? Object.fromEntries(areas.places.map((place) => [place.id, place.label])) : {};
  if (!items.length && !showWeed && !showChinch) return null;
  const on = new Set(rows.map((row) => String(row.productId).toLowerCase()));
  const monthName = month ? MONTH_NAMES[month - 1] : null;
  return (
    <div className="tech-protocol-addons" role="group" aria-labelledby={titleId}>
      <div className="tech-protocol-addons-head">
        <h4 id={titleId} className="tech-protocol-addons-title">{monthName ? `Also in ${monthName}’s protocol` : 'Also in this month’s protocol'}</h4>
        <p className="tech-visit-muted">Tap what you applied.</p>
      </div>
      {showWeed && (
        <WeedSpotsEntry newSod={newSod} weedMix={weedMix} items={weedEntry || []} places={weedPlaces} labels={placeLabels} onPlace={onWeedPlace} on={on} locked={locked} waiting={gov.locked} onAdd={onAdd} />
      )}
      {showChinch && <ChinchFoundEntry newSod={newSod} chinch={chinch} catalog={catalog} places={chinchPlaces} labels={placeLabels} on={on} locked={locked} waiting={gov.locked} onAdd={onAdd} markChinch={markChinch} />}
      {items.map((item) => (
        <AddOnLine
          key={item.productId}
          item={item}
          sod={sodLineOf(newSod, item.productId)}
          onSheet={on.has(String(item.productId).toLowerCase())}
          // A product a guide card may own waits for the card (the fresh guide), then follows it.
          waiting={gov.locked && gov.governed.has(String(item.productId).toLowerCase())}
          unreadableNote={gov.unreadable.has(String(item.productId).toLowerCase()) ? gov.unreadableNote : ''}
          locked={locked}
          onAdd={onAdd}
        />
      ))}
    </div>
  );
}

// One opt-in product of the month: its name, the protocol's own words for it, and its tap.
function AddOnLine({ item, sod, onSheet, waiting, unreadableNote = '', locked, onAdd }) {
  const rate = Number(item.ratePer1000) > 0 && item.rateUnit ? `${item.ratePer1000} ${unitLabel(item.rateUnit)} per 1,000 sq ft` : '';
  const look = sodAddLook(sod);
  const why = [
    // GATE_LAWN_NEW_SOD_NOTE: the hold's reason (or the part-of-lawn skip note) leads the line.
    sodWords(sod),
    item.substituteFor ? `In place of ${item.substituteFor}` : '',
    item.line || '',
    ...(item.gateNotes || []),
    item.applicationMethod ? methodLabel(item.applicationMethod) : '',
    rate,
    // A product whose limit read failed is never silent: the one wording says what to do.
    unreadableNote,
  ].filter(Boolean).join(' · ');
  return (
    <div className={look.className}>
      <span className="tech-protocol-addon-text">
        <span className="tech-protocol-addon-name">{item.product.name}</span>
        <span className="tech-visit-muted">{waiting ? CONFIRM_FIRST : onSheet ? 'On the sheet' : why}</span>
      </span>
      {!waiting && (
        <Button
          type="button"
          variant="secondary"
          className="tech-visit-action tech-protocol-addon-add"
          aria-label={onSheet ? `${item.product.name} is on the sheet` : `Add ${item.product.name}${look.suffix}`}
          disabled={locked || onSheet}
          onClick={() => onAdd(item.product, { planned: item })}
        >
          {onSheet ? '✓' : look.label}
        </Button>
      )}
    </div>
  );
}

// What a guide-governed tap says until the fresh guide has answered (the sheet's order is assessment first).
const CONFIRM_FIRST = 'Confirm the assessment first.';

// "Weed spots": the server's one entry for the weed mix (lib: lawn-weed-mix.js). One tap
// opens the rows it names (each seeded from its own plan item, as a single add-on is) and
// they share one area. With nothing to add (the yearly limit is reached) it is a line only.
function WeedSpotsEntry({ newSod, weedMix, items, places = null, labels = {}, onPlace, on, locked, waiting = false, onAdd }) {
  // What a tap adds: with places (GATE_LAWN_TROUBLE_AREAS) one set per place, each tap naming its place; else the one set.
  const options = places || (items.length ? [{ id: '', items }] : []);
  const onSheet = (ids) => ids.some((id) => on.has(String(id).toLowerCase()));
  // With places any of the group on the sheet closes the entry (the rows' place is then changed on their place control).
  const done = places ? onSheet(weedMix.groupProductIds || []) : items.length > 0 && items.every((item) => onSheet([item.productId]));
  const names = items.map((item) => item.product.name).join(', ');
  // What differs by place (a place at its limit, a place that takes the replacement) is said by place.
  const byPlace = places ? Object.entries(weedMix.byPlace || {}).filter(([, d]) => d.note && d.note !== weedMix.note) : [];
  // GATE_LAWN_NEW_SOD_NOTE: the entry's products are one weed killer class, so one hold line speaks for them.
  const sod = items.map((item) => sodLineOf(newSod, item.productId)).find(Boolean);
  const look = sodAddLook(sod);
  const line = [done ? 'On the sheet' : names, sodWords(sod), weedMix.note, ...byPlace.map(([id, d]) => `${labels[id] || id}: ${d.note}`)];
  const add = (option) => {
    option.items.forEach((item) => onAdd(item.product, { planned: item, weedGroup: true, guided: 'weeds', ...(places ? { source: 'tech_tap' } : {}) }));
    if (places) onPlace(option.id);
  };
  return (
    <div className={look.className}>
      <span className="tech-protocol-addon-text">
        <span className="tech-protocol-addon-name">Weed spots</span>
        <span className="tech-visit-muted">{waiting ? CONFIRM_FIRST : line.filter(Boolean).join(' · ')}</span>
      </span>
      {options.length > 0 && !waiting && (places && !done
        ? <PlaceAddButtons choices={places} locked={locked} ariaPrefix="Add weed spots" onPick={(placeId) => add(places.find((choice) => choice.id === placeId))} />
        : (
          <Button type="button" variant="secondary" className="tech-visit-action tech-protocol-addon-add" aria-label={done ? 'Weed spots are on the sheet' : `Add weed spots${look.suffix}`} disabled={locked || done} onClick={() => add(options[0])}>
            {done ? '✓' : look.label}
          </Button>
        ))}
    </div>
  );
}

// The catalog product a plan-shaped item stands for. A product the sheet's catalog does not list
// still opens as a row, built from the item's name, like a planned row (plannedRows).
const catalogProductFor = (item, catalog) => (catalog || []).find((product) => sameId(product.id, item.productId)) || { id: item.productId, name: item.name || 'Product' };

// The guide's cards, or null while there is no guide.
const guideCardsOf = (guide) => (guide ? guide.cards : null);

// The plan's notes for the products a card offers (a watering hold), each once.
const gateNotesOf = (items) => [...new Set(items.flatMap((item) => item.gateNotes || []))];

// Every product a card offers is on the sheet (a half-added weed mix is not: its tap finishes it).
// What each place takes, said by place, only when the places differ from one another ("Front: Blind Herbicide", "Back: Lead WG, ...").
function placeSets(card, areas) {
  const entries = cardPlaceEntries(card);
  const sets = entries.map(([id, entry]) => [id, entry.items.map((item) => item.name).join(', ')]);
  if (!areas || new Set(sets.map(([, names]) => names)).size < 2) return [];
  return sets.map(([id, names]) => `${areas.places.find((place) => place.id === id)?.label || id}: ${names}`);
}

// What the completion's guide record says of one card: the products actually added (a flat list of ids, as for any card) and, for a card
// taken at a place, the place as an extra field. One rule for every card: the record's place is the place of the row the card added. A card
// with a set per place (weeds, chinch) records the set of the place the tech took; any other card (fungus, take-all, caterpillar, dry spot)
// records the place its own row carries. A card not taken, or whose row has no place, records exactly what it always did.
function guideRecordCard(card, { checks, on, rows }) {
  const record = { kind: card.kind, shown: true, checked: checks[card.kind] || null, taken: cardOnSheet(card, on), productIds: card.productIds };
  if (!record.taken) return record;
  const onSheet = (item) => on.has(String(item.productId).toLowerCase());
  const taken = cardPlaceEntries(card).filter(([, entry]) => entry.items.every(onSheet));
  if (!taken.length) {
    const ids = lowerIds(card.productIds);
    const place = rows.find((row) => row.place && ids.includes(String(row.productId).toLowerCase()))?.place;
    return place ? { ...record, place } : record;
  }
  // Several places can share one set; the place is the one the rows of that set carry.
  const placeOf = ([, entry]) => rows.find((row) => sameId(row.productId, entry.items[0].productId))?.place;
  const [place, entry] = taken.find((candidate) => placeOf(candidate) === candidate[0]) || taken[0];
  return { ...record, productIds: entry.items.map((item) => item.productId), place };
}

const cardOnSheet = (card, on) => {
  const everyOn = (ids) => ids.length > 0 && ids.every((id) => on.has(String(id).toLowerCase()));
  const places = cardPlaceEntries(card);
  // With places, a card is taken once ANY place's own set is on the sheet.
  return places.length ? places.some(([, entry]) => everyOn(entry.items.map((item) => item.productId))) : everyOn(card.productIds);
};

// "Suggested from this lawn" (GATE_LAWN_TREATMENT_GUIDE): one card per photo finding. The server
// decided every word and every product; this renders them and performs the taps. A card with a
// check asks the tech to do it first: "Found at the edge. Add it" opens the product as a spot row (the
// same path as a single add-on tap) and "Nothing found" dismisses the card. The weed card is the
// Weed spots entry's own tap. Nothing is added by itself.
// The new-sod words for a guide card: the hold reason (or the part-of-lawn note) of every product the card can add, each once.
function sodCardWords(card, newSod) {
  const items = [...(card.items || []), ...Object.values(card.byPlace || {}).flatMap((decision) => decision?.items || [])];
  return [...new Set(items.map((item) => sodWords(sodLineOf(newSod, item.productId))).filter(Boolean))];
}

function TreatmentGuide({ newSod = null, guide, checks, onCheck, rows, catalog, locked, onAdd, areas = null, onWeedPlace }) {
  const titleId = useId();
  const cards = guideCardsOf(guide);
  if (!cards) return null;
  const visible = cards.filter((card) => checks[card.kind] !== 'none');
  // Cards that were all dismissed leave nothing to show; a lawn with no findings says so.
  if (cards.length && !visible.length) return null;
  const on = new Set(rows.map((row) => String(row.productId).toLowerCase()));
  // The tap adds what THIS card names (the fresh read), the weed card's rows as the entry's rows.
  const add = (card) => {
    card.items.forEach((item) => onAdd(catalogProductFor(item, catalog), { planned: item, guided: card.kind, source: 'guide_card', ...(card.kind === 'weeds' ? { weedGroup: true } : {}) }));
    if (card.check) onCheck(card.kind, 'found');
  };
  // GATE_LAWN_TROUBLE_AREAS: a card with a decision per place adds a place's own set with one tap on the place (the weeds card as
  // the Weed spots entry, the chinch card as the chinch entry), so a place that needs the replacement or the second product is
  // never out of reach. The weeds card names the place on the entry's shared control; the chinch card on the row.
  const addAt = (card, placeId) => {
    card.byPlace[placeId].items.forEach((item) => onAdd(catalogProductFor(item, catalog), {
      planned: item, guided: card.kind, source: 'guide_card', ...(card.kind === 'weeds' ? { weedGroup: true } : { place: placeId }),
    }));
    if (card.kind === 'weeds') onWeedPlace?.(placeId);
    if (card.check) onCheck(card.kind, 'found');
  };
  const placeChoices = (card) => {
    if (!areas) return [];
    const known = knownPlacesOfType(areas, card.kind === 'weeds' ? 'weeds' : 'chinch');
    return cardPlaceEntries(card)
      .map(([id]) => ({ id, label: areas.places.find((place) => place.id === id)?.label || id, known: known.has(id) }))
      .sort((a, b) => Number(b.known) - Number(a.known));
  };
  return (
    <div className="tech-protocol-addons tech-guide" role="group" aria-labelledby={titleId}>
      <div className="tech-protocol-addons-head">
        <h4 id={titleId} className="tech-protocol-addons-title">Suggested from this lawn</h4>
        <p className="tech-visit-muted">From the photos you confirmed. Tap what you applied.</p>
      </div>
      {!cards.length && <p className="tech-guide-empty tech-visit-muted" role="status">Nothing extra suggested from the photos.</p>}
      {visible.map((card) => {
        const onSheet = cardOnSheet(card, on);
        return (
          <div key={card.kind} className="tech-guide-card" role="group" aria-label={`${card.title} suggestion`}>
            <p className="tech-protocol-addon-name">{card.title}</p>
            <p className="tech-visit-muted">{card.finding}</p>
            {card.check && <p className="tech-guide-check">{card.check}</p>}
            {card.detail && <p className="tech-visit-muted">{card.detail}</p>}
            {gateNotesOf(card.items).map((gateNote) => <p key={gateNote} className="tech-visit-muted">{gateNote}</p>)}
            {card.note && <p className="tech-visit-muted" role="status">{card.note}</p>}
            {/* GATE_LAWN_NEW_SOD_NOTE: what the new-sod holds say about a product this card names, before its action. */}
            {!onSheet && sodCardWords(card, newSod).map((words) => <p key={words} className="tech-visit-status--warn" role="status">{words}</p>)}
            {placeSets(card, areas).map((line) => <p key={line} className="tech-visit-muted">{line}</p>)}
            {/* A check-only card (take-all, no trouble area on file) has no product to add. */}
            <div className="tech-guide-actions">
              {card.actionLabel && !onSheet && placeChoices(card).length > 0 && (
                <PlaceAddButtons choices={placeChoices(card)} locked={locked} ariaPrefix={card.actionLabel} onPick={(placeId) => addAt(card, placeId)} />
              )}
              {card.actionLabel && (onSheet || placeChoices(card).length === 0) && (
                <Button
                  type="button"
                  variant="secondary"
                  className="tech-visit-action tech-protocol-addon-add"
                  aria-label={onSheet ? `${card.title}: on the sheet` : undefined}
                  disabled={locked || onSheet}
                  onClick={() => add(card)}
                >
                  {onSheet ? 'On the sheet' : card.actionLabel}
                </Button>
              )}
              {card.dismissLabel && !onSheet && (
                <Button type="button" variant="secondary" className="tech-visit-action tech-protocol-addon-add" disabled={locked} onClick={() => onCheck(card.kind, 'none')}>
                  {card.dismissLabel}
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// "Chinch bugs found at the edge of damage": the standing entry of the optional list in every month (owner 2026-10-08).
// Any chinch bugs the tech finds are treated in any month without asking the office; the photo
// card is seasonal, this tap is not. The server picked the product (Arena, else the bifenthrin
// product at the Arena yearly limit) and says why; with nothing to add it is a line only.
// The button's states: not on the sheet (Add), on the sheet and markable while the ties are live (Found), on the sheet (✓). A state is a row
// of this table, so a new state is a new row.
const CHINCH_BUTTON = {
  add: { aria: 'Add chinch bug treatment', text: 'Add', disabled: false },
  mark: { aria: 'Chinch bugs found: mark the treatment on the sheet', text: 'Found', disabled: false },
  done: { aria: 'Chinch bug treatment is on the sheet', text: '✓', disabled: true },
};

function ChinchFoundEntry({ newSod, chinch, catalog, places, labels, on, locked, waiting, onAdd, markChinch }) {
  const { item, note } = chinch;
  // What a tap can add: with places (GATE_LAWN_TROUBLE_AREAS) one product per place, each tap naming its place; else the one product.
  const options = places || (item ? [{ id: '', item }] : []);
  const offered = [item, ...Object.values(chinch.byPlace || {}).map((decision) => decision.item)];
  const onSheetItem = offered.find((product) => product && on.has(String(product.productId).toLowerCase()));
  const onSheet = !!onSheetItem;
  // While the report ties are live, a product already on the sheet (it came from another card) can still be tapped "found": the tap
  // marks it as the technician's chinch find; it adds no row. Tapped once, it reads ✓.
  const canMark = onSheet && !!markChinch && markChinch.tapped !== String(onSheetItem.productId).toLowerCase();
  const button = CHINCH_BUTTON[canMark ? 'mark' : (onSheet ? 'done' : 'add')];
  const names = [...new Set(options.map((option) => option.item.name))];
  // What differs by place (a place at its limit, a place that takes the second product) is said by place.
  const byPlace = Object.entries(chinch.byPlace || {}).filter(([, d]) => d.note && d.note !== note);
  // GATE_LAWN_NEW_SOD_NOTE: a chinch product a hold covers (Dylox at the end of the ladder) says so; the tap still works.
  const sod = options.map((option) => sodLineOf(newSod, option.item.productId)).find(Boolean);
  const line = [names.length ? `${names.join(' or ')}, spot treatment` : null, sodWords(sod), ...(item?.gateNotes || []), note, ...byPlace.map(([id, d]) => `${labels[id] || id}: ${d.note}`)];
  const add = (option) => {
    onAdd(catalogProductFor(option.item, catalog), { planned: option.item, guided: 'chinch', ...(places ? { source: 'tech_tap', place: option.id } : {}) });
    if (markChinch) markChinch.onTap(option.item.productId);
  };
  const press = () => (canMark ? markChinch.onTap(onSheetItem.productId) : add(options[0]));
  return (
    <div className="tech-protocol-addon">
      <span className="tech-protocol-addon-text">
        <span className="tech-protocol-addon-name">Chinch bugs found at the edge of damage</span>
        <span className="tech-visit-muted">{waiting ? CONFIRM_FIRST : onSheet ? 'On the sheet' : line.filter(Boolean).join(' · ')}</span>
      </span>
      {options.length > 0 && !waiting && (places && !onSheet
        ? <PlaceAddButtons choices={places} locked={locked} ariaPrefix="Add chinch bug treatment" onPick={(placeId) => add(places.find((choice) => choice.id === placeId))} />
        : <Button type="button" variant="secondary" className="tech-visit-action tech-protocol-addon-add" aria-label={button.aria} disabled={locked || button.disabled} onClick={press}>{button.text}</Button>)}
    </div>
  );
}

// The area a spot row went down on: quick sizes and a typed box (owner 2026-10-08).
function SpotAreaControl({ title = null, value, locked, onChange, children = null }) {
  const areaId = useId();
  return (
    <div role="group" aria-label={title || 'Area treated'} className={title ? 'tech-spot-area tech-product-editor' : 'tech-spot-area'}>
      {title && <p className="tech-product-editor-label">{title}</p>}
      <label htmlFor={areaId} className="tech-product-editor-label">Area treated (sq ft)</label>
      <div className="tech-visit-tile-grid">
        {SPOT_AREA_SIZES.map((size) => (
          <Chip disabled={locked} key={size} label={`${size.toLocaleString('en-US')} sq ft`} pressed={Number(value) === size} onClick={() => onChange(String(size))} />
        ))}
      </div>
      <Input
        id={areaId}
        className="tech-visit-control tech-product-amount-input"
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        disabled={locked}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
      />
      {children}
    </div>
  );
}

// A product: its name, how it goes down (the method chips, and the area it will
// submit when the method needs one), the amount, and Remove.
function ProductEditor({ row, methods, lawnSqft, locked, note = null, onChange, onRemove, children = null }) {
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
        <span className="tech-visit-muted">{[categoryLabel(row.product), row.fromProtocol ? 'from the protocol' : row.added ? 'added by you' : 'planned'].filter(Boolean).join(' · ')}</span>
      </div>
      <MethodSection row={row} methods={methods} locked={locked} onChange={onChange} layout="select" />
      {areaText && <p className="tech-visit-muted">{areaText}</p>}
      {/* Spot rules: a weed-mix row reads the entry's shared area; any other spot row asks for its own. */}
      {row.spotRule && !row.weedGroup && !row.spotExempt && <SpotAreaControl value={row.spotSqft} locked={locked} onChange={(value) => onChange({ spotSqft: value, spotGallons: '' })} />}
      {row.spotRule && row.spotArea > 0 && <p className="tech-visit-muted">{`Spot area, ${row.spotArea.toLocaleString('en-US')} sq ft`}</p>}
      {/* GATE_LAWN_TROUBLE_AREAS: where the spot went (the caller's place control; a weed-mix row reads the entry's shared place). */}
      {children}
      {note && <p className="tech-visit-muted" role="status">{note}</p>}
      {(row.gateNotes || []).map((gateNote) => <p key={gateNote} className="tech-visit-muted" role="status">{gateNote}</p>)}
      <AmountRow row={row} rate={NO_RATE} onChange={onChange} />
      {row.derivedNote && <p className="tech-visit-muted">{row.derivedNote}</p>}
      {!hasAmount(row) && <p className="tech-visit-muted" role="status">No amount entered. It is recorded without one.</p>}
      <div className="tech-product-editor-actions">
        <Button type="button" variant="secondary" className="tech-visit-action tech-product-remove" disabled={locked} onClick={onRemove}>Remove</Button>
      </div>
    </div>
  );
}
