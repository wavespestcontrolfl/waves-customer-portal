/**
 * start_program — start a recurring service program for an existing
 * customer from the Intelligence Bar, in ONE confirm card (owner 2026-10-06:
 * "she's moving forward on lawn care, 12 times a year at $61.33 after the
 * Silver discount, mark her Silver and schedule the first treatment").
 *
 * One card, three writes, each through the path the portal already uses:
 *   1. The recurring series — createScheduleBooking (routes/admin-schedule.js),
 *      the Schedule screen's own POST handler, with the body that screen
 *      sends for a recurring booking.
 *   2. The WaveGuard tier — update_customer's write (sanitizeUpdates:
 *      waveguard_tier with waveguard_tier_source 'manual').
 *   3. The monthly bill — the plan-rate ledger line writer update_customer
 *      uses (setLineForScalarWrite), one line per changed service, and the
 *      customers.monthly_rate total. The card shows every line before → after.
 *
 * Owner rulings (plan page BRxSMfNpX9hKTrNHSFbhb3):
 *   D1 a tier change never reprices the other services by itself: the
 *      operator opts in per service (reprice_lines) and states the new price.
 *      No discount math is invented here.
 *   D3 the texts the Schedule screen sends, behind send_texts (default on).
 *   D4 a monthly total below the other services' lines is refused
 *      (planRateChange).
 *   D2 no membership email: neither the schedule route nor the update_customer
 *      write sends one (the membership.started email lives only in the admin
 *      customers PUT route), so the card says none is sent.
 *
 * Commit order. createScheduleBooking cannot join a caller transaction: the
 * handler opens its own db.transaction (occupancy and comms locks, then the
 * series inserts and the WaveGuard plan sync) and runs more steps after its
 * commit. So the series is booked FIRST; then the tier, the ledger lines and
 * the monthly total change together in ONE transaction. If that second step
 * fails, the receipt is partial: it names what landed (the series) and what
 * did not (tier and bill), never a plain Done. Booking first is safe only
 * because the customer must already be dues-billed (monthly lane, positive
 * rate, no payer): the series is booked as dues-covered (no visit price, no
 * invoice per visit) both before and after the bill changes.
 */

const crypto = require('crypto');
const db = require('../../models/db');
const logger = require('../logger');

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum'];
// The month-based cadences the Schedule screen books (recurringPattern).
const CADENCES = {
  monthly: 'monthly',
  bimonthly: 'every 2 months',
  quarterly: 'quarterly',
  triannual: 'every 4 months',
  semiannual: 'every 6 months',
};
// The Schedule screen books an ongoing series as its first 4 visits.
const ONGOING_PRESEED = 4;
const LEDGER_SOURCE = 'ib_update';

function startProgramLive() {
  return require('../../config/feature-gates').ibStartProgramLive();
}

const round = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function refusal(error, code) {
  return { error, ...(code ? { code } : {}) };
}

function normalizeTier(value) {
  const key = String(value || '').trim().toLowerCase();
  return TIERS.find((t) => t.toLowerCase() === key) || null;
}

