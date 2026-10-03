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
// Records what the application record needs. The HOUSE PEST MIX (Taurus SC,
// Atticus Talak 7.9 F, LESCO 90/10 surfactant — lib/pest-default-mix.js)
// starts on the sheet; "+ Other product" adds any other catalog product
// (FastCompleteProductPicker.jsx) with the amount the tech types, in units a
// truck can measure (lib/fast-complete-products.js: never mL; tsp goes to
// the server as fl oz). Per product: amount, rate, how it went down (the How
// row for sprays unless the tech picks another way for an added product),
// pests targeted and where; plus the activity seen when the server keeps a
// tech rating. It submits the FULL completion endpoint (POST
// /admin/dispatch/:id/complete → completeScheduledService), NOT
// /pest-recap: the full path records per-product method, targets, amounts,
// rates and areas. "Full form" opens the full completion screen — the
// Dispatch CompletionPanel — before any attempt may have reached the
// server; so does "+ Other product" when the product list did not load.
//
// Customer text (dark, GATE_FAST_COMPLETE_RECAP, `service.recapEnabled`): off,
// the sheet pins sendCompletionSms / requestReview / includePayLink to false
// and the customer gets nothing. On, it asks for the ONE fixed re-service text
// (customerRecapMode 'reservice_fixed'); the SERVER builds it from the saved
// facts (address, where, pests, products) and sends it through its normal send
// path, so consent, STOP and opt-out checks still apply. No customer wording
// lives here, no review ask and no pay link go with it, and after Complete the
// tech sees the exact text that went (or why none did) from the response.
//
// The layout is compact (three/four-across choice rows, the note behind a
// tap) so the choices fit a typical phone screen; the Complete button is
// pinned in the footer either way.
//
// Product catalog and visit identity come from the SAME context endpoint
// ServiceRecapModal loads (GET /admin/dispatch/:id/pest-recap/context).
//
// Report flow (GATE_FAST_COMPLETE_REPORT, owner "ok go" 2026-10-01): with
// `service.reportFlow`, the sheet opens for any open untyped pest visit (a
// re-service or a regular visit) and runs talk, generate the AI report,
// read it, trace the spray, send. The tech talks into the note, adds photos,
// taps whether the customer was home (not home, full access, picked every
// time), the pest activity 1 to 5, one tip and the promise check, then
// generates the report (POST /admin/schedule/generate-report, the full
// form's own request) and reads it before anything goes. Where product went
// down and the pests named are read from the note (POST
// /admin/dispatch/:id/voice-facts, owner 2026-09-30: those facts are voice
// only) and shown under the report. A saved perimeter trace makes the
// sprays perimeter sprays at the trace's length; without one they are spot
// treatments. Complete & send posts /complete as the full form does: the
// visit bills at finish, the customer gets the report text, a regular visit
// also gets the pay link and the review ask (never a re-service). The pieces
// live in FastCompleteReport.jsx.
//
// The frame, header, saved view, note, tip picker and tiles are shared with
// every Fast Complete sheet (FastCompleteParts.jsx), as is the /complete
// submit (hooks/useFastCompleteSubmit.js); products, photos, pests and the
// completion body are this sheet's own.
import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { isPestDefaultMixVisit, pestDefaultMixSelections } from '../../lib/pest-default-mix';
import { defaultApplicationMethodForLine, prefillRateCeiling, resolveRatePrefill } from '../../lib/product-rate-prefill';
import { recapVisitIdentity } from '../../hooks/useServiceRecapDraft';
import {
  UNIT_CHOICES, amountText, categoryLabel, hasAmount, isOutOfStock, productUnits, seededAmount, stockHolds,
} from '../../lib/fast-complete-products';
import { isMlUnit, submittedAmount } from '../../lib/measure-units';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import { WarningIcon } from './FastCompleteProductPicker';
import RATE_UNITS from '../../../../shared/rate-units.json';
import TechServicePhotosModal from './TechServicePhotosModal';
import TechTreatmentZoneModal from './TechTreatmentZoneModal';
import {
  ActivitySection, CollectPayment, ConfirmPrompt, CustomerHomeSection, DEFAULT_CUSTOMER_HOME, FIRST_VISIT_RATING, PhotoStripSection,
  BlogPostSection, EMPTY_LANE_RECORD, EMPTY_TYPED_RECORD, InspectionCreditToggle, LaneRecordCard, PromisesSection, ReportCard, SentSummary, StepFooter,
  TechNoteBoxPhotos, TraceSection, TypedRecordCard, changeTypedRecord, laneRecordNeedsAction, mergeTypedRecord, scoreTypedRecord, typedCardFields,
  typedScoreIsTechs,
  WritingView, changeLaneRecord, customerHomeWriterLabel, factsHold, mergeLaneRecord, perimeterFeetOf, photoCaptionsOf, useBlogPostOffer,
  useVisitPhotos, useVisitPromises, useVisitTrace,
} from './FastCompleteReport';
import { promiseMarksPayload } from '../schedule/PromiseCheck';
import { SERVICE_COMPLETION_PRESETS } from '../../lib/service-completion-presets';
import AREA_SCOPES from '../../../../shared/treatment-area-scopes.json';
import {
  completionAreasForTypedFindings, parseApplicationAreas, trapSetupConflicts, typedActivityScoreConflict, typedFieldRequiredNow,
  typedFormTakesPlaces, typedTreatmentAreaField, typedZeroStateRefusesBody,
} from '../../lib/typed-findings-rules';
import {
  AmountEntry, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, SavedView,
  SheetHeader, TipSection, VisitNote, customerNameOf, techTipsOf, toggleInSet, useProductPicker, useTipLibrary,
  visitChangedSinceSchedule,
} from './FastCompleteParts';
import {
  OfficeNote, ProductHeardLines, VisitHeardLine, VoiceFillMicBar, VoiceFillReview, useVoiceFillSheet,
} from './FastCompleteVoiceFill';
import { Button, Field, Input, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

const unitLabel = (unit) => String(unit || '').replace(/_/g, ' ');

// How the SPRAY products went down. Spot treatment needs no measured area;
// a perimeter spray records its linear feet (the application record's area
// and the server's perimeter-footage check).
const METHOD_CHOICES = [
  { value: 'spot_treatment', label: 'Spot treatment' },
  { value: 'perimeter_spray', label: 'Perimeter spray' },
];
const SPRAY_METHODS = new Set(METHOD_CHOICES.map((choice) => choice.value));
// Every way a product goes down as a spray, a catalog's own method included
// (product-rate-prefill.js): a note that says "didn't spray" contradicts any
// of them, not only the How row's two (codex local r17).
const SPRAYED_METHODS = new Set(['perimeter_spray', 'spot_treatment', 'broadcast_spray', 'foliar_spray', 'fog_ulv', 'pin_stream']);
// The How row's starting pick.
const DEFAULT_METHOD = 'spot_treatment';
// The ways an added product can go down, beside its own catalog method.
const ROW_METHOD_CHOICES = [
  ...METHOD_CHOICES,
  { value: 'bait_placement', label: 'Bait placement' },
  { value: 'granular_broadcast', label: 'Granular' },
];
// A lane visit's products (GATE_LANE_VOICE_FILL) also go down the ways the
// full form records specialty work: a yard broadcast, a mosquito barrier
// mist, a mound drench.
const LANE_METHOD_CHOICES = [
  ...ROW_METHOD_CHOICES,
  { value: 'broadcast_spray', label: 'Broadcast spray' },
  { value: 'fog_ulv', label: 'Fog/ULV' },
  { value: 'soil_drench', label: 'Soil drench' },
];

// The line a lane visit's products resolve on, as the full form resolves
// them: the mosquito lane's own (a methodless liquid is a barrier mist),
// every other lane the pest line, bed bug's indoors.
const laneProductLine = (lane) => ({ serviceLine: lane === 'mosquito' ? 'mosquito' : 'pest', interiorLane: lane === 'bed_bug_treatment' });
// A rate goes on the record only in a unit /complete accepts: the server's
// own list (shared/rate-units.json, read by inventory-units.js), matched
// trimmed and case-blind as it matches them, less its mL units, which this
// sheet never shows (owner ruling 2026-09-27) — a rate the tech can't see
// is not one they confirmed. Any other unit (a catalog oddity such as
// "percent_solution") leaves the row without a rate rather than have the
// server refuse the whole visit.
const SENDABLE_RATE_UNITS = new Set(RATE_UNITS.filter((unit) => !isMlUnit(unit)));
export const isSendableRateUnit = (unit) => SENDABLE_RATE_UNITS.has(String(unit || '').trim().toLowerCase());
// With no method of its own in the catalog, the shared pest resolver calls
// anything outside a bait category a spray, which then follows the How row.
// A product's form — its name, category or catalog formulation — says
// otherwise: a sprayable dry form (WSG, WDG, WG, WP, DF, SG, soluble
// granules) still follows the How row, but a bait, block, station or gel
// is placed and a granule is broadcast.
const SPRAYED_DRY_FORM = /\b(wsg|wdg|wg|wp|df|sg|soluble)\b/i;
const PLACED_FORM = /\b(baits?|blox|stations?|gels?)\b/i;
const BROADCAST_FORM = /\bgranul\w*/i;

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

// Why the live context can't be completed here, or '' when it can: the
// schedule row the tech tapped may be stale, so the loaded visit must still
// be that visit (same customer, day and property), still an open pest
// re-service (any open pest visit in the report flow), and still eligible
// for the short form (not typed or project-backed).
// The report flow opens on any open pest visit, so the live visit must still
// be the service the tech tapped (the header shows the schedule's): an office
// edit that changed the service since the schedule loaded is a changed visit.
function serviceChangedSinceSchedule(visit, service) {
  // The row's stored label, as the context reports it (the schedule shows a
  // cleaned-up one).
  const changedType = service?.routedServiceType && visit?.serviceType
    && String(service.routedServiceType).trim() !== String(visit.serviceType).trim();
  const changedKey = service?.routedServiceKey && visit?.serviceKey && service.routedServiceKey !== visit.serviceKey;
  return !!(changedType || changedKey);
}

// The lane a report-flow visit was routed as (GATE_LANE_VOICE_FILL): the
// lane the live visit must still read as, and whose record the sheet reads.
const routedLaneOf = (service) => (service?.reportFlow === true && service.laneFlow === true ? service.laneKey || null : null);
// The typed form a report-flow visit was routed as (GATE_TYPED_VOICE_FILL):
// the form the live visit must still read as, and whose record the sheet
// reads.
const routedTypedOf = (service) => (service?.reportFlow === true && service.typedFlow === true ? service.typedType || null : null);

// Whether the live visit is still one this sheet takes as it was routed: a
// lane visit its lane, a typed visit its form, any other one the short form.
function routeStillHolds(context, service) {
  if (service?.typedFlow) return context?.typedType === service.typedType;
  if (service?.laneFlow) return context?.lane === service.laneKey;
  return context?.eligible === true;
}

function blockedReasonFor(context, service) {
  const visit = context?.service || {};
  if (visitChangedSinceSchedule(visit, service) || (service?.reportFlow && serviceChangedSinceSchedule(visit, service))) {
    return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  }
  if (!service?.reportFlow && visit.serviceKey !== 'pest_re_service') return 'This visit is no longer a pest re-service. Use the full form.';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  // A lane visit (GATE_LANE_VOICE_FILL) must still read as the lane the
  // schedule routed it for, a typed visit (GATE_TYPED_VOICE_FILL) as its
  // form; any other visit must still be one the short form takes.
  if (!routeStillHolds(context, service)) return 'This visit needs the full form.';
  return '';
}

// A row keeps its catalog product: its method comes from the catalog (the
// shared pest resolver, then the product's form) unless it is a spray, which
// follows the How row, or the tech picked another way for an added product;
// its rate is resolved at the method actually submitted — the same resolver
// the full form seeds the mix with — so the record's method and rate agree.
// Its measure and starting unit are fixed when it lands on the sheet
// (lib/fast-complete-products.js), so a later How change never re-labels an
// amount already typed. What the tech typed wins.
function productRow(product, { serviceType, totalAmount = '', common = null, visitMethod = DEFAULT_METHOD, added = false, lane = null }) {
  const row = {
    product,
    productId: product.id,
    name: product.name,
    catalogMethod: catalogMethodOf(product, serviceType, lane),
    // A lane visit's row resolves on its lane's line and offers its ways.
    lane,
    // The unit the catalog states the label rate in; '' when it names none
    // (the rate resolver then falls back to a bare "oz" of its own).
    labelUnit: String(product.default_unit || product.rate_unit || '').trim(),
    methodInput: null,
    rateInput: null,
    active: true,
    added,
  };
  const { dimension, unit } = productUnits(product, { common, method: rowMethod(row, visitMethod) });
  const seeded = seededAmount(totalAmount, unit);
  return { ...row, dimension, totalAmount: seeded.amount, amountUnit: seeded.unit };
}

function catalogMethodOf(product, serviceType, lane = null) {
  const { serviceLine, interiorLane } = laneProductLine(lane);
  const resolved = defaultApplicationMethodForLine(product, serviceLine, { serviceType, interiorLane });
  if (product.application_method || product.method || !SPRAY_METHODS.has(resolved)) return resolved;
  const form = `${product.name || ''} ${product.category || ''} ${product.formulation || ''}`;
  if (SPRAYED_DRY_FORM.test(form)) return resolved;
  if (PLACED_FORM.test(form)) return 'bait_placement';
  return BROADCAST_FORM.test(form) ? 'granular_broadcast' : resolved;
}

// A spray with no way picked for it goes down the way the How row says.
const followsVisitMethod = (row) => !row.methodInput && SPRAY_METHODS.has(row.catalogMethod);

function rowMethod(row, sprayMethod) {
  if (row.methodInput) return row.methodInput;
  return SPRAY_METHODS.has(row.catalogMethod) ? sprayMethod : row.catalogMethod;
}

// The row's rate at its submitted method, plus the label ceiling the recap
// editor warns against: per-basis bands carry their upper bound; per-1,000
// rates use the verified catalog max; the 4-oz house default has none. A
// rate unit /complete would refuse, or one in mL, leaves the row without a
// rate. An added product's rate is only what the tech types in Edit amounts:
// its editor shows none, so a label band or the house default would go on
// the record unseen (owner ruling: the application record holds only what
// the tech confirmed). The house mix starts at the rate the full form seeds.
function rowRate(row, sprayMethod) {
  const resolved = resolveRatePrefill(row.product, { applicationMethod: rowMethod(row, sprayMethod), serviceLine: laneProductLine(row.lane).serviceLine });
  // An added product has a rate only in its label's own unit: never the pest
  // house default (4 oz, the house mix's rate), nor the resolver's bare "oz"
  // for a catalog row that names no unit at all.
  const labelRate = !(row.added && (resolved.usePestSprayDefault || !row.labelUnit));
  const rateUnit = labelRate && isSendableRateUnit(resolved.rateUnit) ? resolved.rateUnit : '';
  const prefill = !row.added && Number(resolved.rate) > 0 && rateUnit ? String(Number(resolved.rate)) : '';
  const max = prefillRateCeiling(resolved, row.product);
  // A rate typed for one way of spraying doesn't carry to another (its unit
  // is that way's): the report flow's way can change with the note's read.
  const typed = row.rateInput != null && (row.rateMethod == null || row.rateMethod === rowMethod(row, sprayMethod));
  return { rate: typed ? row.rateInput : prefill, rateUnit, max };
}

// The first requirement the application record still needs, in screen order
// (reason '' when none), and the product whose stock holds Complete when
// that is what is missing.
function missingRequirement(form, rows, ratingAllowed, dictationPending, openChecks = 0, voiceHolds = {}) {
  const active = rows.filter((row) => row.active);
  // The server refuses the whole visit when a tracked stock would go below
  // zero; a stock already at zero is named here instead.
  const outOfStock = active.find((row) => stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const missingAmount = active.find((row) => !hasAmount(row));
  const needsLinearFt = active.some((row) => rowMethod(row, form.method) === 'perimeter_spray');
  const [, reason = '', stockRow = null] = [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [!active.length, 'Select at least one product.'],
    [outOfStock, outOfStock && `${outOfStock.name} shows 0 in stock. Update inventory or remove it.`, outOfStock],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [!form.pests.size, 'Select at least one pest.'],
    [form.pests.has('Other') && !form.otherPest.trim(), 'Name the other pest.'],
    [!form.areas.size, 'Select where you treated.'],
    [needsLinearFt && !(Number(form.linearFt) > 0), 'Enter the linear feet you sprayed.'],
    [ratingAllowed && !form.activity, 'Select activity seen.'],
    // Voice fill: something it could not settle is still open.
    [openChecks > 0, 'Check what I couldn\'t fill.'],
    // Voice fill: what it set waits on the tech's ✓, and the office note fits.
    [voiceHolds.confirms > 0, 'Confirm what I filled.'],
    [voiceHolds.officeNoteTooLong, 'Shorten the office note.'],
  ].find(([missing]) => missing) || [];
  return { reason, stockRow };
}

function targetsOf(form) {
  return [...form.pests].map((pest) => (pest === 'Other' ? form.otherPest.trim() : pest));
}

// Gate on: the completion text is asked for in the server's fixed re-service
// mode (services/reservice-fixed-recap.js). The review ask and the pay link
// stay off, as on a re-service they always were (fast-complete scope: "leave it
// off on re-services").
const CUSTOMER_RECAP_FLAGS = {
  sendCompletionSms: true,
  requestReview: false,
  includePayLink: false,
  customerRecapMode: 'reservice_fixed',
};
// Today's body: no customer text, no review ask, no pay link.
const NO_CUSTOMER_RECAP_FLAGS = {
  sendCompletionSms: false,
  requestReview: false,
  includePayLink: false,
};

function completionBody(form, rows, { visitIdentity, ratingAllowed, tipsAvailable, recapEnabled, officeNote = '' }) {
  const targets = targetsOf(form);
  // Where rides each product row too: service_products.application_area
  // comes only from the row (the full form sends the same comma-joined string).
  const applicationArea = [...form.areas].join(', ');
  return {
    visitOutcome: 'completed',
    ...(visitIdentity ? { expectedVisit: visitIdentity } : {}),
    products: rows.filter((row) => row.active).map((row) => {
      const applicationMethod = rowMethod(row, form.method);
      const { rate, rateUnit } = rowRate(row, form.method);
      // fl_oz, gal, g, oz (a dry weight), lb or each; a tsp amount goes as fl oz.
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      return {
        productId: row.productId,
        applicationMethod,
        targets,
        totalAmount,
        amountUnit,
        applicationArea,
        ...(Number(rate) > 0 && rateUnit ? { rate: Number(rate), rateUnit } : {}),
        ...(applicationMethod === 'perimeter_spray' ? { areaValue: Number(form.linearFt), areaUnit: 'linear_ft' } : {}),
      };
    }),
    areasServiced: [...form.areas],
    ...(ratingAllowed ? { clientPestRating: ACTIVITY_LEVELS.find((a) => a.value === form.activity)?.rating ?? null } : {}),
    technicianNotes: form.note.trim(),
    // Voice fill's office note: staff-only (the visit's internal notes),
    // sent only when there is one.
    ...(officeNote.trim() ? { officeNote: officeNote.trim() } : {}),
    techTips: techTipsOf(form, tipsAvailable),
    // Gate off (GATE_FAST_COMPLETE_RECAP): no customer text, review ask or pay
    // link. Gate on: the fixed re-service text; the server composes it.
    ...(recapEnabled ? CUSTOMER_RECAP_FLAGS : NO_CUSTOMER_RECAP_FLAGS),
  };
}

// The report flow takes visits the house mix is not for (an initial
// cleanout), so it seeds only where the recap modal and the full form would;
// a re-service sheet always starts with it.
function seedsHouseMix(visit, { serviceType, reportFlow, laneKey, typedType }) {
  // A lane visit (bed bug, fire ant, tick, …) is never the pest house mix,
  // a callback included.
  if (laneKey || typedType) return false;
  return !reportFlow || isPestDefaultMixVisit({ ...visit, serviceType: visit.serviceType || serviceType });
}

// The identity the server re-checks under its lock. The report flow's pay
// link and review ask follow whether the visit is a free callback, so that
// flow echoes it too.
function sheetVisitIdentity(visit, reportFlow) {
  return reportFlow && typeof visit.isCallback === 'boolean'
    ? { ...recapVisitIdentity(visit), isCallback: visit.isCallback }
    : recapVisitIdentity(visit);
}

// The context + rating contract for this visit. The routed schedule row can
// be stale: the context is re-checked to still be an open pest re-service
// before anything can be completed here.
function useFastCompleteContext({
  base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress, routedServiceType, routedServiceKey, reportFlow,
  laneKey = null,
  typedType = null,
}) {
  const [ctx, setCtx] = useState({
    loading: true, loadError: '', blockedReason: '', rows: [], products: [], commonProducts: [], visitIdentity: null, visit: null,
    rating: { allowed: false, scaleLabels: null },
  });
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const [data, ratingContract] = await Promise.all([
          // The picker's most-used list is asked for here only; the recap
          // modal and the stock re-read below never run that aggregate.
          request(`${base}/pest-recap/context?include=common_products`),
          // A failed read keeps the rating off: never send a rating the
          // server may drop, or show a scale it may not use.
          request(`${base}/tech-rating-allowed`).catch(() => null),
        ]);
        if (!active) return;
        const visit = data?.service || {};
        const products = Array.isArray(data?.products) ? data.products : [];
        // This service line's most-used products (newer servers only): the
        // picker's first list, and each product's usual unit.
        const commonProducts = Array.isArray(data?.commonProducts)
          ? data.commonProducts.filter((common) => common && common.productId != null)
          : [];
        // A typed visit keeps its own activity (the completion ignores the
        // 1 to 5 rating on a typed form), so it asks for none.
        const rates = ratingContract?.allowed === true && !typedType;
        setCtx({
          loading: false,
          loadError: '',
          blockedReason: blockedReasonFor(data, {
            routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress, reportFlow, routedServiceType, routedServiceKey,
            laneFlow: !!laneKey, laneKey, typedFlow: !!typedType, typedType,
          }),
          visit,
          products,
          commonProducts,
          // The house totals are in the unit the resolver gives (4 fl oz), so
          // a house row never takes a usual unit: that is for picked products
          // (a Taurus usually logged in gal would otherwise open as "4 gal").
          rows: seedsHouseMix(visit, { serviceType, reportFlow, laneKey, typedType })
            ? pestDefaultMixSelections(products).map(({ product, totalAmount }) => productRow(product, { serviceType, totalAmount }))
            : [],
          visitIdentity: sheetVisitIdentity(visit, reportFlow),
          // A lane visit: whether its saved trace would show on the report
          // (an older server says nothing, so the trace holds stand).
          traceOnReport: data?.traceOnReport !== false,
          // Step 3 "after sending": book the follow-up a completion suggests.
          followupBooking: data?.followupBooking === true,
          rating: {
            allowed: rates,
            scaleLabels: ratingContract?.scaleLabels || null,
            // The report flow opens a first visit's tracker at 5 (owner
            // ruling 2026-09-24, the full form's prefill).
            firstVisit: rates && ratingContract?.firstVisit === true,
          },
        });
      } catch (err) {
        if (active) setCtx((prev) => ({ ...prev, loading: false, loadError: err?.message || 'Failed to load products' }));
      }
    })();
    return () => { active = false; };
  }, [base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress, routedServiceType, routedServiceKey, reportFlow, laneKey, typedType]);
  // The stock on hand the server has now, for a product restocked while the
  // sheet is open; nothing else is re-read. Resolves to the fresh catalog
  // rows by id.
  const refreshStock = useCallback(async () => {
    const data = await request(`${base}/pest-recap/context`);
    const fresh = new Map((Array.isArray(data?.products) ? data.products : []).map((product) => [String(product.id), product]));
    setCtx((prev) => ({ ...prev, products: prev.products.map((product) => withFreshStock(product, fresh)) }));
    return fresh;
  }, [base, request]);
  return { ...ctx, refreshStock };
}

