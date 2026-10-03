// client/src/lib/fast-complete-voice-plan.js
//
// Fast Complete voice fill, the apply half for the pest re-service sheet: turns
// the server's validated fill (products, visit, customerNote, officeNote,
// unclear) into the taps the sheet would otherwise need, as a PLAN the sheet
// applies through its own state setters. Pure: no state, no requests.
//
// Rules (owner 2026-10-02):
//  - the fill only ADDS or SETS EMPTY fields. A value the tech already set is
//    kept, and the difference becomes a Check ("You entered A; heard B");
//  - an amount is set only in a unit the row offers; else it stays as it is
//    and a Check asks for it. "Same as last time" fills only a last-time
//    amount the sheet really has (the house mix's own amount, or a picked
//    product's usual amount); else a Check;
//  - the activity level is ignored when the sheet shows none;
//  - every Check that points at a field clears itself when the tech changes
//    that field (unresolvedChecks), and the rest are dismissed by hand;
//  - one tap per product, and visit taps too (owner 2026-10-02): every product
//    row and visit value the fill sets starts UNCONFIRMED (`confirms`, shown
//    with its "Heard" words) until the tech taps ✓ or changes it, and
//    Complete waits on them like a Check;
//  - a How the tech tapped themselves (form.methodPicked) is never replaced,
//    even when it is the default way.
import { UNIT_CHOICES, amountText, hasAmount, usualAmountFor } from './fast-complete-products';
import { submittedAmount } from './measure-units';

// The plain-English reason for each code the server's `unclear` items carry.
const REASON_TEXT = {
  ambiguous_product: 'it could be more than one product',
  unknown_product: 'it is not a product on this list',
  not_on_sheet: 'it is not on this sheet',
  not_heard: 'it did not match your words',
  product_not_heard: 'the product name was not clear',
  duplicate_product: 'it was mentioned twice',
  negated_product: 'you said you did not use it',
  too_many_products: 'too many products at once',
  unclear_amount: 'the amount was not clear',
  amount_invalid: 'the amount was not a usable number',
  amount_not_spoken: 'no amount was said for it',
  carrier_volume: 'that sounds like the size of the mix, not an amount of the product',
  unclear_unit: 'that unit is not one this product uses',
  bad_unit: 'that unit is not one this product uses',
  unit_not_heard: 'the unit did not match your words',
  method_not_heard: 'how it went down was not clear',
  same_as_last_not_heard: 'it was not clear that you meant the same as last time',
  linear_ft_not_heard: 'the linear feet were not clear',
  value_not_heard: 'it was not clear which choice you meant',
  other_pest_unnamed: 'the other pest was not named',
  unclear_other: 'I could not tell what this meant',
  product_said_not_filled: 'you named it, but it was not filled in',
  amount_said_not_filled: 'you said an amount, but it was not filled in',
  visit_said_not_filled: 'you said it, but it was not filled in',
  office_said_not_filled: 'you said it for the office, but it is not in the office note',
  note_not_heard: 'those were not your words, so it was left out of the note',
  note_audience_unclear: 'it may have been for the office, so it was left out of the customer note',
  note_safety_claim: 'safety wording cannot go on the customer report',
  note_company_name: 'the company is Waves Pest Control',
  note_over_cap: 'the note was too long for this line',
};
const FALLBACK_REASON = 'I could not match it to a choice';

export function plainReason(reason) {
  const code = String(reason || '').trim();
  if (REASON_TEXT[code]) return REASON_TEXT[code];
  // Already words (not a code): show as is.
  return code.includes(' ') ? code : FALLBACK_REASON;
}

const words = (value) => String(value || '').replace(/_/g, ' ');
const quoted = (heard) => `“${heard}”`;
const rowAmount = (row) => ({ amount: row.totalAmount, unit: row.amountUnit });
const offers = (row, unit) => (UNIT_CHOICES[row.dimension] || []).some((choice) => choice.value === unit);
const textOf = (a) => amountText(a.amount, a.unit);

function sameAmount(a, b) {
  const x = submittedAmount(a.amount, a.unit);
  const y = submittedAmount(b.amount, b.unit);
  return x.amountUnit === y.amountUnit && Math.abs(Number(x.totalAmount) - Number(y.totalAmount)) < 1e-6;
}

