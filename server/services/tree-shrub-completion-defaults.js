const { etCalendarDayOf } = require('../utils/datetime-et');

const PALM = /(?:8[-–]0[-–]12|8[-–]2[-–]12|palm.*fertili|fertili.*palm|\b510513\b)/i;
const PALM_ZERO_N_LEGACY = /^LESCO\s+0[-–]0[-–]16$/i;
const SNAPSHOT = /\bsnapshot\b/i;
const MAX_SNAPSHOT_LB_PER_1000 = 600 / 43.56;

// Calendar dates are compared at UTC noon, independent of server TZ/DST.
function dayNumber(value) {
  if (value == null || value === '') return NaN;
  try {
    const day = etCalendarDayOf(value);
    return day ? Date.parse(`${day}T12:00:00Z`) / 86400000 : NaN;
  } catch { return NaN; }
}

function monthsAfter(value, count) {
  const [year, month, day] = etCalendarDayOf(value).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + count, 1, 12));
  const lastDay = new Date(Date.UTC(year, month + count, 0, 12)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next.getTime() / 86400000;
}

// One palm-spacing rule for every completion surface (full form defaults
// and Fast Complete warnings): a feeding is too soon until three calendar
// months after the last one. The longest three-month span is 92 days, so a
// history read needs no further lookback than this.
const PALM_SPACING_LOOKBACK_DAYS = 92;
function palmFeedingTooSoon(lastApplicationDate, visitDate) {
  const today = dayNumber(visitDate);
  if (!Number.isFinite(today) || !Number.isFinite(dayNumber(lastApplicationDate))) return false;
  return today < monthsAfter(lastApplicationDate, 3);
}

// lb/1,000 sq ft for one recorded Snapshot application. The full form saves
// the rate; Fast Complete saves only the applied total (and the bed area when
// known), so derive the rate from total ÷ area, or reserve the label maximum
// when the area is missing. A row with neither a rate nor an amount stays
// unreviewable.
const SNAPSHOT_LABEL_MAX_LB_PER_1000 = 4.6;
function snapshotRatePer1000(row) {
  const unit = String(row.rate_unit || '').toLowerCase().replace(/[\s,]/g, '');
  const rate = Number(row.application_rate);
  if (row.application_rate != null && row.application_rate !== '') {
    return ['lb', 'lb/1000sf', 'lb/1000sqft', 'lb/1000ft2'].includes(unit) && Number.isFinite(rate) && rate > 0 ? rate : null;
  }
  const total = Number(row.total_amount);
  const totalUnit = String(row.amount_unit || '').toLowerCase().replace(/\s|\./g, '');
  if (!['lb', 'lbs'].includes(totalUnit) || !Number.isFinite(total) || total <= 0) return null;
  const area = Number(row.area_value);
  const areaUnit = String(row.area_unit || '').toLowerCase().replace(/\s|\./g, '');
  if (Number.isFinite(area) && area > 0 && ['sqft', 'sf', 'ft2'].includes(areaUnit)) return (total / area) * 1000;
  return SNAPSHOT_LABEL_MAX_LB_PER_1000;
}

function treeShrubDueReason(key, history, scheduledDate, propertyId) {
  const today = dayNumber(scheduledDate);
  if (!Number.isFinite(today) || !propertyId) return 'Confirm the service property and visit date.';
  const matches = name => key === 'snapshot' ? SNAPSHOT.test(name) : PALM.test(name) || PALM_ZERO_N_LEGACY.test(name.trim());
  // Only the past 12 months can affect a due decision. An older row (even an
  // unlinked one) never holds a suggestion; an undated row still does.
  const relevant = history.filter(row => matches(row.product_name || '') &&
    (!row.property_id || String(row.property_id) === String(propertyId)) &&
    !(Number.isFinite(dayNumber(row.application_date)) && today >= monthsAfter(row.application_date, 12)));
  if (relevant.some(row => !row.property_id || !Number.isFinite(dayNumber(row.application_date)))) {
    return 'Review application history with an unconfirmed property or date.';
  }
  // Future/same-day records also suppress a suggestion; never infer a due
  // product by silently dropping a conflicting application date.
  if (relevant.some(row => dayNumber(row.application_date) >= today)) return 'An application is already recorded on or after this visit.';
  const annual = relevant.filter(row => today < monthsAfter(row.application_date, 12));
  if (annual.length >= 4) return 'Four applications are already recorded in the past year.';
  if (key === 'snapshot') {
    if (annual.some(row => today - dayNumber(row.application_date) < 60)) return 'Snapshot was applied less than 60 days ago.';
    const quarter = value => { const d = etCalendarDayOf(value); return `${d.slice(0, 4)}-${Math.floor((Number(d.slice(5, 7)) - 1) / 3)}`; };
    if (annual.some(row => quarter(row.application_date) === quarter(scheduledDate))) return 'Snapshot is already recorded for this quarter.';
    let total = 0;
    for (const row of annual) {
      const rate = snapshotRatePer1000(row);
      if (rate == null) return 'Review prior Snapshot rates before adding another application.';
      total += rate;
    }
    // A weed-specific rate has not been selected yet. Reserve the label's
    // highest possible rate instead of assuming the low end is appropriate.
    if (total + SNAPSHOT_LABEL_MAX_LB_PER_1000 > MAX_SNAPSHOT_LB_PER_1000) return 'Select a weed rate and review Snapshot’s rolling annual limit.';
  } else {
    const latest = annual.sort((a, b) => dayNumber(b.application_date) - dayNumber(a.application_date))[0];
    if (latest) {
      if (palmFeedingTooSoon(latest.application_date, scheduledDate)) return 'The last palm feeding was less than three months ago.';
    }
  }
  return null;
}

async function filterTreeShrubDefaults({ db, scheduled, entries }) {
  // Use the existing closeout ledger. A missing table/read is an unavailable
  // history, never proof that the property has had no applications.
  const history = await db('property_application_history as history')
    .leftJoin('service_records as record', 'record.id', 'history.service_record_id')
    .leftJoin('scheduled_services as visit', 'visit.id', 'record.scheduled_service_id')
    .leftJoin('service_products as applied', 'applied.id', 'history.service_product_id')
    .leftJoin('products_catalog as product', 'product.id', 'history.product_id')
    .where('history.customer_id', scheduled.customer_id).whereNull('history.retracted_at')
    .select('history.application_date', 'history.application_rate', 'history.rate_unit', 'visit.property_id',
      'product.name as catalog_name', 'applied.product_name',
      'applied.total_amount', 'applied.amount_unit', 'applied.area_value', 'applied.area_unit');
  const normalized = history.map(row => ({ ...row, product_name: row.product_name || row.catalog_name }));
  if (normalized.some(row => !row.product_name && (!row.property_id || row.property_id === scheduled.property_id))) {
    return { entries: [], holds: entries.map(entry => ({ name: entry.name, reason: 'Review an application with an unidentified product.' })) };
  }
  const allowed = [], holds = [];
  for (const entry of entries) {
    if (!['snapshot', 'f8012', 'f0016'].includes(entry.treeShrubKey)) continue;
    const reason = treeShrubDueReason(entry.treeShrubKey, normalized, scheduled.scheduled_date, scheduled.property_id);
    if (reason) holds.push({ name: entry.name, reason });
    else allowed.push(entry);
  }
  return { entries: allowed, holds };
}

module.exports = { treeShrubDueReason, filterTreeShrubDefaults, palmFeedingTooSoon, PALM_SPACING_LOOKBACK_DAYS };