// A catalog row with the stock on hand a fresh read has for it.
function withFreshStock(product, fresh) {
  const row = fresh.get(String(product.id));
  return row ? { ...product, inventory_on_hand: row.inventory_on_hand, inventory_unit: row.inventory_unit } : product;
}

// The photo manager opens over the sheet. While it is up the sheet is inert
// and hidden from assistive tech, the way the photo manager treats its own
// marks dialog; `version` moves on each close so the count is read again.
function usePhotoManager() {
  const [state, setState] = useState({ isOpen: false, version: 0 });
  const open = useCallback(() => setState((prev) => ({ ...prev, isOpen: true })), []);
  const close = useCallback(() => setState((prev) => ({ isOpen: false, version: prev.version + 1 })), []);
  return { ...state, open, close, hiddenProps: state.isOpen ? { 'aria-hidden': true, inert: '' } : {} };
}

// The sheet's title before and after the save: the report flow names a
// regular visit as a service; the re-service sheet keeps its words.
const SHEET_TITLES = {
  reservice: ['Complete re-service', 'Re-service complete'],
  service: ['Complete service', 'Service complete'],
};
const INERT = { 'aria-hidden': true, inert: '' };
// A re-service: the pest re-service itself, or a free callback booked under
// a regular service key. Neither gets a pay link or a review ask.
const isReserviceVisit = (visit) => visit?.serviceKey === 'pest_re_service' || visit?.isCallback === true;
function sheetTitle(reportFlow, visit, done) {
  return SHEET_TITLES[reportFlow && !isReserviceVisit(visit) ? 'service' : 'reservice'][done ? 1 : 0];
}

