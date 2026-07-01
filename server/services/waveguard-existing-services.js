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

// Tier values that do NOT represent an active WaveGuard plan membership.
// Mirrors hasMembership() in routes/admin-customers.js (the same logic the
// admin "No Plan" badge reads) so the estimate flow and the admin UI agree on
// who counts as a member.
const NON_MEMBERSHIP_TIER_KEYS = new Set(['none', 'onetime', 'na', 'no', 'notset', 'commercial']);

function membershipTierKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// A customer is an actual WaveGuard plan member only when their record carries
// a membership tier (Bronze/Silver/Gold/Platinum) — NOT merely because they
// have a scheduled visit. A lead / one-time buyer whose initial service
// auto-scheduled a recurring follow-up is still "No Plan" and must be treated
// as a new customer for the WaveGuard setup fee + annual-prepay decisions.
function isMembershipCustomerRow(customer = {}) {
  const tierKey = membershipTierKey(customer.waveguard_tier ?? customer.tier);
  if (tierKey && NON_MEMBERSHIP_TIER_KEYS.has(tierKey)) return false;
  if (tierKey) return true;
  // No tier set: fall back to a positive recurring monthly rate (legacy members
  // whose tier column was never populated).
  return Number(customer.monthly_rate ?? customer.monthlyRate ?? 0) > 0;
}

// Live "does this customer hold a WaveGuard plan today?" check. Fail-closed to
// false (treat as a non-member / new customer) on a missing customer or any
// lookup error — the safe default is to charge the setup fee and offer annual
// prepay, never to silently waive them for a non-member.
async function isActivePlanCustomer(database, customerId) {
  if (!database || !customerId) return false;
  try {
    const customer = await database('customers').where({ id: customerId }).first();
    if (!customer || customer.active === false) return false;
    return isMembershipCustomerRow(customer);
  } catch {
    return false;
  }
}

// Map a free-text service name (scheduled_services.service_type or an estimate
// line label) to a WaveGuard qualifying service key. Scoped to the five
// qualifiers — palm_injection and rodent_bait are explicitly NOT qualifiers,
// and one-time treatments (one_time_pest etc.) never count toward the tier.
function toQualifyingKey(raw) {
  const s = String(raw || '').toLowerCase();
  if (!s) return null;
  if (s.includes('rodent') || s.includes('palm')) return null;
  if (/one[\s_-]?time|onetime/.test(s)) return null;
  // Commercial auto-priced plans are FLAT and never count toward a WaveGuard
  // tier — otherwise an accepted "Commercial Turf Treatment Program" would feed
  // priorQualifyingServices and unlock WaveGuard discounts on future estimates.
  if (s.includes('commercial')) return null;
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
  // Plan-gate: only customers who actually hold a WaveGuard plan have
  // "existing" recurring coverage. A lead / one-time buyer with a stray
  // scheduled visit is NOT a member, so they get the new-customer treatment.
  if (!(await isActivePlanCustomer(database, customerId))) return [];
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
  isMembershipCustomerRow,
  isActivePlanCustomer,
};