function dateLabel(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function clockLabel(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

function customerName(row) {
  return `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Unnamed customer';
}

// The bill as plain rows the ledger helpers take ({ family_key, monthly_rate }).
function linesToComponents(lines) {
  return [...lines].map(([family, amount]) => ({ family_key: family, monthly_rate: amount }));
}

// The whole bill change, computed with the ledger's own planRateChange one
// line at a time — the SAME steps, in the same order, the commit runs with
// setLineForScalarWrite. Returns { steps, lines, totalBefore, totalAfter,
// newLine } or { error, code }.
function planBill({ components, previousScalar, family, monthly, monthlyTotal, reprice }) {
  const PlanRateLedger = require('../plan-rate-ledger');
  const before = PlanRateLedger.billLines(components, previousScalar);
  let current = before;
  let scalar = round(previousScalar);
  const steps = [];
  for (const r of reprice) {
    const lineBefore = current.get(r.family) || 0;
    const next = round(scalar - lineBefore + r.monthly);
    const change = PlanRateLedger.planRateChange({
      components: linesToComponents(current), previousScalar: scalar, newScalar: next, familyKey: r.family,
    });
    if (change.error) return refusal(change.error, change.code);
    steps.push({ family: r.family, previousScalar: scalar, newScalar: next });
    current = new Map(change.lines.filter((l) => l.after !== 0).map((l) => [l.family, l.after]));
    scalar = next;
  }
  const others = round([...current.values()].reduce((s, v) => s + v, 0));
  const total = monthly != null ? round(others + monthly) : round(monthlyTotal);
  // D4: a total below the other lines is refused by the ledger itself.
  const change = PlanRateLedger.planRateChange({
    components: linesToComponents(current), previousScalar: scalar, newScalar: total, familyKey: family,
  });
  if (change.error) return refusal(change.error, change.code);
  const newLine = round(total - others);
  if (!(newLine > 0)) {
    return refusal(`The new total ${money(total)} leaves nothing for the new service: the other services already bill ${money(others)}.`, 'rate_below_other_lines');
  }
  if (monthly != null && monthlyTotal != null && round(monthlyTotal) !== total) {
    return refusal(`monthly ${money(monthly)} plus the other services (${money(others)}) is ${money(total)}, not the monthly_total ${money(monthlyTotal)} given. Ask which number is right.`, 'program_total_mismatch');
  }
  steps.push({ family, previousScalar: scalar, newScalar: total });
  const families = [...new Set([...before.keys(), ...change.lines.map((l) => l.family)])];
  const afterMap = new Map(change.lines.map((l) => [l.family, l.after]));
  return {
    steps,
    newLine,
    totalBefore: round(previousScalar),
    totalAfter: total,
    lines: families.map((f) => ({ family: f, before: before.get(f) || 0, after: afterMap.get(f) || 0 })),
  };
}

// Is there an open estimate for this service family? Accepting estimates from
// the bar is a pending owner decision (Q5), so an open quote for the service
// refuses instead of booking around it. An unreadable estimate fails closed.
async function openEstimateForFamily(customerId, family) {
  // The estimate lifecycle's open set (sending included); an archived row keeps
  // its status but is no longer an offer.
  const { OPEN_ESTIMATE_STATUSES } = require('../estimate-conversion-agent');
  const rows = await db('estimates').where({ customer_id: customerId })
    .whereIn('status', OPEN_ESTIMATE_STATUSES).whereNull('archived_at').select('id', 'status', 'estimate_data');
  if (!rows.length) return null;
  const { acceptedRecurringBillingLines } = require('../plan-rate-ledger');
  const { serviceFamilyKeyForAdoption } = require('../../routes/estimate-public');
  for (const est of rows) {
    let data = est.estimate_data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { return est; }
    }
    const lines = acceptedRecurringBillingLines(data || {});
    if (lines.some((line) => serviceFamilyKeyForAdoption(line) === family)) return est;
  }
  return null;
}

async function resolveTechnician(input) {
  const Tools = require('./tools');
  if (input.technician_id) return Tools.resolveActiveTechnicianById(input.technician_id);
  if (input.technician_name) return Tools.resolveTechnicianByName(String(input.technician_name));
  return null;
}

// The model's arguments, checked before anything is read. Returns
// { error, code } or the normalized fields.
function parsePrices(input) {
  const monthly = input.monthly == null ? null : Number(input.monthly);
  const monthlyTotal = input.monthly_total == null ? null : Number(input.monthly_total);
  if (monthly == null && monthlyTotal == null) {
    return refusal('Give the new service\'s monthly price (monthly), or the new whole monthly bill (monthly_total). Nothing was proposed.', 'program_price_required');
  }
  const positive = (n) => n == null || (Number.isFinite(n) && n > 0);
  if (!positive(monthly) || !positive(monthlyTotal)) return refusal('Monthly prices must be positive dollar amounts.');
  return { monthly, monthlyTotal };
}

function parseProgramInput(input) {
  const { validScheduleDate } = require('../../utils/datetime-et');
  const customerId = String(input.customer_id || '').trim().toLowerCase();
  if (!customerId) return refusal('customer_id is required.');
  const serviceText = String(input.service || '').trim();
  if (!serviceText) return refusal('Name the service the program is for (for example Lawn Care).');
  const tier = normalizeTier(input.tier);
  if (!tier) return refusal(`tier must be one of ${TIERS.join(', ')}.`);
  const cadence = String(input.cadence || '').trim().toLowerCase();
  if (!CADENCES[cadence]) return refusal(`cadence must be one of ${Object.keys(CADENCES).join(', ')}.`);
  // Ongoing programs only: a finite series beside a monthly bill line that
  // never ends would keep billing after the last visit.
  if (input.visit_count != null) {
    return refusal('start_program starts ongoing programs only; a set number of visits is not supported. Propose again without visit_count, or book a fixed series from the Schedule screen. Nothing was proposed.', 'program_visit_count_refused');
  }
  const prices = parsePrices(input);
  if (prices.error) return prices;
  // Technician and window are required: the program's first visit is booked
  // onto a route, like the Schedule screen's "choose" assignment.
  if (!input.technician_id && !input.technician_name) {
    return refusal('Name the technician for the first visit. Nothing was proposed.', 'program_technician_required');
  }
  if (input.time_window == null || String(input.time_window).trim() === '') {
    return refusal('Give a start time for the first visit (for example 9:00 AM). Nothing was proposed.', 'program_window_required');
  }
  const firstDate = validScheduleDate(input.first_date);
  if (!firstDate) return refusal(`first_date must be a real YYYY-MM-DD date that is not in the past (got "${input.first_date}").`);
  const win = require('./tools').parseTimeWindowStart(input.time_window);
  if (win.error) return refusal(win.error, win.code || 'invalid_appointment_window');
  return {
    customerId, serviceText, tier, cadence, firstDate, start: win.start,
    ...prices, sendTexts: input.send_texts !== false,
  };
}

// Dues-billed only: the series is booked first, so it must be booked as
// dues-covered both before and after the bill changes (see header). One saved
// address at most: the card names no address picker; that is the Schedule
// screen's job.
async function loadProgramCustomer(customerId) {
  const { resolveBillingLane } = require('../billing-lane');
  const customer = await db('customers').where({ id: customerId })
    .first('*', db.raw('updated_at::text AS version'));
  if (!customer || customer.deleted_at) return refusal('No live customer matches that id. Nothing was proposed.');
  if (customer.payer_id || resolveBillingLane(customer).mode !== 'monthly_membership' || !(Number(customer.monthly_rate) > 0)) {
    return refusal('This tool starts a program only for a customer who already pays a monthly plan bill (monthly membership, no Bill-To payer). Start this customer\'s first plan from an accepted estimate or the Schedule screen. Nothing was proposed.', 'program_needs_monthly_plan');
  }
  const properties = await db('customer_properties').where({ customer_id: customerId, active: true }).select('id');
  if ((properties || []).length > 1) {
    return refusal('This customer has more than one saved address. Book the program from the Schedule screen so you can pick the address. Nothing was proposed.', 'program_multiple_properties');
  }
  return { customer, propertyIds: (properties || []).map((p) => String(p.id)) };
}

// The catalog row (the Schedule screen books a picked catalog service) and
// its monthly-bill family.
async function resolveProgramService(serviceText) {
  const RateChange = require('./rate-change');
  const services = await db('services').where({ is_active: true })
    .select('id', 'name', 'short_name', 'service_key', 'base_price', 'price_range_min', 'category', 'billing_type', 'default_duration_minutes');
  const { resolveBookingCatalogRow } = require('./tools');
  const all = Array.isArray(services) ? services : [];
  // Only a recurring catalog row can start a program: the catalog's own
  // marker, read the way the Schedule screen reads it (inferServiceCadence:
  // any billing_type other than 'recurring' books one time).
  const isRecurringRow = (r) => String(r.billing_type || '').toLowerCase().replace(/[\s-]+/g, '_') === 'recurring';
  const match = resolveBookingCatalogRow(all.filter(isRecurringRow), serviceText);
  if (match.ambiguous) {
    return refusal(`"${serviceText}" names several catalog services (${match.ambiguous.map((r) => r.name).join(', ')}). Use the exact service name. Nothing was proposed.`);
  }
  const catalogRow = match.row;
  if (!catalogRow) {
    return resolveBookingCatalogRow(all, serviceText).row
      ? refusal(`"${serviceText}" is a one-time catalog service, not a recurring program. Book a single visit with create_appointment, or name the recurring service. Nothing was proposed.`, 'program_service_not_recurring')
      : refusal(`"${serviceText}" is not a catalog service. Use the service's exact catalog name. Nothing was proposed.`);
  }
  const family = RateChange.resolveFamily(catalogRow.name, []) || RateChange.resolveFamily(catalogRow.service_key, []);
  if (!family) {
    return refusal(`"${catalogRow.name}" is not a service this tool can put on the monthly bill. Nothing was proposed.`, 'rate_family_unknown');
  }
  return { catalogRow, family };
}

// Refusals that keep a second copy of the program from starting: the service
// already on the bill, a live series of it (the double-visit mistake the
// Schedule screen's duplicate guard refuses), or an open estimate for it.
async function programConflict({ customerId, catalogRow, family, components, currentLines }) {
  const RateChange = require('./rate-change');
  if (currentLines.has(family) || components.some((r) => r.family_key === family)) {
    return refusal(`${RateChange.lineLabel(family)} is already on this customer's monthly bill (${money(currentLines.get(family) || 0)}). Change its price with update_customer and rate_service. Nothing was proposed.`, 'program_already_billed');
  }
  const { loadLiveRecurringObligationRows, ownershipKeysForRow } = require('../waveguard-existing-services');
  let liveRows;
  try {
    liveRows = await loadLiveRecurringObligationRows(db, customerId);
  } catch {
    return refusal('Could not read this customer\'s recurring services. Try again in a moment. Nothing was proposed.');
  }
  const owned = new Set();
  for (const row of liveRows || []) ownershipKeysForRow(row).forEach((k) => owned.add(k));
  if (ownershipKeysForRow({ service_key: catalogRow.service_key, service_name: catalogRow.name }).some((k) => owned.has(k))) {
    return refusal(`This customer already has a recurring ${catalogRow.name} series. Nothing was proposed.`, 'program_series_exists');
  }
  let openEstimate;
  try {
    openEstimate = await openEstimateForFamily(customerId, family);
  } catch {
    return refusal('Could not read this customer\'s open estimates. Try again in a moment. Nothing was proposed.');
  }
  if (openEstimate) {
    return refusal(`This customer has an open estimate for ${RateChange.lineLabel(family).toLowerCase()} (${openEstimate.status}). Mark the estimate accepted on the estimate page. Nothing was proposed.`, 'program_open_estimate');
  }
  return null;
}

function describeLines(currentLines) {
  const { lineLabel } = require('./rate-change');
  return [...currentLines].map(([f, a]) => `${lineLabel(f)} ${money(a)}`).join(' + ');
}

// D1: only the lines the operator said yes to, each at the price they gave.
function resolveRepriceLines(rawLines, components, currentLines) {
  const RateChange = require('./rate-change');
  const reprice = [];
  const held = components.filter((r) => Number(r.monthly_rate) === 0).map((r) => r.family_key);
  for (const r of Array.isArray(rawLines) ? rawLines : []) {
    const amount = Number(r?.monthly);
    if (!(Number.isFinite(amount) && amount > 0)) return refusal('Each reprice_lines entry needs a positive monthly price.');
    const key = RateChange.resolveFamily(r?.service, components);
    if (!key || !currentLines.has(key)) {
      return refusal(`"${r?.service}" is not a service on this customer's monthly bill. The bill today: ${describeLines(currentLines)}. Nothing was proposed.`, 'rate_family_unknown');
    }
    if (held.includes(key)) return refusal(`${RateChange.lineLabel(key)} is on hold, so its price cannot be changed here. Nothing was proposed.`, 'rate_family_on_hold');
    if (reprice.some((x) => x.family === key)) return refusal(`${RateChange.lineLabel(key)} is listed twice in reprice_lines.`);
    reprice.push({ family: key, monthly: round(amount) });
  }
  return { reprice };
}

// The first visit's window: the start the operator gave, the service's
// default length (the handler's own duration rule), the shared admin rules.
function firstVisitWindow(firstDate, start, catalogRow) {
  const { deriveWindowEnd, sameDayWindowElapsed } = require('../../utils/datetime-et');
  const { assertAdminAppointmentWindow } = require('../scheduling/window-rules');
  const duration = Number(catalogRow.default_duration_minutes) > 0 ? Number(catalogRow.default_duration_minutes) : 60;
  const windowEnd = deriveWindowEnd(start, duration);
  if (!windowEnd) return refusal('That window would cross midnight. Pick an earlier start.', 'invalid_appointment_window');
  try {
    const window = assertAdminAppointmentWindow({ windowStart: start, windowEnd, durationMinutes: duration });
    // The same elapsed-window guard create_appointment runs.
    if (sameDayWindowElapsed(firstDate, window.window_end || start)) {
      return refusal('That time has already passed today. Pick a later window or a future date. Nothing was proposed.', 'window_elapsed');
    }
    return { duration, windowStart: window.window_start, windowEnd: window.window_end };
  } catch (err) {
    if (err?.status === 422) return refusal(err.message, 'invalid_appointment_window');
    throw err;
  }
}

// The booking handler runs the WaveGuard plan sync inside its own
// transaction (syncCustomerWaveGuardPlanFromScheduledServices), which can set
// the tier, active, pipeline_stage and member_since. The card predicts it with
// the sync's own member-branch builder over today's schedule plus the series
// being booked. Cases outside the member branch (enrollment of a non-member,
// an auto-derived label) or a predicted rate change are refused.
async function predictPlanSync(customer, catalogRow, firstDate, cadence) {
  const Sync = require('../self-booking-plan-sync');
  const { isMembershipCustomerRow } = require('../waveguard-existing-services');
  const unpredictable = refusal('The Schedule screen\'s WaveGuard plan sync would change this customer in a way this card cannot show. Book from the Schedule screen and set the tier and bill on the profile. Nothing was proposed.', 'program_plan_sync_unpredictable');
  if (!isMembershipCustomerRow(customer) || Sync.isAutoDerivedTierLabelRow(customer)) return unpredictable;
  const columns = await db('customers').columnInfo();
  const rows = await Sync.scheduledServiceRowsForCustomer(db, customer.id);
  const seriesRow = {
    id: 'planned-series', customer_id: customer.id, service_id: catalogRow.id, service_type: catalogRow.name,
    service_key: catalogRow.service_key, service_name: catalogRow.name, catalog_billing_type: catalogRow.billing_type,
    scheduled_date: firstDate, status: 'pending', is_recurring: true, recurring_pattern: cadence, is_callback: false, source: null,
  };
  const { etDateString } = require('../../utils/datetime-et');
  const { alignment } = Sync.memberAlignmentFromRows(customer, [...(rows || []), seriesRow], columns || {}, etDateString());
  const { pipeline_stage_changed_at: _stamp, ...updates } = alignment.updates || {};
  if (updates.monthly_rate !== undefined) return unpredictable;
  return { updates };
}

// Visits that already overlap the first visit's window (create_appointment's
// probe and fact shape, #6047): shown on the card and pinned, so an overlap
// that appears after the card refuses as preview_changed.
async function firstVisitOverlap(firstDate, window) {
  const { probeSlotOverlap } = require('../scheduling/window-rules');
  const rows = await db.transaction((trx) => probeSlotOverlap({
    trx, date: firstDate, windowStart: window.windowStart, windowEnd: window.windowEnd,
  }));
  if (!rows || !rows.length) return [];
  const facts = await require('./tools').bookingOverlapFacts(db, rows, firstDate);
  return facts.sort((a, b) => (a.fact < b.fact ? -1 : a.fact > b.fact ? 1 : 0));
}

// D3: the Schedule screen's texts. The new-recurring welcome text has no
// switch on that screen either, so a "no texts" card is refused when the
// welcome would still go out.
async function welcomeVerdict(args) {
  const { isNewRecurringSignupCandidate, WELCOME_DELAY_MINUTES } = require('../new-recurring-welcome-sms');
  const welcomeCandidate = await isNewRecurringSignupCandidate(args.customerId);
  if (!args.sendTexts && welcomeCandidate) {
    return refusal('This customer has never had a recurring service, so booking the program queues the new-customer welcome text. The Schedule screen has no switch for that text, and neither does this tool. Propose again with send_texts on. Nothing was proposed.', 'program_welcome_cannot_skip');
  }
  return { welcomeCandidate, delay: WELCOME_DELAY_MINUTES };
}

// create_appointment's rule: the booking redeems an open inspection-credit
// offer after commit (account credit this card cannot pin exactly), so a
// credit-bearing booking is refused. Every offer counts, gate-paused ones
// included; the 0 rides the version pin, so an offer that appears after the
// card refuses at commit. Returns { amount: 0 } or { error, code }.
async function openInspectionCredit(customerId) {
  let amount;
  try {
    const projected = await require('../inspection-credit').projectRedeemableOfferAmount(customerId, { includePaused: true });
    amount = Number(projected?.amount ?? projected) || 0;
  } catch {
    return refusal('Could not verify the customer\'s inspection credit. Book the first visit from the Schedule screen instead. Nothing was proposed.', 'program_inspection_credit');
  }
  if (amount > 0) {
    return refusal(`This customer has $${amount.toFixed(2)} of open inspection-credit offer(s) that booking would redeem, which this card cannot pin. Book the first visit from the Schedule screen. Nothing was proposed.`, 'program_inspection_credit');
  }
  return { amount };
}

/**
 * Everything the card shows and the commit needs, read without writing.
 * Returns { error, code } to refuse, or { plan } for the card and commit.
 */
async function buildProgramPlan(input) {
  const PlanRateLedger = require('../plan-rate-ledger');
  const RateChange = require('./rate-change');
  const { impliedMonthlyStampForWrite } = require('../billing-lane');

  const args = parseProgramInput(input);
  if (args.error) return args;
  const loaded = await loadProgramCustomer(args.customerId);
  if (loaded.error) return loaded;
  const { customer, propertyIds } = loaded;
  const service = await resolveProgramService(args.serviceText);
  if (service.error) return service;
  const { catalogRow, family } = service;

  const components = await PlanRateLedger.loadComponents(db, args.customerId);
  const currentLines = PlanRateLedger.billLines(components, customer.monthly_rate);
  const conflict = await programConflict({ customerId: args.customerId, catalogRow, family, components, currentLines });
  if (conflict) return conflict;
  const repriced = resolveRepriceLines(input.reprice_lines, components, currentLines);
  if (repriced.error) return repriced;
  const { reprice } = repriced;
  const bill = planBill({
    components, previousScalar: customer.monthly_rate, family, monthly: args.monthly, monthlyTotal: args.monthlyTotal, reprice,
  });
  if (bill.error) return refusal(`${bill.error} Today the bill is ${describeLines(currentLines)}. Nothing was proposed.`, bill.code);

  const tech = await resolveTechnician(input);
  if (!tech) return refusal('No active technician matches. Nothing was proposed.', 'program_technician_required');
  if (tech.error) return { ...tech };
  const window = firstVisitWindow(args.firstDate, args.start, catalogRow);
  if (window.error) return window;
  let overlap;
  try {
    overlap = await firstVisitOverlap(args.firstDate, window);
  } catch {
    return refusal('Could not check the schedule for visits that overlap the first visit. Try again in a moment. Nothing was proposed.');
  }
  const planSync = await predictPlanSync(customer, catalogRow, args.firstDate, args.cadence);
  if (planSync.error) return planSync;

  const welcome = await welcomeVerdict(args);
  if (welcome.error) return welcome;
  const { welcomeCandidate } = welcome;
  const credit = await openInspectionCredit(args.customerId);
  if (credit.error) return credit;
  const inspectionCredit = credit.amount;

  // update_customer's implied-lane rule (#3140): a write that turns a row
  // into an inferred monthly member stamps the lane. A customer this tool
  // accepts is already on the monthly lane, so the rule never fires here; if
  // it ever would, refuse rather than mint a lane the card did not show.
  if (impliedMonthlyStampForWrite(customer, { ...customer, waveguard_tier: args.tier, monthly_rate: bill.totalAfter })) {
    return refusal('This change would set a new billing lane for the customer. Change the tier and bill on the customer profile. Nothing was proposed.', 'program_lane_change');
  }

  const tierBefore = customer.waveguard_tier || null;
  const ledgerPin = RateChange.ledgerPin(components, customer.monthly_rate);
  const techPin = { id: String(tech.id), name: tech.name };
  return {
    plan: {
      customer, customerId: args.customerId, catalogRow, family, tier: args.tier, tierBefore,
      tierChanges: tierBefore !== args.tier || customer.waveguard_tier_source !== 'manual',
      cadence: args.cadence, firstDate: args.firstDate, ...window,
      tech: techPin, sendTexts: args.sendTexts, welcomeCandidate, welcomeDelay: welcome.delay,
      bill, reprice, ledgerPin, overlap, planSyncUpdates: planSync.updates,
      // Every input the commit trusts, as one string: the customer row
      // version, the bill, the tier, the series and the texts. The route pins
      // it at proposal (VERIFIED_VERSION_PARAMS) and the executor compares it
      // before anything is written.
      version: crypto.createHash('sha256').update(JSON.stringify([
        customer.version, ledgerPin, tierBefore, customer.waveguard_tier_source || null, customer.billing_mode || null,
        customer.payer_id || null, catalogRow.id, family, args.tier, args.cadence, args.firstDate,
        window.windowStart, window.windowEnd, techPin.id, args.sendTexts, welcomeCandidate, bill.steps, propertyIds, inspectionCredit,
        overlap.map((o) => o.fact), planSync.updates,
      ])).digest('hex'),
    },
  };
}

// The card, as ordered lines per kind. The contract sorts lines by kind and
// then by text, so the bill lines carry "n of m" to keep their order.
function cardLines(plan) {
  const RateChange = require('./rate-change');
  const lines = [];
  const add = (kind, text) => lines.push({ kind, text });
  const when = `${dateLabel(plan.firstDate)}, ${clockLabel(plan.windowStart)}-${clockLabel(plan.windowEnd)}`;
  const series = `ongoing, no end date (the first ${ONGOING_PRESEED} visits are booked now, as on the Schedule screen)`;
  add('operational', `Series: ${plan.catalogRow.name}, ${CADENCES[plan.cadence]}, ${series}`);
  add('operational', `First visit: ${when}, technician ${plan.tech.name}`);
  add('operational', 'Order: the visits are booked first. Then the tier and the monthly bill change together. If that second step fails, the visits stay booked and the receipt says what did not change');
  add('operational', `After booking: ask the bar to optimize ${plan.tech.name}'s route on ${dateLabel(plan.firstDate)} (a second card)`);
  if (plan.overlap.length) {
    const who = plan.overlap.map((o) => [o.customer, o.service, o.window].filter(Boolean).join(', ')).join('; ');
    add('operational', `Overlap: the first visit overlaps a visit already on the schedule (${who}). The booking goes ahead, as on the Schedule screen`);
  }

  const total = plan.bill.lines.length + 1;
  plan.bill.lines.forEach((l, i) => {
    let note;
    if (l.family === plan.family) note = 'new';
    else if (plan.reprice.some((r) => r.family === l.family)) note = `${plan.tier} applied, you said yes`;
    else note = `unchanged, ${plan.tier} not applied`;
    add('billing', `Monthly bill ${i + 1} of ${total}: ${RateChange.lineLabel(l.family)} ${money(l.before)} -> ${money(l.after)} (${note})`);
  });
  add('billing', `Monthly bill ${total} of ${total}: total ${money(plan.bill.totalBefore)} -> ${money(plan.bill.totalAfter)} a month`);
  add('billing', 'Visits carry no price: the monthly bill covers them (dues-billed plan visits)');
  add('billing', 'Billing lane: stays monthly membership');

  const sync = plan.planSyncUpdates || {};
  const syncParts = [
    sync.waveguard_tier !== undefined && `tier ${plan.tierBefore || 'none'} -> ${sync.waveguard_tier}`,
    sync.active !== undefined && 'marks the customer active',
    sync.pipeline_stage !== undefined && `stage -> ${String(sync.pipeline_stage).replace(/_/g, ' ')}`,
    sync.member_since !== undefined && `member since ${sync.member_since}`,
  ].filter(Boolean);
  add('customer', syncParts.length
    ? `Booking's WaveGuard plan sync (runs with the booking): ${syncParts.join('; ')}`
    : 'Booking\'s WaveGuard plan sync (runs with the booking): no change to the customer');
  add('customer', plan.tierChanges
    ? `WaveGuard tier: ${plan.tierBefore || 'none'} -> ${plan.tier} (set by hand, so the nightly tier check keeps it)`
    : `WaveGuard tier: ${plan.tier} (no change)`);

  const { arrivalWindowRange, formatSmsTimeRange } = require('../../utils/sms-time-format');
  if (plan.sendTexts) {
    add('comms', `Texts: a booking confirmation for the first visit goes out by text or email, per their settings. It gives the arrival window ${dateLabel(plan.firstDate)}, ${formatSmsTimeRange(arrivalWindowRange(plan.windowStart))}`);
  } else {
    add('comms', 'Texts: no booking confirmation is sent (send texts is off)');
  }
  add('comms', plan.welcomeCandidate
    ? `Texts and email: the new-customer welcome is queued for about ${Math.round(plan.welcomeDelay / 60) || 1} hour after booking. It sends the welcome text and the welcome email (welcome.new_recurring), once ever, by the channels the customer allows`
    : 'Texts and email: no welcome text or welcome email (this customer already had a recurring service)');
  add('comms', 'Texts: visit reminders before each visit, set up as the Schedule screen sets them up');
  add('comms', 'Email: the membership-started email is not sent');
  return lines;
}

function previewFromPlan(plan) {
  const RateChange = require('./rate-change');
  const lines = cardLines(plan);
  return {
    preview: true,
    customer_id: plan.customerId,
    customer_name: customerName(plan.customer),
    service: plan.catalogRow.name,
    cadence: plan.cadence,
    first_visit: { date: plan.firstDate, start: plan.windowStart, end: plan.windowEnd, technician: plan.tech.name },
    tier: { before: plan.tierBefore, after: plan.tier },
    bill: {
      lines: plan.bill.lines.map((l) => ({ service: RateChange.lineLabel(l.family), before: l.before, after: l.after })),
      total_before: plan.bill.totalBefore,
      total_after: plan.bill.totalAfter,
    },
    ...(plan.overlap.length ? { slot_overlap: { with: plan.overlap.map(({ id: _id, fact: _fact, ...shown }) => shown) } } : {}),
    plan_sync: plan.planSyncUpdates,
    send_texts: plan.sendTexts,
    // The handler registers the 72 h / 24 h reminder rows for every visit it
    // books, whatever send_texts says, so the customer is always contacted.
    notifies_customer: true,
    card_lines: lines,
    _version: plan.version,
    note: 'PREVIEW ONLY: nothing was booked or changed. The operator confirms from the card.',
  };
}

// The Schedule screen's POST body for one recurring group
// (CreateAppointmentModal buildGroupRequestBody + recurringGroupRequestFields
// + firstGroupSendFlags), with no price: a dues member's recurring visits are
// covered by the bill (the handler strips visit prices for them anyway).
function scheduleBody(plan) {
  return {
    customerId: plan.customerId,
    scheduledDate: plan.firstDate,
    serviceType: plan.catalogRow.name,
    serviceId: plan.catalogRow.id,
    primaryLinePrice: null,
    estimatedPrice: null,
    windowStart: plan.windowStart,
    windowEnd: plan.windowEnd,
    estimatedDuration: plan.duration,
    assignmentMode: 'choose',
    technicianId: plan.tech.id,
    urgency: 'routine',
    createInvoice: true,
    isRecurring: true,
    recurringPattern: plan.cadence,
    recurringOngoing: true,
    skipWeekends: false,
    sendConfirmationSms: plan.sendTexts,
    sendConfirmation: plan.sendTexts,
  };
}

async function actorFor(actionContext) {
  const technicianId = actionContext.technicianId || actionContext.actorId || null;
  let technicianName = 'Intelligence Bar';
  if (technicianId) {
    try {
      const row = await db('technicians').where({ id: technicianId }).first('name');
      if (row?.name) technicianName = row.name;
    } catch { /* name is a label only */ }
  }
  return { technicianId, technicianName };
}

// Step 2: tier + ledger lines + monthly total in ONE transaction, with the
// same lock order as update_customer (prefs advisory -> customer comms ->
// customers row). Re-checks the bill and billing lane the card was built on.
async function applyTierAndBill(plan) {
  const PlanRateLedger = require('../plan-rate-ledger');
  const RateChange = require('./rate-change');
  const { sanitizeUpdates } = require('./tools');
  const { lockCustomerComms } = require('../../utils/customer-comms-lock');
  const { impliedMonthlyStampForWrite } = require('../billing-lane');
  await db.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))', ['property-preferences', String(plan.customerId)]);
    await lockCustomerComms(trx, plan.customerId);
    const locked = await trx('customers').where('id', plan.customerId).forUpdate().first();
    if (!locked || locked.deleted_at) throw Object.assign(new Error('The customer record is no longer live.'), { drift: true });
    // The booking itself legitimately touches the row (the WaveGuard plan
    // sync can raise the tier and mark the customer active), so the row
    // version is not compared here. The bill and how it is paid must still be
    // exactly what the card showed.
    const components = await PlanRateLedger.loadComponents(trx, plan.customerId);
    if (RateChange.ledgerPin(components, locked.monthly_rate) !== plan.ledgerPin
      || (locked.billing_mode || null) !== (plan.customer.billing_mode || null)
      || (locked.payer_id || null) !== (plan.customer.payer_id || null)) {
      throw Object.assign(new Error("The customer's monthly bill or billing lane changed after the card was shown."), { drift: true });
    }
    const clean = sanitizeUpdates({ waveguard_tier: plan.tier, monthly_rate: plan.bill.totalAfter });
    if (impliedMonthlyStampForWrite(locked, { ...locked, ...clean })) {
      throw Object.assign(new Error('The change would set a new billing lane the card did not show.'), { drift: true });
    }
    await trx('customers').where('id', plan.customerId).update(clean);
    for (const step of plan.bill.steps) {
      await PlanRateLedger.setLineForScalarWrite(trx, plan.customerId, {
        familyKey: step.family, previousScalar: step.previousScalar, newScalar: step.newScalar,
      }, { source: LEDGER_SOURCE });
    }
  });
}