// ── Checks that watch a field ─────────────────────────────────────────────
// A Check about a field records that field's value when it was raised; the
// tech changing it (to anything) is the fix.
const WATCHERS = {
  row: (row) => (row ? `${row.totalAmount ?? ''}|${row.amountUnit}|${row.active}|${row.methodInput ?? ''}` : 'gone'),
  amount: (row) => (row ? `${row.totalAmount ?? ''}|${row.amountUnit}` : 'gone'),
  active: (row) => (row ? String(row.active) : 'gone'),
  rowMethod: (row) => (row ? String(row.methodInput ?? '') : 'gone'),
};

export function watchValue(watch, rowsByKey, form) {
  const [kind, key] = watch.split(':');
  if (kind === 'form') {
    const value = form[key];
    return value instanceof Set ? [...value].sort().join(',') : String(value ?? '');
  }
  return WATCHERS[kind](rowsByKey.get(key));
}

/** The Checks still open: those not about a field the tech has since changed. */
export function unresolvedChecks(checks, rows, form) {
  const rowsByKey = new Map(rows.map((row) => [String(row.productId), row]));
  const open = checks.filter((check) => !check.watch || watchValue(check.watch, rowsByKey, form) === check.baseline);
  return open.length === checks.length ? checks : open;
}

// ── The plan under construction ───────────────────────────────────────────
function newPlan({ rows, form, ctx, ops }) {
  const keyed = (list, key) => new Map(list.map((item) => [String(item[key]), item]));
  return {
    ops,
    ratingAllowed: ctx.rating?.allowed === true,
    rows: keyed(rows, 'productId'),
    initial: keyed(ctx.rows || [], 'productId'),
    catalog: keyed(ctx.products || [], 'id'),
    common: keyed(ctx.commonProducts || [], 'productId'),
    form: { ...form },
    newKeys: new Set(),
    patches: {},
    formPatch: {},
    heard: { products: {}, visit: '' },
    checks: [],
    confirms: [],
    sprayHints: [],
  };
}

function addCheck(plan, text, watch = null) {
  plan.checks.push(watch ? { text, watch } : { text });
}

function patchRow(plan, key, patch) {
  plan.rows.set(key, { ...plan.rows.get(key), ...patch });
  if (!plan.newKeys.has(key)) plan.patches[key] = { ...plan.patches[key], ...patch };
}

function setField(plan, field, value) {
  plan.form[field] = value;
  plan.formPatch[field] = value;
}

// ── Products ──────────────────────────────────────────────────────────────
// What "same as last time" means on this sheet: the house mix's own amount, or
// a picked product's usual amount on these visits. null when it has none.
function lastTimeAmount(plan, key, row) {
  const initial = plan.initial.get(key);
  if (initial) return hasAmount(initial) ? { amount: Number(initial.totalAmount), unit: initial.amountUnit } : null;
  const usual = usualAmountFor(row.product, plan.common.get(key));
  return usual && offers(row, usual.unit) ? usual : null;
}

// The tech's own entry: an amount that is not the house mix's starting one.
function amountIsTechs(plan, key, row) {
  const initial = plan.initial.get(key);
  return !(initial && hasAmount(initial) && sameAmount(rowAmount(row), rowAmount(initial)));
}

// The amount this product was given, and whether the tech said it as a number.
function wantedAmount(plan, key, row, p) {
  if (p.amount != null && p.unit) return offers(row, p.unit) ? { amount: p.amount, unit: p.unit } : null;
  return lastTimeAmount(plan, key, row);
}

function applyAmount(plan, key, p) {
  const saidNumber = p.amount != null && p.unit;
  if (!saidNumber && !p.sameAsLast) return;
  const row = plan.rows.get(key);
  const want = wantedAmount(plan, key, row, p);
  if (!want) {
    addCheck(plan, `Heard ${quoted(p.heard)} — enter the amount for ${row.name}.`, `amount:${key}`);
    return;
  }
  const current = rowAmount(row);
  if (hasAmount(row) && sameAmount(current, want)) return;
  if (hasAmount(row) && amountIsTechs(plan, key, row)) {
    addCheck(plan, `You entered ${textOf(current)}; heard ${textOf(want)} for ${row.name}.`, `amount:${key}`);
    return;
  }
  patchRow(plan, key, { totalAmount: String(want.amount), amountUnit: want.unit });
}

