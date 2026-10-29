/**
 * inventory-count-guard.js — keeps a physical count from being taken off twice.
 *
 * A physical count (a `correction` movement that sets or confirms the shelf
 * total) already includes every product use that happened before it. When a
 * visit done BEFORE the product's latest count is closed or back-filled
 * afterwards, taking its usage off inventory_on_hand drops the stock twice.
 * Under GATE_STOCK_COUNT_AWARE_USAGE the two usage writers
 * (deductProductInventory in complete-scheduled-service.js and the
 * per-completion consumables in supplies-consumption.js) ask this module
 * whether the visit predates the latest count. If so they still write the
 * usage movement (job costing and usage forecasts keep seeing the real use)
 * but leave stock_before = stock_after and do not touch products_catalog.
 *
 * Production has no "this is a physical count" flag on a movement, so
 * isCountCorrection() reads the source and reason that the count writers
 * leave in metadata.
 */
const { etCalendarDayOf, etDateString } = require('../utils/datetime-et');

const COUNT_SOURCES = new Set(['owner_count', 'owner_count_via_claude', 'admin_product_create']);
const COUNT_SOURCE_PREFIX = 'video_inventory_intake';
// Corrections that move stock for another reason. Checked first, so a stray
// setTotal or a reason that mentions "count" never makes them a count.
const NOT_COUNT_SOURCES = new Set(['siteone_invoice', 'amazon_delivery', 'inventory_unit_review_fix']);
const COUNT_REASON_RE = /\bcount\b|physical/i;
// How many recent corrections to read when looking for the newest count.
const RECENT_CORRECTIONS = 50;

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function validDate(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function sourceIsCount(source) {
  if (!source) return false;
  return COUNT_SOURCES.has(source) || source.startsWith(COUNT_SOURCE_PREFIX);
}

function isCountCorrection(movement) {
  if (!movement || movement.movement_type !== 'correction') return false;
  const meta = parseMetadata(movement.metadata);
  const source = typeof meta.source === 'string' ? meta.source : '';
  if (NOT_COUNT_SOURCES.has(source)) return false;
  if (validDate(meta.countedAt)) return true;
  if (sourceIsCount(source)) return true;
  return typeof meta.reason === 'string' && COUNT_REASON_RE.test(meta.reason);
}

// When the shelf was counted: metadata.countedAt when it parses, else the row's created_at.
function countTime(movement) {
  const counted = validDate(parseMetadata(movement?.metadata).countedAt);
  return counted || validDate(movement?.created_at);
}

// The product's newest count correction, or null when it has never been counted.
async function latestCount(conn, productId) {
  if (!productId) return null;
  const rows = await conn('product_inventory_movements')
    .where({ product_id: productId, movement_type: 'correction' })
    .orderBy('created_at', 'desc')
    .limit(RECENT_CORRECTIONS)
    .select('id', 'movement_type', 'metadata', 'created_at');
  for (const row of rows || []) {
    if (!isCountCorrection(row)) continue;
    const countedAt = countTime(row);
    if (countedAt) return { id: row.id, countedAt };
  }
  return null;
}

// The first start time the visit recorded, or null (a never-checked-in visit).
function visitStartedAt({ scheduledService, serviceRecord } = {}) {
  const candidates = [
    scheduledService?.arrived_at,
    scheduledService?.check_in_time,
    scheduledService?.actual_start_time,
    serviceRecord?.started_at,
  ];
  for (const candidate of candidates) {
    const date = validDate(candidate);
    if (date) return date;
  }
  return null;
}

// The visit's Eastern calendar day (date columns, so read literally), or null.
function visitServiceDay({ scheduledService, serviceRecord } = {}) {
  const raw = serviceRecord?.service_date || scheduledService?.scheduled_date;
  if (!raw) return null;
  const day = etCalendarDayOf(raw);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

// True when the visit was done before the count. A start time compares as an instant.
// With no start time only the calendar day is known, so the visit counts as earlier
// only when its Eastern day is strictly before the count's Eastern day.
function usedBeforeCount({ scheduledService, serviceRecord } = {}, count) {
  const countedAt = count && validDate(count.countedAt);
  if (!countedAt) return false;
  const started = visitStartedAt({ scheduledService, serviceRecord });
  if (started) return started.getTime() < countedAt.getTime();
  const day = visitServiceDay({ scheduledService, serviceRecord });
  if (!day) return false;
  return day < etDateString(countedAt);
}

// The one call the usage writers make. Returns the metadata to stamp on a
// stock-unchanged usage movement, or null for a normal deduction.
async function stockHoldFor(conn, productId, visit) {
  if (!require('../config/feature-gates').stockCountAwareUsageLive()) return null;
  const count = await latestCount(conn, productId);
  if (!count) return null;
  // `visit` may be a function, so a writer holding only ids reads the visit's times after a count is known.
  const resolved = typeof visit === 'function' ? await visit() : visit;
  if (!usedBeforeCount(resolved, count)) return null;
  return {
    stockUnchanged: 'used_before_latest_count',
    countMovementId: count.id,
    countedAt: count.countedAt.toISOString(),
  };
}

// The visit's start fields for a writer that was handed ids, not rows.
async function loadVisit(conn, { scheduledServiceId, serviceRecordId } = {}) {
  const [scheduledService, serviceRecord] = await Promise.all([
    scheduledServiceId
      ? conn('scheduled_services').where({ id: scheduledServiceId })
        .select('arrived_at', 'check_in_time', 'actual_start_time', 'scheduled_date').first()
      : null,
    serviceRecordId
      ? conn('service_records').where({ id: serviceRecordId }).select('started_at', 'service_date').first()
      : null,
  ]);
  return { scheduledService: scheduledService || null, serviceRecord: serviceRecord || null };
}

const COUNTED_USAGE_WARNING = 'This visit was done before the latest count, which already includes this use; stock was not changed.';

module.exports = {
  isCountCorrection,
  countTime,
  latestCount,
  visitStartedAt,
  usedBeforeCount,
  stockHoldFor,
  loadVisit,
  COUNTED_USAGE_WARNING,
};
