'use strict';

/**
 * Portal "Your yard this month" card (GATE_PORTAL_YARD_CALENDAR, PR 3 of the
 * SWFL yard pressure calendar). One read model for GET /api/feed/yard:
 *
 *   - the month's yard calendar (landscape-calendar.js) cut to the customer's
 *     grass, only the entries in season (level 2 Peak / 3 In season), plus a
 *     count of lawn entries hidden because they belong to other grasses;
 *   - the customer's plan lines, from the same ownership loader the Property
 *     Score uses (loadOwnedRecurringServiceKeys), so the card never claims a
 *     service the customer does not have;
 *   - the household-pest forecast for the weather route's resolved city, each
 *     pest tagged with the service line that covers it;
 *   - the last completed lawn visit and its service-report link.
 *
 * Nothing here writes, sends or asks an LLM. Every reader degrades on its own
 * (a failed lookup drops that block, never the card).
 */

const db = require('../models/db');
const logger = require('./logger');
const { buildYardCalendar } = require('./pest-forecast/landscape-calendar');
const { getForecast } = require('./pest-forecast/forecast');
const { loadOwnedRecurringServiceKeys } = require('./waveguard-existing-services');
const { loadCustomerGrassContext } = require('./lawn-grass-context');
const { applyPropertyPredicate, isSecondarySelection } = require('./account-properties');
const { etParts } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { detectServiceLine } = require('./service-report/service-line-configs');

// How many recent completions the last-lawn-visit lookup scans.
const LAWN_VISIT_SCAN = 100;

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

// customer_turf_profiles.grass_type (and the canonical loader's fallback from
// customers.lawn_type) onto the calendar's grass keys. mixed / unknown /
// anything else shows every grass.
const GRASS_KEYS = { st_augustine: 'sta', bahia: 'bah', zoysia: 'zoy', bermuda: 'ber' };
const GRASS_LABELS = { sta: 'St. Augustine', bah: 'Bahia', zoy: 'Zoysia', ber: 'Bermuda' };

// loadOwnedRecurringServiceKeys vocabulary onto the card's plan lines.
// rodent_bait is the ownership family for recurring rodent bait monitoring,
// which the combined "Pest & Rodent Control" plan also carries.
const PLAN_KEY_TO_LINE = {
  pest_control: 'pest',
  lawn_care: 'lawn',
  tree_shrub: 'treeShrub',
  mosquito: 'mosquito',
  rodent_bait: 'rodent',
  termite_bait: 'termite',
  termite_foam: 'termite',
};

// Forecast pest keys (pest-forecast/pests.js) onto the service line that
// covers them. Mosquito and rodent service are separate lines from general
// pest control, so a pest-only customer sees them as "not in your plan".
// German-roach cleanouts and fleas are separate specialty services unless
// expressly included (estimate-service-details.js), so no plan line claims
// them: they always list as "not in your plan".
const PEST_LINE = {
  ants: 'pest',
  german_roach: 'specialty',
  palmetto_roach: 'pest',
  fleas_ticks: 'specialty',
  wasps: 'pest',
  mosquitoes: 'mosquito',
  rodents: 'rodent',
  subterranean_termites: 'termite',
};

// The forecast's own "moderate" floor (score10 >= 4): below it a pest is not
// worth a row on the card.
const HOME_PEST_MIN_SCORE10 = 4;

function emptyPlan() {
  return { lawn: false, pest: false, treeShrub: false, mosquito: false, rodent: false, termite: false };
}

// The selected property's own plan lines. A multi-property (scoped) session
// reads ownership only for rows at THAT property's street (the estimate
// pricing's per-property scope, strict locality), so a plan at one house is
// never "in your plan" at another. A scoped property with no readable
// street, or a closed scope with no property at all, claims nothing.
async function propertyStreetScope(customerId, scope, knex) {
  if (!scope || !scope.scoped) return null;
  // Scoped with no property (every saved property retired, closed:true):
  // nothing here can be "in your plan".
  if (!scope.property) return { unreadable: true };
  const { normalizedStampedStreet } = require('./estimate-property-linkage');
  const p = scope.property;
  const estimateStreet = normalizedStampedStreet(p.address_line1, p.address_line2, p.city, p.zip);
  if (!estimateStreet) return { unreadable: true };
  const cust = await knex('customers').where({ id: customerId }).first('address_line1', 'address_line2', 'city', 'zip');
  const customerPrimaryStreet = normalizedStampedStreet(cust?.address_line1, cust?.address_line2, cust?.city, cust?.zip);
  return { estimateStreet, customerPrimaryStreet, requireSharedLocality: true };
}

async function loadPlan(customerId, knex, scope = null) {
  const plan = emptyPlan();
  try {
    const streetScope = await propertyStreetScope(customerId, scope, knex);
    if (streetScope?.unreadable) return plan;
    const keys = await loadOwnedRecurringServiceKeys(knex, customerId, { streetScope });
    for (const key of keys) {
      const line = PLAN_KEY_TO_LINE[key];
      if (line) plan[line] = true;
    }
  } catch (err) {
    // Fails closed: no plan lines means no "in your plan" claim anywhere.
    logger.warn(`[portal-yard-card] plan lookup failed for ${customerId}: ${err.message}`);
  }
  return plan;
}

// customer_turf_profiles is 1:1 with the customer (no property_id), so a
// SECONDARY saved property has no grass of its own: show every grass rather
// than the primary house's (same call photo-id makes for its grass context).
async function loadGrass(customerId, scope, knex) {
  if (isSecondarySelection(scope)) return { key: 'all', known: false, label: null };
  try {
    const ctx = await loadCustomerGrassContext(customerId, knex);
    const key = GRASS_KEYS[ctx.grassType];
    if (key) return { key, known: true, label: GRASS_LABELS[key] };
  } catch (err) {
    logger.warn(`[portal-yard-card] grass lookup failed for ${customerId}: ${err.message}`);
  }
  return { key: 'all', known: false, label: null };
}

