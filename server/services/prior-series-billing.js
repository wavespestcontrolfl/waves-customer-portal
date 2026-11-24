/**
 * Prior-series billing — the earlier plan a "book the plan again" booking restarts.
 * server/services/prior-series-billing.js
 *
 * The Intelligence Bar's book_plan_visits (owner 2026-11-24) restarts a recurring series for a customer who already had one
 * for the same service. A restart books the plan at what the NEW booking stamps. It is allowed only when every
 * billing-relevant fact of the earlier series already equals that, so nothing the earlier plan billed differently is silently
 * dropped or changed: otherwise it goes through an estimate. The preview asks this once, and the Schedule handler's booking
 * transaction asks it again under lock (routes/admin-schedule.js assertApprovedPriorSeries), through the SAME functions.
 *
 * PRIOR_SERIES_BILLING_FIELDS is the whole list, in one place. Each entry names one fact, how it is read, and what the new
 * booking stamps for it:
 *   kind 'money'  equal in cents to expect(x)
 *   kind 'bool'   strictly equal to expect(x) (an unset flag is a difference)
 *   kind 'empty'  the new booking stamps nothing there, so the earlier series must carry nothing (null, '', 0, false, [], {})
 * `read` says where the value comes from: 'row' (the column on the series parent AND on its latest live visit), 'price' (the
 * per-visit price the series bills going forward), 'cioc' (the series' effective invoice-on-completion setting), 'overrides'
 * (the RAW recurring_template_overrides column, so keys the parsed overlay filters out, such as a renewal price or a moved
 * address, still count), 'addons' (any add-on line on any visit of the series), 'separate' (a separate-program marker of this
 * customer's, matched on the leading "Series <id>;" field), 'priceDrift' (the latest live visit still bills the parent's own
 * price), 'moved' (every live visit still sits at the parent's property and service address). `group` picks the refusal the
 * caller words.
 */

const rowFields = (group, kind, fields) => fields.map((field) => ({ field, group, kind, read: 'row' }));

const PRIOR_SERIES_BILLING_FIELDS = [
  // What a visit bills.
  { field: 'estimated_price', group: 'price', kind: 'money', read: 'price', expect: (x) => x.price },
  { field: 'series_price_drift', group: 'changed', kind: 'bool', read: 'priceDrift', expect: () => true },
  { field: 'primary_line_price', group: 'price', kind: 'money', read: 'row', expect: (x) => x.primaryBase },
  ...rowFields('price', 'empty', [
    'discount_id', 'discount_name', 'discount_type', 'discount_amount', 'discount_dollars', 'discount_max_dollars',
    'discount_service_key_filter', 'discount_service_category_filter',
    'line_discount_id', 'line_discount_name', 'line_discount_type', 'line_discount_amount', 'line_discount_dollars',
  ]),
  // Any template override at all (a price, a renewal price, a moved address): the plan was changed after booking.
  { field: 'recurring_template_overrides', group: 'changed', kind: 'empty', read: 'overrides' },
  { field: 'series_moved', group: 'changed', kind: 'bool', read: 'moved', expect: () => true },
  // Whether completing a visit invoices it.
  { field: 'create_invoice_on_complete', group: 'billing_setting', kind: 'bool', read: 'cioc', expect: (x) => x.createInvoice },
  // Add-on lines, which make a visit's price a bundle.
  { field: 'scheduled_service_addons', group: 'addons', kind: 'empty', read: 'addons' },
  // Who pays, and money already taken or owed.
  ...rowFields('billing', 'empty', [
    'payer_id', 'self_pay_override',
    'prepaid_amount', 'prepaid_at', 'prepaid_method', 'prepaid_note', 'annual_prepay_term_id', 'paf_held_term_id',
    'pending_setup_fee', 'first_application_invoice_id',
    'is_callback', 'booster_months',
  ]),
  // A separate recurring program the office created on purpose beside another one.
  { field: 'separate_program_marker', group: 'billing', kind: 'empty', read: 'separate' },
];
// Not on the list on purpose: source_estimate_id (provenance, not a stamp; the setup-fee and price tests above judge what it
// carried), payment_method_preference (a self-booking preference no billing path reads), and the dates, window, technician and
// property (the card pins those itself).

const SERIES_LIVE_EXCLUDED = ['cancelled', 'skipped', 'rescheduled', 'no_show'];

function isEmpty(v) {
  if (v == null || v === '' || v === false || v === 0 || v === '0' || v === '0.00') return true;
  if (v instanceof Date) return false;
  if (typeof v === 'string') return ['[]', '{}'].includes(v.trim());
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}
const cents = (v) => (v == null || v === '' ? null : Math.round(Number(v) * 100));

