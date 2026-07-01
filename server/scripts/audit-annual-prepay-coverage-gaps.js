#!/usr/bin/env node
/**
 * Audit annual-prepay terms whose recurring visits are NOT stamped prepaid — the
 * existing-data side of the completion double-bill fix.
 *
 * Why: completion billing suppresses an invoice only when a visit carries an
 * explicit annual-prepay stamp backed by a live term (see annualPrepayCoversVisit
 * in annual-prepay-renewals.js). Any active-term visit that is PRICED
 * (estimated_price > 0) but NOT stamped will complete-bill again — a double bill
 * on top of the annual prepayment the customer already paid. The converter fix
 * (this PR) stamps NEW single-service prepays and hard-blocks multi-service ones,
 * but terms converted BEFORE it shipped can still be exposed. This surfaces them.
 *
 * Categories reported per exposed term:
 *   RESTAMPABLE      — term HAS coverage config (coverage_service_type +
 *                      coverage_visit_count) but some in-window visits are
 *                      unstamped. refreshTermSnapshot re-applies the configured
 *                      coverage; --restamp-configured does this (idempotent, only
 *                      re-applies EXISTING config, never invents one).
 *   MANUAL_SINGLE    — no coverage config, exactly one distinct recurring service
 *                      type across the exposed visits. A human can safely add
 *                      coverage config / bill the prepay manually.
 *   MANUAL_MULTI     — no coverage config, MULTIPLE recurring service types. A
 *                      term carries one coverage service, so this cannot be
 *                      auto-remediated — operator must handle billing manually
 *                      (this is the class the converter now hard-blocks going
 *                      forward).
 *
 * This script NEVER voids invoices, prices visits, or writes coverage config it
 * had to guess. The only mutation it can make is refreshTermSnapshot on a term
 * that ALREADY has coverage config (--restamp-configured).
 *
 * Usage:
 *   node server/scripts/audit-annual-prepay-coverage-gaps.js                     # report only (default)
 *   node server/scripts/audit-annual-prepay-coverage-gaps.js --restamp-configured # + re-stamp RESTAMPABLE terms
 *   node server/scripts/audit-annual-prepay-coverage-gaps.js --json              # machine-readable report
 *
 * Read-only-safe to run anytime; re-running after a re-stamp shows fewer exposed
 * visits. On prod the internal DB host isn't reachable from `railway run`; run it
 * via `railway ssh` (see the annual-prepay backfill notes).
 */
const db = require('../models/db');
const AnnualPrepayRenewals = require('../services/annual-prepay-renewals');

const RESTAMP = process.argv.includes('--restamp-configured');
const JSON_OUT = process.argv.includes('--json');

// Visit statuses that are terminal / not billable at completion — ignore them.
const TERMINAL_VISIT_STATUSES = ['cancelled', 'canceled', 'no_show', 'skipped', 'rescheduled', 'completed'];
const ANNUAL_PREPAY_PREPAID_METHOD = 'annual_prepay_invoice';

const { serviceMatchesCoverage, normalizeCoverageServiceType } = AnnualPrepayRenewals._private;

// Mirror production annualPrepayCoversVisit: a visit is genuinely covered only
// when it carries this term's annual-prepay stamp AND — when the term declares a
// coverage service — its service_type still matches (the completion gate rejects
// a stale stamp on a dropped/re-typed service, so that visit WILL bill → it must
// count as exposed here, not silently covered).
function visitIsStamped(v, term) {
  if (!(v.prepaid_method === ANNUAL_PREPAY_PREPAID_METHOD
    && String(v.annual_prepay_term_id) === String(term.id)
    && Number(v.prepaid_amount) > 0)) return false;
  if (term.coverage_service_type && v.service_type) {
    return serviceMatchesCoverage(v, normalizeCoverageServiceType(term.coverage_service_type));
  }
  return true;
}