export default function FastCompleteSheet({ service, request, onClose, onCompleted, onFullForm, voiceFillEnabled = false }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const reportFlow = service?.reportFlow === true;
  const ctx = useFastCompleteContext({
    base,
    request,
    serviceType: service?.serviceType,
    routedCustomerId: service?.routedCustomerId,
    routedScheduledDate: service?.routedScheduledDate,
    routedPropertyId: service?.routedPropertyId,
    routedAddress: service?.routedAddress,
    routedServiceType: service?.routedServiceType,
    routedServiceKey: service?.routedServiceKey,
    reportFlow,
    laneKey: routedLaneOf(service),
    typedType: routedTypedOf(service),
  });
  // Only the report flow renders the confirmable prompts (the edited-report
  // heads-up, a promise changed since the report was written).
  const submission = useFastCompleteSubmit({ base, request, confirmable: reportFlow });
  const { submitting, done } = submission;
  const photoManager = usePhotoManager();
  // Another dialog a sheet opens over itself (the report flow's spray
  // tracer), the way the photo manager opens: the sheet goes inert under it.
  const [sheetOverlay, setSheetOverlay] = useState(null);
  // A recorded dictation clip is still being taken or transcribed (the
  // upload path). The full form is another page and carries nothing over,
  // so Full form and "+ Other product" wait for the clip, like Complete and
  // photos. Close still works: it discards the sheet, typed note included.
  const [dictationPending, setDictationPending] = useState(false);
  // A photo change in hand in the note's box (a description open, whose own
  // mic may be recording, a change saving, a removal to answer): Full form
  // waits for it the same way (codex local r3 on #5624).
  const [photoBusy, setPhotoBusy] = useState(false);
  // Voice fill recording, transcribing or filling (the form's own hold, lifted
  // so Full form and Close wait on it too).
  const [voiceBusy, setVoiceBusy] = useState(false);

  // Dismissing a saved sheet refreshes the schedule like "Next stop" does,
  // so a missed socket update can't leave the visit showing as open.
  // Any dismissal the schedule may be stale for asks the parent to refresh:
  // a sheet blocked on a stale or changed visit, or an attempt whose outcome
  // is unknown or refused (it may have saved), so reopening routes from the
  // live schedule rather than the same old row.
  const close = useCallback(() => {
    // Voice still recording, transcribing or filling: closing (×, backdrop or
    // Escape all come through here) would drop those words and the sheet's edits.
    if (submitting || voiceBusy) return;
    if (done) onCompleted?.();
    else onClose?.(ctx.blockedReason || submission.failure ? { refresh: true } : undefined);
  }, [submitting, voiceBusy, done, ctx.blockedReason, submission.failure, onClose, onCompleted]);
  closeRef.current = close;
  // Nothing is editable while a save is in flight, unresolved, or refused
  // for good; the recap modal (Full form) can't resume a /complete attempt,
  // so it is offered only before one may have reached the server.
  // A confirmable prompt (report flow) holds the sheet until it is answered.
  const locked = submitting || submission.failure !== null || !!submission.prompt;

  return (
    <FastCompleteFrame
      isMobile={isMobile}
      dialogRef={dialogRef}
      titleId={titleId}
      onDismiss={close}
      hiddenProps={sheetOverlay ? INERT : photoManager.hiddenProps}
      overlay={(photoManager.isOpen && (
        <TechServicePhotosModal serviceId={service?.id} customerName={customerNameOf(ctx.visit, service)} onClose={photoManager.close} />
      )) || sheetOverlay}
    >
      <SheetHeader titleId={titleId} title={sheetTitle(reportFlow, ctx.visit, done)} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending || photoBusy || voiceBusy} submitting={submitting || voiceBusy} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photoManager} onOverlay={setSheetOverlay} dictationPending={dictationPending} onDictationPending={setDictationPending} onPhotoBusy={setPhotoBusy} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} voiceFillEnabled={voiceFillEnabled === true} onVoiceBusy={setVoiceBusy} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, ctx, submission, locked, photos, onOverlay, dictationPending, onDictationPending, onPhotoBusy, onCompleted, onFullForm, isMobile, voiceFillEnabled, onVoiceBusy }) {
  const reportFlow = service?.reportFlow === true;
  // The report flow keeps its form mounted through the saved view: what the
  // tech marked shows there.
  if (submission.done && !reportFlow) {
    return (
      <SavedView service={service} summary={submission.done.summary} onCompleted={onCompleted}>
        <CustomerTextResult outcome={submission.done.customerText} />
      </SavedView>
    );
  }
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  const stop = ctx.loadError || ctx.blockedReason;
  if (stop) return <ActionFeedback error={!!ctx.loadError} className="tech-visit-feedback tech-visit-loading">{stop}</ActionFeedback>;
  if (reportFlow) {
    return <ReportFlowForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photos} onOverlay={onOverlay} dictationPending={dictationPending} onDictationPending={onDictationPending} onPhotoBusy={onPhotoBusy} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />;
  }
  return <FastCompleteForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photos} dictationPending={dictationPending} onDictationPending={onDictationPending} onFullForm={onFullForm} isMobile={isMobile} voiceFillEnabled={voiceFillEnabled} onVoiceBusy={onVoiceBusy} />;
}

// The products on the sheet: the house mix it opened with, plus what the tech
// added from the picker. One product, one row (/complete keeps only the
// first row per product); an added product's editor is open while the tech
// sets how much and how.
function useProductRows(ctx, serviceType, lane = null) {
  const [rows, setRows] = useState(ctx.rows);
  const [editingId, setEditingId] = useState(null);
  const commonById = useMemo(
    () => new Map(ctx.commonProducts.map((common) => [String(common.productId), common])),
    [ctx.commonProducts],
  );
  const updateRow = useCallback((productId, patch) => {
    setRows((prev) => prev.map((row) => (row.productId === productId ? { ...row, ...patch } : row)));
  }, []);
  const addProduct = useCallback((product, visitMethod) => {
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      productRow(product, { serviceType, common: commonById.get(String(product.id)), visitMethod, added: true, lane }),
    ]));
    setEditingId(product.id);
  }, [serviceType, commonById, lane]);
  const removeRow = useCallback((productId) => {
    setRows((prev) => prev.filter((row) => row.productId !== productId));
    setEditingId(null);
  }, []);
  // A rate typed for one spray method doesn't carry to another.
  const clearFollowingRates = useCallback(() => {
    setRows((prev) => prev.map((row) => (followsVisitMethod(row) ? { ...row, rateInput: null } : row)));
  }, []);
  // A voice fill: rows it adds (without opening their editors) and the patches
  // it makes to rows already there; a product already on the sheet is not added twice.
  const applyFill = useCallback((added, patches) => {
    setRows((prev) => {
      const known = new Set(prev.map((row) => row.productId));
      const kept = prev.map((row) => (patches[row.productId] ? { ...row, ...patches[row.productId] } : row));
      return [...kept, ...added.filter((row) => !known.has(row.productId))];
    });
  }, []);
  // A fresh stock read changes each row's stock on hand, nothing the tech set.
  const applyStock = useCallback((fresh) => {
    setRows((prev) => prev.map((row) => ({ ...row, product: withFreshStock(row.product, fresh) })));
  }, []);
  return { rows, editingId, setEditingId, updateRow, addProduct, removeRow, clearFollowingRates, applyFill, applyStock };
}

// The pest sheet's own row rules, handed to the voice-fill plan
// (lib/fast-complete-voice-plan.js) so it reads rows and choices the way the
// sheet does. `makeRow` is added per sheet (it needs the visit's service type).
const VOICE_SHEET_OPS = {
  rowMethod,
  followsVisitMethod,
  sprayMethods: SPRAY_METHODS,
  defaultMethod: DEFAULT_METHOD,
  pests: [...PEST_CHIPS, ...PEST_CHIPS_MORE],
  areas: AREA_CHIPS,
  activityValues: ACTIVITY_LEVELS.map((level) => level.value),
};

function FastCompleteForm({ service, request, ctx, submission, locked, photos, dictationPending, onDictationPending, onFullForm, isMobile, voiceFillEnabled, onVoiceBusy }) {
  const products = useProductRows(ctx, service?.serviceType);
  const { rows, addProduct, clearFollowingRates } = products;
  const [editAmounts, setEditAmounts] = useState(false);
  const [form, setForm] = useState(() => ({
    pests: new Set(), otherPest: '', areas: new Set(), method: DEFAULT_METHOD, methodPicked: false, linearFt: '', activity: '', note: '',
    tipId: '', customTip: '',
  }));
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);
  const tips = useTipLibrary({ base: `/admin/dispatch/${service?.id}`, request });
  const tipsAvailable = !!tips;

  const chooseMethod = useCallback((next) => {
    setField('method', next);
    clearFollowingRates();
  }, [setField, clearFollowingRates]);
  // The tech's own How tap: voice fill never replaces it, even the default way.
  const pickMethod = useCallback((next) => {
    chooseMethod(next);
    setField('methodPicked', true);
  }, [chooseMethod, setField]);
  // Voice fill (GATE_FAST_COMPLETE_VOICE_FILL, delivered as the `voiceFillEnabled`
  // prop): off, nothing below renders and the sheet is as it always was.
  const voiceOps = useMemo(() => ({
    ...VOICE_SHEET_OPS,
    makeRow: (product, extras) => productRow(product, { serviceType: service?.serviceType, added: true, ...extras }),
  }), [service?.serviceType]);
  const voice = useVoiceFillSheet({
    enabled: voiceFillEnabled,
    request,
    serviceId: service?.id,
    sheet: { ops: voiceOps, ctx, products, form, setForm, chooseMethod, appendNote },
  });
  // Words being recorded, transcribed or filled in would miss the save. The
  // voice mic keeps its own flag: the note's mic finishing first must not clear it.
  const [voiceMicPending, setVoiceMicPending] = useState(false);
  const busy = dictationPending || voiceMicPending || voice.filling;
  const voiceBusy = voiceMicPending || voice.filling;
  useEffect(() => {
    onVoiceBusy?.(voiceBusy);
  }, [voiceBusy, onVoiceBusy]);
  useEffect(() => () => onVoiceBusy?.(false), [onVoiceBusy]);
  // While the voice mic is live every other control waits: the browser's speech
  // session drops the words still in flight on any other tap or keystroke.
  const formLocked = locked || voiceMicPending;
  // The house mix is always on the sheet, so "Used most" lists the rest.
  const pickerCommonProducts = useMemo(() => {
    const mixIds = new Set(ctx.rows.map((row) => String(row.productId)));
    return ctx.commonProducts.filter((common) => !mixIds.has(String(common.productId)));
  }, [ctx.rows, ctx.commonProducts]);
  const picker = useProductPicker({
    products: ctx.products,
    commonProducts: pickerCommonProducts,
    rows,
    locked: locked || busy,
    isMobile,
    onFullForm,
    onPick: (product) => addProduct(product, form.method),
  });

  const { reason: missingReason, stockRow } = missingRequirement(form, rows, ctx.rating.allowed, busy, voice.checks.length, { confirms: voice.confirms.length, officeNoteTooLong: voice.officeNoteTooLong });
  // "Update inventory or remove it": once the stock is updated, the tech
  // re-reads it here rather than close the sheet and lose the visit.
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
      () => completionBody(form, rows, {
        visitIdentity: ctx.visitIdentity, ratingAllowed: ctx.rating.allowed, tipsAvailable, recapEnabled: recapOn(service),
        officeNote: voice.enabled ? voice.officeNote : '',
      }),
      `${names} · ${targetsOf(form).join(', ')}`,
    );
  };

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        {/* One mic at a time: the note's mic recording (the upload path is not stopped
            by another tap) holds this one. */}
        <VoiceFillMicBar voice={voice} serviceId={service?.id} locked={locked || dictationPending} onPendingChange={setVoiceMicPending} />
        {/* Disabled as one block while the voice mic is live, so no control inside
            (now or added later) can end the speech session early. */}
        <fieldset className="tech-visit-form" disabled={formLocked}>
          <VoiceFillReview voice={voice} locked={formLocked} />
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={formLocked} />
          <OfficeNote voice={voice} locked={formLocked} />
          {/* A clip being recorded keeps recording behind the photo manager, so
              photos wait until the dictation is finished. */}
          <PhotosSection serviceId={service?.id} request={request} photos={photos} locked={formLocked || busy} />
          <ProductsSection
            products={products}
            heardLines={<ProductHeardLines voice={voice} rows={rows} />}
            // With voice fill on, a way the tech picks for a product is stored as
            // picked (never "follows How"), so a dictated How cannot move it. 'how':
            // an unpicked spray still follows the How row here (not the note).
            stickyPicks={voiceFillEnabled === true ? 'how' : false}
            method={form.method}
            editAmounts={editAmounts}
            locked={formLocked}
            onToggleEdit={() => setEditAmounts((on) => !on)}
            other={picker.button}
            popover={picker.popover}
          />
          <PestsSection form={form} setField={setField} locked={formLocked} />
          <ChoiceSection title="Where" columns={3}>
            {AREA_CHIPS.map((label) => (
              <Chip disabled={formLocked} key={label} label={label} pressed={form.areas.has(label)} onClick={() => setField('areas', toggleInSet(form.areas, label))} />
            ))}
          </ChoiceSection>
          <MethodSection form={form} rows={rows} setField={setField} chooseMethod={pickMethod} locked={formLocked} />
          {ctx.rating.allowed && (
            <ChoiceSection title="Activity seen" columns={4}>
              {ACTIVITY_LEVELS.map((level) => (
                <Chip disabled={formLocked} key={level.value} label={ctx.rating.scaleLabels?.[level.rating] || level.label} pressed={form.activity === level.value} onClick={() => setField('activity', level.value)} />
              ))}
            </ChoiceSection>
          )}
          <VisitHeardLine voice={voice} />
          {tipsAvailable && (
            <TipSection
              library={tips}
              tipId={form.tipId}
              customTip={form.customTip}
              locked={formLocked}
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
        label="Complete re-service"
        onSubmit={submit}
        coverProps={picker.coverProps}
      >
        {stockRow && !locked && (
          <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={checkingStock} disabled={voiceMicPending} onClick={checkStock}>Check stock</Button>
        )}
      </CompleteFooter>
      {picker.sheet}
    </div>
  );
}

