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
  PromisesSection, ReportCard, SentSummary, StepFooter, TraceSection, WritingView, customerHomeWriterLabel,
  factsHold, perimeterFeetOf, photoCaptionsOf, useVisitPhotos, useVisitPromises, useVisitTrace,
} from './FastCompleteReport';
import { promiseMarksPayload } from '../schedule/PromiseCheck';
import {
  AmountEntry, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, SavedView,
  SheetHeader, TipSection, VisitNote, customerNameOf, techTipsOf, toggleInSet, useProductPicker, useTipLibrary,
  visitChangedSinceSchedule,
} from './FastCompleteParts';
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

function blockedReasonFor(context, service) {
  const visit = context?.service || {};
  if (visitChangedSinceSchedule(visit, service) || (service?.reportFlow && serviceChangedSinceSchedule(visit, service))) {
    return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  }
  if (!service?.reportFlow && visit.serviceKey !== 'pest_re_service') return 'This visit is no longer a pest re-service. Use the full form.';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  if (context?.eligible !== true) return 'This visit needs the full form.';
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
function productRow(product, { serviceType, totalAmount = '', common = null, visitMethod = DEFAULT_METHOD, added = false }) {
  const row = {
    product,
    productId: product.id,
    name: product.name,
    catalogMethod: catalogMethodOf(product, serviceType),
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

function catalogMethodOf(product, serviceType) {
  const resolved = defaultApplicationMethodForLine(product, 'pest', { serviceType });
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
  const resolved = resolveRatePrefill(row.product, { applicationMethod: rowMethod(row, sprayMethod), serviceLine: 'pest' });
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
function missingRequirement(form, rows, ratingAllowed, dictationPending) {
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

function completionBody(form, rows, { visitIdentity, ratingAllowed, tipsAvailable, recapEnabled }) {
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
    techTips: techTipsOf(form, tipsAvailable),
    // Gate off (GATE_FAST_COMPLETE_RECAP): no customer text, review ask or pay
    // link. Gate on: the fixed re-service text; the server composes it.
    ...(recapEnabled ? CUSTOMER_RECAP_FLAGS : NO_CUSTOMER_RECAP_FLAGS),
  };
}

// The report flow takes visits the house mix is not for (an initial
// cleanout), so it seeds only where the recap modal and the full form would;
// a re-service sheet always starts with it.
function seedsHouseMix(visit, { serviceType, reportFlow }) {
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
        setCtx({
          loading: false,
          loadError: '',
          blockedReason: blockedReasonFor(data, {
            routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress, reportFlow, routedServiceType, routedServiceKey,
          }),
          visit,
          products,
          commonProducts,
          // The house totals are in the unit the resolver gives (4 fl oz), so
          // a house row never takes a usual unit: that is for picked products
          // (a Taurus usually logged in gal would otherwise open as "4 gal").
          rows: seedsHouseMix(visit, { serviceType, reportFlow })
            ? pestDefaultMixSelections(products).map(({ product, totalAmount }) => productRow(product, { serviceType, totalAmount }))
            : [],
          visitIdentity: sheetVisitIdentity(visit, reportFlow),
          rating: {
            allowed: ratingContract?.allowed === true,
            scaleLabels: ratingContract?.scaleLabels || null,
            // The report flow opens a first visit's tracker at 5 (owner
            // ruling 2026-09-24, the full form's prefill).
            firstVisit: ratingContract?.allowed === true && ratingContract?.firstVisit === true,
          },
        });
      } catch (err) {
        if (active) setCtx((prev) => ({ ...prev, loading: false, loadError: err?.message || 'Failed to load products' }));
      }
    })();
    return () => { active = false; };
  }, [base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress, routedServiceType, routedServiceKey, reportFlow]);
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

export default function FastCompleteSheet({ service, request, onClose, onCompleted, onFullForm }) {
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
      <SheetHeader titleId={titleId} title={sheetTitle(reportFlow, ctx.visit, done)} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photoManager} onOverlay={setSheetOverlay} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, ctx, submission, locked, photos, onOverlay, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile }) {
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
    return <ReportFlowForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photos} onOverlay={onOverlay} dictationPending={dictationPending} onDictationPending={onDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />;
  }
  return <FastCompleteForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photos} dictationPending={dictationPending} onDictationPending={onDictationPending} onFullForm={onFullForm} isMobile={isMobile} />;
}

