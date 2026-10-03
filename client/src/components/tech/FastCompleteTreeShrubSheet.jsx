// client/src/components/tech/FastCompleteTreeShrubSheet.jsx
//
// Fast Complete for TREE & SHRUB program visits: the quick completion the
// owner asked for ("quick job, one screen"), sharing its frame, header, saved
// view, note, tip picker, amount entry, product picker and footer with the
// pest re-service sheet (FastCompleteParts.jsx) and its /complete submit
// (hooks/useFastCompleteSubmit.js).
//
// Nothing is assumed applied. This month's protocol products are SUGGESTION
// tiles, off until tapped; an amount fills only from what the server says was
// recorded last time (labeled "last time"), else it is blank and required.
// AI never guesses an amount. "+ Other product" adds any other catalog
// product except an injection (the server hard-blocks injections on a T&S
// visit: they belong to the palm injection flow). A product the server flags
// as an N/P fertilizer in the summer blackout cannot be turned on.
//
// The photos are five slots (the approved shot guide), sent as the body's
// completionPhotos, never through the staged photo manager: staged photos
// satisfy neither the server's 2-photo rule nor the scorer. "Analyze" reads
// the current photos through assess-preview and shows what the read flagged
// as tiles the tech may reject; the signed preview rides the completion only
// while it still describes the exact photos on the sheet. A failed read never
// blocks Complete: the server scores the photos itself.
//
// The server decides everything regulatory and this sheet pre-empts each of
// its blocks in screen order: pollinator status (insect rows only), the
// IRAC / FRAC rotation (the app's own check when the context loaded it, the
// tech's tap when it could not), actual amounts, the 2-photo floor, and the
// two required findings (plant groups, landscape condition). The body never
// carries treatments_completed (the server derives it from the products).
//
// Context, visit identity and the catalog come from GET
// /admin/dispatch/:id/tree-shrub/fast-context (404 {enabled:false} when the
// gate is off: this visit then needs the full form).
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import useIsMobile from '../../hooks/useIsMobile';
import useModalFocus from '../../hooks/useModalFocus';
import useLockBodyScroll from '../../hooks/useLockBodyScroll';
import { recapVisitIdentity } from '../../hooks/useServiceRecapDraft';
import useFastCompleteSubmit from '../../hooks/useFastCompleteSubmit';
import { prepareCompletionPhoto } from '../../lib/completion-photo';
import { defaultApplicationMethodForLine } from '../../lib/product-rate-prefill';
import {
  UNIT_CHOICES, amountText, categoryLabel, hasAmount, isOutOfStock, measureUnit, productUnits, seededAmount, stockHolds,
} from '../../lib/fast-complete-products';
import { submittedAmount } from '../../lib/measure-units';
import { WarningIcon } from './FastCompleteProductPicker';
import {
  AmountEntry, CLOSED_VISIT_STATUSES, Chip, ChoiceSection, CompleteFooter, FastCompleteFrame, OtherProductButton, RecoveredCompletion, SavedView,
  SheetHeader, TipSection, VisitNote, techTipsOf, toggleInSet, useProductPicker, useTipLibrary,
  visitChangedSinceSchedule,
} from './FastCompleteParts';
import { Button, ActionFeedback, cn } from '../ui';
import '../../styles/tech-workflow.css';

// The typed form's option lists (server/services/project-types.js tree_shrub
// findingsFields): the server rejects any value outside them.
const PLANT_GROUP_OPTIONS = ['Palms', 'Shrubs', 'Ornamentals', 'Hedges', 'Small trees', 'Flowering plants', 'Groundcover beds', 'Other'];
const AREA_OPTIONS = [
  'Front landscape', 'Back landscape', 'Side landscapes', 'Entry landscape', 'Foundation beds',
  'Pool / lanai landscape', 'Driveway beds', 'Hedges / screening plants', 'Individual tagged plants', 'Other',
];
const CONDITION_OPTIONS = ['Excellent', 'Good', 'Fair', 'Poor', 'Declining', 'Recovering'];
// Never 'No insecticide applied': the server refuses it beside an insect product.
const POLLINATOR_OPTIONS = ['No blooms or no bees', 'Blooming — no bees active', 'Blooming — bees active'];
const BEES_ACTIVE = 'Blooming — bees active';
// The server's own words for this block (tree-shrub-closeout.js).
const BEES_ACTIVE_MESSAGE = 'Do not complete bee-sensitive insect/contact applications on blooming plants while bees are active.';
const NP_BLACKOUT_TEXT = 'N/P blackout — can’t apply Jun 1–Sep 30';