// Mirror the completion gate's invoiceAmount (admin-dispatch.js /complete +
// project-completion.js): estimated_price when positive, else the customer's
// monthly rate for a non-callback visit. This is what a completion would bill —
// so a null-priced multi-service visit that bills via the monthly-rate fallback
// is caught too (the exact class the converter now hard-blocks going forward).
function completionBillAmount(v) {
  if (v.estimated_price != null && Number(v.estimated_price) > 0) return Number(v.estimated_price);
  if (!v.is_callback && Number(v.cust_monthly_rate) > 0) return Number(v.cust_monthly_rate);
  return 0;
}

async function exposedVisitsForTerm(term) {
  const rows = await db('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where({ 's.customer_id': term.customer_id })
    .whereBetween('s.scheduled_date', [term.term_start, term.term_end])
    .whereNotIn('s.status', TERMINAL_VISIT_STATUSES)
    .select('s.id', 's.service_type', 's.scheduled_date', 's.status', 's.estimated_price',
      's.prepaid_method', 's.prepaid_amount', 's.annual_prepay_term_id', 's.is_callback',
      'c.monthly_rate as cust_monthly_rate');
  // A visit is an exposed gap when a completion WOULD bill it AND it isn't stamped
  // prepaid for this term. For a CONFIGURED term, restrict candidates to visits
  // that actually belong to its coverage — either linked to the term (a stale
  // stamp on a dropped/re-typed service still belongs) OR of the covered service
  // type. An unrelated billable visit (e.g. a one-time WDO for a lawn-prepay
  // customer) is correctly billed by completion and is NOT a coverage gap, so it
  // must not inflate the report / a --restamp that can't fix it. No-config terms
  // can't filter by service (reported MANUAL anyway).
  const hasConfig = term.coverage_service_type != null && Number(term.coverage_visit_count) > 0;
  const coverageType = hasConfig ? normalizeCoverageServiceType(term.coverage_service_type) : null;
  return rows
    .map((v) => ({ ...v, billAmount: completionBillAmount(v) }))
    .filter((v) => {
      if (!(v.billAmount > 0) || visitIsStamped(v, term)) return false;
      if (hasConfig) {
        const belongsToTerm = String(v.annual_prepay_term_id) === String(term.id);
        const matchesCoverage = v.service_type && serviceMatchesCoverage(v, coverageType);
        if (!belongsToTerm && !matchesCoverage) return false;
      }
      return true;
    });
}

// refreshTermSnapshot only (re)stamps terms in an ACTIVE status — a configured
// term in any other covered status (renewed / switch_plan / payment_pending /
// lapsed-cancelled, all of which coveredTermsAsOf includes) would no-op under
// --restamp-configured, so it must NOT be reported RESTAMPABLE (that would claim a
// fix that never happens). Those need manual handling (activate/sync first).
const RESTAMP_STATUSES = ['active', 'renewal_pending'];

function classify(term, exposed) {
  const hasConfig = term.coverage_service_type != null && Number(term.coverage_visit_count) > 0;
  if (hasConfig && RESTAMP_STATUSES.includes(term.status)) return 'RESTAMPABLE';
  const distinctServices = new Set(exposed.map((v) => String(v.service_type || '').trim().toLowerCase()).filter(Boolean));
  return distinctServices.size > 1 ? 'MANUAL_MULTI' : 'MANUAL_SINGLE';
}

async function main() {
  const hasTable = await db.schema.hasTable('annual_prepay_terms');
  if (!hasTable) {
    console.log('annual_prepay_terms table does not exist — nothing to audit.');
    return;
  }

  // Select ONLY terms with still-valid paid coverage — the same canonical filter
  // production billing uses (coveredTermsAsOf: paid status + prepay invoice not
  // void/refunded + payment not fully refunded). Passing no coverageDate keeps ALL
  // windows (a term's exposed visits are found per-term below); a refunded/voided
  // term is excluded so it is never reported RESTAMPABLE nor re-stamped for dead
  // coverage.
  const terms = await AnnualPrepayRenewals.coveredTermsAsOf(db)
    .select('t.id as id', 't.customer_id as customer_id', 't.source_estimate_id as source_estimate_id',
      't.prepay_invoice_id as prepay_invoice_id', 't.prepay_amount as prepay_amount', 't.status as status',
      't.term_start as term_start', 't.term_end as term_end', 't.coverage_service_type as coverage_service_type',
      't.coverage_visit_count as coverage_visit_count', 't.coverage_cadence as coverage_cadence');

  const report = [];
  for (const term of terms) {
    const exposed = await exposedVisitsForTerm(term);
    if (!exposed.length) continue;
    report.push({
      termId: term.id,
      customerId: term.customer_id,
      sourceEstimateId: term.source_estimate_id,
      prepayInvoiceId: term.prepay_invoice_id,
      status: term.status,
      window: `${String(term.term_start).slice(0, 10)} → ${String(term.term_end).slice(0, 10)}`,
      coverageConfigured: term.coverage_service_type != null && Number(term.coverage_visit_count) > 0,
      category: classify(term, exposed),
      exposedVisitCount: exposed.length,
      exposedBillableTotal: exposed.reduce((s, v) => s + Number(v.billAmount || 0), 0),
      exposedVisitIds: exposed.map((v) => v.id),
    });
  }

  // Optional SAFE remediation: re-run refreshTermSnapshot on terms that ALREADY
  // have coverage config so the pipeline stamps their exposed visits. Never
  // invents config for no-config terms.
  const restamped = [];
  if (RESTAMP) {
    for (const row of report.filter((r) => r.category === 'RESTAMPABLE')) {
      try {
        await AnnualPrepayRenewals.refreshTermSnapshot(row.termId);
        const term = terms.find((t) => t.id === row.termId);
        const stillExposed = await exposedVisitsForTerm(term);
        restamped.push({ termId: row.termId, before: row.exposedVisitCount, after: stillExposed.length });
      } catch (err) {
        restamped.push({ termId: row.termId, error: err.message });
      }
    }
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ generatedFrom: 'covered_terms', restampApplied: RESTAMP, report, restamped }, null, 2));
    return;
  }

  const counts = report.reduce((acc, r) => { acc[r.category] = (acc[r.category] || 0) + 1; return acc; }, {});
  console.log(`\nAnnual-prepay coverage-gap audit — ${terms.length} covered term(s) scanned, ${report.length} exposed.`);
  console.log(`  RESTAMPABLE:   ${counts.RESTAMPABLE || 0}  (has config + active status → refreshTermSnapshot re-stamps)`);
  console.log(`  MANUAL_SINGLE: ${counts.MANUAL_SINGLE || 0}  (no config or non-active status, one service — human fix)`);
  console.log(`  MANUAL_MULTI:  ${counts.MANUAL_MULTI || 0}  (no config or non-active status, multi-service — MUST bill manually)`);
  for (const r of report) {
    console.log(`\n• term ${r.termId}  [${r.category}]  status=${r.status}`);
    console.log(`    customer=${r.customerId}  estimate=${r.sourceEstimateId || '—'}  prepayInvoice=${r.prepayInvoiceId || '—'}`);
    console.log(`    window ${r.window}  configured=${r.coverageConfigured}`);
    console.log(`    exposed visits: ${r.exposedVisitCount}  (~$${r.exposedBillableTotal.toFixed(2)} of double-bill risk)`);
    console.log(`    visit ids: ${r.exposedVisitIds.join(', ')}`);
  }
  if (RESTAMP) {
    console.log(`\nRe-stamp results (RESTAMPABLE terms):`);
    for (const s of restamped) {
      console.log(s.error
        ? `  • ${s.termId}: ERROR ${s.error}`
        : `  • ${s.termId}: exposed ${s.before} → ${s.after}`);
    }
  } else if (counts.RESTAMPABLE) {
    console.log(`\nRe-run with --restamp-configured to re-stamp the ${counts.RESTAMPABLE} RESTAMPABLE term(s).`);
  }
  console.log('\nMANUAL_* terms need operator handling (bill the prepay manually / void duplicate completion invoices).');
}

main()
  .then(() => db.destroy && db.destroy())
  .catch(async (err) => {
    console.error('audit failed:', err);
    try { await (db.destroy && db.destroy()); } catch (_) { /* noop */ }
    process.exit(1);
  });
