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
// The frame, header, saved view, note, tip picker and tiles are shared with
// every Fast Complete sheet (FastCompleteParts.jsx), as is the /complete
// submit (hooks/useFastCompleteSubmit.js); products, photos, pests and the
// completion body are this sheet's own.
import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { pestDefaultMixSelections } from '../../lib/pest-default-mix';
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
import {
  AmountEntry, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, SavedView,
  SheetHeader, TipSection, VisitNote, customerNameOf, techTipsOf, toggleInSet, useProductPicker, useTipLibrary,
  visitChangedSinceSchedule,
} from './FastCompleteParts';
import {
  OfficeNote, ProductHeardLines, VisitHeardLine, VoiceFillTop, useVoiceFillSheet,
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
// re-service, and still eligible for the short form (not typed or
// project-backed).
function blockedReasonFor(context, service) {
  const visit = context?.service || {};
  if (visitChangedSinceSchedule(visit, service)) return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  if (visit.serviceKey !== 'pest_re_service') return 'This visit is no longer a pest re-service. Use the full form.';
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
  return { rate: row.rateInput ?? prefill, rateUnit, max };
}

// The first requirement the application record still needs, in screen order
// (reason '' when none), and the product whose stock holds Complete when
// that is what is missing.
function missingRequirement(form, rows, ratingAllowed, dictationPending, openChecks = 0) {
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

// The context + rating contract for this visit. The routed schedule row can
// be stale: the context is re-checked to still be an open pest re-service
// before anything can be completed here.
function useFastCompleteContext({ base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress }) {
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
          blockedReason: blockedReasonFor(data, { routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress }),
          visit,
          products,
          commonProducts,
          // The house totals are in the unit the resolver gives (4 fl oz), so
          // a house row never takes a usual unit: that is for picked products
          // (a Taurus usually logged in gal would otherwise open as "4 gal").
          rows: pestDefaultMixSelections(products).map(({ product, totalAmount }) => productRow(product, { serviceType, totalAmount })),
          visitIdentity: recapVisitIdentity(visit),
          rating: { allowed: ratingContract?.allowed === true, scaleLabels: ratingContract?.scaleLabels || null },
        });
      } catch (err) {
        if (active) setCtx((prev) => ({ ...prev, loading: false, loadError: err?.message || 'Failed to load products' }));
      }
    })();
    return () => { active = false; };
  }, [base, request, serviceType, routedCustomerId, routedScheduledDate, routedPropertyId, routedAddress]);
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

export default function FastCompleteSheet({ service, request, onClose, onCompleted, onFullForm, voiceFillEnabled = false }) {
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
  const photoManager = usePhotoManager();
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
  const locked = submitting || submission.failure !== null;

  return (
    <FastCompleteFrame
      isMobile={isMobile}
      dialogRef={dialogRef}
      titleId={titleId}
      onDismiss={close}
      hiddenProps={photoManager.hiddenProps}
      overlay={photoManager.isOpen && (
        <TechServicePhotosModal serviceId={service?.id} customerName={customerNameOf(ctx.visit, service)} onClose={photoManager.close} />
      )}
    >
      <SheetHeader titleId={titleId} title={done ? 'Re-service complete' : 'Complete re-service'} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photoManager} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} voiceFillEnabled={voiceFillEnabled === true} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, ctx, submission, locked, photos, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile, voiceFillEnabled }) {
  if (submission.done) {
    return (
      <SavedView service={service} summary={submission.done.summary} onCompleted={onCompleted}>
        <CustomerTextResult outcome={submission.done.customerText} />
      </SavedView>
    );
  }
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  const stop = ctx.loadError || ctx.blockedReason;
  if (stop) return <ActionFeedback error={!!ctx.loadError} className="tech-visit-feedback tech-visit-loading">{stop}</ActionFeedback>;
  return <FastCompleteForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photos} dictationPending={dictationPending} onDictationPending={onDictationPending} onFullForm={onFullForm} isMobile={isMobile} voiceFillEnabled={voiceFillEnabled} />;
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

function FastCompleteForm({ service, request, ctx, submission, locked, photos, dictationPending, onDictationPending, onFullForm, isMobile, voiceFillEnabled }) {
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
  // Words being recorded, transcribed or filled in would miss the save.
  const busy = dictationPending || voice.filling;
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

  const { reason: missingReason, stockRow } = missingRequirement(form, rows, ctx.rating.allowed, busy, voice.checks.length);
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
        <fieldset className="tech-visit-form" disabled={locked}>
          <VoiceFillTop voice={voice} serviceId={service?.id} locked={locked} onPendingChange={onDictationPending} />
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
          <OfficeNote voice={voice} locked={locked} />
          {/* A clip being recorded keeps recording behind the photo manager, so
              photos wait until the dictation is finished. */}
          <PhotosSection serviceId={service?.id} request={request} photos={photos} locked={locked || busy} />
          <ProductsSection
            products={products}
            heardLines={<ProductHeardLines voice={voice} rows={rows} />}
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
          <VisitHeardLine voice={voice} />
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
function ProductsSection({ products, heardLines = null, method, editAmounts, locked, onToggleEdit, other, popover }) {
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
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
        <Button type="button" variant="ghost" className="tech-visit-action" aria-pressed={editAmounts} onClick={onToggleEdit}>
          {editAmounts ? 'Done' : 'Edit amounts'}
        </Button>
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
          locked={locked}
          onChange={(patch) => updateRow(editing.productId, patch)}
          onRemove={removeEditing}
          onDone={closeEditor}
        />
      )}
      {editAmounts && rows.filter((row) => row.active).map((row) => (
        <AmountRow key={row.productId} row={row} rate={rowRate(row, method)} onChange={(patch) => updateRow(row.productId, patch)} />
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
function AddedProductEditor({ id, row, method, locked, onChange, onRemove, onDone }) {
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
      <RowMethodPicker row={row} method={method} locked={locked} onChange={onChange} />
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
function RowMethodPicker({ row, method, locked, onChange }) {
  const labelId = useId();
  const current = rowMethod(row, method);
  const standard = SPRAY_METHODS.has(row.catalogMethod) ? method : row.catalogMethod;
  const ownMethod = row.catalogMethod && !ROW_METHOD_CHOICES.some((choice) => choice.value === row.catalogMethod);
  const choices = ownMethod ? [...ROW_METHOD_CHOICES, { value: row.catalogMethod, label: methodLabel(row.catalogMethod) }] : ROW_METHOD_CHOICES;
  const pick = (value) => onChange({
    methodInput: value === standard ? null : value,
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
      {followsVisitMethod(row) && <p className="tech-visit-muted">Same as the visit&apos;s How</p>}
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