// The customer row as it is after the booking (its plan sync may have moved
// the tier), for a partial receipt that reports the real state.
async function customerStateAfterBooking(customerId) {
  try {
    return await db('customers').where('id', customerId).first('waveguard_tier', 'monthly_rate');
  } catch {
    return null;
  }
}

function partialReceipt(plan, booked, state, reason) {
  const tierNow = state ? (state.waveguard_tier || 'none') : 'unknown (could not read the customer)';
  const billNow = state ? money(state.monthly_rate) : 'unknown (could not read the customer)';
  return {
    success: true,
    partial: true,
    series_booked: booked,
    not_done: ['waveguard_tier', 'monthly_bill'],
    customer_now: state ? { waveguard_tier: state.waveguard_tier || null, monthly_rate: round(state.monthly_rate) } : null,
    warning: `PARTLY DONE. Booked: ${booked.visits_booked} ${plan.catalogRow.name} visit(s), first on ${dateLabel(plan.firstDate)}. NOT done by this card: the tier ${plan.tier} and the monthly bill ${money(plan.bill.totalAfter)}. Now the tier is ${tierNow} and the monthly bill is ${billNow}. Reason: ${reason}.`,
    message: 'Partly done: visits booked; this card did not set the tier or the monthly bill.',
  };
}