// ── Report flow (GATE_FAST_COMPLETE_REPORT) ─────────────────────────────────

// How a spray went down when the tech picked no other way for it, as the
// note says it (owner ruling 2026-09-30: How is voice only): around the
// outside of the home is a perimeter spray, anything else a spot treatment.
// It is read before the report is written, so the report and the record
// agree; the trace only gives a perimeter spray its length. (The server
// reads a spray sent with no method as a perimeter spray and refuses it
// without linear feet.)
const reportSprayMethod = (facts) => (facts?.spray === 'perimeter' ? 'perimeter_spray' : 'spot_treatment');

// What the record says about one product, heard from the note: how it went
// down and the pests it was for; where only when the visit was in one place,
// as the full form fills it (the note does not say which product went where,
// so two places stay on the visit's areas serviced, never on every product).
// The report is written from exactly this, and the completion records
// exactly this.
function recordedApplication(row, facts) {
  const sprayMethod = reportSprayMethod(facts);
  const { rate, rateUnit } = rowRate(row, sprayMethod);
  const areas = facts?.areas || [];
  return {
    applicationMethod: rowMethod(row, sprayMethod),
    targets: facts?.pests || [],
    ...(areas.length === 1 ? { applicationArea: areas[0] } : {}),
    ...(Number(rate) > 0 && rateUnit ? { rate: Number(rate), rateUnit } : {}),
  };
}

// "October 1, 2026" from the visit's ET calendar day, as the full form
// sends it; never browser-local date math.
function reportServiceDate(day) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!match) return undefined;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12))
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

// What the report is written from. A change after it was written marks it
// stale: the note (and so what is heard from it), a product or a way or rate
// the tech picked for one, the customer choice, the rating, the promise
// marks and the photos the writer reads. The tip prints as its own card on
// the report (the writer never repeats it), so it is not part of it. Nor is
// the trace: it only gives a perimeter spray its length.
function writerSignature(form, rows, promiseMarks, photos, recordPart = null) {
  return JSON.stringify({
    // A lane or typed visit's record is what the report says.
    ...(recordPart || {}),
    note: form.note.trim(),
    products: rows.filter((row) => row.active)
      .map((row) => [String(row.productId), row.methodInput || null, row.rateInput ?? null, row.rateMethod ?? null])
      .sort(([a], [b]) => a.localeCompare(b)),
    customerHome: form.customerHome,
    rating: form.rating,
    // Choosing the default's own value still changes what the writer reads.
    ratingPrefilled: !!form.ratingPrefilled,
    promiseMarks,
    photos: [photos.length, photoCaptionsOf(photos)],
  });
}

// The report request: the same POST /admin/schedule/generate-report the
// full form's "Generate AI report" sends, with each product as the record
// will hold it. The visit id grounds it (the route re-reads the visit, the
// customer's texts and calls, past visits and the weather).
// What a report and its completion say of where and what: a lane visit's
// own record (GATE_LANE_VOICE_FILL), its places standing where the note's
// heard places stand and its findings as the observations the full form
// sends; else what the note was heard to say.
// A typed visit's record (GATE_TYPED_VOICE_FILL) is its typed form's own
// values, sent as the full form sends them (structuredFindings), with the
// activity score when it is the tech's to set; its places are its form's own
// area field, as the full form sends them (the sheet has no other places).
function recordInputs(mode, record, facts, typedSchema = null) {
  if (mode === 'lane' && record) {
    const observations = Object.values(record.values);
    return { heard: { areas: record.areas }, writerExtras: { observations }, completionExtras: { structuredObservations: observations } };
  }
  if (mode === 'typed' && record) {
    const structuredFindings = { type: typedSchema.type, values: record.values };
    const score = typedScoreIsTechs(typedSchema) && Number.isInteger(record.score) ? record.score : null;
    const areaKey = typedTreatmentAreaField(typedSchema)?.key || null;
    return {
      heard: { areas: completionAreasForTypedFindings({ typedAreaKey: areaKey, findingsValues: record.values, genericAreas: [] }) },
      writerExtras: { structuredFindings, typedActivityScore: score },
      completionExtras: { structuredFindings, ...(score != null ? { activityScore: score, activityScoreSource: 'technician' } : {}) },
    };
  }
  return { heard: facts, writerExtras: {}, completionExtras: {} };
}

function writerPayload({ service, visit, form, rows, facts, ratingAllowed, photos, promiseMarks }) {
  const active = rows.filter((row) => row.active);
  const captions = photoCaptionsOf(photos);
  return {
    scheduledServiceId: service?.id || null,
    customerName: visit?.customerName || service?.customerName || undefined,
    serviceType: visit?.serviceType || service?.serviceType,
    ...(service?.technicianName ? { technicianName: service.technicianName } : {}),
    serviceDate: reportServiceDate(visit?.scheduledDate),
    serviceNotes: form.note.trim(),
    productsApplied: active.map((row) => row.name).join(', '),
    products: active.map((row) => ({ productId: row.productId || null, name: row.name, ...recordedApplication(row, facts) })),
    areasServiced: facts?.areas || [],
    customerInteraction: customerHomeWriterLabel(form.customerHome),
    // The first-visit 5 is a scoring default, not something the technician
    // saw: the writer gets a rating only once they choose one (codex local
    // r28 on #5538), as the completion recap leaves the default out.
    pestActivityRating: ratingAllowed && !form.ratingPrefilled && Number.isInteger(form.rating) ? form.rating : null,
    photoCount: photos.length,
    ...(captions.length ? { photoCaptions: captions } : {}),
    // The full form's default: the customer's texts and calls ground the report.
    includeCustomerComms: true,
    ...(promiseMarks.length ? { promiseMarks } : {}),
  };
}

// The completion: the full /complete body for the report the tech read,
// each product as the report was written from it (a perimeter spray with the
// trace's length). The report is the notes, and reportDraftBase tells the
// server what was written so an edit gets its heads-up. A regular visit gets
// the full form's customer text, pay link and review ask; a re-service never
// gets a pay link or a review ask.
function reportCompletionBody({
  form, rows, draft, perimeterFeet, trace, visitIdentity, ratingAllowed, tipsAvailable, isReservice, promiseMarks, recordFields = null,
}) {
  const ratingSent = ratingAllowed && Number.isInteger(form.rating);
  // A lane or typed visit records its own record, as the report was written
  // from it.
  const { heard, completionExtras } = recordFields || recordInputs(null, null, draft.facts);
  return {
    visitOutcome: 'completed',
    ...(visitIdentity ? { expectedVisit: visitIdentity } : {}),
    // The saved trace this report was judged against (null: none, or a map
    // gate that hides traces), for the server to re-check under the visit
    // lock and freeze: the report shows only this trace.
    traceSeen: trace.zone?.updated_at ?? null,
    products: rows.filter((row) => row.active).map((row) => {
      const application = recordedApplication(row, heard);
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      return {
        productId: row.productId,
        ...application,
        totalAmount,
        amountUnit,
        ...(application.applicationMethod === 'perimeter_spray' ? { areaValue: perimeterFeet, areaUnit: 'linear_ft' } : {}),
      };
    }),
    areasServiced: heard?.areas || [],
    ...completionExtras,
    customerInteraction: form.customerHome,
    ...(ratingSent ? { clientPestRating: form.rating } : {}),
    // The untouched first-visit 5: the server re-checks it is still the
    // first visit (owner ruling 2026-09-24).
    ...(ratingSent && form.ratingPrefilled ? { clientPestRatingPrefilled: true } : {}),
    technicianNotes: draft.text.trim(),
    reportDraftBase: draft.base,
    ...(promiseMarks.length ? { promiseMarks } : {}),
    techTips: techTipsOf(form, tipsAvailable),
    // The picked Waves blog post; /complete checks it is still live and
    // freezes it onto the report.
    ...(form.blogPost ? { blogPostId: form.blogPost.id } : {}),
    sendCompletionSms: true,
    includePayLink: !isReservice,
    requestReview: !isReservice,
  };
}

// What an empty product list says, per record mode. A lane visit's work
// without a product (heat, steam, nest removal, an inspection) is recorded by
// its protocol action, which carries its re-entry wait or inspection-only
// standing on the report; the sheet records none, so that work goes on the
// full form. A typed form records its work in its own fields (treatments,
// inspections), so it needs no product (null: no hold).
// The send holds per record mode: a lane visit's, a typed visit's, else the
// pest visit's.
const sendHoldsFor = (mode) => ({ lane: laneSendHolds, typed: typedSendHolds })[mode] || sendHolds;

const NO_PRODUCT_HOLDS = {
  lane: 'Add the product you applied. Work done without one (heat, steam, nest removal, an inspection) goes on the Full form.',
  typed: null,
};

