/**
 * Intelligence Bar — Reprice a customer's future visits
 * server/services/intelligence-bar/reprice-visits-tools.js
 *
 * `reprice_future_visits` (owner ruling 2026-10-07, Q8: "reprice future visits —
 * card lists each visit old → new; never paid or invoiced visits") sets ONE new
 * per-visit price on one customer's upcoming visits of ONE service.
 *
 *   unconfirmed → a PREVIEW: every visit that changes (date, service, old price →
 *                 new price), every visit left alone and why, and that no customer
 *                 message is sent. Nothing is written.
 *   confirmed   → re-plans and refuses on any drift from the card (the route
 *                 fingerprints the preview and hands its `_version` here as
 *                 `_verified_reprice_version`), re-reads each visit's pin again,
 *                 then saves each visit through the Schedule screen's own visit
 *                 edit — updateVisitDetails, the named PUT
 *                 /admin/schedule/:id/update-details handler — with the body the
 *                 screen's price-only edit sends. That handler owns validation,
 *                 the re-price block (REPRICE_BLOCKED_COMMITTED_MONEY), its row
 *                 CAS and the post-commit effects; this module adds no writer.
 *
 * Scope (owner): scheduled_date on or after today (ET); one customer; one service
 * family (appointment-tagger's classification). Never a visit that is completed,
 * in progress (en_route / on_site), invoiced (any invoice row), prepaid, covered
 * by an annual prepay term (the Schedule coverage reader decides), a free re-service, a $0 visit, a visit with add-on
 * lines, a series' first (template) visit, or one the screen's re-price block reports as holding money. A
 * monthly-membership customer is refused whole: dues cover those visits, so the
 * price there is the monthly rate (update_customer / rate_service).
 *
 * The new price is a dollar amount. A percent is not accepted: a stored visit
 * price may already be net of an older discount, so "15% off" has no single
 * answer the card could state without guessing which base it applies to.
 *
 * Dark behind GATE_IB_REPRICE_VISITS (ibRepriceVisitsLive, strict 'true').
 */
const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');
const { UUID_RE } = require('./task-context');
const { etDateString, validCalendarDate } = require('../../utils/datetime-et');
const { resolveBillingLane } = require('../billing-lane');
const { dateOnly } = require('../visit-groups');
const { ibRepriceVisitsLive } = require('../../config/feature-gates');

// Owner: cap the batch; a larger request is refused, never truncated.
const MAX_VISITS = 24;
const OPEN_STATUSES = new Set(['pending', 'confirmed']);
// Not upcoming visits at all — left out of the card without a line.
const GONE_STATUSES = new Set(['cancelled', 'canceled', 'skipped', 'no_show', 'rescheduled']);
const IN_PROGRESS_STATUSES = new Set(['en_route', 'on_site', 'in_progress']);
// Every stored discount field the Schedule price edit clears on a visit with no
// add-on lines (admin-schedule.js computeSingleServiceEstimatedPricePlan and
// clearAppointmentDiscountCatalogFields): any one of them set means the card
// must say the stamp is replaced. Identity / name / scope fields count when
// present; amount fields count when non-zero.
const STORED_DISCOUNT_FIELDS = [
  'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars', 'discount_max_dollars',
  'discount_service_key_filter', 'discount_service_category_filter',
  'line_discount_id', 'line_discount_name', 'line_discount_type', 'line_discount_amount', 'line_discount_dollars',
];