// A product's method: a spray on a row that follows the How row is a hint for
// the visit's How; any other way goes to an added product's own method (the
// only place the sheet lets the tech set it).
function applyProductMethod(plan, key, p) {
  const { ops } = plan;
  const row = plan.rows.get(key);
  if (!p.method) return;
  // A spray on a row that follows How is a hint even when it matches How now:
  // the visit's How is settled after every product (planVisitMethod).
  if (ops.followsVisitMethod(row) && ops.sprayMethods.has(p.method)) {
    plan.sprayHints.push({ method: p.method, heard: p.heard, name: row.name });
    return;
  }
  if (ops.rowMethod(row, plan.form.method) === p.method) return;
  if (!row.added) {
    addCheck(plan, `Heard ${quoted(p.heard)} — ${row.name} has no way to set that; check how it went down.`);
    return;
  }
  if (row.methodInput && row.methodInput !== p.method) {
    addCheck(plan, `You picked ${words(row.methodInput)}; heard ${words(p.method)} for ${row.name}.`, `rowMethod:${key}`);
    return;
  }
  const standard = ops.sprayMethods.has(row.catalogMethod) ? plan.form.method : row.catalogMethod;
  patchRow(plan, key, { methodInput: p.method === standard ? null : p.method, rateInput: null });
}

// The row for a product: the one on the sheet, or the catalog product added
// the way "+ Other product" adds it. null (with a Check) when it is neither.
function rowFor(plan, key, p) {
  if (plan.rows.has(key)) return plan.rows.get(key);
  const product = plan.catalog.get(key);
  if (!product) {
    addCheck(plan, `Heard ${quoted(p.heard)} — that product is not on this list.`);
    return null;
  }
  plan.rows.set(key, plan.ops.makeRow(product, { common: plan.common.get(key), visitMethod: plan.form.method }));
  plan.newKeys.add(key);
  return plan.rows.get(key);
}

function planProduct(plan, p) {
  const key = String(p.productId);
  const row = rowFor(plan, key, p);
  if (!row) return;
  plan.heard.products[key] = p.heard;
  if (!row.active) {
    addCheck(plan, `You turned off ${row.name}; heard ${quoted(p.heard)}.`, `active:${key}`);
    return;
  }
  applyAmount(plan, key, p);
  applyProductMethod(plan, key, p);
}

// ── The visit ─────────────────────────────────────────────────────────────
function addToSet(plan, field, values, allowed, heard) {
  const known = values.filter((value) => allowed.includes(value));
  for (const value of values.filter((v) => !known.includes(v))) {
    addCheck(plan, `Heard ${quoted(heard || value)} — ${value} is not a choice on this sheet.`);
  }
  const fresh = known.filter((value) => !plan.form[field].has(value));
  if (fresh.length) setField(plan, field, new Set([...plan.form[field], ...fresh]));
}

// A single-value field: set when empty, left alone when it already says the
// same, a Check when the tech has a different value.
function setOrCheck(plan, { field, want, same, label }) {
  const current = plan.form[field];
  if (!String(current).trim()) {
    setField(plan, field, want);
  } else if (!same(current, want)) {
    addCheck(plan, `You ${label.verb} ${label.show(current)}; heard ${label.show(want)}.`, `form:${field}`);
  }
}