// How a product went down. Foliar spray is the T&S default; the other two are
// chips on an added product. None of them asks for a measured area.
const METHOD_CHOICES = [
  { value: 'foliar_spray', label: 'Foliar spray' },
  { value: 'soil_drench', label: 'Soil drench' },
  { value: 'granular_broadcast', label: 'Granular' },
];
const DEFAULT_METHOD = 'foliar_spray';
const methodLabel = (value) => {
  const text = String(value || '').replace(/_/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
};

// The approved shot guide: standing on the ground, about a minute for all of
// them. The first two are the floor.
const PHOTO_SLOTS = [
  { key: 'front_beds', label: 'Front beds', when: 'Required', required: true, caption: 'The whole front bed line from the driveway apron or walk, chest height, same spot as last time.' },
  { key: 'back_landscape', label: 'Back or side landscape', when: 'Required', required: true, caption: 'The back beds from the lanai or back door edge, or a side bed if the back is locked, fenced or has a dog.' },
  { key: 'whole_palm', label: 'Whole palm', when: 'If palms', caption: 'Step back until the worst-looking palm fits top to bottom, shot from the ground.' },
  { key: 'oldest_fronds', label: 'Oldest fronds', when: 'If palms', caption: 'The lowest fronds you can reach standing, at arm’s length.' },
  { key: 'leaf_close_up', label: 'Leaf close-up', when: 'If something’s wrong', caption: 'One leaf or stem with the problem, 6 to 12 inches away; top and underside if there are insects or sooty mold.' },
];
const MAX_PHOTOS = PHOTO_SLOTS.length;
const SLOT_KEYS = new Set(PHOTO_SLOTS.map((slot) => slot.key));

// Last visit's photo per slot, as the server signed it: only a known slot with
// an http(s) URL is kept, so anything odd simply shows nothing.
function lastPhotosFrom(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [key, photo] of Object.entries(value)) {
    if (SLOT_KEYS.has(key) && typeof photo?.url === 'string' && /^https?:\/\//i.test(photo.url)) {
      out[key] = { url: photo.url, takenAt: typeof photo.takenAt === 'string' ? photo.takenAt : null };
    }
  }
  return out;
}

const shortDate = (iso) => {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
};

const flagsOf = (product) => product?.tsFlags || {};

// The app can only rotation-check a product that carries a resistance group;
// one with none (a horticultural oil) gets the tech's own IRAC / FRAC tap, as
// does every product when the server could not read the application history.
const RESISTANCE_GROUP_FIELDS = ['irac_group', 'frac_group', 'hrac_group', 'hrac_group_secondary', 'moa_group'];
const appCanRotationCheck = (product) => RESISTANCE_GROUP_FIELDS.some((field) => String(product?.[field] ?? '').trim());
const needsManualIrac = (rows, ctx) => rows.some((row) => row.active && flagsOf(row.product).needsIracFrac
  && (ctx.warningsUnavailable || !appCanRotationCheck(row.product)));

// What the server called its decision, in the words its decisions list takes
// (monitor | confirmed | hidden | edit).
function decisionAction(action) {
  if (action === 'confirm') return 'confirmed';
  if (action === 'hide') return 'hidden';
  return ['monitor', 'confirmed', 'hidden', 'edit'].includes(action) ? action : 'monitor';
}

// A product on the sheet. `last` is the amount the server says was recorded
// last time: the only thing an amount ever starts from, in the unit it was
// recorded in. Anything else leaves it blank for the tech.
function productRow(product, { method, last = null, added = false }) {
  const flags = flagsOf(product);
  const own = productUnits(product, { method });
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
  return {
    product,
    productId: product.id,
    name: product.name,
    method,
    added,
    active: false,
    blocked: !!flags.npBlackout,
    dimension,
    totalAmount: seeded.amount,
    amountUnit: seeded.unit,
    fromLast: seeded.amount !== '',
  };
}

// A catalog product's method on this line: foliar spray unless it is a
// granule or a drench.
function catalogMethod(product) {
  const resolved = defaultApplicationMethodForLine(product, 'tree_shrub');
  return METHOD_CHOICES.some((choice) => choice.value === resolved) ? resolved : DEFAULT_METHOD;
}

// The method the server names for a month product; one that would need a
// measured area (a perimeter spray) is never taken.
function monthMethod(method, product) {
  const value = String(method || '').trim();
  if (!value) return catalogMethod(product);
  return value === 'perimeter_spray' ? DEFAULT_METHOD : value;
}

// Why the live context can't be completed here, or '' when it can.
function blockedReasonFor(data, service) {
  const visit = data?.service || {};
  if (visitChangedSinceSchedule(visit, service)) return 'This visit changed since your schedule loaded. Close and reopen it from the schedule.';
  if (CLOSED_VISIT_STATUSES.has(String(visit.status || ''))) return `This visit is already ${visit.status}. Close and reopen it from the schedule.`;
  if (data?.eligible !== true) return 'This visit needs the full form.';
  return '';
}

