#!/usr/bin/env node
'use strict';

/**
 * Repair: clear HOUSE square footage that the public quote form wrote into the LAWN mirror.
 *
 * Until 2026-10-23 routes/public-quote.js stored the quote's clamped home size (`sqft`, default 2,000) in
 * customers.property_sqft, and customer-properties.js copied it into the primary property's property_sqft. Both
 * columns are the treated-lawn mirror by schema contract (initial_schema 20260401000001): lawn-size-sync and
 * property-service-areas write the turf profile and these two mirrors together. A house size there made the lawn
 * backfill refuse the estimate's turf figure (has_size) and read as a lawn to every lawn reader.
 *
 * A row is a candidate only when ALL of these hold, so a real lawn size is never cleared:
 *   - the active turf profile has no lawn_sqft (every lawn writer sets the turf row together with the mirrors);
 *   - no reviewed lawn area sits on the primary property (service-area review also writes the turf row);
 *   - a write of the SAME quote request records that exact number as the home size: its quote-wizard estimate
 *     (estimates.source = 'quote_wizard') for the customer's PRIMARY property (estimateTargetsPrimary: property
 *     link or address match), or its lead row (leads.lead_type = 'quote_wizard', linked by customer_id, with
 *     extracted_data.homeSqFt). The lead covers a request whose customer update committed but whose estimate
 *     upsert failed (the two ran in separate try blocks). No customer-row marker is used: the old route kept an
 *     existing lead_source and copied attribution text into lead_source_detail, so no stamp is reliable
 *     (codex #6520 r2).
 *   - WRITE PROVENANCE: the customer row itself was created by that quote request (customers.created_at within
 *     QUOTE_WRITE_WINDOW_MS of the proving estimate's / lead's created_at). The new-lead insert wrote property_sqft
 *     unconditionally, so for such a row the value can only be the house. The existing-customer update only filled
 *     a NULL, so an older customer with a legacy lawn mirror and a later quote whose home size happens to match
 *     (the 2,000 default most of all) is NOT proven: it is listed as legacy_ambiguous_review and never applied
 *     (pre-push audit on 75ecf0d2f9).
 *   A legacy lawn mirror with no turf row is left alone unless a quote write ties it to the number (codex #6520
 *   r1 P1: an unrelated estimate's home size must not clear a real lawn by numerical coincidence).
 * --apply nulls customers.property_sqft and, when it holds the same number, the primary property's property_sqft,
 * under the turf-profile fence, one customer per transaction, with one audit row. Afterwards run
 * backfill-lawn-sqft-from-estimate.js (--use-unconfirmed-when-empty, per the owner's 2026-10-04 ruling) so the
 * now-empty customers get their estimate's turf figure.
 *
 * Usage (from the repo root, DATABASE_URL set):
 *   node server/scripts/repair-house-sqft-in-lawn-mirror.js --out /path/dry-run.csv
 *   node server/scripts/repair-house-sqft-in-lawn-mirror.js --apply --i-am-sure-this-is-the-intended-database --out /path/applied.csv
 *   --only <customerId>   one customer
 */

const fs = require('fs');
const { estimateTargetsPrimary } = require('../services/lawn-size-sync');

const QUOTE_ESTIMATE_SOURCE = 'quote_wizard';
const QUOTE_LEAD_TYPE = 'quote_wizard';
// A quote request creates the lead, the customer and the estimate within one request; minutes of slack for retries.
const QUOTE_WRITE_WINDOW_MS = 15 * 60 * 1000;

function ms(v) { const t = v instanceof Date ? v.getTime() : Date.parse(v); return Number.isFinite(t) ? t : null; }

/** The customer row was created by the same quote request as the evidence row (write provenance). */
function createdByQuote(customer, evidenceCreatedAt) {
  const c = ms(customer?.created_at);
  const e = ms(evidenceCreatedAt);
  if (c == null || e == null) return false;
  return Math.abs(c - e) <= QUOTE_WRITE_WINDOW_MS;
}

const HOME_SQFT_CARRIERS = [
  ['engineRequest.profile', (d) => d.engineRequest?.profile],
  ['engineRequest', (d) => d.engineRequest],
  ['engineInputs', (d) => d.engineInputs],
  ['engineInput', (d) => d.engineInput],
  ['inputs', (d) => d.inputs],
  ['request.profile', (d) => d.request?.profile],
  ['request', (d) => d.request],
  ['profile', (d) => d.profile],
  ['intake', (d) => d.intake],
  ['lead', (d) => d.lead],
];
const HOME_SQFT_KEYS = ['homeSqFt', 'squareFootage', 'homeSquareFeet', 'sqft'];

function parseData(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return {};
  try { const p = JSON.parse(raw); return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; }
}

