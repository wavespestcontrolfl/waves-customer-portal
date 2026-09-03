#!/usr/bin/env node
/**
 * audit-pricing-data-quality.js — READ-ONLY data-quality audit of the tables
 * that feed (or should feed) estimator pricing: service catalog, product
 * catalog / vendor pricing, service→product usage, protocols, equipment
 * calibrations, pricing_config, estimates, customers' billing lanes, and
 * completed-visit actuals.
 *
 * Safety
 *   - Reads the connection string from AUDIT_DB_URL ONLY (never DATABASE_URL),
 *     so stray tooling that defaults to DATABASE_URL can never target prod.
 *   - Opens the session with SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY,
 *     so Postgres itself refuses any write.
 *   - Every query is an aggregate or a catalog/config row. No customer names,
 *     phones, emails, addresses or free-text notes are selected.
 *
 * Usage (from the repo root, node_modules installed):
 *   AUDIT_DB_URL=postgres://... node scripts/audit-pricing-data-quality.js [--json out.json] [--md out.md]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require(path.join(__dirname, '..', 'node_modules', 'pg'));

const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const JSON_OUT = argValue('--json');
const MD_OUT = argValue('--md');
// Reject unknown flags: a not-yet-built mode (the plan names --lawn-rates for
// PR B1) must never silently run the default checks (codex P1 on PR #3792).
const KNOWN_FLAGS = new Map([['--json', 1], ['--md', 1], ['--since', 1]]);
const SINCE = argValue('--since') || '2026-06-01';
// Reused from the billing code, never re-typed (codex r3 P1): the always-free
// service-type list and the active-autopay predicate the workbench applies.
const { ALWAYS_FREE_SERVICE_TYPE_PATTERNS } = require(path.join(__dirname, '..', 'server', 'services', 'no-cost-visit-types'));
const { autopayActivePredicate } = require(path.join(__dirname, '..', 'server', 'services', 'autopay-eligibility'));
const { etDateString } = require(path.join(__dirname, '..', 'server', 'utils', 'datetime-et'));
const TODAY_ET = etDateString(new Date());
const ALWAYS_FREE_SQL_ARRAY = ALWAYS_FREE_SERVICE_TYPE_PATTERNS.map((p) => `'%${p.replace(/'/g, "''")}%'`).join(',');
const AUTOPAY_ACTIVE_SQL = autopayActivePredicate(new Date()).sql.replace('?', '$2');
const ENGINE_TIER_SQL = `coalesce(${['serviceOptOut,engineTier','result,recurring,waveGuardTier','result,recurring,tier','recurring,waveGuardTier','recurring,tier','engineResult,recurring,waveGuardTier','engineResult,recurring,tier','engineResult,waveGuard,tier','result,waveGuard,tier','waveGuard,tier'].map((p) => { const k = p.split(','); return `nullif(trim(estimate_data${k.slice(0, -1).map((x) => `->'${x}'`).join('')}->>'${k[k.length - 1]}'), '')`; }).join(', ')})`;
const EFFECTIVE_PRICE_SQL = "coalesce(nullif(ss.estimated_price, 0), case when c.billing_mode = 'per_application' then c.per_application_fee end, 0)";
// CLI-only validation (a library require under another argv must not exit):
// unknown flags are rejected, and the window is validated as YYYY-MM-DD and
// bound as a query parameter below (never interpolated into SQL — codex P1
// on PR #3792).
if (require.main === module) {
  for (let i = 0; i < args.length; i += 1) {
    if (!KNOWN_FLAGS.has(args[i])) {
      console.error(`Unknown argument ${JSON.stringify(args[i])}. Known flags: ${[...KNOWN_FLAGS.keys()].join(' ')}`);
      process.exit(2);
    }
    i += KNOWN_FLAGS.get(args[i]);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) {
    console.error(`--since must be YYYY-MM-DD (got ${JSON.stringify(SINCE)})`);
    process.exit(2);
  }
}

const CHECKS = [
  {
    key: 'catalog_overview',
    title: 'Service catalog overview',
    sql: `select count(*) as services, count(*) filter (where is_active and not is_archived) as active,
                 count(*) filter (where is_active and not is_archived and engine_keys is not null) as active_with_engine_key,
                 count(*) filter (where is_active and not is_archived and engine_keys is null) as active_without_engine_key,
                 count(*) filter (where is_active and not is_archived and public_quote_selectable) as quote_selectable,
                 count(*) filter (where is_active and not is_archived and billing_type='recurring' and (frequency is null or visits_per_year is null)) as recurring_missing_cadence,
                 count(*) filter (where is_active and not is_archived and base_price is not null) as with_base_price
          from services`,
  },
  {
    key: 'catalog_cadence_drift',
    title: 'Catalog rows whose frequency label disagrees with visits_per_year',
    sql: `select service_key, name, frequency, visits_per_year
          from services
          where is_active and not is_archived and billing_type='recurring'
            and frequency is not null and visits_per_year is not null
            and visits_per_year <> case frequency
              when 'monthly' then 12 when 'every_6_weeks' then 9 when 'seasonal_feb_oct' then 9
              when 'bimonthly' then 6 when 'quarterly' then 4 when 'triannual' then 3
              when 'semiannual' then 2 when 'annual' then 1 else visits_per_year end
          order by service_key`,
  },
  {
    key: 'catalog_engine_gaps',
    title: 'Active, quote-selectable catalog rows with no engine key (priced by name matching only)',
    sql: `select service_key, name, category, billing_type, frequency, visits_per_year, pricing_model_key
          from services where is_active and not is_archived and engine_keys is null and public_quote_selectable
          order by category, service_key`,
  },
  {
    key: 'products_cost_completeness',
    title: 'Product catalog cost completeness (active products)',
    sql: `select count(*) as total, count(*) filter (where active) as active,
                 count(*) filter (where active and (cost_per_unit is null or cost_per_unit <= 0)) as no_cost_per_unit,
                 count(*) filter (where active and (best_price is null or best_price <= 0)) as no_best_price,
                 count(*) filter (where active and cost_unit is null) as no_cost_unit,
                 count(*) filter (where active and needs_pricing) as needs_pricing,
                 count(*) filter (where active and unit_size_oz is null) as no_unit_size_oz,
                 count(*) filter (where active and default_rate_per_1000 is null and default_rate is null) as no_rate,
                 count(*) filter (where active and rate_unit is null) as no_rate_unit,
                 count(*) filter (where active and label_verified_at is null) as label_unverified,
                 count(*) filter (where active and best_price_updated_at is null) as best_price_never_updated,
                 count(*) filter (where active and best_price_updated_at < now() - interval '90 days') as best_price_stale_90d,
                 count(*) filter (where active and best_price_status <> 'current') as best_price_not_current
          from products_catalog`,
  },
  {
    key: 'products_unit_vocab',
    title: 'Product cost_unit / rate_unit vocabulary (active)',
    sql: `select 'cost_unit' as field, coalesce(cost_unit,'NULL') as value, count(*) from products_catalog where active group by 1,2
          union all
          select 'rate_unit', coalesce(rate_unit,'NULL'), count(*) from products_catalog where active group by 1,2
          order by 1, 3 desc`,
  },
  {
    key: 'products_duplicates',
    title: 'Duplicate product names / SKUs (active)',
    sql: `select 'dup_name' as kind, count(*) from (select lower(name) n from products_catalog where active group by 1 having count(*)>1) x
          union all select 'dup_sku', count(*) from (select sku from products_catalog where active and sku is not null group by 1 having count(*)>1) y`,
  },
  {
    key: 'vendor_pricing_quality',
    title: 'Vendor pricing normalization',
    sql: `select count(*) as rows, count(*) filter (where is_active) as active,
                 count(*) filter (where price_per_oz is null and normalized_unit_price is null) as no_normalized_unit_price,
                 count(*) filter (where unit is null) as no_unit,
                 count(*) filter (where approval_status in ('approved','auto_approved')) as approved,
                 count(*) filter (where last_checked_at < now() - interval '90 days') as stale_90d
          from vendor_pricing`,
  },
  {
    key: 'service_product_usage_quality',
    title: 'service_product_usage (the estimate audit COGS map) completeness',
    sql: `select count(*) as rows, count(distinct u.service_type) as service_types,
                 count(*) filter (where u.usage_amount is null and u.usage_per_1000sf is null) as no_quantity,
                 count(*) filter (where u.usage_unit is null) as no_unit,
                 count(*) filter (where p.id is null) as product_missing,
                 count(*) filter (where p.id is not null and (p.cost_per_unit is null or p.cost_per_unit<=0) and (p.best_price is null or p.best_price<=0)) as product_no_cost,
                 count(*) filter (where not exists (select 1 from services s where s.service_key = u.service_type)) as service_type_not_a_catalog_key
          from service_product_usage u left join products_catalog p on p.id = u.product_id`,
  },
  {
    key: 'lawn_protocol_products_quality',
    title: 'lawn_protocol_products rate / carrier / product-link completeness',
    sql: `select count(*) as rows, count(*) filter (where product_id is null) as unlinked_product,
                 count(*) filter (where rate_per_1000 is null) as no_rate, count(*) filter (where rate_unit is null) as no_rate_unit,
                 count(*) filter (where carrier_gal_per_1000 is null) as no_carrier
          from lawn_protocol_products`,
  },
  {
    key: 'protocol_templates',
    title: 'Deterministic protocol templates and their product rows',
    sql: `select count(*) as templates, count(*) filter (where status='active') as active,
                 (select count(*) from protocol_template_products) as product_rows,
                 (select count(*) from protocol_template_products where rate is null) as product_rows_without_rate
          from protocol_templates`,
  },
  {
    key: 'equipment_calibrations',
    title: 'Equipment calibrations (field-verified status)',
    sql: `select es.name as system, es.system_type, es.tank_capacity_gal, c.carrier_gal_per_1000, c.pump_output_reference_gpm,
                 c.gun_output_reference_gpm, c.flow_output_reference_gpm, c.calibration_status, c.active, c.calibrated_at::date as calibrated, c.verified_at::date as verified
          from equipment_calibrations c join equipment_systems es on es.id = c.equipment_system_id order by c.calibrated_at`,
  },
  {
    key: 'pricing_config_overview',
    title: 'pricing_config rows (DB-authoritative knobs) and audit trail',
    sql: `select (select count(*) from pricing_config) as config_rows,
                 (select count(*) from pricing_config_audit) as audit_rows,
                 (select count(*) from pricing_changelog) as changelog_rows,
                 (select max(updated_at)::date from pricing_config) as newest_config_update,
                 (select max(changed_at)::date from pricing_changelog) as newest_changelog`,
  },
  {
    key: 'pricing_config_core_values',
    title: 'Core pricing_config values to compare against constants.js',
    sql: `select config_key, updated_at::date as updated,
                 case config_key
                   when 'global_labor_rate' then data->>'value'
                   when 'global_drive_time' then data->>'value'
                   when 'global_admin_annual' then data->>'value'
                   when 'global_margin_floor' then data->>'value'
                   when 'pest_base' then (data->>'base') || ' / floor ' || (data->>'floor')
                   when 'waveguard_tiers' then (data->'silver'->>'discount') || '/' || (data->'gold'->>'discount') || '/' || (data->'platinum'->>'discount')
                   when 'rodent_waveguard' then 'tier_qualifier=' || (data->>'tier_qualifier') || ' exclude_pct=' || (data->>'exclude_from_pct_discount')
                   when 'waveguard_qualifying' then data->>'services'
                   when 'ts_frequencies' then data::text
                   when 'onetime_pest' then data::text
                   when 'onetime_wdo' then data->'brackets'->0->>'price'
                   else left(data::text, 120) end as value
          from pricing_config
          where config_key in ('global_labor_rate','global_drive_time','global_admin_annual','global_margin_floor','pest_base','waveguard_tiers','rodent_waveguard','waveguard_qualifying','ts_frequencies','onetime_pest','onetime_wdo','global_processing','waveguard_caps','pest_service_costs')
          order by config_key`,
  },
  {
    key: 'estimates_authority',
    title: 'Estimates by pricing authority and status (live rows)',
    sql: `select coalesce(pricing_authority,'NULL') as authority, status, count(*)
          from estimates where archived_at is null group by 1,2 order by 3 desc`,
  },
  {
    key: 'estimates_defaulted_inputs',
    title: 'Live estimates carrying synthetic / low-confidence scope inputs',
    sql: `select count(*) filter (where estimate_data::text like '%property_measurements_defaulted%') as measurements_defaulted,
                 count(*) filter (where status in ('sent','viewed','accepted') and estimate_data::text like '%property_measurements_defaulted%') as measurements_defaulted_delivered,
                 count(*) filter (where estimate_data::text like '%lotFallback%') as turf_lot_fallback,
                 count(*) filter (where status in ('sent','viewed','accepted') and estimate_data::text like '%lotFallback%') as turf_lot_fallback_delivered,
                 count(*) filter (where estimate_data->'summary'->'manualDiscount'->>'type'='FIXED' and coalesce((estimate_data->'summary'->'manualDiscount'->>'oneTimeAmount')::numeric,-1) <> 0) as fixed_discount_not_replayable
          from estimates where archived_at is null and status not in ('expired','declined')`,
  },
  {
    key: 'estimates_tier_vs_engine',
    title: 'Live estimates whose stored WaveGuard tier differs from the engine tier',
    sql: `select waveguard_tier, count(*) as n,
                 -- IS DISTINCT FROM so a NULL stored tier beside a non-null engine tier counts (codex r2 P2); rows with no engine tier in the snapshot are not comparable
                 -- engine-tier carriers mirror serviceOptOutEngineTierReference (estimate-service-opt-out.js) — codex r3 P2
                 count(*) filter (where ${ENGINE_TIER_SQL} is not null and lower(waveguard_tier) is distinct from lower(${ENGINE_TIER_SQL})) as differs_from_engine
          from estimates where archived_at is null and status in ('sent','viewed','accepted','draft') group by 1 order by 2 desc`,
  },
  {
    key: 'accepted_cost_snapshots',
    title: 'Accepted estimates with a frozen cost/margin snapshot (plus the all-snapshot missing-cost count, scoped separately)',
    sql: `select (select count(*) from estimates where status='accepted') as accepted,
                 (select count(distinct s.estimate_id) from estimate_pricing_audit_snapshots s join estimates e on e.id=s.estimate_id where e.status='accepted') as with_snapshot,
                 -- LATEST snapshot per accepted estimate (snapshots are append-only; the reader uses the newest row — codex r3 P2)
                 (select count(*) from (select distinct on (s.estimate_id) s.estimate_id, s.estimated_cost from estimate_pricing_audit_snapshots s join estimates e on e.id=s.estimate_id where e.status='accepted' order by s.estimate_id, s.snapshot_at desc) latest
                    where latest.estimated_cost is null or latest.estimated_cost = 0) as accepted_without_cost,
                 (select count(*) from estimate_pricing_audit_snapshots) as all_snapshots,
                 (select count(*) from estimate_pricing_audit_snapshots where estimated_cost is null or estimated_cost = 0) as all_snapshots_without_cost`,
  },
  {
    key: 'customers_billing_lanes',
    title: 'Real customers by billing lane and fee coverage',
    sql: `select coalesce(billing_mode,'NULL') as lane, count(*) as n,
                 count(*) filter (where monthly_rate > 0) as with_monthly_rate,
                 count(*) filter (where per_application_fee > 0) as with_per_application_fee,
                 count(*) filter (where billing_mode='per_application' and (per_application_fee is null or per_application_fee <= 0)) as per_app_without_fee,
                 count(*) filter (where per_application_fee > 0 and monthly_rate > 0 and abs(per_application_fee - monthly_rate) < 0.01) as fee_equals_monthly
          from customers where pipeline_stage in ('active_customer','won','at_risk') group by 1 order by 2 desc`,
  },
  {
    key: 'visits_uninvoiced',
    // Mirrors uninvoicedLeakQuery in server/routes/admin-billing-recovery.js
    // (the authoritative Billing Recovery workbench predicate — codex r3 P1):
    // effective price > 0 (row price, else the per-application fee), completed
    // service record or status-only completion, not dispositioned, no
    // non-void invoice on the record or the visit, no callback on either row,
    // not fully prepaid, self-pay only, never an always-free type, and not an
    // active-autopay customer unless on a per-visit lane. Two deliberate
    // differences: membership-covered visits are excluded outright (dues cover
    // them), and any visit stamped with an annual-prepay term is excluded —
    // the workbench validates term coverage in JS (annualPrepayCoversVisit),
    // which this raw-SQL audit cannot, so it under-counts lapsed terms.
    title: `Completed billable visits since ${SINCE} with no invoice (by lane) — Billing Recovery predicate`,
    params: [SINCE, TODAY_ET],
    sql: `with u as (
            select distinct ss.id, ss.customer_id, ss.scheduled_date, ${EFFECTIVE_PRICE_SQL} as effective_price, c.billing_mode
            from scheduled_services ss
            join customers c on c.id = ss.customer_id
            left join service_records sr on sr.scheduled_service_id = ss.id
            left join visit_billing_dispositions d on d.scheduled_service_id = ss.id
            where ss.status='completed' and ss.scheduled_date >= $1::date
              and ${EFFECTIVE_PRICE_SQL} > 0
              and d.id is null
              and (sr.status = 'completed' or (sr.id is null and ss.status = 'completed'))
              and not exists (select 1 from invoices i where (i.service_record_id = sr.id or i.scheduled_service_id = ss.id) and coalesce(i.status, '') <> 'void')
              and coalesce(ss.is_callback,false) = false and coalesce(sr.is_callback,false) = false
              and coalesce(ss.prepaid_amount,0) < ${EFFECTIVE_PRICE_SQL}
              and ss.annual_prepay_term_id is null
              and coalesce(ss.payer_id, case when coalesce(ss.self_pay_override,false) then null else c.payer_id end) is null
              and coalesce(ss.service_type,'') not ilike all (array[${ALWAYS_FREE_SQL_ARRAY}]::text[])
              and coalesce(c.billing_mode,'') <> 'monthly_membership'
              and (not ${AUTOPAY_ACTIVE_SQL} or c.billing_mode in ('per_application','per_visit','one_time')))
          select coalesce(billing_mode,'NULL') as lane, count(*) as uninvoiced,
                 count(*) filter (where not exists (select 1 from invoices i where i.customer_id = u.customer_id and i.archived_at is null and i.service_date between u.scheduled_date - 3 and u.scheduled_date + 3)) as no_invoice_within_3_days,
                 round(coalesce(sum(effective_price) filter (where not exists (select 1 from invoices i where i.customer_id = u.customer_id and i.archived_at is null and i.service_date between u.scheduled_date - 3 and u.scheduled_date + 3)),0)::numeric,2) as est_price_at_risk
          from u group by 1 order by 2 desc`,
  },
  {
    key: 'visit_actual_minutes',
    // Recorded check-in→check-out spans, NOT on-site time: check-out is often
    // stamped while driving to the next stop (owner 2026-09-02, MON-004).
    title: `Completed-visit RECORDED span minutes (check-in→check-out, often includes drive — not on-site time) by service type since ${SINCE} (n ≥ 3)`,
    params: [SINCE],
    sql: `with v as (
            select service_type, coalesce(time_on_site_adjusted_minutes, actual_duration_minutes, (extract(epoch from (check_out_time - check_in_time))/60)::int) as mins,
                   estimated_duration_minutes as est, estimated_price as price
            from scheduled_services
            where status='completed' and scheduled_date >= $1::date
              and (time_on_site_adjusted_minutes is not null or actual_duration_minutes is not null or (check_in_time is not null and check_out_time is not null)))
          select service_type, count(*) as n, round(avg(est)) as scheduled_est_avg,
                 round((percentile_cont(0.5) within group (order by mins))::numeric) as median_min,
                 round(avg(mins)::numeric) as avg_min,
                 round((percentile_cont(0.75) within group (order by mins))::numeric) as p75_min,
                 round((percentile_cont(0.9) within group (order by mins))::numeric) as p90_min,
                 round(avg(price)::numeric,2) as price_avg,
                 round(avg(price / nullif(mins, 0) * 60) filter (where mins between 1 and 600 and price > 0)::numeric, 2) as realized_per_hour_over_recorded_span
          from v where mins between 1 and 600 group by 1 having count(*) >= 3 order by n desc`,
  },
  {
    key: 'job_costs_quality',
    title: 'job_costs (actual costing ledger) sanity by service type (n ≥ 3)',
    sql: `select service_type, count(*) as n, round(avg(revenue)::numeric,2) as rev_avg, round(avg(labor_cost)::numeric,2) as labor_avg,
                 round(avg(products_cost)::numeric,2) as products_avg, round(avg(drive_cost)::numeric,2) as drive_avg, round(avg(equipment_cost)::numeric,2) as equipment_avg,
                 round(avg(margin_pct)::numeric,1) as margin_avg, count(*) filter (where products_cost = 0) as zero_products, count(*) filter (where revenue = 0) as zero_revenue,
                 count(*) filter (where products_cost > revenue and revenue > 0) as products_exceed_revenue
          from job_costs group by 1 having count(*) >= 3 order by n desc`,
  },
  {
    key: 'service_type_taxonomy_drift',
    title: 'Completed visits: service_type strings vs catalog names/keys',
    sql: `select count(distinct service_type) as distinct_service_types,
                 count(distinct service_type) filter (where exists (select 1 from services s where s.name = ss.service_type)) as match_catalog_name,
                 count(distinct service_type) filter (where exists (select 1 from services s where s.service_key = ss.service_type)) as match_catalog_key,
                 count(*) filter (where service_key_snapshot is not null) as visits_with_key_snapshot, count(*) as visits
          from scheduled_services ss where status='completed'`,
  },
];

async function main() {
  const url = process.env.AUDIT_DB_URL;
  if (!url) { console.error('AUDIT_DB_URL is required (read-only role recommended). DATABASE_URL is deliberately ignored.'); process.exit(2); }
  const u = new URL(url);
  const client = new Client({ connectionString: url, application_name: 'pricing_audit_ro', ssl: /railway|proxy|rlwy/.test(u.hostname) ? { rejectUnauthorized: false } : undefined, statement_timeout: 120000 });
  await client.connect();
  await client.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  const results = [];
  const md = ['# Pricing data-quality audit (read-only)', '', `Generated ${new Date().toISOString()} · database host ${u.hostname.replace(/[A-Za-z0-9]{4,}/g, (m) => m.slice(0, 2) + '…')} · window since ${SINCE}`, ''];
  for (const check of CHECKS) {
    let rows; let error = null;
    try { rows = (await client.query(check.sql, check.params || [])).rows; } catch (e) { rows = []; error = e.message; }
    results.push({ key: check.key, title: check.title, rows, error });
    md.push(`## ${check.title}`, '');
    if (error) { md.push(`_query failed: ${error}_`, ''); continue; }
    if (!rows.length) { md.push('_(0 rows)_', ''); continue; }
    const cols = Object.keys(rows[0]);
    md.push(`| ${cols.join(' | ')} |`, `|${cols.map(() => '---').join('|')}|`);
    for (const r of rows) md.push(`| ${cols.map((c) => (r[c] === null ? 'NULL' : typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]).replace(/\|/g, '\\|'))).join(' | ')} |`);
    md.push('');
  }
  await client.end();
  const text = md.join('\n');
  if (MD_OUT) fs.writeFileSync(MD_OUT, text);
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ generatedAt: new Date().toISOString(), since: SINCE, results }, null, 1));
  console.log(text);
  // A check whose query failed is recorded in the report AND fails the run:
  // a partial report must never exit 0 and pass for a completed audit
  // (codex pre-push P1 on PR #3792).
  const failed = results.filter((r) => r.error);
  if (failed.length) {
    console.error(`${failed.length} check(s) failed: ${failed.map((r) => r.key).join(', ')}`);
    process.exit(4);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