function hasStoredDiscount(row) {
  return STORED_DISCOUNT_FIELDS.some((field) => {
    const value = row[field];
    if (value == null || value === '') return false;
    return /(amount|dollars)$/.test(field) ? Number(value) !== 0 : true;
  });
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const NO_MESSAGE = 'No customer message is sent.';

const REPRICE_FUTURE_VISITS_TOOL = {
  name: 'reprice_future_visits',
  description: `Change the per-visit price of ONE customer's upcoming visits for ONE service (e.g. "she is Gold now, make her future pest visits $49"). The first call returns a PREVIEW and changes nothing: each visit that changes (date, service, old price → new price), each visit left alone and why, and that no customer message is sent. The operator approves on the confirmation card. Each visit is then saved exactly as the Schedule screen's Edit appointment price edit saves it.
Never changes a visit that is completed, in progress, invoiced, prepaid, covered by an annual prepay term, a free re-service or $0 visit, a visit with add-on lines, a plan's first (template) visit, or one holding money — those are listed on the card as left alone. At most ${MAX_VISITS} visits per card: pass through_date to split a longer schedule.
Refused for a customer with an annual prepay term (change those prices on the Schedule screen). Refused for a customer billed by monthly membership: dues cover those visits and the price is the monthly rate — use update_customer / rate_service for that instead.
new_price is the new price of each visit in dollars (the full visit price after any discount). A percentage is not accepted: ask the operator for the dollar price. Changing a WaveGuard tier never reprices visits by itself — use this tool when the operator wants the visits repriced.
Admin-only.`,
  input_schema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', format: 'uuid', description: 'The customer whose upcoming visits change' },
      service: { type: 'string', description: 'The service whose visits change, as the operator said it (e.g. "pest", "lawn", "mosquito", "tree and shrub")' },
      new_price: { type: 'number', description: 'The new price of EACH visit in dollars, above 0' },
      through_date: { type: 'string', format: 'date', description: 'Optional last visit date to include (YYYY-MM-DD)' },
    },
    required: ['customer_id', 'service', 'new_price'],
  },
};

const REPRICE_VISITS_TOOLS = [REPRICE_FUTURE_VISITS_TOOL];

function money(value) {
  return `$${Number(value).toFixed(2)}`;
}

function priceText(value) {
  return value == null ? 'no price on file' : money(value);
}

function cents(value) {
  return value == null || value === '' ? null : Math.round(Number(value) * 100);
}

