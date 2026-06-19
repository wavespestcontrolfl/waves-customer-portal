/**
 * Newsletter audience profiles — service-line-aware segmentation.
 *
 * The "Agora play" primitive: derive, per newsletter subscriber, which Waves
 * service lines they already have (pest, lawn, mosquito, tree & shrub, termite,
 * rodent) so the composer can target cross-sell segments like
 * "has pest but not lawn" or "single-line member eligible to bundle".
 *
 * Why a JS service and not a SQL view:
 *   Service-line membership is NOT a column. It is classified from the free-text
 *   `scheduled_services.service_type` string. The canonical classifier already
 *   exists and is trusted by the estimator (`serviceKeysFromText` in
 *   estimate-service-lines.js). We reuse it here so there is ONE definition of
 *   "what is a lawn service" across the whole platform — a SQL view could not
 *   call that regex.
 *
 * Definition of "has a service line" (Adam, 2026-06-16):
 *   A customer "has" a line if it is part of their ACTIVE RECURRING services
 *   (their active WaveGuard membership). A one-off job does not make them
 *   "covered" — so they stay eligible for that line's cross-sell. This is the
 *   `recurringOnly` default below; flip it to inspect the looser definition.
 *
 * This module is READ-ONLY. It selects/derives; it never sends.
 */

// db + logger are required lazily inside buildProfiles so the pure
// classification/filter helpers can be imported (and unit-tested) without
// pulling in the database layer.
const { serviceKeysFromText, SERVICE_LINE_LABELS } = require('./estimate-service-lines');
// ONE definition of "active recurring coverage" platform-wide: a completed /
// cancelled / no_show / skipped / rescheduled scheduled_services row is NOT
// live coverage. Reuse the canonical set (this module imports no DB layer, so
// the pure helpers below stay unit-testable).
const { TERMINAL_STATUSES } = require('./waveguard-existing-services');

// The cross-sell universe we segment + promote on. `palm_injection` and the
// `commercial_*` variants are intentionally NOT in the consumer cross-sell set;
// palm work is folded into tree & shrub for "missing line" purposes.
const SELLABLE_LINES = ['pest', 'lawn', 'mosquito', 'tree_shrub', 'termite', 'rodent'];

// Map raw classifier keys -> the sellable line they count toward.
const LINE_ALIASES = {
  palm_injection: 'tree_shrub',
  commercial_pest: 'pest',
  commercial_lawn: 'lawn',
};

function normalizeLine(key) {
  if (!key) return null;
  const mapped = LINE_ALIASES[key] || key;
  return SELLABLE_LINES.includes(mapped) ? mapped : null;
}

/**
 * Collapse a set of scheduled_services rows for ONE customer into the set of
 * sellable service lines they hold. Pure — no I/O — so it is unit-testable.
 *
 * @param {Array<{service_type: string, status: string, is_recurring?: boolean}>} rows
 * @param {{ recurringOnly?: boolean }} opts
 * @returns {{ lines: string[], hasRecurring: boolean }}
 */
function linesFromScheduledServices(rows = [], { recurringOnly = true } = {}) {
  const lines = new Set();
  let hasRecurring = false;
  for (const row of rows) {
    if (!row) continue;
    if (TERMINAL_STATUSES.includes(String(row.status || '').toLowerCase())) continue;
    const recurring = row.is_recurring === true || row.is_recurring === 't' || row.is_recurring === 1;
    if (recurring) hasRecurring = true;
    if (recurringOnly && !recurring) continue;
    for (const key of serviceKeysFromText(row.service_type)) {
      const line = normalizeLine(key);
      if (line) lines.add(line);
    }
  }
  return { lines: Array.from(lines), hasRecurring };
}

function missingLines(heldLines = []) {
  const held = new Set(heldLines);
  return SELLABLE_LINES.filter((line) => !held.has(line));
}

function lifecycleStage(customer) {
  if (!customer) return 'lead';
  if (customer.service_paused_at) return 'paused_customer';
  if (customer.active === false || customer.active === 'f' || customer.active === 0) return 'inactive_customer';
  return 'active_customer';
}

/**
 * Build audience profiles for newsletter subscribers, joined to their customer
 * record and active recurring services.
 *
 * @param {object} opts
 * @param {boolean} [opts.recurringOnly=true]  see module header
 * @param {boolean} [opts.customersOnly=false] only subscribers linked to a customer
 * @returns {Promise<Array>} profile objects
 */