// What still holds the report (generate) or the completion (complete), in
// screen order, the product whose stock holds it, and the fix the hold
// offers on the sheet ('remove_trace').
function reportFlowMissing({ form, active, ratingAllowed, dictationPending, photoHold, photosLoaded, photosFailed, promisesLoaded, stage, mode, ...sendInputs }) {
  const outOfStock = active.find((row) => stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const missingAmount = active.find((row) => !hasAmount(row));
  const noProduct = mode in NO_PRODUCT_HOLDS ? NO_PRODUCT_HOLDS[mode] : 'Select at least one product.';
  const [, reason = '', stockRow = null, fix = null] = [
    [dictationPending, 'Finish dictating first.'],
    [photoHold, photoHold],
    [!photosLoaded, 'Loading photos…'],
    [photosFailed, 'Read the photos again first.'],
    [!promisesLoaded, 'Loading promises…'],
    [!active.length && noProduct, noProduct],
    [outOfStock, outOfStock && `${outOfStock.name} shows 0 in stock. Update inventory or remove it.`, outOfStock],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [ratingAllowed && !Number.isInteger(form.rating), 'Pick the pest activity, 1 to 5.'],
    ...(stage === 'complete' ? sendHoldsFor(mode)({ active, ...sendInputs }) : []),
  ].find(([missing]) => missing) || [];
  return { reason, stockRow, fix };
}

// What else holds Complete & send: the report itself; the note's read of
// where product went down, which decides the customer's re-entry wait (an
// indoor treatment keeps its indoor wait; a failed read is written again,
// and the Full form stays open for an outage); and, for a perimeter spray,
// the trace that gives it its length.
// The first active product the record sprays around the house: the note's
// perimeter, or a product the tech set to Perimeter spray by hand.
function perimeterSprayRow(active, draft) {
  return draft ? active.find((row) => rowMethod(row, reportSprayMethod(draft.facts)) === 'perimeter_spray') || null : null;
}

// What holds any report's send: the report itself, and the read of a saved
// trace (whether one is saved decides what the report shows, and the
// completion re-checks it).
function reportReadyHolds({ draft, writing, traceRead }) {
  return {
    report: [
      [writing, 'Writing the report…'],
      [!draft, 'Generate the report first.'],
      [draft && !draft.text.trim(), 'The report is empty. Write it again.'],
    ],
    trace: [
      [!traceRead.loaded, 'Checking for a saved trace…'],
      [traceRead.failed, 'Couldn’t check for a saved trace. Check the trace again.'],
    ],
  };
}

// The saved outlines that claim an area treated (the lawn and yard
// workflows; trace-eligibility.js reads them as outline captures), and the
// ways a product goes down across an area.
const AREA_CAPTURES = new Set(['lawn', 'lawn_highlight', 'yard']);
const AREA_METHODS = new Set(['broadcast_spray', 'granular_broadcast', 'fog_ulv']);

// A lane visit (GATE_LANE_VOICE_FILL) has no pest facts and no trace step
// (its outline stays on the full form): its record is the tech's to
// confirm. A product picked as a perimeter spray needs a traced length, and
// a saved trace shows on the customer's report only with such a spray to
// back it (as on a pest visit).
function laneSendHolds({ active, draft, writing, perimeterFeet, traceRead, lane, record: laneRecord, traceOnReport = true }) {
  const ready = reportReadyHolds({ draft, writing, traceRead });
  const laneAreas = laneRecord.areas;
  const perimeterRow = perimeterSprayRow(active, draft);
  const untraced = !perimeterFeet && perimeterRow;
  // A saved trace claims what it shows: a perimeter a spray around the
  // house, an outline (the lawn and yard workflows) an area treated, so each
  // stands only with a product that went down that way (codex local r2 on
  // #5629).
  const traceMode = traceRead.zone?.capture_mode ?? traceRead.zone?.captureMode;
  const areaTrace = AREA_CAPTURES.has(traceMode);
  const areaRow = active.find((row) => AREA_METHODS.has(rowMethod(row, reportSprayMethod(draft?.facts))));
  // A trace the report never shows (bed bug's indoor work, nest work)
  // claims nothing, so only one it shows can hold the send (codex local r5
  // on #5629).
  const shownTrace = traceOnReport && traceRead.zone;
  const unusedTrace = draft && shownTrace && (areaTrace ? !areaRow : !perimeterRow);
  // An "Interior spray too" trace claims indoor treatment on the customer's
  // map, so the record must list a place inside (the pest sheet asks the
  // note for Inside; codex local r4 on #5629).
  const interiorUnbacked = draft && shownTrace && traceMode === 'interior' && !laneAreas.some((area) => AREA_SCOPES.interior.includes(area));
  // Every shown trace (an outline, a perimeter, and "Interior spray too",
  // which still carries the perimeter) draws the outside of the house and
  // sets the outdoor re-entry wait, so the record must list a place outside;
  // a broadcast spray picked beside an inside-only record is not enough.
  const exteriorUnbacked = draft && shownTrace && !laneAreas.some((area) => AREA_SCOPES.exterior.includes(area));
  return [
    ...ready.report,
    // The record's places are the visit's treated side on the report: with
    // none, the outdoor re-entry wait is dropped and the indoor one kept
    // (report-data.js normalizeAdvisoryForTreatmentScope), so a lane visit
    // never sends without one (codex local r3 on #5629). A read that heard
    // none leaves them for the tech to pick.
    [!laneAreas.length, 'Pick where you treated: tap Change beside Where.'],
    // A finding the completion takes only beside the work performed (a lane
    // with a work state) goes on the full form, which records the work.
    [laneRecordNeedsAction(SERVICE_COMPLETION_PRESETS[lane], laneRecord), 'A finding on this record needs the work you did recorded beside it, and only the Full form records that. Use the Full form.'],
    ...ready.trace,
    [untraced, untraced && `${untraced.name} is a perimeter spray and this visit can’t be traced here. Use the Full form.`],
    [unusedTrace, areaTrace
      ? 'Your saved outline would show on the customer’s report as the area treated, but nothing on this visit was broadcast, spread or misted across an area. Remove the trace, or use the Full form.'
      : 'Your saved trace would show on the customer’s report, but nothing on this visit was sprayed around the house. Remove the trace, or use the Full form.', null, 'remove_trace'],
    [interiorUnbacked, 'Your trace says you sprayed inside too, but no place on the record is inside. Add the place inside (Change beside Where), or remove the trace.', null, 'remove_trace'],
    [exteriorUnbacked, 'Your trace would show the outside of the house on the customer’s report, but no place on the record is outside. Add the place outside (Change beside Where), or remove the trace.', null, 'remove_trace'],
  ];
}

// A typed visit (GATE_TYPED_VOICE_FILL): its record must answer every field
// the completion requires now (typed_findings_required/invalid), the
// activity score when it is the tech's, and a score that agrees with the
// findings (activity_score_inconsistent). A record whose nothing-found state
// keeps the report's standard wording (the full form holds Generate there)
// goes on the full form. No trace step here: a perimeter spray needs its
// traced length, and a saved trace the report would show goes on the full
// form too.
// The ways a product goes down that are not a spray (the office form's spray
// evidence leaves them out).
const PLACED_METHODS = new Set(['bait_placement', 'station_check', 'trunk_injection']);

// The activity score a typed record carries: the tech's own where they set
// it, else the one its findings derive (deriveScores), or none.
function typedScoreOf(schema, record) {
  const activity = schema?.activity;
  if (!activity) return null;
  if (!activity.deriveField) return Number.isInteger(record.score) ? record.score : null;
  const derived = activity.deriveScores?.[String(record.values[activity.deriveField] ?? '')];
  return Number.isInteger(derived) ? derived : null;
}

function typedSendHolds({ active, draft, writing, perimeterFeet, traceRead, record, typedSchema, traceOnReport = true }) {
  const ready = reportReadyHolds({ draft, writing, traceRead });
  const values = record.values;
  const missing = typedCardFields(typedSchema).find((field) => typedFieldRequiredNow(field, values) && !String(values[field.key] ?? '').trim());
  const typedIn = missing && (missing.type === 'text' || missing.type === 'count');
  // An initial setup's own rules (its trap count; no work on traps already
  // out), as the office form holds them before submit.
  const [setupConflict] = trapSetupConflicts(typedSchema.type, values);
  const scoreMissing = typedScoreIsTechs(typedSchema) && !Number.isInteger(record.score);
  // The score the completion keeps: the tech's own, or the one its findings
  // derive (a bait visit's consumption), as the office form judges it.
  const score = typedScoreOf(typedSchema, record);
  const scoreConflict = typedActivityScoreConflict(typedSchema.type, values, score);
  const standardWording = typedZeroStateRefusesBody(typedSchema.type, values, score);
  const perimeterRow = perimeterSprayRow(active, draft);
  const untraced = !perimeterFeet && perimeterRow;
  const shownTrace = draft && traceOnReport && traceRead.zone;
  // A product's place is the visit's treated side on the report (as on a
  // lane visit): the form's own area field, or, for a form whose places the
  // full form picks (pest inspection, wildlife, a bait station visit where
  // something went down other than bait), the full form.
  const areaField = typedTreatmentAreaField(typedSchema);
  const sprayed = active.some((row) => !PLACED_METHODS.has(rowMethod(row, reportSprayMethod(draft?.facts))));
  const placesMissing = active.length > 0 && (areaField
    ? !parseApplicationAreas(values[areaField.key]).length
    : typedFormTakesPlaces(typedSchema.type, { sprayed }));
  return [
    ...ready.report,
    [missing, missing && (typedIn ? `Fill in ${missing.label}.` : `Pick ${missing.label}: tap Change beside it.`)],
    [setupConflict, setupConflict],
    [placesMissing, areaField
      ? `Pick where you treated: tap Change beside ${areaField.label}.`
      : 'Where you applied the product is picked on the Full form. Use the Full form.'],
    [scoreMissing, `Pick the ${String(typedSchema.activity?.label || 'activity').toLowerCase()} score, 0 to 5.`],
    [scoreConflict, scoreConflict],
    [standardWording, 'Nothing was found on this record, so the customer’s report uses its standard wording, not this one. Use the Full form.'],
    ...ready.trace,
    [untraced, untraced && `${untraced.name} is a perimeter spray and this visit can’t be traced here. Use the Full form.`],
    [shownTrace, 'This visit has a saved trace the customer’s report would show, and this sheet doesn’t check it. Remove the trace, or use the Full form.', null, 'remove_trace'],
  ];
}

function sendHolds({ active, draft, writing, perimeterFeet, traceAvailable, traceRead }) {
  const ready = reportReadyHolds({ draft, writing, traceRead });
  const perimeterRow = perimeterSprayRow(active, draft);
  const untraced = !perimeterFeet && perimeterRow;
  // The note says no spraying, so a product still going down as a spray (the
  // house mix starts on) would be recorded as applied when it wasn't.
  const sprayedAnyway = draft?.facts?.noSpray
    && active.find((row) => SPRAYED_METHODS.has(rowMethod(row, reportSprayMethod(draft.facts))));
  // A saved trace shows on the customer's report whatever its length or
  // kind (a perimeter, an outline), so one the record has no spray around
  // the house for would claim a spray it never records (Codex #5538).
  const unusedTrace = draft && traceRead.zone && !perimeterRow;
  // An "Interior spray too" trace (saved now or earlier) claims inside on the
  // customer's map; the record and the re-entry wait only say inside when the
  // note does.
  const traceMode = traceRead.zone?.capture_mode ?? traceRead.zone?.captureMode;
  const interiorUnheard = draft && traceMode === 'interior' && !(draft.facts?.areas || []).includes('Inside');
  return [
    ...ready.report,
    [draft && factsHold(draft.facts), draft && factsHold(draft.facts)],
    [sprayedAnyway, sprayedAnyway && `Your note says you didn’t spray, but ${sprayedAnyway.name} is a spray. Remove it or change how it went down, then write it again.`],
    // Whether a trace is saved decides both holds below.
    ...ready.trace,
    [untraced, untraced && (traceAvailable
      ? `Trace where you sprayed: ${untraced.name} is a perimeter spray.`
      : `${untraced.name} is a perimeter spray and this visit can’t be traced here. Use the Full form.`)],
    // A trace the note doesn't back can also come off ("Remove the trace").
    [unusedTrace, 'Your saved trace would show on the customer’s report, but your note doesn’t say you sprayed around the house. Remove the trace, or say plainly how you sprayed and write it again.', null, 'remove_trace'],
    [interiorUnheard, 'Your trace says you sprayed inside too, but your note doesn’t say you treated inside. Say where you treated, trace again without Interior spray, or remove the trace.', null, 'remove_trace'],
  ];
}

// The report action both steps offer: write it the first time, or write it
// again once the visit changed (a fresh draft); null while it is current.
function writeAction(draft, stale, writeError) {
  if (!draft) return { label: writeError ? 'Try again' : 'Generate AI report', fresh: false };
  return stale ? { label: 'Write it again', fresh: true } : null;
}

function writerSources({ productCount, photoCount, marked, rated }) {
  return [
    'What you said',
    `Products used (${productCount})`,
    ...(photoCount ? [`Photos (${photoCount})`] : []),
    'The customer’s texts and calls since the last visit',
    'Past visits',
    ...(marked ? ['The promises you marked'] : []),
    'Whether the customer was home',
    ...(rated ? ['The pest activity you rated'] : []),
    'Rain this week',
  ];
}

// The products as one line ("Taurus SC 4 fl oz · …"), opened to the full
// product tiles on Edit.
function ProductsLine({ active, locked, onOpen }) {
  const listed = active.map((row) => (hasAmount(row) ? `${row.name} ${amountText(row.totalAmount, row.amountUnit)}` : row.name));
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products</h3>
        <Button type="button" variant="ghost" className="tech-visit-action" aria-expanded={false} disabled={locked} onClick={onOpen}>Edit</Button>
      </div>
      <p className="tech-visit-muted">{listed.length ? listed.join(' · ') : 'None selected'}</p>
    </section>
  );
}

// A lane visit's reader answer (GATE_LANE_VOICE_FILL) as the record merges
// it; anything else is a read that failed: nothing fills, and the tech picks
// each field.
function laneFactsOf(heard) {
  const listOf = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);
  return heard?.available === true && heard.status === 'read'
    ? {
      status: 'read',
      areas: listOf(heard.areas),
      findings: listOf(heard.findings),
      unclearGroups: Array.isArray(heard.unclearGroups) ? heard.unclearGroups.filter((key) => typeof key === 'string') : [],
    }
    : { status: 'failed', areas: [], findings: [], unclearGroups: [] };
}