// The products on the sheet: the house mix it opened with, plus what the tech
// added from the picker. One product, one row (/complete keeps only the
// first row per product); an added product's editor is open while the tech
// sets how much and how.
function useProductRows(ctx, serviceType) {
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
      productRow(product, { serviceType, common: commonById.get(String(product.id)), visitMethod, added: true }),
    ]));
    setEditingId(product.id);
  }, [serviceType, commonById]);
  const removeRow = useCallback((productId) => {
    setRows((prev) => prev.filter((row) => row.productId !== productId));
    setEditingId(null);
  }, []);
  // A rate typed for one spray method doesn't carry to another.
  const clearFollowingRates = useCallback(() => {
    setRows((prev) => prev.map((row) => (followsVisitMethod(row) ? { ...row, rateInput: null } : row)));
  }, []);
  // A fresh stock read changes each row's stock on hand, nothing the tech set.
  const applyStock = useCallback((fresh) => {
    setRows((prev) => prev.map((row) => ({ ...row, product: withFreshStock(row.product, fresh) })));
  }, []);
  return { rows, editingId, setEditingId, updateRow, addProduct, removeRow, clearFollowingRates, applyStock };
}

function FastCompleteForm({ service, request, ctx, submission, locked, photos, dictationPending, onDictationPending, onFullForm, isMobile }) {
  const products = useProductRows(ctx, service?.serviceType);
  const { rows, addProduct, clearFollowingRates } = products;
  const [editAmounts, setEditAmounts] = useState(false);
  const [form, setForm] = useState(() => ({
    pests: new Set(), otherPest: '', areas: new Set(), method: DEFAULT_METHOD, linearFt: '', activity: '', note: '',
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
  // The house mix is always on the sheet, so "Used most" lists the rest.
  const pickerCommonProducts = useMemo(() => {
    const mixIds = new Set(ctx.rows.map((row) => String(row.productId)));
    return ctx.commonProducts.filter((common) => !mixIds.has(String(common.productId)));
  }, [ctx.rows, ctx.commonProducts]);
  const picker = useProductPicker({
    products: ctx.products,
    commonProducts: pickerCommonProducts,
    rows,
    locked: locked || dictationPending,
    isMobile,
    onFullForm,
    onPick: (product) => addProduct(product, form.method),
  });

  const { reason: missingReason, stockRow } = missingRequirement(form, rows, ctx.rating.allowed, dictationPending);
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
      }),
      `${names} · ${targetsOf(form).join(', ')}`,
    );
  };

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
          {/* A clip being recorded keeps recording behind the photo manager, so
              photos wait until the dictation is finished. */}
          <PhotosSection serviceId={service?.id} request={request} photos={photos} locked={locked || dictationPending} />
          <ProductsSection
            products={products}
            method={form.method}
            editAmounts={editAmounts}
            locked={locked}
            onToggleEdit={() => setEditAmounts((on) => !on)}
            other={picker.button}
            popover={picker.popover}
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
        label="Complete re-service"
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
function writerSignature(form, rows, promiseMarks, photos) {
  return JSON.stringify({
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
  form, rows, draft, perimeterFeet, trace, visitIdentity, ratingAllowed, tipsAvailable, isReservice, promiseMarks,
}) {
  const ratingSent = ratingAllowed && Number.isInteger(form.rating);
  return {
    visitOutcome: 'completed',
    ...(visitIdentity ? { expectedVisit: visitIdentity } : {}),
    // The saved trace this report was judged against (null: none, or a map
    // gate that hides traces), for the server to re-check under the visit
    // lock and freeze: the report shows only this trace.
    traceSeen: trace.zone?.updated_at ?? null,
    products: rows.filter((row) => row.active).map((row) => {
      const application = recordedApplication(row, draft.facts);
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      return {
        productId: row.productId,
        ...application,
        totalAmount,
        amountUnit,
        ...(application.applicationMethod === 'perimeter_spray' ? { areaValue: perimeterFeet, areaUnit: 'linear_ft' } : {}),
      };
    }),
    areasServiced: draft.facts?.areas || [],
    customerInteraction: form.customerHome,
    ...(ratingSent ? { clientPestRating: form.rating } : {}),
    // The untouched first-visit 5: the server re-checks it is still the
    // first visit (owner ruling 2026-09-24).
    ...(ratingSent && form.ratingPrefilled ? { clientPestRatingPrefilled: true } : {}),
    technicianNotes: draft.text.trim(),
    reportDraftBase: draft.base,
    ...(promiseMarks.length ? { promiseMarks } : {}),
    techTips: techTipsOf(form, tipsAvailable),
    sendCompletionSms: true,
    includePayLink: !isReservice,
    requestReview: !isReservice,
  };
}

// What still holds the report (generate) or the completion (complete), in
// screen order, the product whose stock holds it, and the fix the hold
// offers on the sheet ('remove_trace').
function reportFlowMissing({ form, active, ratingAllowed, dictationPending, photosLoaded, promisesLoaded, stage, ...sendInputs }) {
  const outOfStock = active.find((row) => stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const missingAmount = active.find((row) => !hasAmount(row));
  const [, reason = '', stockRow = null, fix = null] = [
    [dictationPending, 'Finish dictating first.'],
    [!photosLoaded, 'Loading photos…'],
    [!promisesLoaded, 'Loading promises…'],
    [!active.length, 'Select at least one product.'],
    [outOfStock, outOfStock && `${outOfStock.name} shows 0 in stock. Update inventory or remove it.`, outOfStock],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [ratingAllowed && !Number.isInteger(form.rating), 'Pick the pest activity, 1 to 5.'],
    ...(stage === 'complete' ? sendHolds({ active, ...sendInputs }) : []),
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

function sendHolds({ active, draft, writing, perimeterFeet, traceAvailable, traceRead }) {
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
    [writing, 'Writing the report…'],
    [!draft, 'Generate the report first.'],
    [draft && !draft.text.trim(), 'The report is empty. Write it again.'],
    [draft && factsHold(draft.facts), draft && factsHold(draft.facts)],
    [sprayedAnyway, sprayedAnyway && `Your note says you didn’t spray, but ${sprayedAnyway.name} is a spray. Remove it or change how it went down, then write it again.`],
    // Whether a trace is saved decides both holds below.
    [!traceRead.loaded, 'Checking for a saved trace…'],
    [traceRead.failed, 'Couldn’t check for a saved trace. Check the trace again.'],
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

// Reads the note (where product went down, the pests named, how the sprays
// went down), then writes the report from exactly those facts, so the report
// and the record agree. Only the latest request may land.
function useReportDraft({ request, base }) {
  const [draft, setDraft] = useState(null);
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState('');
  const sequenceRef = useRef(0);
  const write = useCallback(async ({ buildPayload, note, signature, fresh }) => {
    const sequence = ++sequenceRef.current;
    setWriting(true);
    setWriteError('');
    const heard = await request(`${base}/voice-facts`, { method: 'POST', body: JSON.stringify({ note }) }).catch(() => null);
    const listOf = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []);
    const facts = heard?.available === true
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
    if (sequence !== sequenceRef.current) return;
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
    setDraft({ text, base: text, signature, deterministic: written.deterministic === true, facts });
  }, [request, base]);
  const editText = useCallback((text) => setDraft((prev) => ({ ...prev, text })), []);
  return { draft, writing, writeError, write, editText };
}

function ReportFlowForm({
  service, request, ctx, submission, locked, photos, onOverlay, dictationPending, onDictationPending,
  onCompleted, onFullForm, isMobile,
}) {
  // Only opened for a visit in the report flow (service.reportFlow), so the
  // service is always there.
  const base = `/admin/dispatch/${service.id}`;
  const products = useProductRows(ctx, service.serviceType);
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
  }));
  const tips = useTipLibrary({ base, request });
  const tipsAvailable = !!tips;
  const visitPromises = useVisitPromises({ base, request });
  const visitPhotos = useVisitPhotos({ serviceId: service.id, request, version: photos.version });
  const trace = useVisitTrace({ serviceId: service.id, request });
  const report = useReportDraft({ request, base });
  const { draft, writing } = report;
  const [step, setStep] = useState('visit');

  const perimeterFeet = perimeterFeetOf(trace.zone);
  const traceAvailable = trace.enabled && service.traceEligible !== false;
  // The property this sheet loaded: a trace saved or removed here is refused
  // if the office has moved the visit to another one since.
  const loadedPropertyId = ctx.visit && 'propertyId' in ctx.visit ? ctx.visit.propertyId : undefined;
  const promiseMarks = visitPromises.available ? promiseMarksPayload(form.promiseMarks, visitPromises.promises) : [];
  const signature = writerSignature(form, rows, promiseMarks, visitPhotos.photos);
  const stale = !!draft && draft.signature !== signature;
  const ratingAllowed = ctx.rating.allowed;
  const action = writeAction(draft, stale, report.writeError);
  const holdInputs = { form, active, ratingAllowed, dictationPending, photosLoaded: visitPhotos.loaded, promisesLoaded: visitPromises.loaded };
  const generateMissing = reportFlowMissing({ ...holdInputs, stage: 'generate' });
  const completeMissing = reportFlowMissing({
    ...holdInputs, stage: 'complete', draft, writing, perimeterFeet, traceAvailable, traceRead: trace,
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
    report.write({
      buildPayload: (facts) => writerPayload({ service, visit: ctx.visit, form, rows, facts, ratingAllowed, photos: visitPhotos.photos, promiseMarks }),
      note: form.note,
      signature,
      fresh,
    });
  };
  const summary = () => {
    const areas = draft?.facts?.areas || [];
    return [active.map((row) => row.name).join(', '), areas.join(', ')].filter(Boolean).join(' · ');
  };
  const submit = () => {
    if (completeMissing.reason && !submission.hasPendingBody()) return;
    submission.submit(
      () => reportCompletionBody({
        form, rows, draft, perimeterFeet, trace, visitIdentity: ctx.visitIdentity, ratingAllowed, tipsAvailable, isReservice, promiseMarks,
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
        <SentSummary result={submission.done.response} doneMarks={doneMarks} base={base} request={request} />
        <CollectPayment result={submission.done.response} />
      </SavedView>
    );
  }
  if (step === 'report') {
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
        // Only a perimeter spray is traced: a spot visit has no trace step.
        trace={traceAvailable && perimeterSprayRow(active, draft) ? trace : null}
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
      visitPromises={visitPromises}
      photos={visitPhotos.photos}
      onPhotos={photos.open}
      locked={locked}
      dictationPending={dictationPending}
      onDictationPending={onDictationPending}
      onFullForm={onFullForm}
      isMobile={isMobile}
      onAddProduct={addProduct}
      footer={action
        ? { reason: generateMissing.reason, label: action.label, onAction: () => write(action.fresh) }
        : { reason: '', label: 'Back to the report', onAction: () => setStep('report') }}
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
  report, stale, action, locked, submission, generateMissing, completeMissing, stockButton, trace, sources, photoCount,
  onWrite, onSubmit, onTrace, onRetryTrace, onRemoveTrace, removingTrace, traceError, onBack, onConfirm, onBackFromPrompt,
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
            traced={!!trace?.zone}
            onEdit={() => setEditing(true)}
            onDoneEditing={() => setEditing(false)}
            onChangeText={report.editText}
            onWriteAgain={() => { setEditing(false); onWrite(true); }}
          />
        )}
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
  service, ctx, form, setForm, products, active, sprayMethod, tips, visitPromises, photos, onPhotos, locked, dictationPending,
  onDictationPending, onFullForm, isMobile, onAddProduct, footer, writing, warn, stockButton,
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
    locked: locked || dictationPending,
    isMobile,
    onFullForm,
    onPick: (product) => onAddProduct(product, sprayMethod),
  });
  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
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
          <PhotoStripSection photos={photos} locked={locked || dictationPending} onOpen={onPhotos} />
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
function ProductsSection({ products, method, editAmounts, locked, onToggleEdit, other, popover, onCollapse, stickyPicks = false }) {
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
function RowMethodPicker({ row, method, sticky = false, locked, onChange }) {
  const labelId = useId();
  const current = rowMethod(row, method);
  const standard = SPRAY_METHODS.has(row.catalogMethod) ? method : row.catalogMethod;
  const ownMethod = row.catalogMethod && !ROW_METHOD_CHOICES.some((choice) => choice.value === row.catalogMethod);
  const choices = ownMethod ? [...ROW_METHOD_CHOICES, { value: row.catalogMethod, label: methodLabel(row.catalogMethod) }] : ROW_METHOD_CHOICES;
  const pick = (value) => onChange({
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
      {followsVisitMethod(row) && <p className="tech-visit-muted">{sticky ? 'Goes the way your note says until you pick one' : 'Same as the visit\'s How'}</p>}
    </div>
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
          onChange={(e) => onChange({ totalAmount: e.target.value })}
        />
        <select
          className="ui-control tech-visit-control"
          aria-label={`Unit for ${row.name}`}
          value={row.amountUnit}
          onChange={(e) => onChange({ amountUnit: e.target.value })}
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