// Step 1. Returns { result } when the booking did not land (refused: nothing
// changed; threw: unknown), else the handler's { status, json }.
async function bookSeries(plan, actionContext) {
  const { createScheduleBooking } = require('../../routes/admin-schedule');
  let booking;
  try {
    // creditFreeCard: the card showed no inspection credit; the handler
    // re-checks under the credit lock and stamps the booking credit-free.
    booking = await createScheduleBooking({ body: scheduleBody(plan), actor: await actorFor(actionContext), creditFreeCard: true });
  } catch (err) {
    logger.error(`[intelligence-bar] start_program booking threw for customer ${plan.customerId}: ${err.message}`);
    return { result: {
      outcome_unknown: true,
      error: `The booking step failed with an unexpected error (${err.message}). Check this customer on the Schedule screen before trying again. The tier and the monthly bill were NOT changed.`,
    } };
  }
  if (booking.status !== 201) {
    const body = booking.json || {};
    return { result: {
      error: `The Schedule screen refused the booking: ${body.error || `status ${booking.status}`}. Nothing was booked and nothing else changed.`,
      ...(body.code ? { code: body.code } : {}),
      ...(body.code === 'INSPECTION_CREDIT_CHANGED' ? { preview_changed: true } : {}),
      nothing_changed: true,
    } };
  }
  return booking;
}

