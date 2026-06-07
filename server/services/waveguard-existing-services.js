// ============================================================
// waveguard-existing-services.js
//
// Single source of truth for "what WaveGuard-qualifying recurring services
// does this customer already have?" — shared by:
//   - admin-estimate-persistence.js, to reprice a linked customer's estimate
//     at the COMBINED tier (so the charged total honors membership), and
//   - estimate-membership-context.js, to render the membership card.
//
// Keeping the query + key-mapping here guarantees the displayed tier and the
// charged tier are derived from the same rows and can never disagree.
// ============================================================

// Statuses that mean a scheduled visit is not live, active coverage.
// 'rescheduled' is a phantom row the customer-portal reschedule flow leaves in
// place until SmartRebooker actions it (see admin-schedule.js), so it must not
// count toward coverage/tier.
const TERMINAL_STATUSES = ['cancelled', 'completed', 'no_show', 'skipped', 'rescheduled'];

// Map a free-text service name (scheduled_services.service_type or an estimate
// line label) to a WaveGuard qualifying service key. Scoped to the five
// qualifiers — palm_injection and rodent_bait are explicitly NOT qualifiers,
// and one-time treatments (one_time_pest etc.) never count toward the tier.
function toQualifyingKey(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (s.includes('rodent') || s.includes('palm')) return null;
  if (/one[\s_-]?time|onetime/.test(s)) return null;
  if (s.includes('pest')) return 'pest_control';
  if (s.includes('lawn') || s.includes('turf')) return 'lawn_care';
  if (s.includes('tree') || s.includes('shrub') || s.includes('ornamental')) return 'tree_shrub';
  if (s.includes('mosquito')) return 'mosquito';
  if (s.includes('termite') && s.includes('bait')) return 'termite_bait';
  return null;
}

// Load the customer's active, recurring, qualifying scheduled_services rows.
// Restricts to RECURRING rows (is_recurring true; recurring_parent_id is NOT
// used because booster-month visits carry a parent but is_recurring:false and
// would inflate coverage — see admin-schedule.js). Guarded on column existence
// so schema drift degrades gracefully rather than throwing.
async function loadExistingRecurringQualifyingRows(database, customerId) {
  if (!database || !customerId) return [];
  const cols = await database('scheduled_services').columnInfo();
  const hasIsRecurring = !!cols.is_recurring;
  let query = database('scheduled_services')
    .where({ customer_id: customerId })
    .whereNotIn('status', TERMINAL_STATUSES);
  if (hasIsRecurring) {
    query = query.where({ is_recurring: true });
  }
  const selectCols = ['id', 'service_type', 'scheduled_date'];
  if (cols.estimated_price) selectCols.push('estimated_price');
  if (cols.annual_prepay_term_id) selectCols.push('annual_prepay_term_id');
  const rows = await query.select(selectCols);
  return rows.filter((r) => toQualifyingKey(r.service_type) !== null);
}

// Distinct qualifying service keys from a set of rows.
function qualifyingKeysFromRows(rows = []) {
  const keys = new Set();
  for (const r of rows) {
    const key = toQualifyingKey(r.service_type);
    if (key) keys.add(key);
  }
  return [...keys];
}

// Convenience: just the distinct qualifying keys for a customer.
async function loadExistingQualifyingServiceKeys(database, customerId) {
  const rows = await loadExistingRecurringQualifyingRows(database, customerId);
  return qualifyingKeysFromRows(rows);
}

module.exports = {
  TERMINAL_STATUSES,
  toQualifyingKey,
  loadExistingRecurringQualifyingRows,
  qualifyingKeysFromRows,
  loadExistingQualifyingServiceKeys,
};