function weekdayDate(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  // Date first: the card sorts its lines by text, so this keeps them in date order.
  return `${day} (${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

function classify(text) {
  return require('../appointment-tagger').classifyAppointmentType(String(text || ''));
}

// The pin each visit is approved against: identity (customer, service, plan
// position), schedule, price, every eligibility field the card judged, and the
// row version (any write to the row after the card changes it).
function visitPin(row) {
  const iso = (v) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
  return {
    id: String(row.id),
    customer_id: row.customer_id == null ? null : String(row.customer_id),
    service_type: row.service_type || null,
    service_id: row.service_id == null ? null : String(row.service_id),
    is_recurring: row.is_recurring === true,
    recurring_parent_id: row.recurring_parent_id == null ? null : String(row.recurring_parent_id),
    is_callback: row.is_callback === true,
    date: dateOnly(row.scheduled_date),
    status: row.status || null,
    track_state: row.track_state || null,
    estimated_price: cents(row.estimated_price),
    primary_line_price: cents(row.primary_line_price),
    prepaid_amount: cents(row.prepaid_amount),
    prepaid_at: iso(row.prepaid_at),
    annual_prepay_term_id: row.annual_prepay_term_id == null ? null : String(row.annual_prepay_term_id),
    // Every discount field the card's replaced-discount note reads: a stamp
    // added after the card is drift, never adopted between saves.
    discount: Object.fromEntries(STORED_DISCOUNT_FIELDS.map((f) => [f, row[f] == null || row[f] === '' ? null : String(row[f])])),
    row_version: row.row_version || null,
  };
}

function pinsVersion(pins, extra) {
  return crypto.createHash('sha256').update(JSON.stringify({ pins, ...extra })).digest('hex');
}

function parseInput(input) {
  if (!UUID_RE.test(String(input.customer_id || ''))) return { error: 'Resolve the customer first (customer_id).' };
  const service = String(input.service || '').trim();
  if (!service) return { error: 'Name the service whose visits change (for example pest or lawn).' };
  const price = Number(input.new_price);
  if (!Number.isFinite(price) || price <= 0) {
    return { error: 'Give the new per-visit price in dollars, above $0. To make a visit free, use the Schedule screen.' };
  }
  if (Math.abs(price * 100 - Math.round(price * 100)) > 1e-6) return { error: 'Give the new price in whole cents.' };
  if (price > 10000) return { error: 'That price is above $10,000 a visit. Check the amount.' };
  const through = input.through_date == null || input.through_date === '' ? null : String(input.through_date).trim();
  if (through && !validCalendarDate(through)) return { error: 'through_date must be a real calendar date (YYYY-MM-DD).' };
  return { service, newPrice: Math.round(price * 100) / 100, through };
}

// One service family: appointment-tagger's tag for the operator's words, or the
// visits whose service name contains them — and those must share one tag.
function pickFamily(rows, service) {
  const asked = classify(service);
  const byTag = new Map();
  for (const row of rows) {
    const c = classify(row.service_type);
    if (!byTag.has(c.tag)) byTag.set(c.tag, { tag: c.tag, label: c.label, rows: [] });
    byTag.get(c.tag).rows.push(row);
  }
  const offered = [...byTag.values()].map((f) => `${f.label} (${f.rows.length})`).join(', ') || 'none';
  // A recognized family takes its whole bucket. Otherwise only the visits whose
  // name contains the words — never the rest of their bucket ('general' holds
  // every unrecognized service) — and those must name one service.
  if (asked.tag !== 'general' && byTag.has(asked.tag)) return { family: byTag.get(asked.tag) };
  const needle = service.toLowerCase();
  const named = rows.filter((r) => String(r.service_type || '').toLowerCase().includes(needle));
  const names = [...new Set(named.map((r) => String(r.service_type).trim()))];
  if (!named.length) return { error: `This customer has no upcoming "${service}" visits. Upcoming services: ${offered}. Nothing was changed.` };
  if (new Set(named.map((r) => classify(r.service_type).tag)).size > 1 || (classify(named[0].service_type).tag === 'general' && names.length > 1)) {
    return { error: `"${service}" matches more than one service: ${names.join(', ')}. Name one. Nothing was changed.` };
  }
  const c = classify(named[0].service_type);
  return { family: { tag: c.tag === 'general' ? `general:${names[0].toLowerCase()}` : c.tag, label: c.tag === 'general' ? names[0] : c.label, rows: named } };
}

// An annual prepay term the visit save's term refresh would process — that
// refresh's own selection (refreshableTermsForCustomer), not a narrower one.
async function hasRefreshablePrepayTerm(customerId) {
  const { refreshableTermsForCustomer } = require('../annual-prepay-renewals');
  return (await refreshableTermsForCustomer(customerId, db)).length > 0;
}

async function loadCustomer(customerId) {
  return db('customers').where({ id: customerId }).whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'billing_mode', 'waveguard_tier', 'monthly_rate');
}

async function loadUpcomingVisits(customerId, today, through) {
  const q = db('scheduled_services')
    .where({ customer_id: customerId })
    .where('scheduled_date', '>=', today)
    .select('scheduled_services.*', db.raw("(xmin::text || ':' || ctid::text) as row_version"))
    .orderBy('scheduled_date', 'asc')
    .orderBy('window_start', 'asc')
    // Stable tie-breaker: two visits on one date and window keep one order,
    // so the card and its pinned version read the same on every re-plan.
    .orderBy('id', 'asc');
  if (through) q.where('scheduled_date', '<=', through);
  return q;
}

// The invoice shown for a visit with several: a live row before a void /
// refunded / cancelled one (those hold no money — findBillingCoveredVisits'
// NO_MONEY_HELD set), then by invoice id, so the card is the same whatever
// order the rows come back in.
const NO_MONEY_HELD = new Set(['void', 'refunded', 'canceled', 'cancelled']);
async function linkedInvoices(ids) {
  if (!ids.length) return new Map();
  const rows = await db('invoices').whereIn('scheduled_service_id', ids)
    .select('id', 'scheduled_service_id', 'invoice_number', 'status').orderBy('id', 'asc');
  rows.sort((a, b) => (NO_MONEY_HELD.has(String(a.status)) - NO_MONEY_HELD.has(String(b.status)))
    || String(a.id).localeCompare(String(b.id)));
  const out = new Map();
  for (const r of rows) {
    const key = String(r.scheduled_service_id);
    if (!out.has(key)) out.set(key, r);
  }
  return out;
}

async function visitsWithAddons(ids) {
  if (!ids.length) return new Set();
  const rows = await db('scheduled_service_addons').whereIn('scheduled_service_id', ids).select('scheduled_service_id');
  return new Set(rows.map((r) => String(r.scheduled_service_id)));
}

// The Schedule screen's own re-price block reader (findBillingCoveredVisits,
// liveInvoice), judged with the new price, so the card names a visit the save
// would refuse. The save re-checks under its locks either way.
async function committedMoney(rows, newPrice) {
  if (!rows.length) return new Map();
  const { findBillingCoveredVisits } = require('../../routes/admin-schedule');
  return findBillingCoveredVisits(db, rows.map((r) => ({ ...r, _proposedPrice: newPrice })), { liveInvoice: true });
}

// Not upcoming work: done, under way, or a tracker that moved on while the
// status still reads confirmed.
function workStateReason(row) {
  const status = String(row.status || '').toLowerCase();
  if (status === 'completed') return 'completed';
  if (IN_PROGRESS_STATUSES.has(status)) return 'in progress (technician on the way or on site)';
  if (!OPEN_STATUSES.has(status)) return `status is ${status || 'unknown'}`;
  const track = row.track_state == null ? 'scheduled' : String(row.track_state);
  return track === 'scheduled' ? null : `the visit tracker shows ${track.replace(/_/g, ' ')}`;
}

// Money already committed on the visit at its current price.
function committedReason(row, invoice) {
  if (invoice) return `invoiced (${invoice.invoice_number || 'invoice'}, ${invoice.status || 'status unknown'})`;
  if (row.prepaid_at || (row.prepaid_amount != null && Number(row.prepaid_amount) > 0)) return 'prepaid';
  return null;
}

// Why a visit is left alone, from its own row and the linked records — null
// when it can be repriced.
function exclusionReason(row, { invoice, hasAddons }) {
  const reason = workStateReason(row) || committedReason(row, invoice);
  if (reason) return reason;
  if (row.is_callback) return 'a free re-service visit';
  // A series' template visit: the Schedule edit carries its price into the
  // visits the plan adds later, beyond what this card approves.
  if (row.is_recurring && !row.recurring_parent_id) return "the plan's first visit (later visits copy its price) — change it on the Schedule screen";
  if (row.estimated_price != null && Number(row.estimated_price) === 0) return 'a $0 visit — change it on the Schedule screen if that is intended';
  if (hasAddons) return 'has add-on lines — change it on the Schedule screen';
  return null;
}

async function buildPlan(input) {
  if (!ibRepriceVisitsLive()) {
    return { error: 'Repricing future visits from the bar is turned off (GATE_IB_REPRICE_VISITS). Nothing was changed.', code: 'gate_off' };
  }
  const parsed = parseInput(input);
  if (parsed.error) return { error: parsed.error };
  const { service, newPrice, through } = parsed;
  const customer = await loadCustomer(input.customer_id);
  if (!customer) return { error: 'Customer not found. Nothing was changed.' };
  const customerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'This customer';
  const lane = resolveBillingLane(customer);
  if (lane.mode === 'monthly_membership') {
    return {
      error: `${customerName} is billed by monthly membership${Number(customer.monthly_rate) > 0 ? ` (${money(customer.monthly_rate)} a month)` : ''}: dues cover the plan visits, so they carry no per-visit price. Change the monthly rate with update_customer or rate_service instead. Nothing was changed.`,
      code: 'membership_lane',
    };
  }
  // The visit save refreshes the customer's annual prepay terms from the
  // new prices — an effect this card cannot show. Those customers stay on the
  // Schedule screen.
  if (await hasRefreshablePrepayTerm(customer.id)) {
    return { error: `${customerName} has an annual prepay term — change visit prices on the Schedule screen. Nothing was changed.`, code: 'annual_prepay_customer' };
  }
  const today = etDateString();
  if (through && through < today) return { error: 'through_date is in the past. Nothing was changed.' };
  const upcoming = (await loadUpcomingVisits(customer.id, today, through))
    .filter((r) => !GONE_STATUSES.has(String(r.status || '').toLowerCase()));
  const picked = pickFamily(upcoming, service);
  if (picked.error) return { error: picked.error };
  const { family } = picked;
  const ids = family.rows.map((r) => String(r.id));
  const [invoices, addons] = await Promise.all([linkedInvoices(ids), visitsWithAddons(ids)]);

  const excluded = [];
  const unchanged = [];
  let candidates = [];
  for (const row of family.rows) {
    const reason = exclusionReason(row, { invoice: invoices.get(String(row.id)), hasAddons: addons.has(String(row.id)) });
    if (reason) excluded.push({ row, reason });
    else if (cents(row.estimated_price) === Math.round(newPrice * 100)) unchanged.push(row);
    else candidates.push(row);
  }
  const covered = await committedMoney(candidates, newPrice);
  candidates = candidates.filter((row) => {
    const reason = covered.get(row.id) || covered.get(String(row.id));
    if (reason) excluded.push({ row, reason });
    return !reason;
  });

  const line = (row) => ({ id: String(row.id), date: dateOnly(row.scheduled_date), service: row.service_type || family.label });
  const excludedOut = excluded.map(({ row, reason }) => ({ ...line(row), reason }));
  const unchangedOut = unchanged.map((row) => ({ ...line(row), price: money(newPrice) }));
  if (!candidates.length) {
    return {
      error: `No upcoming ${family.label} visit for ${customerName} can change to ${money(newPrice)}. Nothing was changed.`,
      code: 'nothing_to_reprice',
      left_alone: excludedOut,
      already_at_price: unchangedOut,
    };
  }
  if (candidates.length > MAX_VISITS) {
    return {
      error: `${candidates.length} upcoming ${family.label} visits would change; one card holds at most ${MAX_VISITS}. Pass through_date to do part of the schedule. Nothing was changed.`,
      code: 'too_many_visits',
    };
  }
  const pins = candidates.map(visitPin);
  return {
    preview: true,
    customer_id: String(customer.id),
    customer_name: customerName,
    service_label: family.label,
    new_price: money(newPrice),
    visits: candidates.map((row) => ({
      ...line(row),
      old_price: priceText(row.estimated_price),
      new_price: money(newPrice),
      ...(hasStoredDiscount(row) ? { discount_note: 'its discount stamp is replaced: the new price is the full visit price' } : {}),
    })),
    left_alone: excludedOut,
    already_at_price: unchangedOut,
    customer_message: NO_MESSAGE,
    _version: pinsVersion(pins, { customer_id: String(customer.id), new_price: Math.round(newPrice * 100), family: family.tag, lane: lane.mode, refreshable_prepay_term: false }),
    _lane: lane.mode,
    _pins: pins,
    _new_price: newPrice,
  };
}

// Card lines (authorization-contract.js reads these for the curated card):
// one line per visit, in date order, then what is left alone.
function cardLines(preview) {
  const lines = [];
  for (const v of preview.visits || []) {
    lines.push({ kind: 'billing', text: `Visit ${weekdayDate(v.date)} · ${v.service}: ${v.old_price} → ${v.new_price}${v.discount_note ? ` (${v.discount_note})` : ''}` });
  }
  for (const v of preview.left_alone || []) {
    lines.push({ kind: 'operational', text: `Left alone: ${weekdayDate(v.date)} · ${v.service} — ${v.reason}` });
  }
  for (const v of preview.already_at_price || []) {
    lines.push({ kind: 'operational', text: `Already ${v.price}: ${weekdayDate(v.date)} · ${v.service}` });
  }
  lines.push({ kind: 'operational', text: `Each visit is saved like a price edit on the Schedule screen. Only the listed visits change; visits the plan adds later are not repriced by this card.` });
  lines.push({ kind: 'operational', text: NO_MESSAGE });
  return lines;
}

async function readRow(id) {
  return db('scheduled_services').where({ id })
    .first('scheduled_services.*', db.raw("(xmin::text || ':' || ctid::text) as row_version"));
}

async function readPin(id) {
  const row = await readRow(id);
  return row ? visitPin(row) : null;
}

function samePin(a, b) {
  return !!a && !!b && JSON.stringify(a) === JSON.stringify(b);
}

// Between saves the row version is not compared: a save's own post-commit
// effects may touch a later row without changing what the card showed. Date,
// status and price still must match.
function sameShownState(a, b) {
  return !!a && !!b && samePin({ ...a, row_version: null }, { ...b, row_version: null });
}

// The Schedule screen's visit edit, with the body its price-only edit sends
// (estimatedPrice) plus the total the card showed (expectedTotal — the screen's
// preview witness: the save refuses if it would store any other total). The
// version just checked against the card is the save's row-version baseline:
// a write between that check and the save's row lock refuses 409.
// approvedRepriceState is rechecked inside the save's transaction under its
// customer and visit locks: still no add-on line, the same billing lane, still
// no annual prepay term the save's refresh would process.
function saveVisitPrice(id, newPrice, approvedVisitVersion, billingLane, actionContext) {
  const { updateVisitDetails } = require('../../routes/admin-schedule');
  return updateVisitDetails({
    id,
    body: { estimatedPrice: newPrice, expectedTotal: newPrice },
    actor: { technicianId: actionContext?.technicianId || null },
    approvedVisitVersion,
    approvedRepriceState: { addonCount: 0, billingLane, refreshablePrepayTerm: false },
  });
}

function resultNote(changed, failure, notAttempted) {
  const parts = [`Changed ${changed.length} visit${changed.length === 1 ? '' : 's'}.`];
  if (failure) parts.push(`Stopped at ${failure.date}: ${failure.error}`);
  if (notAttempted.length) parts.push(`Not changed: ${notAttempted.map((v) => v.date).join(', ')}.`);
  parts.push('No customer message was sent.');
  return parts.join(' ');
}

// The approved plan, re-derived — or the refusal when anything changed since
// the card. Every pin is read again before the first save: drift on any visit
// changes none.
async function verifiedPlan(input) {
  const pinned = input._verified_reprice_version;
  if (!pinned) return { refusal: { error: 'Use the confirmation card to approve this change.' } };
  const plan = await buildPlan(input);
  if (plan.error) return { refusal: { error: `Nothing was changed: ${plan.error}`, code: plan.code, preview_changed: true } };
  if (plan._version !== pinned) {
    return { refusal: { error: 'The visits changed after the card was shown — nothing was changed. Ask again for a fresh confirmation card.', preview_changed: true } };
  }
  const fresh = await Promise.all(plan._pins.map((p) => readPin(p.id)));
  if (plan._pins.some((p, i) => !samePin(p, fresh[i]))) {
    return { refusal: { error: 'A visit changed after the card was shown — nothing was changed. Ask again for a fresh confirmation card.', preview_changed: true } };
  }
  return { plan };
}

// Right before its own save, the visit must still be what the card showed —
// the same customer, service, plan position, date, status, price and
// eligibility, still with no invoice or add-on line. Only the row version may
// differ from the card (an earlier save's post-commit effects); the version
// read here is the one the save's row lock must still find. Null on any drift.
async function stillAsApproved(pin) {
  const row = await readRow(pin.id);
  if (!row) return null;
  const now = visitPin(row);
  if (!sameShownState(pin, now)) return null;
  const [invoices, addons, customer] = await Promise.all([
    linkedInvoices([pin.id]), visitsWithAddons([pin.id]), loadCustomer(pin.customer_id),
  ]);
  // The customer must still bill per visit: a switch to monthly membership
  // during the batch stops it (dues cover those visits).
  if (!customer || resolveBillingLane(customer).mode === 'monthly_membership') return null;
  if (await hasRefreshablePrepayTerm(pin.customer_id)) return null;
  return exclusionReason(row, { invoice: invoices.get(pin.id), hasAddons: addons.has(pin.id) }) ? null : now;
}

// One visit's save: 'changed', a refusal (`failure`), or an unknown outcome.
async function saveOne(plan, i, actionContext) {
  const visit = plan.visits[i];
  const now = await stillAsApproved(plan._pins[i]);
  if (!now) {
    return { failure: { id: visit.id, date: visit.date, error: 'this visit changed after the card was shown.', code: 'preview_changed' } };
  }
  let reply;
  try {
    reply = await saveVisitPrice(visit.id, plan._new_price, now.row_version, plan._lane, actionContext);
  } catch (err) {
    if (err?.statusCode && err.statusCode < 500) {
      // The save's own under-lock drift checks (row version, approved state).
      const code = err.code === 'VISIT_CHANGED_RETRY' ? 'preview_changed' : (err.code || null);
      return { failure: { id: visit.id, date: visit.date, error: err.message, code } };
    }
    logger.error(`[intelligence-bar:reprice-visits] save interrupted for ${visit.id}: ${err?.code || err?.name || 'error'}`);
    return { unknown: { id: visit.id, date: visit.date } };
  }
  if (reply.status === 200 && reply.json?.success === true) {
    return { changed: { id: visit.id, date: visit.date, service: visit.service, old_price: visit.old_price, new_price: visit.new_price } };
  }
  return { failure: { id: visit.id, date: visit.date, error: reply.json?.error || `the save answered ${reply.status}.`, code: reply.json?.code || null } };
}

// Saves in date order and stops at the first visit that is not changed.
async function saveListed(plan, actionContext) {
  const changed = [];
  for (let i = 0; i < plan.visits.length; i += 1) {
    const step = await saveOne(plan, i, actionContext);
    if (!step.changed) return { changed, failure: step.failure || null, unknown: step.unknown || null };
    changed.push(step.changed);
  }
  return { changed, failure: null, unknown: null };
}

function commitResult(plan, { changed, failure, unknown }) {
  const stopAt = changed.length + (failure || unknown ? 1 : 0);
  const notAttempted = plan.visits.slice(stopAt).map((v) => ({ id: v.id, date: v.date }));
  const body = { customer_id: plan.customer_id, service: plan.service_label, new_price: plan.new_price, changed, not_attempted: notAttempted, messages_sent: false };
  if (unknown) {
    return {
      ...body, outcome_unknown: true, code: 'execution_interrupted', unknown_visit: unknown,
      error: `The save of the ${unknown.date} visit was interrupted — it may or may not have changed. Check it on the Schedule screen. ${resultNote(changed, null, notAttempted)}`,
    };
  }
  if (failure && !changed.length) {
    return {
      ...body, error: `Nothing was changed: ${failure.date}: ${failure.error}`, code: failure.code || 'reprice_refused', failed_visit: failure,
      ...(failure.code === 'preview_changed' ? { preview_changed: true } : {}),
    };
  }
  if (failure) return { ...body, partial: true, failed_visit: failure, note: resultNote(changed, failure, notAttempted) };
  return { ...body, success: true, note: resultNote(changed, null, []) };
}

async function commit(input, actionContext) {
  const verified = await verifiedPlan(input);
  if (verified.refusal) return verified.refusal;
  const { plan } = verified;
  const outcome = await saveListed(plan, actionContext);
  logger.info(`[intelligence-bar:reprice-visits] ${plan.customer_id}: ${outcome.changed.length}/${plan.visits.length} visit(s) repriced${outcome.failure ? `; stopped (${outcome.failure.code || 'refused'})` : ''}${outcome.unknown ? '; outcome unknown on one' : ''}`);
  return commitResult(plan, outcome);
}

async function executeRepriceVisitsTool(toolName, input = {}, actionContext = {}) {
  // Admin-only like the requireAdmin edit route it runs; the route and registry
  // refuse a technician too.
  if (actionContext && actionContext.isAdmin === false) {
    return { error: 'Repricing visits is limited to admin accounts', code: 'permission_denied' };
  }
  try {
    switch (toolName) {
      case 'reprice_future_visits': {
        // Only /confirm-action sets confirmed (route-derived, never a model param).
        if (input.confirmed !== true) return await buildPlan(input);
        if (!ibRepriceVisitsLive()) {
          return { error: 'Repricing future visits from the bar is turned off (GATE_IB_REPRICE_VISITS). Nothing was changed.', code: 'gate_off' };
        }
        return await commit(input, actionContext);
      }
      default: return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error(`[intelligence-bar:reprice-visits] ${toolName} failed (${err.code || err.name || 'error'})`);
    return input.confirmed === true
      ? { outcome_unknown: true, code: 'execution_interrupted', error: 'The reprice was interrupted — some visits may have changed. Check the Schedule screen before trying again.' }
      : { error: 'Could not prepare the reprice card' };
  }
}

module.exports = { REPRICE_VISITS_TOOLS, executeRepriceVisitsTool, cardLines, MAX_VISITS, repriceVisitsLive: ibRepriceVisitsLive };