// The handler queues its texts after it replies (setImmediate), so the
// receipt says queued, never sent.
function receiptTexts(plan) {
  const confirmation = plan.sendTexts
    ? ' Booking confirmation queued (sent shortly by text or email per their settings; a failure is logged).'
    : ' No booking confirmation (send texts was off).';
  const welcome = plan.welcomeCandidate
    ? ' Welcome text and welcome email queued for about 1 hour from now (a failure is logged).'
    : '';
  return `${confirmation}${welcome}`;
}

async function commitProgram(input, actionContext) {
  const approved = typeof input._verified_program_version === 'string' ? input._verified_program_version : null;
  if (!approved) {
    return { error: 'This program start has no approved card. Ask again for a fresh confirmation card.', preview_changed: true };
  }
  const built = await buildProgramPlan(input);
  if (built.error) return { ...built, preview_changed: true };
  const { plan } = built;
  if (plan.version !== approved) {
    return { error: 'What this program start would do changed after the card was shown (customer, bill, tier, technician, time or texts). Nothing was booked. Ask again for a fresh card.', preview_changed: true };
  }

  // Step 1: the series, through the Schedule screen's own handler.
  const booking = await bookSeries(plan, actionContext);
  if (booking.result) return booking.result;
  const created = booking.json || {};
  const booked = {
    series_id: created.id,
    visits_booked: created.recurringCreated,
    first_visit: plan.firstDate,
    dates: (created.appointments || []).map((a) => a.date),
  };
  const warnings = Array.isArray(created.warnings) ? created.warnings : [];

  // Fewer visits than the card promised (blackout days, closed weekdays):
  // the program is not what was approved, so the tier and bill stay as they
  // are and the receipt names the shortfall.
  const planned = ONGOING_PRESEED;
  const createdCount = Number(created.recurringCreated) || 0;
  if (createdCount < planned) {
    const state = await customerStateAfterBooking(plan.customerId);
    return partialReceipt(plan, booked, state,
      `the Schedule screen booked ${createdCount} of the ${planned} visits on the card${warnings.length ? ` (${warnings.join(' ')})` : ''}. Add the missing visits on the Schedule screen (check days off and blackout dates), then set the tier and bill with update_customer`);
  }

  // Step 2: tier + bill, one transaction.
  try {
    await applyTierAndBill(plan);
  } catch (err) {
    logger.error(`[intelligence-bar] start_program tier/bill step failed for customer ${plan.customerId} after booking ${created.id}: ${err.message}`);
    const state = await customerStateAfterBooking(plan.customerId);
    return partialReceipt(plan, booked, state,
      `${err.drift ? err.message : `the update failed (${err.code || err.message})`} Set them with update_customer, or cancel the series on the Schedule screen`);
  }
  logger.info(`[intelligence-bar] start_program: customer ${plan.customerId}, series ${created.id}, ${plan.family} ${money(plan.bill.newLine)}, tier ${plan.tier}`);
  return {
    success: true,
    series_booked: booked,
    tier: { before: plan.tierBefore, after: plan.tier },
    monthly_bill: { before: plan.bill.totalBefore, after: plan.bill.totalAfter },
    ...(warnings.length ? { booking_warnings: warnings } : {}),
    next_step: `Offer to optimize ${plan.tech.name}'s route on ${plan.firstDate} with optimize_tech_route (its own card).`,
    message: `Program started: ${created.recurringCreated} visit(s) booked, first on ${dateLabel(plan.firstDate)}; tier ${plan.tier}; monthly bill ${money(plan.bill.totalBefore)} -> ${money(plan.bill.totalAfter)}.${receiptTexts(plan)}`,
  };
}