// Reads the note (where product went down, the pests named, how the sprays
// went down; a lane visit's own record), then writes the report from exactly
// those facts, so the report and the record agree. Only the latest request
// may land.
// The note's pest facts (where product went down, the pests named, how the
// sprays went down); anything else is a read that failed.
function pestFactsOf(heard) {
  const listOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);
  return heard?.available === true
    ? {
      status: heard.status,
      areas: listOf(heard.areas),
      unclearAreas: listOf(heard.unclearAreas),
      pests: listOf(heard.pests),
      unclearPests: listOf(heard.unclearPests),
      spray: heard.spray === 'perimeter' || heard.spray === 'spot' ? heard.spray : null,
      unclearSpray: heard.unclearSpray === true,
      noSpray: heard.noSpray === true,
    }
    : { status: 'failed', areas: [], unclearAreas: [], pests: [], unclearPests: [], spray: null, unclearSpray: false, noSpray: false };
}

// A typed visit's reader answer (GATE_TYPED_VOICE_FILL) as the record merges
// it: the form's own values, the words each stood on, the fields left
// unclear. A record that already holds every field the note could fill is
// answered without a read (nothing new, nothing failed). Anything else is a
// read that failed: nothing fills.
function typedFactsOf(heard) {
  if (heard?.available === true && heard.status === 'nothing_to_fill') {
    return { status: 'read', type: heard.type, values: {}, heard: {}, unclearFields: [], score: null, scoreUnclear: false };
  }
  if (heard?.available !== true || heard.status !== 'read') {
    return { status: 'failed', values: {}, heard: {}, unclearFields: [], score: null, scoreUnclear: false };
  }
  return {
    status: 'read',
    type: heard.type,
    values: Object.fromEntries(Object.entries(heard.values || {}).filter(([, value]) => typeof value === 'string' && value)),
    heard: heard.heard && typeof heard.heard === 'object' ? heard.heard : {},
    unclearFields: Array.isArray(heard.unclearFields) ? heard.unclearFields.filter((key) => typeof key === 'string') : [],
    // The technician's own rating (step 4), on a form whose score they set.
    score: Number.isInteger(heard.score?.value) && typeof heard.score.quote === 'string' ? { value: heard.score.value, quote: heard.score.quote } : null,
    scoreUnclear: heard.scoreUnclear === true,
  };
}

// Each record mode's reader and the facts it answers.
const READS = {
  lane: { endpoint: 'lane-facts', factsOf: laneFactsOf },
  typed: { endpoint: 'typed-facts', factsOf: typedFactsOf },
};
const PEST_READ = { endpoint: 'voice-facts', factsOf: pestFactsOf };

function useReportDraft({ request, base, mode = null }) {
  const [draft, setDraft] = useState(null);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState('');
  const sequenceRef = useRef(0);
  const write = useCallback(async ({ buildPayload, note, current, scoreSet, signature, fresh }) => {
    const sequence = ++sequenceRef.current;
    setWriting(true);
    setWriteError('');
    const read = READS[mode] || PEST_READ;
    // A typed read is judged beside the record's present values (never
    // stored on the server).
    const body = mode === 'typed' ? { note, current: current || {}, scoreSet: scoreSet === true } : { note };
    const heard = await request(`${base}/${read.endpoint}`, { method: 'POST', body: JSON.stringify(body) }).catch(() => null);
    const facts = read.factsOf(heard);
    if (sequence !== sequenceRef.current) return;
    // The signature of what the report is written from, read included (a
    // lane visit's record fills from the read).
    const draftSignature = signature(facts);
    const payload = buildPayload(facts);
    let written = null;
    let failure = null;
    try {
      written = await request('/admin/schedule/generate-report', { method: 'POST', body: JSON.stringify(fresh ? { ...payload, fresh: true } : payload) });
    } catch (err) {
      failure = err;
    }
    if (sequence !== sequenceRef.current) return;
    setWriting(false);
    const text = typeof written?.report === 'string' ? written.report.trim() : '';
    if (!text) {
      setWriteError(failure ? `${failure.message || 'The report could not be written.'} Try again.` : 'The writer sent back no report. Try again.');
      return;
    }
    setDraft({ text, base: text, signature: draftSignature, deterministic: written.deterministic === true, facts });
  }, [request, base, mode]);
  const editText = useCallback((text) => setDraft((prev) => ({ ...prev, text })), []);
  return { draft, writing, writeError, write, editText };
}

// Lane voice fill (GATE_LANE_VOICE_FILL, Fast Complete step 2): a specialty
// visit's own record (its places and findings) in place of the pest facts
// (where treated, the pests, the sprays). With no lane every part answers as
// absent: no record, no card.
function useLaneRecord(service) {
  const lane = routedLaneOf(service);
  const preset = lane ? SERVICE_COMPLETION_PRESETS[lane] : null;
  const [laneRecord, setLaneRecord] = useState(EMPTY_LANE_RECORD);
  const ref = useRef(laneRecord);
  ref.current = laneRecord;
  // The record a read lands on: only what is empty and unpicked fills.
  const recordFor = (facts) => (lane ? mergeLaneRecord(ref.current, facts, preset) : null);
  return {
    lane,
    mode: lane ? 'lane' : null,
    record: lane ? laneRecord : null,
    // What the report is written from, for its stale check.
    signaturePart: (record) => (record ? { lane: [record.areas, record.values] } : null),
    inputs: (record, facts) => recordInputs(lane ? 'lane' : null, record, facts),
    recordFor,
    // Lands a read on the record and answers the filled record.
    settle: (facts) => {
      const filled = recordFor(facts);
      if (filled) {
        ref.current = filled;
        setLaneRecord(filled);
      }
      return filled;
    },
    card: ({ draft, locked, writing }) => (lane ? (
      <LaneRecordCard
        lane={lane}
        preset={preset}
        record={laneRecord}
        unclear={draft?.facts?.unclearGroups || []}
        readFailed={draft?.facts?.status === 'failed'}
        locked={locked || writing}
        onChange={(key, value) => setLaneRecord((prev) => changeLaneRecord(prev, key, value, preset))}
      />
    ) : null),
  };
}

// Typed voice fill (GATE_TYPED_VOICE_FILL, Fast Complete step 3): a typed
// visit's own record (its typed form's values and, when the tech sets it,
// the activity score) in place of the pest facts. With no typed form every
// part answers as absent.
function useTypedRecord(service) {
  const typed = routedTypedOf(service);
  const schema = typed && service.typedSchema?.type === typed ? service.typedSchema : null;
  const [typedRecord, setTypedRecord] = useState(EMPTY_TYPED_RECORD);
  const ref = useRef(typedRecord);
  ref.current = typedRecord;
  // A typed inspection's credit toward booked service (the office form's
  // toggle), on unless the tech turns it off; sent only where it is offered.
  const creditOffered = !!schema && service.inspectionCredit === true;
  const [offerCredit, setOfferCredit] = useState(true);
  // The record a read lands on: only fields still empty that nobody picked,
  // and only from an answer for this form.
  const recordFor = (facts) => {
    if (!schema) return null;
    return facts?.type === schema.type ? mergeTypedRecord(ref.current, facts) : ref.current;
  };
  return {
    lane: null,
    mode: schema ? 'typed' : null,
    schema,
    record: schema ? typedRecord : null,
    // What the read is judged beside (the server never fills over it), and
    // whether the tech's rating is already set.
    current: typedRecord.values,
    scoreSet: typedRecord.score != null,
    signaturePart: (record) => (record ? { typed: [record.values, record.score] } : null),
    inputs: (record, facts) => {
      const fields = recordInputs(schema ? 'typed' : null, record, facts, schema);
      return creditOffered ? { ...fields, completionExtras: { ...fields.completionExtras, offerInspectionCredit: offerCredit } } : fields;
    },
    recordFor,
    settle: (facts) => {
      const filled = recordFor(facts);
      if (filled) {
        ref.current = filled;
        setTypedRecord(filled);
      }
      return filled;
    },
    card: ({ draft, locked, writing }) => (schema ? (
      <>
        <TypedRecordCard
          schema={schema}
          record={typedRecord}
          unclear={draft?.facts?.unclearFields || []}
          scoreUnclear={draft?.facts?.scoreUnclear === true}
          readFailed={draft?.facts?.status === 'failed'}
          locked={locked || writing}
          onChange={(key, value) => setTypedRecord((prev) => changeTypedRecord(prev, key, value))}
          onScore={(score) => setTypedRecord((prev) => scoreTypedRecord(prev, score))}
        />
        {creditOffered && <InspectionCreditToggle checked={offerCredit} locked={locked || writing} onChange={setOfferCredit} />}
      </>
    ) : null),
  };
}

// The record a report-flow visit keeps: a lane visit's, a typed visit's, or
// none (a pest visit, whose facts the note gives).
function useVisitRecord(service) {
  const laneState = useLaneRecord(service);
  const typedState = useTypedRecord(service);
  return laneState.lane ? laneState : typedState;
}

// The line a lane or typed visit's products resolve on: the lane's own, or
// a typed form's (a mosquito event's mist; otherwise the pest line).
function productLaneOf(service) {
  const typed = routedTypedOf(service);
  if (typed) return typed === 'mosquito_event' ? 'mosquito' : 'typed';
  return routedLaneOf(service);
}