// Last time's actual amount per product, from the last visit's recorded rows.
function lastAmountsOf(lastVisit) {
  const amounts = {};
  for (const p of Array.isArray(lastVisit?.products) ? lastVisit.products : []) {
    if (p?.productId != null && Number(p.totalAmount) > 0 && p.amountUnit) {
      amounts[String(p.productId)] = { totalAmount: p.totalAmount, amountUnit: p.amountUnit };
    }
  }
  return amounts;
}

// The server sends warnings as facts; the sheet says them in one line.
// Never a block: the app ran the check so the tech doesn't have to.
function warningText(warning) {
  const applied = warning.appliedProductName ? ` (${warning.appliedProductName})` : '';
  if (warning.type === 'rotation') {
    return `${warning.group} went down ${warning.daysAgo} days ago${applied}. Rotate to another group if you can.`;
  }
  if (warning.type === 'palm_fertilizer_spacing') {
    return `Palm fertilizer went down ${warning.daysAgo} days ago${applied}. Keep it about 3 months apart.`;
  }
  return '';
}

// The suggestion rows: this month's products the catalog still has (never an
// injection), each starting off, with last time's amount when the server has one.
function monthRows(data, products, lastVisit) {
  const byId = new Map(products.map((product) => [String(product.id), product]));
  const lastAmounts = lastAmountsOf(lastVisit);
  const seen = new Set();
  const rows = [];
  for (const month of Array.isArray(data?.monthProducts) ? data.monthProducts : []) {
    const id = String(month?.productId);
    const product = byId.get(id);
    if (!product || seen.has(id)) continue;
    seen.add(id);
    rows.push(productRow(product, { method: monthMethod(month.method, product), last: month.lastAmount || lastAmounts[id] || null }));
  }
  return rows;
}

// Reasons that are a failed read, not this visit's eligibility: a retry fixes them.
const RETRYABLE_REASONS = new Set(['catalog_unavailable', 'profile_unavailable']);

function contextFrom(data, service) {
  if (data?.eligible !== true && RETRYABLE_REASONS.has(data?.reason)) {
    return { ...EMPTY_CONTEXT, loading: false, loadError: 'Couldn’t load this visit’s products. Try again.' };
  }
  // An injection never goes on this sheet (the server blocks it).
  const products = (Array.isArray(data?.products) ? data.products : []).filter((product) => product && !flagsOf(product).injection);
  const lastVisit = data?.lastVisit && typeof data.lastVisit === 'object' ? data.lastVisit : {};
  return {
    loading: false,
    loadError: '',
    blockedReason: blockedReasonFor(data, service),
    visit: data?.service || {},
    products,
    rows: monthRows(data, products, lastVisit),
    lastVisit,
    lastVisitPhotos: lastPhotosFrom(data?.lastVisitPhotos),
    warnings: (Array.isArray(data?.warnings) ? data.warnings : [])
      .filter(Boolean)
      .map((warning) => ({ ...warning, message: warningText(warning) }))
      .filter((warning) => warning.message),
    warningsUnavailable: data?.warningsUnavailable === true,
    visitIdentity: recapVisitIdentity(data?.service),
  };
}

const EMPTY_CONTEXT = {
  loading: true, loadError: '', blockedReason: '', rows: [], products: [], warnings: [], warningsUnavailable: false,
  visitIdentity: null, visit: null, lastVisit: {}, lastVisitPhotos: {},
};

function useTreeShrubContext({ base, request, service }) {
  const [ctx, setCtx] = useState(EMPTY_CONTEXT);
  // Bumped by Try again: the same read, run once more.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setCtx(EMPTY_CONTEXT);
    request(`${base}/tree-shrub/fast-context`)
      .then((data) => { if (active) setCtx(contextFrom(data, service)); })
      .catch((err) => {
        if (!active) return;
        // 404 {enabled:false}: the gate is off for this visit.
        if (err?.status === 404) setCtx((prev) => ({ ...prev, loading: false, blockedReason: 'This visit needs the full form.' }));
        else setCtx((prev) => ({ ...prev, loading: false, loadError: err?.message || 'Failed to load this visit' }));
      });
    return () => { active = false; };
  }, [base, request, attempt, service?.routedCustomerId, service?.routedScheduledDate, service?.routedPropertyId, service?.routedAddress]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  // The stock on hand the server has now, for a product restocked while the
  // sheet is open; nothing else is re-read. Resolves to the fresh rows by id.
  const refreshStock = useCallback(async () => {
    const data = await request(`${base}/tree-shrub/fast-context`);
    return new Map((Array.isArray(data?.products) ? data.products : []).map((product) => [String(product.id), product]));
  }, [base, request]);
  return { ...ctx, retry, refreshStock };
}

