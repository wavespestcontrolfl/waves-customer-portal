/**
 * Tree & Shrub Fast Complete — what the one-screen completion sheet loads
 * (GET /:serviceId/tree-shrub/fast-context, GATE_TS_FAST_COMPLETE).
 *
 * Read-only. The sheet submits through the existing full /complete path with
 * tree_shrub structuredFindings, so every compliance rule still runs there;
 * this only assembles suggestions and warnings:
 *   - month products are SUGGESTIONS (nothing is assumed applied); an amount is
 *     pre-filled ONLY from the last actual amount recorded for that product at
 *     this property, else left blank — never rate x tank (owner 2026-10-01);
 *   - the rotation / palm-spacing warnings replace the tech's manual IRAC/FRAC
 *     lookup and never block.
 */
const db = require('../models/db');
const logger = require('./logger');
const { resolveEligibility, recapServiceIdentity, loadRecapCatalogProducts } = require('./pest-recap');
const { resolveMonthProducts } = require('./tree-shrub-month-products');
const {
  inferTreeShrubOrdinanceZone,
  isSummerBlackoutForZone,
  productHasNpFertilizer,
  isInsectFamilyProduct,
  productNeedsIracFracLog,
  isInjectionProduct,
  deriveTreeShrubTreatments,
} = require('./tree-shrub-closeout');
const { etCalendarDayOf } = require('../utils/datetime-et');
const PhotoService = require('./photos');
const { normalizeTreeShrubPhotoSlot } = require('../config/tree-shrub-photo-slots');

const ROTATION_WINDOW_DAYS = 60;
// Palm spacing = the shared three-calendar-month rule (owner program, #5089).
const { palmFeedingTooSoon, PALM_SPACING_LOOKBACK_DAYS: PALM_FERTILIZER_SPACING_DAYS } = require('./tree-shrub-completion-defaults');
const HISTORY_RECORD_LIMIT = 12;
// Same lifetime the tech portal's own photo list signs for (tech-track GET /:id/photos).
const LAST_PHOTO_URL_TTL_SECONDS = 3600;
// 'rescheduled' is the phantom row a legacy customer reschedule leaves behind
// (both schedule feeds hide it); /complete does not refuse it, so this does.
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show', 'incomplete', 'rescheduled']);

// Classifier inputs the shared catalog list does not carry.
// Every catalog field the closeout classifiers read, so these flags match what
// /complete (which loads the full row) decides.
const CLASSIFIER_COLUMNS = [
  'irac_group', 'frac_group', 'hrac_group', 'hrac_group_secondary',
  'analysis_n', 'analysis_p', 'fertilizer_analysis', 'product_type',
];

const dayNumber = (day) => {
  const [y, m, d] = String(day).split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
};
const daysBetween = (laterDay, earlierDay) => Math.round(dayNumber(laterDay) - dayNumber(earlierDay));

// The server-computed flags the sheet needs per catalog product, from the SAME
// classifiers /complete enforces (tree-shrub-closeout.js), so the sheet's
// prompts can never disagree with the closeout's blocks.
function treeShrubProductFlags(row, { serviceDate, zone }) {
  const ref = { catalog: row };
  return {
    insectFamily: isInsectFamilyProduct(ref),
    needsIracFrac: productNeedsIracFracLog(ref),
    npBlackout: productHasNpFertilizer(ref) && isSummerBlackoutForZone(serviceDate, zone),
    injection: isInjectionProduct(ref),
  };
}

// Why this visit cannot use the sheet, or null. Mirrors pest-recap's
// resolveEligibility, plus the T&S-specific /complete paths the sheet does not
// cover: companion sections (the retired lawn+T&S combo) and grouped visits.
async function treeShrubFastIneligibleReason(svc, profile, knex) {
  if (!profile) return 'profile_unavailable';
  if (profile.findingsType !== 'tree_shrub') return 'not_tree_shrub';
  if (profile.projectBacked || profile.requiresProject) return 'project_backed';
  if (Array.isArray(profile.companions) && profile.companions.length) return 'has_companions';
  if (svc.visit_id) {
    // An orphaned pointer blocks too: dissolution NULLs child visit_id, so a
    // missing visit row means something is mid-flight (same rule as
    // /completion-status).
    const visit = await knex('service_visits').where({ id: svc.visit_id }).first('status');
    if (!visit || String(visit.status || '') !== 'dissolved') return 'grouped_visit';
  }
  if (TERMINAL_STATUSES.has(String(svc.status || ''))) return 'terminal_status';
  return null;
}