function ReportFlowForm({
  service, request, ctx, submission, locked, photos, onOverlay, dictationPending, onDictationPending,
  onPhotoBusy, onCompleted, onFullForm, isMobile,
}) {
  // Only opened for a visit in the report flow (service.reportFlow), so the
  // service is always there.
  const base = `/admin/dispatch/${service.id}`;
  const products = useProductRows(ctx, service.serviceType, productLaneOf(service));
  const { rows, addProduct } = products;
  const active = rows.filter((row) => row.active);
  const isReservice = isReserviceVisit(ctx.visit);
  const [form, setForm] = useState(() => ({
    note: '',
    customerHome: DEFAULT_CUSTOMER_HOME,
    rating: ctx.rating.firstVisit ? FIRST_VISIT_RATING : null,
    ratingPrefilled: !!ctx.rating.firstVisit,
    tipId: '',
    customTip: '',
    promiseMarks: {},
    blogPost: null,
  }));
  const tips = useTipLibrary({ base, request });
  const tipsAvailable = !!tips;
  const visitPromises = useVisitPromises({ base, request });
  const blog = useBlogPostOffer({ base, request });
  // A description saved or a photo removed in the note's box reads the
  // photos again, as closing the photo manager does.
  const [photoReloads, setPhotoReloads] = useState(0);
  const reloadPhotos = useCallback(() => setPhotoReloads((n) => n + 1), []);
  const [photoHold, setPhotoHold] = useState('');
  // The sheet's header (Full form) waits on the same photo change in hand.
  useEffect(() => { onPhotoBusy?.(!!photoHold); }, [photoHold, onPhotoBusy]);
  useEffect(() => () => onPhotoBusy?.(false), [onPhotoBusy]);
  const noteBoxPhotos = service.noteBoxPhotosEnabled === true;
  const visitPhotos = useVisitPhotos({ serviceId: service.id, request, version: photos.version + photoReloads, keepOnFailure: noteBoxPhotos });
  const trace = useVisitTrace({ serviceId: service.id, request });
  // A lane or typed visit's own record (or none: a pest visit).
  const recordState = useVisitRecord(service);
  const { lane, mode, record } = recordState;
  const report = useReportDraft({ request, base, mode });
  const { draft, writing } = report;
  const [step, setStep] = useState('visit');

  const perimeterFeet = perimeterFeetOf(trace.zone);
  const traceAvailable = trace.enabled && service.traceEligible !== false;
  // The property this sheet loaded: a trace saved or removed here is refused
  // if the office has moved the visit to another one since.
  const loadedPropertyId = ctx.visit && 'propertyId' in ctx.visit ? ctx.visit.propertyId : undefined;
  const promiseMarks = visitPromises.available ? promiseMarksPayload(form.promiseMarks, visitPromises.promises) : [];
  const signature = writerSignature(form, rows, promiseMarks, visitPhotos.photos, recordState.signaturePart(record));
  const stale = !!draft && draft.signature !== signature;
  const ratingAllowed = ctx.rating.allowed;
  const action = writeAction(draft, stale, report.writeError);
  const holdInputs = {
    form, active, ratingAllowed, dictationPending, photoHold, photosLoaded: visitPhotos.loaded, photosFailed: visitPhotos.failed, promisesLoaded: visitPromises.loaded, mode,
  };
  const generateMissing = reportFlowMissing({ ...holdInputs, stage: 'generate' });
  const completeMissing = reportFlowMissing({
    ...holdInputs, stage: 'complete', draft, writing, perimeterFeet, traceAvailable, traceRead: trace, lane, record, typedSchema: recordState.schema, traceOnReport: ctx.traceOnReport,
  });

  // "Update inventory or remove it": once the stock is updated, the tech
  // re-reads it here rather than close the sheet and lose the visit.
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
  const stockButton = generateMissing.stockRow && !locked ? (
    <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={checkingStock} onClick={checkStock}>Check stock</Button>
  ) : null;

  const write = (fresh) => {
    if (writing || generateMissing.reason) return;
    setStep('report');
    // A lane or typed read first fills the record (only what is empty and
    // unpicked), and the report is written from the filled record.
    report.write({
      buildPayload: (facts) => {
        const { heard, writerExtras } = recordState.inputs(recordState.settle(facts), facts);
        const payload = writerPayload({ service, visit: ctx.visit, form, rows, facts: heard, ratingAllowed, photos: visitPhotos.photos, promiseMarks });
        return { ...payload, ...writerExtras };
      },
      note: form.note,
      // A typed read is judged beside the record's present values.
      current: recordState.current,
      scoreSet: recordState.scoreSet,
      signature: (facts) => writerSignature(form, rows, promiseMarks, visitPhotos.photos, recordState.signaturePart(recordState.recordFor(facts))),
      fresh,
    });
  };
  const summary = () => {
    // A typed visit's places live in its form, so its record names the form.
    const where = { lane: () => record.areas, typed: () => [recordState.schema.label] }[mode];
    const areas = where ? where() : (draft?.facts?.areas || []);
    return [active.map((row) => row.name).join(', '), areas.join(', ')].filter(Boolean).join(' · ');
  };
  const submit = () => {
    if (completeMissing.reason && !submission.hasPendingBody()) return;
    submission.submit(
      () => reportCompletionBody({
        form, rows, draft, perimeterFeet, trace, visitIdentity: ctx.visitIdentity, ratingAllowed, tipsAvailable, isReservice, promiseMarks,
        recordFields: recordState.inputs(record, draft?.facts),
      }),
      summary(),
    );
  };
  // The tracer opens over the sheet, the way the photo manager does.
  const openTracer = () => onOverlay(
    <TechTreatmentZoneModal
      serviceId={service.id}
      expectedPropertyId={loadedPropertyId}
      openVisitOnly
      customerName={customerNameOf(ctx.visit, service) || 'Customer'}
      address={service.routedAddress || service.address || ''}
      lat={service.lat}
      lng={service.lng}
      onClose={() => onOverlay(null)}
      onSaved={trace.saved}
    />,
  );

  // "Remove the trace": a saved trace the note no longer backs comes off,
  // then the trace is read again. A refusal (the visit moved, or was
  // completed elsewhere) is shown and the hold stays.
  const [removingTrace, setRemovingTrace] = useState(false);
  const [traceError, setTraceError] = useState('');
  const removeTrace = async () => {
    setRemovingTrace(true);
    setTraceError('');
    const bound = loadedPropertyId === undefined ? '' : `?expectedPropertyId=${encodeURIComponent(loadedPropertyId ?? '')}`;
    try {
      await request(`/tech/services/${service.id}/treatment-zone${bound}`, { method: 'DELETE' });
    } catch (err) {
      setTraceError(err?.message || 'Couldn’t remove the trace. Try again.');
    }
    setRemovingTrace(false);
    trace.reload();
  };

  if (submission.done) {
    const doneMarks = promiseMarks.filter((mark) => mark.mark === 'done').map((mark) => ({
      id: mark.id,
      description: visitPromises.promises.find((promise) => promise.id === mark.id)?.description || '',
    }));
    return (
      <SavedView service={service} summary={submission.done.summary} onCompleted={onCompleted}>
        <SentSummary result={submission.done.response} doneMarks={doneMarks} base={base} request={request} followupBooking={ctx.followupBooking} />
        <CollectPayment result={submission.done.response} />
      </SavedView>
    );
  }
  if (step === 'report') {
    const stepTrace = traceAvailable && perimeterSprayRow(active, draft) ? trace : null;
    return (
      <ReportStep
        report={report}
        stale={stale}
        action={action}
        locked={locked}
        submission={submission}
        generateMissing={generateMissing}
        completeMissing={completeMissing}
        stockButton={stockButton}
        // Only a perimeter spray is traced: a spot visit has no trace step
        // (nor has a lane or typed visit: the schedule routes it untraced,
        // and a trace saved on the full form goes on its report as it is).
        trace={stepTrace}
        traced={!!(mode ? ctx.traceOnReport && trace.zone : stepTrace?.zone)}
        pestHeard={!mode}
        laneCard={recordState.card({ draft, locked, writing })}
        onRetryTrace={trace.failed ? trace.reload : null}
        onRemoveTrace={completeMissing.fix === 'remove_trace' ? removeTrace : null}
        removingTrace={removingTrace}
        traceError={traceError}
        sources={writerSources({
          productCount: active.length,
          photoCount: visitPhotos.photos.length,
          marked: promiseMarks.length > 0,
          rated: ratingAllowed && Number.isInteger(form.rating),
        })}
        photoCount={visitPhotos.photos.length}
        blogPost={form.blogPost}
        onWrite={write}
        onSubmit={submit}
        onTrace={openTracer}
        onBack={() => setStep('visit')}
        onConfirm={() => submission.confirm(summary())}
        // A promise that changed after the report was written: the list
        // reloads, and a mark that no longer holds makes the report stale.
        onBackFromPrompt={() => {
          if (submission.prompt?.code === 'promise_marks_changed') visitPromises.reload();
          submission.dismissPrompt();
        }}
      />
    );
  }
  return (
    <VisitStep
      service={service}
      ctx={ctx}
      form={form}
      setForm={setForm}
      products={products}
      active={active}
      sprayMethod={reportSprayMethod(draft?.facts)}
      tips={tips}
      blog={blog}
      visitPromises={visitPromises}
      photos={visitPhotos.photos}
      onPhotos={photos.open}
      noteBoxPhotos={noteBoxPhotos}
      photosReadFailed={visitPhotos.failed}
      request={request}
      photoHold={photoHold}
      onPhotoHold={setPhotoHold}
      onPhotosUpdate={visitPhotos.update}
      onPhotosChanged={reloadPhotos}
      locked={locked}
      dictationPending={dictationPending}
      onDictationPending={onDictationPending}
      onFullForm={onFullForm}
      isMobile={isMobile}
      onAddProduct={addProduct}
      footer={action
        ? { reason: generateMissing.reason, label: action.label, onAction: () => write(action.fresh) }
        // A photo change in hand (a description open, a change saving, a
        // removal to answer) holds the way back too (codex local r2).
        : { reason: photoHold, label: 'Back to the report', onAction: () => setStep('report') }}
      writing={writing}
      warn={!!generateMissing.stockRow}
      stockButton={stockButton}
    />
  );
}

// The report step: the report being written, or the report to read (edit,
// write again), the trace, and the footer that fits: answer a completion
// prompt, write the report, or complete & send.
function ReportStep({
  report, stale, action, locked, submission, generateMissing, completeMissing, stockButton, trace, traced, sources, photoCount,
  blogPost, pestHeard, laneCard, onWrite, onSubmit, onTrace, onRetryTrace, onRemoveTrace, removingTrace, traceError, onBack, onConfirm,
  onBackFromPrompt,
}) {
  const { draft, writing, writeError } = report;
  const [editing, setEditing] = useState(false);
  const showDraft = draft && !writing;
  let footer = (
    <CompleteFooter submission={submission} missingReason={completeMissing.reason} warn={!!completeMissing.stockRow} label="Complete & send" onSubmit={onSubmit}>
      {stockButton}
      {onRetryTrace && (
        <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" disabled={locked} onClick={onRetryTrace}>Check the trace again</Button>
      )}
      {onRemoveTrace && (
        <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={removingTrace} disabled={locked} onClick={onRemoveTrace}>Remove the trace</Button>
      )}
    </CompleteFooter>
  );
  if (submission.prompt) {
    footer = (
      <footer className="tech-visit-footer tech-visit-footer--stacked">
        <ConfirmPrompt prompt={submission.prompt} busy={submission.submitting} onBack={onBackFromPrompt} onConfirm={onConfirm} />
      </footer>
    );
  } else if (action) {
    footer = <StepFooter reason={generateMissing.reason} label={action.label} busy={writing} disabled={writing} onAction={() => onWrite(action.fresh)} />;
  }
  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body">
        <Button type="button" variant="ghost" className="tech-visit-action tech-report-back" disabled={locked || writing} onClick={() => { setEditing(false); onBack(); }}>
          Back to the visit
        </Button>
        {writing && <WritingView sources={sources} />}
        {writeError && !writing && <ActionFeedback error className="tech-visit-feedback">{writeError}</ActionFeedback>}
        {traceError && <ActionFeedback error className="tech-visit-feedback">{traceError}</ActionFeedback>}
        {showDraft && (
          <ReportCard
            draft={draft}
            editing={editing}
            stale={stale}
            locked={locked}
            photoCount={photoCount}
            traced={traced}
            blogPost={blogPost}
            pestHeard={pestHeard}
            onEdit={() => setEditing(true)}
            onDoneEditing={() => setEditing(false)}
            onChangeText={report.editText}
            onWriteAgain={() => { setEditing(false); onWrite(true); }}
          />
        )}
        {showDraft && laneCard}
        {showDraft && trace && <TraceSection trace={trace} locked={locked} onTrace={onTrace} />}
        {submission.submitting && <ActionFeedback className="tech-visit-feedback">Saving completion…</ActionFeedback>}
      </div>
      {footer}
    </div>
  );
}

// The visit step: talk, products, photos, the three taps, the tip, the
// promise check, then write the report (or go back to it while current).
function VisitStep({
  service, ctx, form, setForm, products, active, sprayMethod, tips, blog, visitPromises, photos, onPhotos, locked, dictationPending,
  onDictationPending, onFullForm, isMobile, onAddProduct, footer, writing, warn, stockButton,
  noteBoxPhotos, photosReadFailed, request, photoHold, onPhotoHold, onPhotosUpdate, onPhotosChanged,
}) {
  const [editAmounts, setEditAmounts] = useState(false);
  const [productsOpen, setProductsOpen] = useState(false);
  const setField = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  // Each dictated chunk joins what is already in the box (stable for the mic).
  const appendNote = useCallback(
    (text) => setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text })),
    [setForm],
  );
  // The house mix is always on the sheet, so "Used most" lists the rest.
  const pickerCommonProducts = useMemo(() => {
    const mixIds = new Set(ctx.rows.map((row) => String(row.productId)));
    return ctx.commonProducts.filter((common) => !mixIds.has(String(common.productId)));
  }, [ctx.rows, ctx.commonProducts]);
  const picker = useProductPicker({
    products: ctx.products,
    commonProducts: pickerCommonProducts,
    rows: products.rows,
    // A photo description's own mic may be recording: the picker never
    // covers it (codex local r3 on #5624).
    locked: locked || dictationPending || !!photoHold,
    isMobile,
    onFullForm,
    onPick: (product) => onAddProduct(product, sprayMethod),
  });
  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          {/* Photos in the note's box (GATE_NOTE_BOX_PHOTOS): the note's mic
              waits while a photo's description is open or a change is
              saving, so one microphone records at a time. */}
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked || !!photoHold}>
            {noteBoxPhotos ? (
              <TechNoteBoxPhotos
                serviceId={service.id}
                request={request}
                photos={photos}
                disabled={locked || dictationPending}
                readFailed={photosReadFailed}
                onAdd={onPhotos}
                onUpdate={onPhotosUpdate}
                onChanged={onPhotosChanged}
                onRetry={onPhotosChanged}
                onHold={onPhotoHold}
              />
            ) : null}
          </VisitNote>
          {productsOpen ? (
            <ProductsSection
              products={products}
              method={sprayMethod}
              stickyPicks
              editAmounts={editAmounts}
              locked={locked}
              onToggleEdit={() => setEditAmounts((on) => !on)}
              other={picker.button}
              popover={picker.popover}
              onCollapse={() => setProductsOpen(false)}
            />
          ) : (
            <ProductsLine active={active} locked={locked} onOpen={() => setProductsOpen(true)} />
          )}
          {/* A clip being recorded keeps recording behind the photo manager, so
              photos wait until the dictation is finished. */}
          {!noteBoxPhotos && <PhotoStripSection photos={photos} locked={locked || dictationPending} onOpen={onPhotos} />}
          <CustomerHomeSection value={form.customerHome} locked={locked} onChange={(value) => setField('customerHome', value)} />
          {ctx.rating.allowed && (
            <ActivitySection
              value={form.rating}
              scaleLabels={ctx.rating.scaleLabels}
              locked={locked}
              onChange={(rating) => setForm((prev) => ({ ...prev, rating, ratingPrefilled: false }))}
            />
          )}
          {tips && (
            <TipSection
              library={tips}
              tipId={form.tipId}
              customTip={form.customTip}
              locked={locked}
              onPick={(id) => setForm((prev) => ({ ...prev, tipId: prev.tipId === id ? '' : id, customTip: '' }))}
              onCustom={(value) => setForm((prev) => ({ ...prev, customTip: value, tipId: value.trim() ? '' : prev.tipId }))}
            />
          )}
          {blog.available && (
            <BlogPostSection search={blog.search} value={form.blogPost} locked={locked} onChange={(post) => setField('blogPost', post)} />
          )}
          {visitPromises.available && visitPromises.promises.length > 0 && (
            <PromisesSection
              promises={visitPromises.promises}
              total={visitPromises.total}
              marks={form.promiseMarks}
              locked={locked}
              onChange={(next) => setField('promiseMarks', next)}
            />
          )}
        </fieldset>
      </div>
      <StepFooter reason={footer.reason} warn={warn} label={footer.label} busy={writing} disabled={writing} onAction={footer.onAction} coverProps={picker.coverProps}>
        {stockButton}
      </StepFooter>
      {picker.sheet}
    </div>
  );
}