// The tech's own taps on the sheet's products. One product, one row.
function useProductRows(ctx) {
  const [rows, setRows] = useState(ctx.rows);
  const lastAmounts = useMemo(() => lastAmountsOf(ctx.lastVisit), [ctx.lastVisit]);
  const updateRow = useCallback((productId, patch) => {
    setRows((prev) => prev.map((row) => (row.productId === productId
      // An amount the tech changed is no longer last time's.
      ? { ...row, ...patch, ...('totalAmount' in patch || 'amountUnit' in patch ? { fromLast: false } : {}) }
      : row)));
  }, []);
  const addProduct = useCallback((product) => {
    setRows((prev) => (prev.some((row) => row.productId === product.id) ? prev : [
      ...prev,
      { ...productRow(product, { method: catalogMethod(product), last: lastAmounts[String(product.id)] || null, added: true }), active: !flagsOf(product).npBlackout },
    ]));
  }, [lastAmounts]);
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

const sameSet = (analyzed, photos) => analyzed.length === photos.length && analyzed.every((data, index) => data === photos[index].data);

function missingRequirement({ form, rows, slots, photoBusy, ctx, dictationPending }) {
  const active = rows.filter((row) => row.active);
  const outOfStock = active.find((row) => stockHolds(row.product, submittedAmount(row.totalAmount, row.amountUnit).amountUnit));
  const missingAmount = active.find((row) => !hasAmount(row));
  const insect = active.some((row) => flagsOf(row.product).insectFamily);
  const manualIrac = needsManualIrac(rows, ctx);
  const [, reason = ''] = [
    // A recorded clip still being taken or transcribed would miss the save.
    [dictationPending, 'Finish dictating before you complete.'],
    [photoBusy, 'Wait for the photo to finish loading.'],
    [!slots.front_beds, 'Add a front beds photo.'],
    [!slots.back_landscape, 'Add a back or side landscape photo.'],
    [outOfStock, outOfStock && `${outOfStock.name} shows 0 in stock. Update inventory, then tap Check stock.`],
    [missingAmount, missingAmount && `Enter the amount for ${missingAmount.name}.`],
    [insect && !form.pollinator, 'Select the flowering / bee status.'],
    [insect && form.pollinator === BEES_ACTIVE, BEES_ACTIVE_MESSAGE],
    [manualIrac && form.irac !== 'Yes', 'Confirm the IRAC / FRAC rotation was checked and logged.'],
    [!form.plantGroups.size, 'Select the plant groups serviced.'],
    [!form.condition, 'Select the overall landscape condition.'],
  ].find(([missing]) => missing) || [];
  return reason;
}

const inOptionOrder = (options, set) => options.filter((option) => set.has(option)).join(', ');

function completionBody({ form, rows, photos, preview, previewCurrent, ctx, tipsAvailable }) {
  const active = rows.filter((row) => row.active);
  const applicationArea = inOptionOrder(AREA_OPTIONS, form.areas);
  const insect = active.some((row) => flagsOf(row.product).insectFamily);
  const irac = active.some((row) => flagsOf(row.product).needsIracFrac);
  const result = previewCurrent ? preview.result : null;
  return {
    visitOutcome: 'completed',
    ...(ctx.visitIdentity ? { expectedVisit: ctx.visitIdentity } : {}),
    products: active.map((row) => {
      const { totalAmount, amountUnit } = submittedAmount(row.totalAmount, row.amountUnit);
      return { productId: row.productId, applicationMethod: row.method, totalAmount, amountUnit, applicationArea, targets: [] };
    }),
    structuredFindings: {
      type: 'tree_shrub',
      values: {
        plant_groups: inOptionOrder(PLANT_GROUP_OPTIONS, form.plantGroups),
        ...(form.areas.size ? { areas_treated: applicationArea } : {}),
        landscape_condition: form.condition,
        ...(insect ? { pollinator_status: form.pollinator } : {}),
        // Yes when the app ran the rotation check (the context loaded its
        // warnings) or the tech confirmed it by hand.
        ...(irac ? { irac_frac_logged: 'Yes' } : {}),
      },
    },
    completionPhotos: photos.map((photo, index) => ({
      data: photo.data,
      name: photo.name || `service-photo-${index + 1}.jpg`,
      photoType: 'after',
      sortOrder: index,
      capturedAt: photo.capturedAt || null,
      // The slot the shot was taken for; the server keeps it only if it is one
      // of the five, and shows it beside the same slot on the next visit.
      slot: photo.slotKey,
    })),
    // Only a preview of THIS photo set: its signature pins the exact photos.
    ...(result?.scores && result.signature ? {
      treeShrubReview: {
        scores: result.scores,
        observations: result.observations || '',
        scoredCount: result.scoredCount,
        signature: result.signature,
        decisions: (result.findings || []).map((finding) => ({
          key: finding.key,
          action: preview.rejected.has(finding.key) ? 'hidden' : decisionAction(finding.defaultAction),
          detail: finding.detail,
        })),
      },
    } : {}),
    technicianNotes: form.note.trim(),
    techTips: techTipsOf(form, tipsAvailable),
    // Same as the full form (owner ruling): the completion text, the review
    // ask and the pay link go out the way they do from there.
    sendCompletionSms: true,
    requestReview: true,
    includePayLink: true,
    reviewTiming: 'auto',
  };
}

export default function FastCompleteTreeShrubSheet({ service, request, operatorId, onClose, onCompleted, onFullForm }) {
  const isMobile = useIsMobile();
  const closeRef = useRef(null);
  const dialogRef = useModalFocus(true, () => closeRef.current?.());
  useLockBodyScroll(true);
  const titleId = useId();
  const base = `/admin/dispatch/${service?.id}`;
  const ctx = useTreeShrubContext({ base, request, service });
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
      <SheetHeader titleId={titleId} title={done ? 'Tree & shrub complete' : 'Complete tree & shrub'} service={service} visit={ctx.visit} done={!!done} locked={locked} dictationPending={dictationPending} submitting={submitting} onFullForm={onFullForm} onClose={close} />
      <SheetBody service={service} request={request} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={setDictationPending} onCompleted={onCompleted} onFullForm={onFullForm} isMobile={isMobile} />
    </FastCompleteFrame>
  );
}