// The comma-joined multi_select a typed snapshot freezes ("Palms, Shrubs").
function splitChips(value) {
  const parts = Array.isArray(value) ? value : String(value ?? '').split(',');
  return parts.map((part) => String(part).trim()).filter(Boolean);
}

const positiveOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// An amount unit, or null for a per-area rate unit ("lb/1000sf", which the
// completion writer can store when no amount unit was sent): a rate is not an
// amount applied, so it never pre-fills (pest-recap's common-products rule).
const quantityUnit = (unit) => {
  const value = String(unit || '').trim();
  return value && !value.includes('/') ? value : null;
};

/**
 * This customer's recent completed T&S records at THIS property (newest
 * first) and their recorded products. records[0] is the last visit; a product
 * missing from it (Snapshot is quarterly) still carries its own last amount
 * from an earlier record. A record with no scheduled_service_id has no
 * property link and is not counted.
 */
async function loadTreeShrubHistory(svc, knex, visitDate) {
  // An unresolved property proves nothing about which address a past visit
  // was at (a multi-property account), so it pre-fills nothing.
  if (!svc.property_id) return [];
  const records = await knex('service_records as sr')
    .join('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('sr.customer_id', svc.customer_id)
    // An incomplete visit's recorded products were physically applied, so they
    // count for amounts; only a completed record can be the last visit.
    .whereIn('sr.status', ['completed', 'incomplete'])
    .where('sr.service_line', 'tree_shrub')
    // Never a visit after this one (an older visit closed out late).
    .where('sr.service_date', '<=', visitDate)
    .whereNot('sr.scheduled_service_id', svc.id)
    .where('ss.property_id', svc.property_id)
    .orderBy('sr.service_date', 'desc')
    .orderBy('sr.created_at', 'desc')
    .orderBy('sr.id', 'desc')
    .limit(HISTORY_RECORD_LIMIT)
    .select('sr.id', 'sr.status', 'sr.service_date', knex.raw("sr.service_data #> '{typedReportSnapshot,values}' as typed_values"));
  if (!records.length) return [];
  const products = await knex('service_products')
    .whereIn('service_record_id', records.map((r) => r.id))
    .orderBy('created_at')
    .select('service_record_id', 'product_id', 'product_name', 'total_amount', 'amount_unit');
  return records.map((record) => ({
    ...record,
    products: products.filter((p) => p.service_record_id === record.id),
  }));
}

function buildLastVisit(history) {
  const last = history.find((record) => record.status === 'completed');
  if (!last) return null;
  const typed = last.typed_values && typeof last.typed_values === 'object' ? last.typed_values : {};
  return {
    serviceRecordId: last.id,
    serviceDate: etCalendarDayOf(last.service_date),
    plantGroups: splitChips(typed.plant_groups),
    areasTreated: splitChips(typed.areas_treated),
    products: last.products.map((p) => ({
      productId: p.product_id ?? null,
      productName: p.product_name,
      totalAmount: quantityUnit(p.amount_unit) ? positiveOrNull(p.total_amount) : null,
      amountUnit: quantityUnit(p.amount_unit),
    })),
  };
}

function slotOfAiTags(aiTags) {
  let tags = aiTags;
  if (typeof tags === 'string') {
    try { tags = JSON.parse(tags); } catch { return null; }
  }
  return tags && typeof tags === 'object' && !Array.isArray(tags) ? normalizeTreeShrubPhotoSlot(tags.slot) : null;
}

/**
 * Last visit's photo per slot: { [slotKey]: { url, takenAt } }. Reads only the
 * last COMPLETED record from loadTreeShrubHistory (so it inherits that read's
 * property scoping and visit-date bound), and only photos whose ai_tags carry
 * a known slot key. A full-form visit's photos carry none, so they never show
 * as "last time" for a slot. The URL is a short-lived presigned view URL, never
 * a raw key. Any failure answers {} (the sheet then shows no thumbnails).
 */
async function loadLastVisitPhotos(history, knex, serviceId) {
  try {
    const last = history.find((record) => record.status === 'completed');
    if (!last) return {};
    const rows = await knex('service_photos')
      .where('service_record_id', last.id)
      .whereNotNull('ai_tags')
      .orderBy('captured_at', 'desc')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .select('id', 's3_key', 'ai_tags', 'captured_at', 'created_at');
    // Newest first, so the first photo seen for a slot is the one to show.
    const bySlot = new Map();
    for (const row of rows) {
      const slot = slotOfAiTags(row.ai_tags);
      if (slot && row.s3_key && !bySlot.has(slot)) bySlot.set(slot, row);
    }
    const out = {};
    for (const [slot, row] of bySlot) {
      const takenAt = row.captured_at || row.created_at;
      // One photo that will not sign loses only its own thumbnail.
      try {
        out[slot] = {
          url: await PhotoService.getViewUrl(row.s3_key, LAST_PHOTO_URL_TTL_SECONDS),
          takenAt: takenAt ? new Date(takenAt).toISOString() : null,
        };
      } catch (err) {
        logger.warn(`[ts-fast-context] last visit photo not signed for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
      }
    }
    return out;
  } catch (err) {
    // No driver message: it can echo SQL and bound values.
    logger.warn(`[ts-fast-context] last visit photos unavailable for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
    return {};
  }
}

// Most recent ACTUAL amount (positive, with a unit) per catalog product.
function lastAmountsByProduct(history) {
  const byProduct = new Map();
  for (const record of history) {
    for (const p of record.products) {
      const totalAmount = positiveOrNull(p.total_amount);
      const amountUnit = quantityUnit(p.amount_unit);
      if (!p.product_id || !totalAmount || !amountUnit || byProduct.has(String(p.product_id))) continue;
      byProduct.set(String(p.product_id), { totalAmount, amountUnit, serviceDate: etCalendarDayOf(record.service_date) });
    }
  }
  return byProduct;
}

// The generic moa_group column carries no family ("Group 3" is a FRAC DMI on
// Headway and an HRAC code on Snapshot), so its family comes from the
// product's category; an unknown category stays 'moa' and matches any family.
function moaFamily(category) {
  const c = String(category || '').toLowerCase();
  if (/insect|miticide|igr|acaricide/.test(c)) return 'irac';
  if (/fungicide/.test(c)) return 'frac';
  if (/herbicide/.test(c)) return 'hrac';
  return 'moa';
}

// Every individual resistance group a product carries, family-qualified.
// Combination products list several ("28+4A", "Group 11 + 3"), and a
// rotation conflict is ANY shared group, so each is its own entry. The
// explicit IRAC/FRAC/HRAC columns win over the generic moa_group.
function resistanceGroups(row) {
  // Combination herbicides keep their second mode in hrac_group_secondary
  // (Celsius 2+4, Dismiss 14+2).
  const explicit = [['irac', row.irac_group], ['frac', row.frac_group], ['hrac', row.hrac_group], ['hrac', row.hrac_group_secondary]]
    .filter(([, raw]) => String(raw || '').trim());
  const sources = explicit.length ? explicit : [[moaFamily(row.category), row.moa_group]];
  const groups = [];
  for (const [family, raw] of sources) {
    for (const part of String(raw || '').replace(/group/gi, '').split(/[+,/&]|\band\b/i)) {
      const code = part.trim().replace(/\s+/g, '').toUpperCase();
      if (code && !groups.some((g) => g.family === family && g.code === code)) groups.push({ family, code });
    }
  }
  return groups;
}

const sameGroup = (a, b) => a.code === b.code && (a.family === b.family || a.family === 'moa' || b.family === 'moa');
const groupLabel = (g) => `${g.family === 'moa' ? 'MOA' : g.family.toUpperCase()} ${g.code}`;

// A ledger row with no catalog id is classified from its recorded name and
// category under a stand-in id.
const isPalmFertilizer = (row) => !!(row.id || row.name) && deriveTreeShrubTreatments({
  products: [{ productId: row.id || 'unlinked' }],
  productRows: [{ ...row, id: row.id || 'unlinked' }],
}).split(',').map((s) => s.trim()).includes('Palm fertilizer');

/**
 * Rotation + palm-fertilizer-spacing warnings for catalog candidates.
 * `applications` are this property's recent property_application_history rows
 * joined to their catalog row ({ application_date, product_id, product_name,
 * category, active_ingredient, irac_group, frac_group, moa_group, analysis_n,
 * analysis_p, history_moa_group }); a row with no catalog row falls back to its
 * own recorded moa_group. Warnings only — one per candidate product, naming the
 * most recent matching application.
 */
function buildTreeShrubWarnings({ catalogRows, applications, visitDate }) {
  const dated = applications
    .map((app) => ({ app, daysAgo: daysBetween(visitDate, etCalendarDayOf(app.application_date)) }))
    .filter((entry) => entry.daysAgo >= 0)
    .sort((a, b) => a.daysAgo - b.daysAgo);
  // Newest first, so the first entry sharing a group is the one to name.
  const rotationEntries = [];
  let palmApplication = null;
  for (const entry of dated) {
    if (entry.daysAgo <= ROTATION_WINDOW_DAYS) {
      const groups = resistanceGroups({ ...entry.app, moa_group: entry.app.moa_group ?? entry.app.history_moa_group });
      if (groups.length) rotationEntries.push({ entry, groups });
    }
    if (!palmApplication && palmFeedingTooSoon(entry.app.application_date, visitDate) && isPalmFertilizer({ ...entry.app, id: entry.app.product_id, name: entry.app.product_name })) palmApplication = entry;
  }
  const warnings = [];
  for (const row of catalogRows) {
    const candidateGroups = resistanceGroups(row);
    let rotation = null;
    let shared = [];
    for (const { entry, groups } of rotationEntries) {
      shared = candidateGroups.filter((g) => groups.some((h) => sameGroup(g, h)));
      if (shared.length) { rotation = entry; break; }
    }
    if (rotation) {
      warnings.push({
        type: 'rotation',
        productId: row.id,
        productName: row.name,
        group: shared.map(groupLabel).join(', '),
        daysAgo: rotation.daysAgo,
        appliedProductName: rotation.app.product_name || null,
        appliedOn: etCalendarDayOf(rotation.app.application_date),
      });
    }
    if (palmApplication && isPalmFertilizer(row)) {
      warnings.push({
        type: 'palm_fertilizer_spacing',
        productId: row.id,
        productName: row.name,
        windowDays: PALM_FERTILIZER_SPACING_DAYS,
        daysAgo: palmApplication.daysAgo,
        appliedProductName: palmApplication.app.product_name || null,
        appliedOn: etCalendarDayOf(palmApplication.app.application_date),
      });
    }
  }
  return warnings;
}

// The ledger has no property column: scope through the record's visit, and keep
// rows whose property cannot be determined (more warnings, never fewer).
async function loadRecentApplications(svc, visitDate, knex) {
  const since = new Date((dayNumber(visitDate) - PALM_FERTILIZER_SPACING_DAYS) * 86400000).toISOString().slice(0, 10);
  const query = knex('property_application_history as pah')
    .leftJoin('products_catalog as pc', 'pc.id', 'pah.product_id')
    // A row with no catalog link still names its product through the
    // completion's service_products row.
    .leftJoin('service_products as sp', 'sp.id', 'pah.service_product_id')
    .leftJoin('service_records as sr', 'sr.id', 'pah.service_record_id')
    .leftJoin('scheduled_services as ss', 'ss.id', 'sr.scheduled_service_id')
    .where('pah.customer_id', svc.customer_id)
    .whereNull('pah.retracted_at')
    .where('pah.application_date', '>=', since)
    .where((q) => q.whereNull('ss.id').orWhereNot('ss.id', svc.id));
  if (svc.property_id) query.where((q) => q.whereNull('ss.property_id').orWhere('ss.property_id', svc.property_id));
  return query.select(
    'pah.application_date', 'pah.product_id', 'pah.moa_group as history_moa_group',
    knex.raw('COALESCE(pc.name, sp.product_name) as product_name'),
    knex.raw('COALESCE(pc.active_ingredient, sp.active_ingredient, pah.active_ingredient) as active_ingredient'),
    // A ledger row with no catalog link keeps its own recorded category, so
    // its moa_group still resolves to the right family.
    knex.raw('COALESCE(pc.category, sp.product_category, pah.category) as category'),
    'pc.irac_group', 'pc.frac_group', 'pc.hrac_group', 'pc.hrac_group_secondary', 'pc.moa_group', 'pc.analysis_n', 'pc.analysis_p',
  );
}

/**
 * The sheet's context for one scheduled service. `{ ok: false, reason }` only
 * for a missing service; an ineligible visit answers `eligible: false` with the
 * reason and the visit identity, and skips the heavier reads.
 */
async function buildTreeShrubFastContext(serviceId, knex = db) {
  const { ok, reason, svc, profile } = await resolveEligibility(serviceId, knex);
  if (!ok) return { ok: false, reason };
  const service = recapServiceIdentity(svc, profile);
  const ineligibleReason = await treeShrubFastIneligibleReason(svc, profile, knex);
  if (ineligibleReason) return { ok: true, eligible: false, reason: ineligibleReason, service };

  const visitDate = etCalendarDayOf(svc.scheduled_date);
  // /complete's typed check infers the ordinance zone from the customer's
  // city, not the visit's stamped address. Where the two disagree (a
  // multi-property customer) the sheet can't be both right for the property
  // and consistent with the server, so the visit takes the full form.
  const zone = inferTreeShrubOrdinanceZone({ city: service.address?.city, address: service.address?.line1 });
  if (zone !== inferTreeShrubOrdinanceZone({ ...svc, city: svc.cust_city })) {
    return { ok: true, eligible: false, reason: 'zone_mismatch', service };
  }
  const catalog = await loadRecapCatalogProducts(knex, { extraColumns: CLASSIFIER_COLUMNS });
  // The shared loader turns a failed read into []. An empty catalog here would
  // let the sheet record a real application as "Inspection only" with none of
  // the product checks, so it sends the visit to the full form instead.
  if (!catalog.length) return { ok: true, eligible: false, reason: 'catalog_unavailable', service };
  const products = catalog.map((row) => ({ ...row, tsFlags: treeShrubProductFlags(row, { serviceDate: visitDate, zone }) }));

  let history = [];
  try {
    history = await loadTreeShrubHistory(svc, knex, visitDate);
  } catch (err) {
    // No driver message: it can echo SQL and bound values. A blank pre-fill is
    // the safe degradation.
    logger.warn(`[ts-fast-context] last visit unavailable for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
  }
  const lastAmounts = lastAmountsByProduct(history);
  const monthProducts = resolveMonthProducts(svc.scheduled_date, catalog).map((entry) => ({
    ...entry,
    ...(lastAmounts.has(String(entry.productId)) && { lastAmount: lastAmounts.get(String(entry.productId)) }),
  }));

  let warnings = [];
  let warningsUnavailable = false;
  try {
    warnings = buildTreeShrubWarnings({
      catalogRows: catalog,
      applications: await loadRecentApplications(svc, visitDate, knex),
      visitDate,
    });
  } catch (err) {
    warningsUnavailable = true;
    logger.warn(`[ts-fast-context] warnings unavailable for ${serviceId}: ${err?.code || err?.name || 'Error'}`);
  }

  return {
    ok: true,
    eligible: true,
    reason: null,
    service,
    products,
    monthProducts,
    lastVisit: buildLastVisit(history),
    lastVisitPhotos: await loadLastVisitPhotos(history, knex, serviceId),
    warnings,
    ...(warningsUnavailable && { warningsUnavailable: true }),
  };
}

module.exports = {
  ROTATION_WINDOW_DAYS,
  PALM_FERTILIZER_SPACING_DAYS,
  buildTreeShrubFastContext,
  treeShrubFastIneligibleReason,
  treeShrubProductFlags,
  buildTreeShrubWarnings,
  buildLastVisit,
  lastAmountsByProduct,
};