const sameText = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
const sameNumber = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;
const titled = (value) => {
  const text = words(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
};

function planVisitMethod(plan, visit) {
  const hints = plan.sprayHints;
  const wanted = visit.method || hints[0]?.method || '';
  if (!wanted) return;
  const current = plan.form.method;
  if (current === wanted) {
    // already how it is
  } else if (current === plan.ops.defaultMethod && !plan.form.methodPicked) {
    setField(plan, 'method', wanted);
  } else {
    addCheck(plan, `You tapped ${titled(current)}; heard ${titled(wanted)}.`, 'form:method');
  }
  for (const hint of hints.filter((h) => h.method !== wanted)) {
    addCheck(plan, `Heard ${quoted(hint.heard)} — ${hint.name} went down a different way from the How row.`, 'form:method');
  }
}

function planVisitFields(plan, visit) {
  const { ops } = plan;
  addToSet(plan, 'pests', visit.pests || [], ops.pests, visit.heard);
  addToSet(plan, 'areas', visit.areas || [], ops.areas, visit.heard);
  if (visit.otherPest && plan.form.pests.has('Other')) {
    setOrCheck(plan, { field: 'otherPest', want: visit.otherPest, same: sameText, label: { verb: 'named', show: (v) => quoted(v) } });
  }
  if (visit.linearFt != null) {
    setOrCheck(plan, { field: 'linearFt', want: String(visit.linearFt), same: sameNumber, label: { verb: 'entered', show: (v) => `${v} ft` } });
  }
  if (plan.ratingAllowed && ops.activityValues.includes(visit.activity)) {
    setOrCheck(plan, { field: 'activity', want: visit.activity, same: (a, b) => a === b, label: { verb: 'tapped', show: titled } });
  }
}

function planVisit(plan, visit) {
  const safe = visit && typeof visit === 'object' ? visit : {};
  planVisitFields(plan, safe);
  planVisitMethod(plan, safe);
  if (safe.heard) plan.heard.visit = safe.heard;
}

// ── Confirm taps ──────────────────────────────────────────────────────────
// What the fill SET (a row added or changed, a visit field filled) is a
// suggestion until the tech confirms it. A value the tech had already set and
// the fill left alone needs nothing.
const VISIT_LABELS = { pests: 'Pests', areas: 'Where', otherPest: 'Other pest', linearFt: 'Linear feet', activity: 'Activity', method: 'How' };
function visitValueText(field, value) {
  if (value instanceof Set) return [...value].join(', ');
  if (field === 'linearFt') return `${value} ft`;
  return titled(value);
}
function addConfirms(plan) {
  for (const key of new Set([...plan.newKeys, ...Object.keys(plan.patches)])) {
    const row = plan.rows.get(key);
    if (!row) continue;
    const amount = hasAmount(row) ? ` — ${textOf(rowAmount(row))}` : '';
    plan.confirms.push({ text: `${row.name}${amount}`, heard: plan.heard.products[key] || '', watch: `row:${key}` });
  }
  for (const field of Object.keys(plan.formPatch)) {
    plan.confirms.push({ text: `${VISIT_LABELS[field] || titled(field)}: ${visitValueText(field, plan.formPatch[field])}`, heard: plan.heard.visit, watch: `form:${field}` });
  }
}

/**
 * The taps a fill makes, as a plan:
 *   added      rows to add (a product not yet on the sheet)
 *   patches    { [productId]: patch } for rows already there
 *   formPatch  the visit fields to set (`method` is applied through the How tap)
 *   customerNote / officeNote  text to append to each note
 *   heard      { products: { [productId]: words }, visit: words }
 *   checks     [{ text, watch?, baseline? }] to show as Check chips
 *   confirms   [{ text, heard, watch, baseline }] what the fill set, each held
 *              unconfirmed until the tech taps ✓ or changes it
 * `rows` and `form` are the sheet's state right now; `ctx` its loaded context;
 * `ops` the sheet's own row rules (see FastCompleteSheet.jsx VOICE_SHEET_OPS).
 */
export function planVoiceFill({ fill, rows, form, ctx, ops }) {
  const plan = newPlan({ rows, form, ctx, ops });
  for (const item of Array.isArray(fill?.unclear) ? fill.unclear : []) {
    addCheck(plan, `Heard ${quoted(item.heard || '…')} — ${plainReason(item.reason)}.`);
  }
  for (const p of Array.isArray(fill?.products) ? fill.products : []) planProduct(plan, p);
  planVisit(plan, fill?.visit);
  addConfirms(plan);
  for (const check of [...plan.checks, ...plan.confirms]) {
    if (check.watch) check.baseline = watchValue(check.watch, plan.rows, plan.form);
  }
  return {
    added: [...plan.newKeys].map((key) => plan.rows.get(key)),
    patches: plan.patches,
    formPatch: plan.formPatch,
    customerNote: String(fill?.customerNote || '').trim(),
    officeNote: String(fill?.officeNote || '').trim(),
    heard: plan.heard,
    checks: plan.checks,
    confirms: plan.confirms,
  };
}