function SheetBody({ service, request, ctx, submission, locked, dictationPending, onDictationPending, onCompleted, onFullForm, isMobile }) {
  if (submission.done) return <SavedView service={service} summary={submission.done.summary} onCompleted={onCompleted} />;
  if (submission.recovering) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Checking for an unfinished completion…</ActionFeedback>;
  if (submission.restored) return <RecoveredCompletion submission={submission} />;
  if (ctx.loading) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">Loading…</ActionFeedback>;
  const stop = ctx.loadError || ctx.blockedReason;
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
  if (stop) return <ActionFeedback className="tech-visit-feedback tech-visit-loading">{stop}</ActionFeedback>;
  return <TreeShrubForm service={service} request={request} ctx={ctx} submission={submission} locked={locked} dictationPending={dictationPending} onDictationPending={onDictationPending} onFullForm={onFullForm} isMobile={isMobile} />;
}

function TreeShrubForm({ service, request, ctx, submission, locked, dictationPending, onDictationPending, onFullForm, isMobile }) {
  const base = `/admin/dispatch/${service?.id}`;
  const products = useProductRows(ctx);
  const { rows } = products;
  const [form, setForm] = useState(() => ({
    note: '',
    // What the server says was serviced last time, kept to the form's own options.
    plantGroups: new Set(PLANT_GROUP_OPTIONS.filter((option) => (ctx.lastVisit?.plantGroups || []).includes(option))),
    areas: new Set(AREA_OPTIONS.filter((option) => (ctx.lastVisit?.areasTreated || []).includes(option))),
    condition: '', pollinator: '', irac: '', tipId: '', customTip: '',
  }));
  const setField = useCallback((key, value) => setForm((prev) => ({ ...prev, [key]: value })), []);
  // Each dictated chunk joins what is already in the box.
  const appendNote = useCallback((text) => {
    setForm((prev) => ({ ...prev, note: prev.note.trim() ? `${prev.note.trimEnd()} ${text}` : text }));
  }, []);
  const tips = useTipLibrary({ base, request });
  const tipsAvailable = !!tips;
  const photos = usePhotoSlots({ base, request });
  const picker = useProductPicker({
    products: ctx.products,
    commonProducts: [],
    rows,
    locked: locked || dictationPending,
    isMobile,
    onFullForm,
    onPick: products.addProduct,
  });

  const photoList = photos.list;
  const previewCurrent = !!photos.preview && sameSet(photos.preview.photos, photoList);
  const missingReason = missingRequirement({ form, rows, slots: photos.slots, photoBusy: photos.busy, ctx, dictationPending });
  // "Update inventory, then tap Check stock": the tech re-reads the stock here
  // instead of closing the sheet and losing the photos and note.
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
      () => completionBody({ form, rows, photos: photoList, preview: photos.preview, previewCurrent, ctx, tipsAvailable }),
      `${names || 'Inspection'} · ${inOptionOrder(PLANT_GROUP_OPTIONS, form.plantGroups)}`,
    );
  };
  const active = rows.filter((row) => row.active);
  const insect = active.some((row) => flagsOf(row.product).insectFamily);
  const iracRows = active.some((row) => flagsOf(row.product).needsIracFrac);
  const suggested = previewCurrent && CONDITION_OPTIONS.includes(photos.preview.result?.suggestedCondition)
    ? photos.preview.result.suggestedCondition
    : '';

  return (
    <div className="tech-visit-form-area">
      <div className="tech-visit-body" {...picker.coverProps}>
        <fieldset className="tech-visit-form" disabled={locked}>
          <VisitNote note={form.note} onChange={(value) => setField('note', value)} onDictated={appendNote} onDictationPending={onDictationPending} serviceId={service?.id} locked={locked} />
          <PhotosSection photos={photos} lastPhotos={ctx.lastVisitPhotos} previewCurrent={previewCurrent} locked={locked || dictationPending} />
          <ProductsSection ctx={ctx} products={products} locked={locked} other={picker.button} popover={picker.popover} />
          {(insect || iracRows) && (
            <ComplianceSection form={form} setField={setField} insect={insect} iracRows={iracRows} manualIrac={needsManualIrac(rows, ctx)} locked={locked} />
          )}
          <ChoiceSection title="Plant groups serviced" columns={2}>
            {PLANT_GROUP_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.plantGroups.has(label)} onClick={() => setField('plantGroups', toggleInSet(form.plantGroups, label))} />
            ))}
          </ChoiceSection>
          <ChoiceSection title="Areas treated (optional)" columns={2}>
            {AREA_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label} pressed={form.areas.has(label)} onClick={() => setField('areas', toggleInSet(form.areas, label))} />
            ))}
          </ChoiceSection>
          <ChoiceSection title="Overall landscape condition" columns={3}>
            {CONDITION_OPTIONS.map((label) => (
              <Chip disabled={locked} key={label} label={label === suggested ? `${label} (photo read)` : label} pressed={form.condition === label} onClick={() => setField('condition', label)} />
            ))}
          </ChoiceSection>
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
        warn={missingReason === BEES_ACTIVE_MESSAGE || !!stockRow}
        label="Complete tree & shrub"
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