// Only an exact true turns the customer recap on (GATE_FAST_COMPLETE_RECAP,
// delivered as the schedule row's fastCompleteRecapEnabled).
const recapOn = (service) => service?.recapEnabled === true;

// After Complete: the exact text the server sent (its words, shown as sent),
// or why none went. Nothing when the sheet never asked for one.
// A held message's channel is only known once the replay picks it.
function queuedLabel(channel) {
  if (channel === 'push') return 'Queued for the customer\'s app';
  if (channel === 'sms') return 'Text queued';
  return 'Message queued';
}

function CustomerTextResult({ outcome }) {
  if (!outcome) return null;
  const { sent, queued, unverified, body, reason, channel } = outcome;
  // The recorded channel decides the words: a text is not an app message.
  const app = channel === 'push';
  return (
    <div data-testid="fast-complete-text-result">
      {sent && <p className="tech-visit-muted">{app ? 'Sent to the customer\'s app:' : 'Text sent to the customer:'}</p>}
      {!sent && queued && <p className="tech-visit-muted">{queuedLabel(channel)}: {reason}.</p>}
      {!sent && unverified && <p className="tech-visit-muted">Delivery not confirmed: {reason}.</p>}
      {!sent && !queued && !unverified && <p className="tech-visit-muted">No text sent: {reason}.</p>}
      {body && <blockquote data-testid="fast-complete-text-body">{body}</blockquote>}
    </div>
  );
}

// Every product on the sheet. A house-mix tile taps off and on (struck
// through, never removed); an added product's tile opens its editor.
// stickyPicks (the report flow): a way the tech picks for a product stays that
// way. The visit's way there is the note's read, which can change when the
// report is written, so a pick never quietly follows it.
function ProductsSection({ products, heardLines = null, method, editAmounts, locked, onToggleEdit, other, popover, onCollapse, stickyPicks = false }) {
  const { rows, editingId, setEditingId, updateRow, removeRow } = products;
  const editorId = useId();
  const tileRefs = useRef(new Map());
  const editing = rows.find((row) => row.added && row.productId === editingId) || null;
  const onTile = (row) => {
    if (row.added) setEditingId((id) => (id === row.productId ? null : row.productId));
    else updateRow(row.productId, { active: !row.active });
  };
  // Focus goes where the tech is next: back to the product's tile, or, with
  // the product removed, to "+ Other product".
  const closeEditor = () => {
    tileRefs.current.get(editing.productId)?.focus();
    setEditingId(null);
  };
  const removeEditing = () => {
    other.buttonRef.current?.focus();
    removeRow(editing.productId);
  };
  const editAmountsButton = (
    <Button type="button" variant="ghost" className="tech-visit-action" aria-pressed={editAmounts} onClick={onToggleEdit}>
      {editAmounts ? 'Done' : 'Edit amounts'}
    </Button>
  );
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
        {/* The report flow folds the products back into one line. */}
        {onCollapse ? (
          <span className="tech-visit-head-actions">
            {editAmountsButton}
            <Button type="button" variant="ghost" className="tech-visit-action" onClick={onCollapse}>Hide</Button>
          </span>
        ) : editAmountsButton}
      </div>
      <div className="tech-visit-tile-grid">
        {rows.map((row) => (
          <ProductTile
            key={row.productId}
            tileRef={(node) => {
              if (node) tileRefs.current.set(row.productId, node);
              else tileRefs.current.delete(row.productId);
            }}
            row={row}
            editorId={row === editing ? editorId : null}
            locked={locked}
            onClick={() => onTile(row)}
          />
        ))}
      </div>
      {heardLines}
      {editing && (
        <AddedProductEditor
          key={editing.productId}
          id={editorId}
          row={editing}
          method={method}
          stickyPicks={stickyPicks}
          locked={locked}
          onChange={(patch) => updateRow(editing.productId, patch)}
          onRemove={removeEditing}
          onDone={closeEditor}
        />
      )}
      {editAmounts && rows.filter((row) => row.active).map((row) => (
        <AmountRow
          key={row.productId}
          row={row}
          rate={rowRate(row, method)}
          onChange={(patch) => updateRow(row.productId, 'rateInput' in patch ? { ...patch, rateMethod: rowMethod(row, method) } : patch)}
        />
      ))}
      <OtherProductButton {...other} popover={popover} />
    </section>
  );
}

// A product tile names what goes on the record: "Taurus SC — 4 fl oz". A
// tracked stock at zero shows on the tile; Complete holds for it when the
// server would refuse the amount against that stock (stockHolds).
function ProductTile({ tileRef, row, editorId, locked, onClick }) {
  const outOfStock = row.active && isOutOfStock(row.product);
  const amount = hasAmount(row) ? amountText(row.totalAmount, row.amountUnit) : 'How much?';
  const state = row.added
    ? { 'aria-expanded': !!editorId, 'aria-controls': editorId || undefined }
    : { 'aria-pressed': row.active };
  return (
    <Button
      ref={tileRef}
      type="button"
      variant="secondary"
      className={cn('tech-visit-action tech-visit-product tech-visit-product-tile', {
        'tech-visit-product--off': !row.active,
        'tech-visit-product--added': row.added,
        'tech-visit-product--editing': !!editorId,
        'tech-visit-product--stock': outOfStock,
      })}
      disabled={locked}
      onClick={onClick}
      {...state}
    >
      {/* Two lines on the tile (the amount never wraps apart from its unit);
          one name for assistive tech: "Taurus SC — 4 fl oz". */}
      <span className="tech-visit-product-name">{row.name}</span>
      <span className="sr-only"> — </span>
      <span className="tech-visit-product-amount">{amount}</span>
      {outOfStock && (
        <>
          {' '}
          <span className="tech-visit-stock-flag"><WarningIcon />0 in stock</span>
        </>
      )}
    </Button>
  );
}

// An added product: how much, in the units its measure allows, and how it
// went down. Fresh from the picker, the amount is the next thing to enter.
function AddedProductEditor({ id, row, method, stickyPicks, locked, onChange, onRemove, onDone }) {
  const nameId = useId();
  const amountId = useId();
  const amountRef = useRef(null);
  // Only as the editor opens: typing must not move focus.
  useEffect(() => {
    if (!hasAmount(row)) amountRef.current?.focus();
  }, []);
  return (
    <div id={id} role="group" aria-labelledby={nameId} className="tech-product-editor">
      <div className="tech-product-editor-head">
        <h4 id={nameId} className="tech-product-editor-name">{row.name}</h4>
        <span className="tech-visit-muted">{[categoryLabel(row.product), 'added by you'].filter(Boolean).join(' · ')}</span>
      </div>
      <AmountEntry id={amountId} inputRef={amountRef} row={row} locked={locked} onChange={onChange} />
      <RowMethodPicker row={row} method={method} sticky={stickyPicks} locked={locked} onChange={onChange} />
      <div className="tech-product-editor-actions">
        <Button type="button" variant="secondary" className="tech-visit-action tech-product-remove" disabled={locked} onClick={onRemove}>Remove</Button>
        <Button type="button" variant="secondary" className="tech-visit-action tech-visit-primary" disabled={locked} onClick={onDone}>Done</Button>
      </div>
    </div>
  );
}

const methodLabel = (value) => {
  const text = String(value || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// How an added product went down. A spray follows the visit's How until the
// tech picks another way; a product with its own catalog method (a bait, a
// granule) starts there. Picking the row's standard way puts it back on it.
// What a spray with no way picked goes down as: the visit's How, the way the
// note says (the report flow), or a spot treatment on a lane visit (its note
// is read for its record, not its sprays).
function followHint(row, sticky) {
  if (!sticky) return 'Same as the visit\'s How';
  // voice fill's sticky picks: the row still follows How until a way is picked
  if (sticky === 'how') return 'Same as the visit\'s How until you pick one';
  return row.lane ? 'Spot treatment until you pick another way' : 'Goes the way your note says until you pick one';
}

function RowMethodPicker({ row, method, sticky = false, locked, onChange }) {
  const labelId = useId();
  const current = rowMethod(row, method);
  const standard = SPRAY_METHODS.has(row.catalogMethod) ? method : row.catalogMethod;
  const ways = row.lane ? LANE_METHOD_CHOICES : ROW_METHOD_CHOICES;
  const ownMethod = row.catalogMethod && !ways.some((choice) => choice.value === row.catalogMethod);
  const choices = ownMethod ? [...ways, { value: row.catalogMethod, label: methodLabel(row.catalogMethod) }] : ways;
  const pick = (value) => onChange({
    // the tech's own pick, even when it is the row's standard way (voice fill never replaces it)
    methodPicked: true,
    methodInput: !sticky && value === standard ? null : value,
    // A rate typed for one method doesn't carry to another.
    ...(value !== current ? { rateInput: null } : {}),
  });
  return (
    <div>
      <span id={labelId} className="tech-product-editor-label">How</span>
      <div role="group" aria-labelledby={labelId} className="tech-visit-tile-grid">
        {choices.map((choice) => (
          <Chip disabled={locked} key={choice.value} label={choice.label} pressed={current === choice.value} onClick={() => pick(choice.value)} />
        ))}
      </div>
      {followsVisitMethod(row) && <p className="tech-visit-muted">{followHint(row, sticky)}</p>}
    </div>
  );
}

function PestsSection({ form, setField, locked }) {
  const [moreTapped, setShowMore] = useState(false);
  // A pest from the second row (a voice fill can pick one) keeps it open.
  const showMore = moreTapped || PEST_CHIPS_MORE.some((label) => form.pests.has(label));
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

// Photos are staged against the visit by the existing photo manager (opened
// over the sheet by the parent) and promoted into the service record at
// completion. Optional here.
function PhotosSection({ serviceId, request, photos, locked }) {
  const [count, setCount] = useState(null);
  // Only the latest read may set the count: a first read still in flight
  // when the manager closes must not land after the refreshed one.
  const readSequence = useRef(0);
  useEffect(() => {
    const sequence = ++readSequence.current;
    request(`/tech/services/${serviceId}/photos`)
      .then((data) => {
        if (sequence === readSequence.current) setCount(Array.isArray(data?.photos) ? data.photos.length : null);
      })
      // The count is a convenience; the photo manager reports its own errors.
      .catch(() => { if (sequence === readSequence.current) setCount(null); });
    return () => { readSequence.current += 1; };
  }, [request, serviceId, photos.version]);
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Photos</h3>
        <span className="tech-visit-muted">{count ? `${count} added` : 'Optional'}</span>
      </div>
      <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" onClick={photos.open} disabled={locked}>
        {count ? 'Add or view photos' : 'Add photos'}
      </Button>
    </section>
  );
}

// "Edit amounts": every product's amount in its own measure's units, and
// its rate. A label rate in mL is neither shown nor recorded (owner ruling
// 2026-09-27): rowRate leaves such a row without a rate unit.
function AmountRow({ row, rate, onChange }) {
  const inputId = useId();
  const rateId = useId();
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
          // amountPicked: the tech's own entry, even when it equals the seeded amount
          onChange={(e) => onChange({ totalAmount: e.target.value, amountPicked: true })}
        />
        <select
          className="ui-control tech-visit-control"
          aria-label={`Unit for ${row.name}`}
          value={row.amountUnit}
          onChange={(e) => onChange({ amountUnit: e.target.value, amountPicked: true })}
        >
          {UNIT_CHOICES[row.dimension].map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
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