/** Every home-size figure an estimate records, with where it was read. Pure. */
function homeSqFtFromEstimate(estimateData) {
  const d = parseData(estimateData);
  const out = [];
  for (const [where, get] of HOME_SQFT_CARRIERS) {
    const carrier = get(d);
    if (!carrier || typeof carrier !== 'object') continue;
    for (const key of HOME_SQFT_KEYS) {
      const n = Number(carrier[key]);
      if (Number.isFinite(n) && n > 0) out.push({ field: `${where}.${key}`, value: Math.round(n) });
    }
  }
  return out;
}

/**
 * Classify one customer. Pure. `estimates` = every estimate row of the customer (any status: the quote writes the
 * lead's estimate before it is accepted, and the house value lands with it); `leads` = the customer's quote-wizard
 * lead rows. Only a quote-wizard estimate for the customer's primary property, or a quote-wizard lead linked to the
 * customer, can prove a house value.
 * @returns {{ class: string, houseField?: string, propertySqft?: number, primaryMatches?: boolean }}
 */
function classify({ customer, turf, primary, estimates, leads }) {
  const propertySqft = Number(customer.property_sqft);
  if (!(propertySqft > 0)) return { class: 'no_property_sqft' };
  if (Number(turf?.lawn_sqft) > 0) return { class: 'has_turf_lawn', propertySqft };
  const reviewed = primary?.service_area_measurements;
  const reviewedLawn = (typeof reviewed === 'string' ? parseData(reviewed) : reviewed)?.areas?.lawn?.sqft;
  if (Number(reviewedLawn) > 0) return { class: 'has_reviewed_lawn', propertySqft };
  // The quote's own writes that record this exact number as the home size.
  const evidence = [];
  for (const e of estimates || []) {
    if (e.source !== QUOTE_ESTIMATE_SOURCE) continue;
    if (!estimateTargetsPrimary(e, customer, primary).match) continue;
    const hit = homeSqFtFromEstimate(e.estimate_data).find((h) => h.value === propertySqft);
    if (hit) evidence.push({ houseField: hit.field, estimateId: e.id, createdAt: e.created_at });
  }
  for (const l of leads || []) {
    if (l.lead_type !== QUOTE_LEAD_TYPE) continue;
    const n = Number(parseData(l.extracted_data).homeSqFt);
    if (Number.isFinite(n) && Math.round(n) === propertySqft) evidence.push({ houseField: 'lead.extracted_data.homeSqFt', leadId: l.id, createdAt: l.created_at });
  }
  if (!evidence.length) return { class: 'unproven', propertySqft };
  const primaryMatches = !!primary && Number(primary.property_sqft) === propertySqft;
  // Provenance: only a customer row the quote created can have had the house written unconditionally.
  const own = evidence.find((ev) => createdByQuote(customer, ev.createdAt));
  if (!own) return { class: 'legacy_ambiguous_review', houseField: evidence[0].houseField, estimateId: evidence[0].estimateId, leadId: evidence[0].leadId, propertySqft, primaryMatches };
  return { class: 'house_in_lawn_mirror', houseField: own.houseField, estimateId: own.estimateId, leadId: own.leadId, propertySqft, primaryMatches };
}

function parseArgs(argv) {
  const out = { apply: false, sure: false, out: null, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.apply = false;
    else if (a === '--i-am-sure-this-is-the-intended-database') out.sure = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.out) throw new Error('--out <file> is required');
  if (out.apply && !out.sure) throw new Error('--apply requires --i-am-sure-this-is-the-intended-database');
  return out;
}

async function loadCustomers(knex, only) {
  const q = knex('customers as c')
    .leftJoin('customer_turf_profiles as tp', function joinActive() { this.on('tp.customer_id', '=', 'c.id').andOnVal('tp.active', '=', true); })
    .leftJoin('customer_properties as cp', function joinPrimary() { this.on('cp.customer_id', '=', 'c.id').andOnVal('cp.is_primary', '=', true).andOnVal('cp.active', '=', true); })
    .whereNull('c.deleted_at')
    .where('c.property_sqft', '>', 0)
    .select('c.id', 'c.property_sqft', 'c.created_at', 'c.lead_source', 'c.lead_source_detail', 'c.address_line1', 'c.address_line2', 'c.city', 'c.state', 'c.zip',
      'tp.lawn_sqft as turf_lawn_sqft', 'cp.id as primary_id', 'cp.property_sqft as primary_property_sqft', 'cp.service_area_measurements',
      'cp.address_line1 as p_address_line1', 'cp.address_line2 as p_address_line2', 'cp.city as p_city', 'cp.state as p_state', 'cp.zip as p_zip')
    .orderBy('c.id');
  if (only) q.where('c.id', only);
  const rows = await q;
  const ids = rows.map((r) => r.id);
  const estimates = ids.length ? await knex('estimates').whereIn('customer_id', ids).select('id', 'customer_id', 'status', 'source', 'property_id', 'address', 'created_at', 'estimate_data') : [];
  const byCustomer = new Map();
  for (const e of estimates) byCustomer.set(e.customer_id, [...(byCustomer.get(e.customer_id) || []), e]);
  const leads = ids.length ? await knex('leads').whereIn('customer_id', ids).where({ lead_type: QUOTE_LEAD_TYPE }).select('id', 'customer_id', 'lead_type', 'created_at', 'extracted_data') : [];
  const leadsBy = new Map();
  for (const l of leads) leadsBy.set(l.customer_id, [...(leadsBy.get(l.customer_id) || []), l]);
  return rows.map((r) => ({
    customer: { id: r.id, property_sqft: r.property_sqft, created_at: r.created_at, lead_source: r.lead_source, lead_source_detail: r.lead_source_detail, address_line1: r.address_line1, address_line2: r.address_line2, city: r.city, state: r.state, zip: r.zip },
    turf: { lawn_sqft: r.turf_lawn_sqft },
    primary: r.primary_id ? { id: r.primary_id, property_sqft: r.primary_property_sqft, service_area_measurements: r.service_area_measurements, address_line1: r.p_address_line1, address_line2: r.p_address_line2, city: r.p_city, state: r.p_state, zip: r.p_zip } : null,
    estimates: byCustomer.get(r.id) || [],
    leads: leadsBy.get(r.id) || [],
  }));
}