// The series parents of this customer that qualify as "the earlier plan": the same service family (the duplicate-series
// guard's own classifier) at the booking property, stamped with it. The newest wins, deterministically: the newest live visit
// date, then the parent's created_at, then its id. lock: read FOR SHARE (the booking transaction's recheck).
async function newestQualifyingPriorSeries(conn, { customerId, serviceId, family, propertyId, lock = false }) {
  const { duplicateGuardFamilyKey } = require('./recurring-appointment-seeder');
  const query = conn('scheduled_services')
    .where({ customer_id: customerId, is_recurring: true })
    .whereNull('recurring_parent_id');
  if (lock) query.forShare();
  const parents = (await query.select('id', 'service_id', 'service_type', 'property_id', 'created_at')) || [];
  const qualifying = parents.filter((p) => {
    const sameFamily = (p.service_id != null && String(p.service_id) === String(serviceId))
      || (!!p.service_type && duplicateGuardFamilyKey(p.service_type) === family);
    return sameFamily && String(p.property_id || '') === String(propertyId || '');
  });
  if (!qualifying.length) return null;
  const ids = qualifying.map((p) => p.id);
  const visits = (await conn('scheduled_services')
    .where((q) => q.whereIn('id', ids).orWhereIn('recurring_parent_id', ids))
    .whereNotIn('status', SERIES_LIVE_EXCLUDED)
    .select('id', 'recurring_parent_id', 'scheduled_date')) || [];
  const newestVisit = new Map();
  for (const v of visits) {
    const root = String(v.recurring_parent_id || v.id);
    const day = String(v.scheduled_date instanceof Date ? v.scheduled_date.toISOString() : (v.scheduled_date || '')).slice(0, 10);
    if (day && (!newestVisit.has(root) || day > newestVisit.get(root))) newestVisit.set(root, day);
  }
  const stamp = (p) => String(p.created_at instanceof Date ? p.created_at.toISOString() : (p.created_at || ''));
  qualifying.sort((a, b) => (newestVisit.get(String(b.id)) || '').localeCompare(newestVisit.get(String(a.id)) || '')
    || stamp(b).localeCompare(stamp(a)) || String(b.id).localeCompare(String(a.id)));
  return { id: String(qualifying[0].id), family };
}

// The earlier series' billing facts against what the new booking stamps. `expected` = { price, primaryBase, createInvoice }.
// Returns { gone: true } when the parent is not a live series root, else { mismatches: [{ field, group }] } (empty = restartable).
async function priorSeriesBillingMismatches(conn, parentId, expected, { lock = false } = {}) {
  if (!parentId) return { gone: true };
  const parentQuery = conn('scheduled_services').where({ id: parentId, is_recurring: true }).whereNull('recurring_parent_id');
  if (lock) parentQuery.forShare();
  const parent = await parentQuery.first();
  if (!parent) return { gone: true };
  const latest = await conn('scheduled_services')
    .where((q) => q.where({ id: parentId }).orWhere({ recurring_parent_id: parentId }))
    .whereNotIn('status', SERIES_LIVE_EXCLUDED)
    .orderBy('scheduled_date', 'desc')
    .first();
  const basis = latest || parent;

  const lazy = {};
  const read = async (entry) => {
    switch (entry.read) {
      case 'row': return [parent[entry.field], basis[entry.field]];
      case 'price': return [basis.estimated_price];
      case 'priceDrift': return [cents(basis.estimated_price) === cents(parent.estimated_price)];
      // The raw column: parseTemplateOverrides filters keys (anchored_split_per_visit, appointment_address) that still change the plan.
      case 'overrides': return [parent.recurring_template_overrides];
      case 'moved': {
        const visits = (await conn('scheduled_services')
          .where({ recurring_parent_id: parentId })
          .whereNotIn('status', SERIES_LIVE_EXCLUDED)
          .select('property_id', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_zip')) || [];
        const place = (r) => [r.property_id, r.service_address_line1, r.service_address_line2, r.service_address_city, r.service_address_zip]
          .map((v) => String(v ?? '').trim().toLowerCase()).join('|');
        return [visits.every((v) => place(v) === place(parent))];
      }
      case 'cioc': {
        if (!('cioc' in lazy)) lazy.cioc = await require('../routes/admin-schedule').resolveSeriesCreateInvoiceOnComplete(conn, parentId, parent);
        return [lazy.cioc];
      }
      case 'addons': {
        const rows = await conn('scheduled_service_addons')
          .whereIn('scheduled_service_id', conn('scheduled_services').select('id').where((q) => q.where({ id: parentId }).orWhere({ recurring_parent_id: parentId })))
          .select('id');
        return [(rows || []).length ? rows : null];
      }
      case 'separate': {
        // This customer's own marker, whose leading field names this series as the one created (not a series it merely reviewed).
        const marker = await conn('activity_log')
          .where({ customer_id: parent.customer_id, action: 'separate_recurring_program_created' })
          .where('description', 'like', `Series ${parentId};%`)
          .first('id');
        return [marker || null];
      }
      default: throw new Error(`prior-series-billing: unknown read ${entry.read}`);
    }
  };

  const mismatches = [];
  for (const entry of PRIOR_SERIES_BILLING_FIELDS) {
    const values = await read(entry);
    const ok = values.every((v) => {
      if (entry.kind === 'money') return cents(v) === cents(entry.expect(expected || {}));
      if (entry.kind === 'bool') return v === entry.expect(expected || {});
      return isEmpty(v);
    });
    if (!ok) mismatches.push({ field: entry.field, group: entry.group });
  }
  return { mismatches };
}

module.exports = { PRIOR_SERIES_BILLING_FIELDS, newestQualifyingPriorSeries, priorSeriesBillingMismatches };