async function startProgram(input, actionContext = {}) {
  if (!startProgramLive()) {
    return { error: 'Starting a program from the Intelligence Bar is not enabled (GATE_IB_START_PROGRAM). Use the Schedule screen and the customer profile.', code: 'gate_off' };
  }
  // ONLY the server-derived context confirms (same rule as merge_customers).
  if (actionContext.confirmed !== true) {
    const built = await buildProgramPlan(input);
    if (built.error) return built;
    return previewFromPlan(built.plan);
  }
  return commitProgram(input, actionContext);
}

const START_PROGRAM_TOOL = {
  name: 'start_program',
  description: `Start a recurring service program for an EXISTING customer who already pays a monthly plan bill, in one confirm card: books the recurring series (through the Schedule screen's own booking), sets the WaveGuard tier, and adds the new service to the monthly bill. Use for: "she's moving forward on lawn care, 12 times a year at $61.33, mark her Silver and schedule the first treatment".
Before you call it:
- 12 times a year = cadence monthly; 4 = quarterly; 6 = bimonthly.
- If the customer has other monthly services, ask the operator once per service: "Also apply <tier> to <service>? Today $X. If yes, what is the new monthly price?" Put only the yes answers in reprice_lines with the price the operator gave. Never work out a discounted price yourself.
- send_texts defaults to true (the Schedule screen's booking confirmation). Set it false only when the operator says not to text.
- technician and time_window are required. Route optimization is NOT part of this tool; after it succeeds, offer optimize_tech_route as a second card.
Ongoing programs only (no visit count). Refuses: a customer who is not on a monthly plan bill, open inspection credit (book from the Schedule screen), more than one saved address, an open estimate for the service (mark the estimate accepted on the estimate page), a service already on the bill or already running as a series, and a monthly_total below the other services. The first call returns a PREVIEW; nothing changes until the operator confirms the card.`,
  input_schema: {
    type: 'object',
    properties: {
      customer_id: { type: 'string', format: 'uuid', description: 'The customer the program is for' },
      service: { type: 'string', description: 'Catalog service name for the program, for example "Lawn Care"' },
      cadence: { type: 'string', enum: Object.keys(CADENCES), description: 'How often the visits repeat' },
      monthly: { type: 'number', description: 'The new service\'s monthly price, as the operator stated it' },
      monthly_total: { type: 'number', description: 'Instead of monthly: the new WHOLE monthly bill the operator stated' },
      tier: { type: 'string', enum: TIERS, description: 'The WaveGuard tier to set' },
      first_date: { type: 'string', description: 'First visit date, YYYY-MM-DD' },
      time_window: { type: 'string', description: 'First visit start: "morning", "afternoon", or a time on the hour like "9:00 AM"' },
      technician_name: { type: 'string', description: 'Technician for the visits' },
      technician_id: { type: 'string', format: 'uuid', description: 'Technician id, from an earlier ambiguity result' },
      reprice_lines: {
        type: 'array',
        description: 'Other monthly services the operator said YES to repricing for the new tier, each with the new monthly price the operator gave',
        items: {
          type: 'object',
          properties: { service: { type: 'string' }, monthly: { type: 'number' } },
          required: ['service', 'monthly'],
        },
      },
      send_texts: { type: 'boolean', description: 'Send the Schedule screen\'s booking confirmation (default true)' },
    },
    required: ['customer_id', 'service', 'cadence', 'tier', 'first_date', 'time_window'],
    additionalProperties: false,
  },
};

module.exports = {
  START_PROGRAM_TOOL,
  startProgram,
  startProgramLive,
  _test: { planBill, scheduleBody, cardLines, buildProgramPlan, applyTierAndBill },
};