async function applyOne(db, entry, verdict) {
  const { withTurfProfileFence } = require('../services/customer-pricing-ai');
  const { recordAuditEvent } = require('../services/audit-log');
  return withTurfProfileFence(db, entry.customer.id, async (trx) => {
    // Re-read under the fence: a lawn write that landed since the dry run wins.
    const [fresh] = await loadCustomersWithin(trx, entry.customer.id);
    const again = fresh ? classify(fresh) : { class: 'gone' };
    if (again.class !== 'house_in_lawn_mirror') return { status: 'skipped', reason: again.class };
    await trx('customers').where({ id: entry.customer.id, property_sqft: again.propertySqft }).update({ property_sqft: null, updated_at: trx.fn.now() });
    let primaryCleared = false;
    if (again.primaryMatches && fresh.primary) {
      primaryCleared = !!(await trx('customer_properties').where({ id: fresh.primary.id, property_sqft: again.propertySqft }).update({ property_sqft: null, updated_at: trx.fn.now() }));
    }
    await recordAuditEvent({
      actor_type: 'system',
      action: 'customer.property_sqft.house_value_cleared',
      resource_type: 'customer',
      resource_id: entry.customer.id,
      metadata: { cleared: again.propertySqft, house_field: again.houseField, estimate_id: again.estimateId ?? null, lead_id: again.leadId ?? null, primary_property_id: fresh.primary?.id ?? null, primary_cleared: primaryCleared, script: 'repair-house-sqft-in-lawn-mirror' },
      critical: true,
      trx,
    });
    return { status: 'cleared', cleared: again.propertySqft, primaryCleared };
  });
}

async function loadCustomersWithin(trx, id) {
  return loadCustomers(trx, id);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = require('../models/db');
  const host = (() => { try { const u = new URL(process.env.DATABASE_URL); return `${u.hostname.slice(0, 2)}***${u.hostname.slice(-3)}`; } catch { return '?'; } })();
  console.log(`[house-sqft-repair] ${args.apply ? 'APPLY' : 'DRY RUN'} against host=${host}`);
  const entries = await loadCustomers(db, args.only);
  const lines = ['customer_id,class,property_sqft,primary_property_sqft,house_field,estimate_id,lead_id,lead_source,status'];
  const counts = {};
  for (const entry of entries) {
    const v = classify(entry);
    counts[v.class] = (counts[v.class] || 0) + 1;
    let status = '';
    if (args.apply && v.class === 'house_in_lawn_mirror') {
      const r = await applyOne(db, entry, v);
      status = r.status === 'cleared' ? `cleared${r.primaryCleared ? '+primary' : ''}` : `${r.status}:${r.reason}`;
      console.log(`[house-sqft-repair] ${entry.customer.id} ${status}`);
    }
    lines.push([entry.customer.id, v.class, v.propertySqft ?? '', entry.primary?.property_sqft ?? '', v.houseField ?? '', v.estimateId ?? '', v.leadId ?? '', entry.customer.lead_source ?? '', status].join(','));
  }
  fs.writeFileSync(args.out, `${lines.join('\n')}\n`);
  console.log(`[house-sqft-repair] ${entries.length} customers with a property_sqft: ${JSON.stringify(counts)}`);
  console.log(`[house-sqft-repair] CSV: ${args.out}`);
  await db.destroy();
}

if (require.main === module) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}

module.exports = { classify, homeSqFtFromEstimate, createdByQuote, parseArgs, QUOTE_WRITE_WINDOW_MS };
