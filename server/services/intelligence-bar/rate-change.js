/**
 * Monthly-rate edits from the Intelligence Bar (owner 2026-10-06).
 *
 * customers.monthly_rate is the customer's WHOLE monthly bill; the plan-rate
 * ledger (customer_plan_rates) splits it by service. update_customer used to
 * write the scalar and reset the ledger to one 'unattributed' line, so "set
 * her lawn to $61.33" would have replaced a $41.33 pest plan with $61.33 and
 * the card showed only "monthly_rate: 61.33".
 *
 * Now a rate edit on a customer who already has a rate names the ONE service
 * whose price changes (rate_service), or 'whole_bill' to replace everything.
 * The card lists every line before and after; a total below the other lines
 * is refused. The ledger read is pinned, and the commit refuses if it changed.
 */
const db = require('../../models/db');
const PlanRateLedger = require('../plan-rate-ledger');

const { WHOLE_BILL, UNATTRIBUTED } = PlanRateLedger;
// The rate the card was built on is the rate submitted: pinned, no line moves.
const UNCHANGED = 'unchanged';

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function lineLabel(family) {
  if (family === UNATTRIBUTED) return 'Earlier rate (not split by service)';
  const text = String(family || '').replace(/_/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : 'Service';
}

// A stable fingerprint of what the card was built from: the scalar and every
// ledger line. Compared at commit; any change since the card refuses.
function ledgerPin(components, scalar) {
  const rows = (components || [])
    .map((r) => `${r.family_key}=${Number(r.monthly_rate || 0).toFixed(2)}`)
    .sort();
  return `${Number(scalar || 0).toFixed(2)}|${rows.join(',')}`;
}

// The ledger family the operator named: an existing line's key as-is,
// 'whole_bill', or a service name classified the way the estimate accept
// path classifies lines (so "Monthly Lawn Care" lands on the same key an
// accepted lawn estimate writes).
function resolveFamily(rateService, components) {
  const raw = String(rateService || '').trim();
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === WHOLE_BILL || lowered === 'whole bill') return WHOLE_BILL;
  const existing = (components || []).find((r) => String(r.family_key).toLowerCase() === lowered);
  if (existing) return existing.family_key;
  // The classifier keeps an unknown name as its own slug ("banana" → banana);
  // only a WaveGuard family that bills MONTHLY may become a new line. Rodent
  // bait bills per application (its plan's monthlyRate is 0), so a rodent
  // line would add a monthly dues charge that service never had.
  const { serviceFamilyKeyForAdoption } = require('../../routes/estimate-public');
  const { WAVEGUARD_SERVICE_FAMILIES } = require('../self-booking-plan-sync');
  const key = serviceFamilyKeyForAdoption({ service: raw });
  return key && key !== 'rodent_bait' && WAVEGUARD_SERVICE_FAMILIES.includes(key) ? key : null;
}

function describeBill(components, previousScalar) {
  return [...PlanRateLedger.billLines(components, previousScalar)]
    .map(([family, amount]) => `${lineLabel(family)} ${money(amount)}`)
    .join(' + ') || money(0);
}

// Customers whose bill a bulk rate would replace: a positive monthly rate, or
// ANY plan-rate ledger row — a paused service keeps a zero 'plan_hold' row
// beside a zero rate, and the hold-resume job restores from it (Codex #6085
// r2). Returns a Set of id strings. `conn` is db or the caller's transaction.
async function customersWithBill(conn, rows) {
  const billed = new Set(rows.filter((r) => Number(r.monthly_rate) > 0).map((r) => String(r.id)));
  const ids = rows.map((r) => String(r.id)).filter((id) => !billed.has(id));
  if (ids.length && (await conn.schema.hasTable('customer_plan_rates'))) {
    const ledgered = await conn('customer_plan_rates').whereIn('customer_id', ids).distinct('customer_id');
    for (const r of ledgered) billed.add(String(r.customer_id));
  }
  return billed;
}

/**
 * Proposal-time check for an update_customer that sets monthly_rate.
 * Returns null when the rate does not change, { error, code } to refuse, or
 * { family, pin, display } for the card and the execution pins.
 */
async function rateChangeProposal(customerId, newRate, rateService) {
  const customer = await db('customers').where('id', customerId).first('monthly_rate', 'billing_mode');
  if (!customer) return { error: 'Customer no longer exists' };
  const previousScalar = Number(customer.monthly_rate) || 0;
  const newScalar = Number(newRate) || 0;
  const components = await PlanRateLedger.loadComponents(db, customerId);
  // An unchanged rate is still pinned (Codex #6085 r2): if another writer
  // changes the bill before Confirm, the stale value would otherwise commit
  // as a real change through the unpinned reset. Nothing to show on the card.
  if (Math.round(previousScalar * 100) === Math.round(newScalar * 100)) {
    return { family: UNCHANGED, pin: ledgerPin(components, previousScalar), display: null };
  }
  const hasBill = previousScalar > 0 || components.some((r) => Number(r.monthly_rate) !== 0);

  let family = resolveFamily(rateService, components);
  if (!family) {
    if (rateService) {
      return {
        error: `"${rateService}" is not a service this tool can price. Use a service name (for example lawn or pest control), or whole_bill to replace the whole monthly bill. Nothing was proposed.`,
        code: 'rate_family_unknown',
      };
    }
    if (hasBill) {
      return {
        error: `monthly_rate is this customer's whole monthly bill: ${describeBill(components, previousScalar)} = ${money(previousScalar)}. Ask which service's price changes, then propose again with rate_service set to that service (for example "lawn"), or "whole_bill" to replace the whole bill. The new monthly_rate is the new TOTAL. Nothing was proposed.`,
        code: 'rate_family_required',
      };
    }
    family = WHOLE_BILL;
  }

  // A zero row is a paused service's kept marker (plan_hold): the hold-resume
  // job restores from it, so neither its own line nor a whole-bill reset may
  // erase it while the hold lasts.
  const heldFamilies = components.filter((r) => Number(r.monthly_rate) === 0).map((r) => r.family_key);
  if (heldFamilies.length && (family === WHOLE_BILL || heldFamilies.includes(family))) {
    return {
      error: `${family === WHOLE_BILL ? 'A service on this bill is on hold' : `${lineLabel(family)} is on hold`}, so ${family === WHOLE_BILL ? 'the whole bill cannot be replaced' : 'its price cannot be changed here'}. Change one active service with rate_service, or end the hold first. Nothing was proposed.`,
      code: 'rate_family_on_hold',
    };
  }
  const change = PlanRateLedger.planRateChange({ components, previousScalar, newScalar, familyKey: family });
  if (change.error) {
    return {
      error: `${change.error} Today the bill is ${describeBill(components, previousScalar)}. Ask the operator which price changes. Nothing was proposed.`,
      code: change.code,
    };
  }
  return {
    family,
    pin: ledgerPin(components, previousScalar),
    display: {
      billing_mode: customer.billing_mode || null,
      replaces_whole_bill: family === WHOLE_BILL,
      lines: change.lines.map((l) => ({ label: lineLabel(l.family), before: l.before, after: l.after })),
      total_before: change.totalBefore,
      total_after: change.totalAfter,
    },
  };
}

module.exports = { rateChangeProposal, ledgerPin, lineLabel, money, UNCHANGED, customersWithBill, resolveFamily };
