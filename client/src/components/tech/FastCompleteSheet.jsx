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
import {
  UNIT_CHOICES, amountText, categoryLabel, isOutOfStock, productUnits, seededAmount, stockHolds,
} from '../../lib/fast-complete-products';
import { isMlUnit, submittedAmount } from '../../lib/measure-units';
import DictationButton from './DictationButton';
import FastCompleteProductPicker, { WarningIcon } from './FastCompleteProductPicker';
import RATE_UNITS from '../../../../shared/rate-units.json';
import TechServicePhotosModal from './TechServicePhotosModal';
import { UiSurface, Button, Field, Input, Textarea, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

const unitLabel = (unit) => String(unit || '').replace(/_/g, ' ');
// The amount /complete would receive is above zero (a tsp amount goes as fl oz).
const hasAmount = (row) => submittedAmount(row.totalAmount, row.amountUnit).totalAmount > 0;

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
  const maxRaw = resolved.perBasisUnit
    ? resolved.labelMaxRate
    : resolved.usePestSprayDefault ? null : parseFloat(String(row.product?.max_label_rate_per_1000 ?? ''));
  const max = Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : null;
  return { rate: row.rateInput ?? prefill, rateUnit, max };
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

// The tip library, read on its own: the picker is optional, so a slow or
// failed read never holds the sheet. null until it arrives, and when the
// read fails or the tips gate is off.
function useTipLibrary({ base, request }) {
  const [library, setLibrary] = useState(null);
  useEffect(() => {
    let active = true;
    request(`${base}/tech-tips`)
      .then((data) => { if (active) setLibrary(data?.available === true ? data : null); })
      .catch(() => { if (active) setLibrary(null); });
    return () => { active = false; };
  }, [base, request]);
  return library;
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

// The photo manager opens over the sheet. While it is up the sheet is inert
// and hidden from assistive tech, the way the photo manager treats its own
// marks dialog; `version` moves on each close so the count is read again.
function usePhotoManager() {
  const [state, setState] = useState({ isOpen: false, version: 0 });
  const open = useCallback(() => setState((prev) => ({ ...prev, isOpen: true })), []);
  const close = useCallback(() => setState((prev) => ({ isOpen: false, version: prev.version + 1 })), []);
  return { ...state, open, close, hiddenProps: state.isOpen ? { 'aria-hidden': true, inert: '' } : {} };
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

  return createPortal(
    <>
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
        {...photoManager.hiddenProps}
      >
        <SheetHeader titleId={titleId} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
        <SheetBody service={service} request={request} ctx={ctx} submission={submission} locked={locked} photos={photoManager} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
      </section>
    </UiSurface>
    {photoManager.isOpen && (
      <TechServicePhotosModal serviceId={service?.id} customerName={customerNameOf(ctx.visit, service)} onClose={photoManager.close} />
    )}
    </>,
    document.body,
  );
}

// The LIVE visit once loaded, so the tech sees whose property this
// completion records against.
function customerNameOf(visit, service) {
  return visit?.customerName || service?.customerName || '';
}

function SheetHeader({ titleId, service, visit, done, locked, dictationPending, submitting, onFullForm, onClose }) {
  const address = liveAddressLine(visit?.address);
  return (
    <header className="tech-visit-header">
      <div>
        <h2 id={titleId} className="tech-visit-title">{done ? 'Re-service complete' : 'Complete re-service'}</h2>
        <p className="tech-visit-muted">
          {customerNameOf(visit, service) || 'Customer'}{service?.serviceType ? ` · ${service.serviceType}` : ''}
        </p>
        {address && <p className="tech-visit-muted">{address}</p>}
      </div>
      {!done && (
        <Button variant="ghost" className="tech-visit-action" onClick={onFullForm} disabled={locked || dictationPending}>Full form</Button>
      )}
      <Button variant="ghost" className="tech-visit-action tech-visit-close" onClick={onClose} disabled={submitting} aria-label="Close">×</Button>
    </header>
  );
}

function SheetBody({ service, request, ctx, submission, locked, photos, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile }) {
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

// "+ Other product" opens the product picker: a bottom sheet over the form
// on a phone, a popover under the button at desktop width. With no product
// list loaded it opens the full completion screen, as it always did.
function useProductPicker({ ctx, rows, locked, isMobile, onFullForm, onPick }) {
  const buttonRef = useRef(null);
  const [open, setOpen] = useState(false);
  const hasCatalog = ctx.products.length > 0;
  useEffect(() => { if (locked) setOpen(false); }, [locked]);
  // The house mix is always on the sheet, so "Used most" lists the rest.
  const commonProducts = useMemo(() => {
    const mixIds = new Set(ctx.rows.map((row) => String(row.productId)));
    return ctx.commonProducts.filter((common) => !mixIds.has(String(common.productId)));
  }, [ctx.rows, ctx.commonProducts]);
  const onSheetIds = useMemo(() => new Set(rows.map((row) => String(row.productId))), [rows]);
  const shown = open && !locked;
  const picker = shown ? (
    <FastCompleteProductPicker
      variant={isMobile ? 'sheet' : 'popover'}
      products={ctx.products}
      commonProducts={commonProducts}
      onSheetIds={onSheetIds}
      anchorRef={buttonRef}
      onPick={(product) => { setOpen(false); onPick(product); }}
      onClose={() => setOpen(false)}
    />
  ) : null;
  const onClick = (event) => {
    if (!hasCatalog) {
      onFullForm?.();
      return;
    }
    // Safari never focuses a tapped button; the picker hands focus back here.
    event.currentTarget.focus();
    setOpen((was) => !was);
  };
  return {
    button: { buttonRef, locked, onClick, hasPicker: hasCatalog, expanded: shown },
    popover: isMobile ? null : picker,
    sheet: isMobile ? picker : null,
    // What the phone sheet covers is out of reach until it closes.
    coverProps: shown && isMobile ? { 'aria-hidden': true, inert: '' } : {},
  };
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
  const picker = useProductPicker({
    ctx,
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
      () => completionBody(form, rows, { visitIdentity: ctx.visitIdentity, ratingAllowed: ctx.rating.allowed, tipsAvailable }),
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
      {/* The reason sits above full-width actions, so neither squeezes the
          other on a phone or beside "Check stock". */}
      <footer className="tech-visit-footer tech-visit-footer--stacked" {...picker.coverProps}>
        {submission.error && <ActionFeedback error className="tech-visit-feedback tech-visit-error-banner">{submission.error}</ActionFeedback>}
        {missingReason && !submission.failure && (
          <p className={cn('tech-visit-muted', stockRow && 'tech-visit-status--warn')} role="status">{missingReason}</p>
        )}
        <div className="tech-visit-actions">
          {stockRow && !locked && (
            <Button type="button" variant="secondary" className="tech-visit-action tech-visit-wide" loading={checkingStock} onClick={checkStock}>Check stock</Button>
          )}
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
      {picker.sheet}
    </div>
  );
}

// Every product on the sheet. A house-mix tile taps off and on (struck
// through, never removed); an added product's tile opens its editor.
function ProductsSection({ products, method, editAmounts, locked, onToggleEdit, other, popover }) {
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
      <div>
        <label htmlFor={amountId} className="tech-product-editor-label">How much?</label>
        <div className="tech-product-editor-amount">
          <Input
            ref={amountRef}
            id={amountId}
            className="tech-visit-control tech-product-amount-input"
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            disabled={locked}
            value={row.totalAmount ?? ''}
            onChange={(e) => onChange({ totalAmount: e.target.value })}
          />
          <div role="group" aria-label="Unit" className="tech-product-units">
            {UNIT_CHOICES[row.dimension].map((choice) => (
              <Chip disabled={locked} key={choice.value} className="tech-product-unit" label={choice.label} pressed={row.amountUnit === choice.value} onClick={() => onChange({ amountUnit: choice.value })} />
            ))}
          </div>
        </div>
      </div>
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

function OtherProductButton({ buttonRef, locked, onClick, hasPicker, expanded, popover }) {
  return (
    <div className="tech-product-other">
      <Button
        ref={buttonRef}
        type="button"
        variant="secondary"
        className="tech-visit-action tech-visit-wide"
        disabled={locked}
        onClick={onClick}
        {...(hasPicker ? { 'aria-haspopup': 'dialog', 'aria-expanded': expanded } : {})}
      >
        + Other product
      </Button>
      {popover}
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