// The five photo slots, the Analyze read, and what it flagged. `slots` is
// slot key -> prepared photo; `list` is the photos in slot order, the order
// the server scores and records them.
function usePhotoSlots({ base, request }) {
  const [slots, setSlots] = useState({});
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [errors, setErrors] = useState({});
  const [preview, setPreview] = useState(null);
  const [analysis, setAnalysis] = useState({ busy: false, error: '' });
  // A read that comes back after the photos changed describes photos that are
  // no longer there; only the latest request may land.
  const readSequence = useRef(0);
  const list = useMemo(
    () => PHOTO_SLOTS.filter((slot) => slots[slot.key]).map((slot) => ({ ...slots[slot.key], slotKey: slot.key })),
    [slots],
  );

  // Any photo change drops the read and its tiles: the signature pins the
  // exact photo set.
  const photosChanged = useCallback(() => {
    readSequence.current += 1;
    setPreview(null);
    setAnalysis({ busy: false, error: '' });
  }, []);
  const setPhoto = useCallback((key, photo) => {
    photosChanged();
    setSlots((prev) => {
      const next = { ...prev };
      if (photo) next[key] = photo;
      else delete next[key];
      return next;
    });
  }, [photosChanged]);
  const addPhoto = useCallback(async (key, file) => {
    setErrors((prev) => ({ ...prev, [key]: '' }));
    setBusyKeys((prev) => new Set(prev).add(key));
    try {
      setPhoto(key, await prepareCompletionPhoto(file));
    } catch (err) {
      setErrors((prev) => ({ ...prev, [key]: err?.message || 'Could not prepare that photo.' }));
    }
    setBusyKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [setPhoto]);

  const analyze = useCallback(async () => {
    const analyzed = list.map((photo) => photo.data);
    const sequence = ++readSequence.current;
    setAnalysis({ busy: true, error: '' });
    try {
      const result = await request(`${base}/tree-shrub/assess-preview`, {
        method: 'POST',
        body: JSON.stringify({ photos: analyzed.map((data) => ({ data })) }),
      });
      if (sequence !== readSequence.current) return;
      // Only a read that scored EVERY photo is reviewable: /complete trusts the
      // tech's decisions only when scoredCount covers the submitted set, and
      // otherwise re-scores, which would drop a rejection the tech made here.
      if (result?.scores && Number(result.scoredCount) === analyzed.length) {
        setPreview({ photos: analyzed, result, rejected: new Set() });
        setAnalysis({ busy: false, error: '' });
      } else {
        setAnalysis({ busy: false, error: 'The photo read could not score these photos. You can still complete; they are scored when the visit is saved.' });
      }
    } catch {
      if (sequence !== readSequence.current) return;
      setAnalysis({ busy: false, error: 'The photo read is unavailable right now. You can still complete; the photos are scored when the visit is saved.' });
    }
  }, [base, request, list]);

  const toggleRejected = useCallback((key) => {
    setPreview((prev) => (prev ? { ...prev, rejected: toggleInSet(prev.rejected, key) } : prev));
  }, []);
  return { slots, list, busy: busyKeys.size > 0, busyKeys, errors, preview, analysis, setPhoto, addPhoto, analyze, toggleRejected };
}

function PhotosSection({ photos, lastPhotos, previewCurrent, locked }) {
  const count = photos.list.length;
  const result = previewCurrent ? photos.preview.result : null;
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Photos</h3>
        <span className="tech-visit-muted">{`${count} of ${MAX_PHOTOS} · first two required`}</span>
      </div>
      <div className="tech-ts-slots">
        {PHOTO_SLOTS.map((slot) => (
          <PhotoSlot
            key={slot.key}
            slot={slot}
            photo={photos.slots[slot.key]}
            last={lastPhotos?.[slot.key]}
            busy={photos.busyKeys.has(slot.key)}
            error={photos.errors[slot.key]}
            locked={locked}
            onFile={(file) => photos.addPhoto(slot.key, file)}
            onClear={() => photos.setPhoto(slot.key, null)}
          />
        ))}
      </div>
      <div className="tech-visit-actions">
        <Button
          type="button"
          variant="secondary"
          className="tech-visit-action tech-visit-wide"
          loading={photos.analysis.busy}
          disabled={locked || count < 2 || photos.busy}
          onClick={photos.analyze}
        >
          {result ? 'Analyze again' : 'Analyze photos'}
        </Button>
      </div>
      {photos.analysis.error && <p className="tech-visit-muted" role="status">{photos.analysis.error}</p>}
      {result && (
        <div className="tech-ts-findings">
          <p className="tech-visit-muted" role="status">{result.aiSummary || 'Photo read done.'}</p>
          {(result.findings || []).map((finding) => (
            <FindingTile
              key={finding.key}
              finding={finding}
              rejected={photos.preview.rejected.has(finding.key)}
              locked={locked}
              onToggle={() => photos.toggleRejected(finding.key)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function PhotoSlot({ slot, photo, last, busy, error, locked, onFile, onClear }) {
  const inputRef = useRef(null);
  // An expired or broken link shows nothing rather than a broken image.
  const [lastBroken, setLastBroken] = useState(false);
  const captionId = useId();
  return (
    <div className="tech-ts-slot">
      <div className="tech-ts-slot-head">
        <span className="tech-ts-slot-label">{slot.label}</span>
        <span className="tech-visit-muted">{slot.when}</span>
      </div>
      {photo ? (
        <img className="tech-ts-slot-image" src={photo.data} alt={`${slot.label} photo`} />
      ) : null}
      <p id={captionId} className="tech-visit-muted">{slot.caption}</p>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-label={`${slot.label} photo file`}
        disabled={locked}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        }}
      />
      <div className="tech-ts-slot-actions">
        {last && !lastBroken && (
          <figure className="tech-ts-slot-last">
            <img
              className="tech-ts-slot-last-image"
              src={last.url}
              alt={`${slot.label}, last visit`}
              loading="lazy"
              onError={() => setLastBroken(true)}
            />
            <figcaption className="tech-visit-muted">{`Last time${shortDate(last.takenAt) ? ` · ${shortDate(last.takenAt)}` : ''}`}</figcaption>
          </figure>
        )}
        <Button
          type="button"
          variant="secondary"
          className="tech-visit-action"
          aria-describedby={captionId}
          loading={busy}
          disabled={locked || busy}
          onClick={() => inputRef.current?.click()}
        >
          {photo ? `Retake ${slot.label}` : `Add ${slot.label} photo`}
        </Button>
        {photo && (
          <Button type="button" variant="ghost" className="tech-visit-action" disabled={locked || busy} onClick={onClear}>{`Remove ${slot.label} photo`}</Button>
        )}
      </div>
      {error && <p className="tech-visit-warning" role="alert">{error}</p>}
    </div>
  );
}

// One thing the photo read flagged. Kept unless the tech rejects it; a
// rejected finding is hidden from the report.
function FindingTile({ finding, rejected, locked, onToggle }) {
  return (
    <div className={cn('tech-visit-card tech-ts-finding', rejected && 'tech-ts-finding--rejected')}>
      <p className="tech-ts-finding-label">{finding.label}</p>
      {finding.detail && <p className="tech-visit-muted">{finding.detail}</p>}
      <Button
        type="button"
        variant="secondary"
        className="tech-visit-action"
        aria-pressed={rejected}
        aria-label={`Reject ${finding.label}`}
        disabled={locked}
        onClick={onToggle}
      >
        {rejected ? 'Rejected' : 'Reject'}
      </Button>
    </div>
  );
}

// This month's protocol products as suggestions, then anything the tech adds.
function ProductsSection({ ctx, products, locked, other, popover }) {
  const { rows, updateRow, removeRow } = products;
  const sectionWarnings = ctx.warnings.filter((warning) => warning.productId == null);
  return (
    <section className="tech-visit-choice-section">
      <div className="tech-visit-section-head">
        <h3 className="tech-visit-section-title">Products used</h3>
        <span className="tech-visit-muted">Tap what you applied</span>
      </div>
      {sectionWarnings.map((warning) => (
        <p key={`${warning.type}-${warning.productId}-${warning.message}`} className="tech-visit-warning" role="status"><WarningIcon /> {warning.message}</p>
      ))}
      {!rows.length && <p className="tech-visit-muted">No suggested products this month. Add what you applied.</p>}
      <div className="tech-visit-tile-grid">
        {rows.map((row) => (
          <ProductTile key={row.productId} row={row} locked={locked} onClick={() => updateRow(row.productId, { active: !row.active })} />
        ))}
      </div>
      {rows.filter((row) => row.active).map((row) => (
        <ProductEditor
          key={row.productId}
          row={row}
          warnings={ctx.warnings.filter((warning) => warning.productId != null && String(warning.productId) === String(row.productId))}
          locked={locked}
          onChange={(patch) => updateRow(row.productId, patch)}
          onRemove={() => removeRow(row.productId)}
        />
      ))}
      <OtherProductButton {...other} popover={popover} />
    </section>
  );
}

// A product tile names what goes on the record. A suggestion starts off; a
// product in the N/P summer blackout says so and cannot be turned on.
function ProductTile({ row, locked, onClick }) {
  const outOfStock = row.active && isOutOfStock(row.product);
  let detail = 'Tap if applied';
  if (row.blocked) detail = NP_BLACKOUT_TEXT;
  else if (row.active) detail = hasAmount(row) ? amountText(row.totalAmount, row.amountUnit) : 'How much?';
  return (
    <Button
      type="button"
      variant="secondary"
      className={cn('tech-visit-action tech-visit-product tech-visit-product-tile', {
        'tech-visit-product--off': !row.active && !row.blocked,
        'tech-visit-product--added': row.added && row.active,
        'tech-visit-product--stock': outOfStock,
      })}
      disabled={locked || row.blocked}
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
// time's amount, labeled), how it went down, and the server's warnings for it.
function ProductEditor({ row, warnings, locked, onChange, onRemove }) {
  const nameId = useId();
  const amountId = useId();
  const methodId = useId();
  const choices = METHOD_CHOICES.some((choice) => choice.value === row.method)
    ? METHOD_CHOICES
    : [...METHOD_CHOICES, { value: row.method, label: methodLabel(row.method) }];
  return (
    <div role="group" aria-labelledby={nameId} className="tech-product-editor">
      <div className="tech-product-editor-head">
        <h4 id={nameId} className="tech-product-editor-name">{row.name}</h4>
        <span className="tech-visit-muted">{[categoryLabel(row.product), row.added ? 'added by you' : 'this month'].filter(Boolean).join(' · ')}</span>
      </div>
      <AmountEntry id={amountId} row={row} locked={locked} onChange={onChange} />
      {row.fromLast && <p className="tech-visit-muted">last time</p>}
      {row.added ? (
        <div>
          <span id={methodId} className="tech-product-editor-label">How</span>
          <div role="group" aria-labelledby={methodId} className="tech-visit-tile-grid">
            {choices.map((choice) => (
              <Chip disabled={locked} key={choice.value} label={choice.label} pressed={row.method === choice.value} onClick={() => onChange({ method: choice.value })} />
            ))}
          </div>
        </div>
      ) : (
        <p className="tech-visit-muted">{`How: ${methodLabel(row.method)}`}</p>
      )}
      {warnings.map((warning) => (
        <p key={`${warning.type}-${warning.productId}-${warning.message}`} className="tech-visit-warning" role="status"><WarningIcon /> {warning.message}</p>
      ))}
      {row.added && (
        <div className="tech-product-editor-actions">
          <Button type="button" variant="secondary" className="tech-visit-action tech-product-remove" disabled={locked} onClick={onRemove}>Remove</Button>
        </div>
      )}
    </div>
  );
}

// The compliance taps the server's checks need, only when a product on the
// sheet calls for them.
function ComplianceSection({ form, setField, insect, iracRows, manualIrac, locked }) {
  return (
    <>
      {insect && (
        <ChoiceSection title="Flowering / bee status" columns={1}>
          {POLLINATOR_OPTIONS.map((label) => (
            <Chip disabled={locked} key={label} label={label} pressed={form.pollinator === label} onClick={() => setField('pollinator', label)} />
          ))}
        </ChoiceSection>
      )}
      {manualIrac && (
        <ChoiceSection title="IRAC / FRAC rotation checked & logged" columns={2}>
          {['Yes', 'No'].map((label) => (
            <Chip disabled={locked} key={label} label={label} pressed={form.irac === label} onClick={() => setField('irac', label)} />
          ))}
        </ChoiceSection>
      )}
      {iracRows && !manualIrac && <p className="tech-visit-muted">IRAC / FRAC rotation checked by the app.</p>}
    </>
  );
}