async function buildProfiles({ recurringOnly = true, customersOnly = false, failClosedOnServiceError = true } = {}) {
  const db = require('../models/db');
  const logger = require('./logger');

  // 1. Active subscribers (the owned list).
  const subscribers = await db('newsletter_subscribers')
    .where({ status: 'active' })
    .select('id', 'email', 'customer_id', 'region_zone', 'tags', 'first_name', 'last_name');

  const customerIds = [...new Set(subscribers.map((s) => s.customer_id).filter(Boolean))];

  // 2. Their customer records (membership status + tier).
  const customers = customerIds.length
    ? await db('customers')
        .whereIn('id', customerIds)
        .select('id', 'first_name', 'last_name', 'waveguard_tier', 'active', 'service_paused_at', 'city')
    : [];
  const customerById = new Map(customers.map((c) => [c.id, c]));

  // 3. Their scheduled services (the source of service-line membership).
  let scheduledByCustomer = new Map();
  if (customerIds.length) {
    try {
      const rows = await db('scheduled_services')
        .whereIn('customer_id', customerIds)
        .whereNotIn('status', TERMINAL_STATUSES)
        .select('customer_id', 'service_type', 'status', 'is_recurring');
      scheduledByCustomer = rows.reduce((map, row) => {
        const list = map.get(row.customer_id) || [];
        list.push(row);
        map.set(row.customer_id, list);
        return map;
      }, new Map());
    } catch (err) {
      logger.warn(`[newsletter-audience-profiles] scheduled_services query failed: ${err.message}`);
      // The send path (selectAudience → resolveSegmentCustomerIds) MUST fail
      // closed: an empty service map makes every customer look like they hold
      // zero lines, so a missing_service / max_line_count segment would match
      // nearly the whole list and broaden the blast. Refuse to build rather
      // than mis-target. Only the read-only preview opts into best-effort
      // (failClosedOnServiceError:false), where transient over-counting is
      // harmless because it sends nothing.
      if (failClosedOnServiceError) {
        throw new Error(
          `audience profiles: scheduled_services query failed — refusing to build a service-line audience that could broaden the send (${err.message})`,
        );
      }
    }
  }

  const profiles = [];
  for (const sub of subscribers) {
    const customer = sub.customer_id ? customerById.get(sub.customer_id) : null;
    if (customersOnly && !customer) continue;

    const { lines, hasRecurring } = linesFromScheduledServices(
      sub.customer_id ? scheduledByCustomer.get(sub.customer_id) || [] : [],
      { recurringOnly },
    );

    profiles.push({
      subscriber_id: sub.id,
      email: sub.email,
      first_name: sub.first_name || customer?.first_name || null,
      customer_id: sub.customer_id || null,
      is_customer: Boolean(customer),
      lifecycle_stage: customer ? lifecycleStage(customer) : 'lead',
      region_zone: sub.region_zone || null,
      waveguard_tier: customer?.waveguard_tier || null,
      tags: Array.isArray(sub.tags) ? sub.tags : [],
      has: SELLABLE_LINES.reduce((acc, line) => { acc[line] = lines.includes(line); return acc; }, {}),
      held_lines: lines,
      missing_lines: missingLines(lines),
      line_count: lines.length,
      has_recurring: hasRecurring,
    });
  }
  return profiles;
}

/**
 * segment_filter semantics. `null`/empty = everyone. Keys (all optional, AND-ed):
 *   audience:       'customers' | 'leads'
 *   region_zone:    string[]            (any-of)
 *   has_service:    string[]            (must hold ALL listed lines)
 *   missing_service:string[]            (must be MISSING ALL listed lines)
 *   waveguard_tier: string[]            (any-of, case-insensitive)
 *   min_line_count / max_line_count: number
 */
function matchesFilter(profile, filter) {
  if (!filter || typeof filter !== 'object') return true;
  const f = filter;

  if (f.audience === 'customers' && !profile.is_customer) return false;
  if (f.audience === 'leads' && profile.is_customer) return false;

  if (Array.isArray(f.region_zone) && f.region_zone.length
      && !f.region_zone.includes(profile.region_zone)) return false;

  // has/missing service lines must be known sellable lines. An unknown key
  // (typo like 'mosquitos') would otherwise read as has[key] === undefined →
  // "missing for everyone" and blast the wrong audience, so reject the profile
  // (fail closed → empty segment → blocked by the send-path EMPTY_SEGMENT guard).
  if (Array.isArray(f.has_service) && f.has_service.length) {
    if (!f.has_service.every((line) => SELLABLE_LINES.includes(line))) return false;
    if (!f.has_service.every((line) => profile.has[line])) return false;
  }

  if (Array.isArray(f.missing_service) && f.missing_service.length) {
    if (!f.missing_service.every((line) => SELLABLE_LINES.includes(line))) return false;
    if (!f.missing_service.every((line) => !profile.has[line])) return false;
  }

  if (Array.isArray(f.waveguard_tier) && f.waveguard_tier.length) {
    const tier = String(profile.waveguard_tier || '').toLowerCase();
    if (!f.waveguard_tier.map((t) => String(t).toLowerCase()).includes(tier)) return false;
  }

  if (Number.isFinite(f.min_line_count) && profile.line_count < f.min_line_count) return false;
  if (Number.isFinite(f.max_line_count) && profile.line_count > f.max_line_count) return false;

  return true;
}

async function selectAudience(filter, opts = {}) {
  const profiles = await buildProfiles(opts);
  return profiles.filter((p) => matchesFilter(p, filter));
}

module.exports = {
  SELLABLE_LINES,
  SERVICE_LINE_LABELS,
  linesFromScheduledServices,
  missingLines,
  buildProfiles,
  matchesFilter,
  selectAudience,
};