function cardItem(item) {
  return {
    id: item.id,
    category: item.category,
    name: item.name,
    hosts: item.hosts,
    level: item.level,
    levelLabel: item.levelLabel,
    sign: item.sign,
    infoOnly: item.infoOnly === true,
  };
}

// In-season only (level 2 and 3), peak first, info-only entries after the
// ones Waves can act on, catalog order within a tier.
function inSeasonItems(calendar) {
  return calendar.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.level >= 2)
    .sort((a, b) => (b.item.level - a.item.level)
      || ((a.item.infoOnly ? 1 : 0) - (b.item.infoOnly ? 1 : 0))
      || (a.index - b.index))
    .map(({ item }) => cardItem(item));
}

function countInSeasonLawn(calendar) {
  return calendar.items.filter((i) => i.category === 'lawn' && i.level >= 2).length;
}

async function loadHomePests(place, plan) {
  try {
    const forecast = await getForecast({ location: place.slug });
    return (forecast.pests || [])
      .filter((p) => Number(p.score10) >= HOME_PEST_MIN_SCORE10)
      .map((p) => {
        const line = PEST_LINE[p.key] || 'pest';
        return {
          key: p.key,
          label: p.label,
          score10: p.score10,
          level: p.level,
          note: p.note,
          line,
          inPlan: plan[line] === true,
        };
      })
      // Termite stays off every non-owned surface (owner ruling 2026-09-28:
      // termite is not an upsell line); an owner still sees it.
      .filter((p) => p.line !== 'termite' || p.inPlan);
  } catch (err) {
    logger.warn(`[portal-yard-card] home pest forecast unavailable for ${place.slug}: ${err.message}`);
    return [];
  }
}

function parseNotes(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Last completed lawn visit for the selected house, with the same report-link
// rule GET /api/services uses: `/report/<token>`, never for a project
// completion and never for a typed completion held in internal-only shadow.
async function loadLastLawnVisit(customerId, scope, knex) {
  try {
    // Lawn by the canonical service line, falling back to the label the way
    // every runtime reader does (detectServiceLine), so legacy labels such as
    // "Fertilization" or "Chinch Bug" count. Recent completions are scanned
    // newest first; the first lawn one is the visit.
    let query = knex('service_records')
      .leftJoin('scheduled_services', 'service_records.scheduled_service_id', 'scheduled_services.id')
      .where({ 'service_records.customer_id': customerId, 'service_records.status': 'completed' })
      .select(
        'service_records.id',
        'service_records.service_date',
        'service_records.service_line',
        'service_records.service_type',
        'service_records.report_view_token',
        'service_records.structured_notes',
        'service_records.completion_source',
      )
      .orderBy('service_records.service_date', 'desc')
      .orderBy('service_records.id', 'desc')
      .limit(LAWN_VISIT_SCAN);
    if (scope && scope.enabled && scope.scoped) {
      // A record without a visit (property_id NULL) belongs to the primary,
      // like an unstamped visit; "every house retired" matches nothing.
      query = scope.closed || !scope.property
        ? query.whereRaw('1 = 0')
        : applyPropertyPredicate(query, scope, 'scheduled_services');
    }
    const rows = await query;
    const row = (rows || []).find((r) => (r.service_line || detectServiceLine(r.service_type)) === 'lawn');
    if (!row) return null;
    const notes = parseNotes(row.structured_notes);
    const isProject = row.completion_source === 'project_completion' || notes.projectCompletion === true;
    const heldInternal = Boolean(notes.typedReportDelivery) && notes.typedReportDelivery !== 'auto_send';
    return {
      date: dateOnlyString(row.service_date),
      reportUrl: !isProject && !heldInternal && row.report_view_token ? `/report/${row.report_view_token}` : null,
    };
  } catch (err) {
    logger.warn(`[portal-yard-card] last lawn visit lookup failed for ${customerId}: ${err.message}`);
    return null;
  }
}

/**
 * @param {object} args
 * @param {string} args.customerId
 * @param {object} args.place   resolved forecast location (slug, label)
 * @param {object|null} args.scope  resolveSessionScope() result for the session
 * @param {Date} [args.now]
 */
async function buildYardCard({ customerId, place, scope = null, now = new Date(), knex = db }) {
  const month = etParts(now).month;
  // The pest list tags each pest with inPlan, so the plan loads first.
  const plan = await loadPlan(customerId, knex, scope);
  const [grass, homePests, lastLawnVisit] = await Promise.all([
    loadGrass(customerId, scope, knex),
    loadHomePests(place, plan),
    loadLastLawnVisit(customerId, scope, knex),
  ]);

  const calendar = buildYardCalendar({ month, grass: grass.key });
  const everyGrass = grass.key === 'all' ? calendar : buildYardCalendar({ month, grass: 'all' });

  return {
    month,
    monthName: MONTH_NAMES[month - 1],
    location: { slug: place.slug, label: place.label, city: String(place.label || '').replace(/,\s*FL$/, '') },
    plan,
    grass,
    reviewedAt: calendar.reviewedAt,
    items: inSeasonItems(calendar),
    hiddenCount: Math.max(0, countInSeasonLawn(everyGrass) - countInSeasonLawn(calendar)),
    homePests,
    lastLawnVisit,
  };
}

module.exports = { buildYardCard, _test: { PEST_LINE, GRASS_KEYS, loadPlan } };
