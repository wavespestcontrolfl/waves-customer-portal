#!/usr/bin/env node
/**
 * Backfill email_messages.lead_id / estimate_id (migration 20260930010000) for
 * mail that was sent to a prospect before the send path recorded them.
 *
 *   node scripts/backfill-lead-email-links.js             # DRY RUN (default): reads only
 *   node scripts/backfill-lead-email-links.js --execute   # writes lead_id / estimate_id
 *   node scripts/backfill-lead-email-links.js --limit 500 # cap candidate rows (either mode)
 *   node scripts/backfill-lead-email-links.js --samples 10 # ids listed per bucket in the report
 *
 * OWNER APPROVAL FIRST. The dry run makes no write of any kind (the whole run
 * is one READ ONLY transaction), so it is safe to run against any database.
 * --execute is a single transaction that only ever touches lead_id and
 * estimate_id on rows where BOTH are still NULL; re-running is a no-op.
 *
 * Candidates: email_messages rows that are lead-typed or untyped
 * (recipient_type NULL, '' or 'lead') with neither link set. Test sends,
 * admin mail and customer-typed mail are never candidates.
 *
 * How each row is linked (strongest evidence first; the address is NEVER used,
 * so two people sharing an inbox cannot be joined by this script):
 *   estimate  1. the automation run that sent it (automation_run_id ->
 *                email_template_automation_runs.entity_id, entity_type 'estimate')
 *             2. a UUID in trigger_event_id / idempotency_key that is an
 *                estimates.id (estimate_delivery:<id>, estimate_followup_*:<id>...)
 *             3. the row's own rendered body: exactly one /estimate/<token> link
 *                whose token belongs to exactly one estimate
 *   lead      1. recipient_id when it is a leads.id
 *             2. the lead that owns the resolved estimate (leads.estimate_id,
 *                newest not-deleted)
 *             3. a UUID in trigger_event_id that is a leads.id
 *
 * Only lead_id / estimate_id are written. recipient_type, recipient_id and
 * updated_at are left alone (the Activity timeline dates a failed email by
 * updated_at, so touching it would move history). The report prints counts by
 * template and method, then how many customers gain timeline rows; it prints
 * row ids only, never addresses, subjects or names.
 */
require('dotenv').config();

const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ESTIMATE_LINK_G = /\/estimate\/([A-Za-z0-9_-]{6,})/g;
const BATCH = 500;

function uuidsIn(text) {
  return [...new Set((String(text || '').match(UUID_G) || []).map((s) => s.toLowerCase()))];
}

function estimateTokensIn(html) {
  const tokens = new Set();
  for (const m of String(html || '').matchAll(ESTIMATE_LINK_G)) tokens.add(m[1]);
  return [...tokens];
}

/**
 * Pure planner. `row` is a candidate; `ref` holds already-fetched lookups:
 *   estimatesById: Set of estimate ids that exist
 *   estimateByToken: Map token -> [estimate ids]
 *   runEstimate: Map automation run id -> estimate id
 *   leadsById: Set of lead ids that exist
 *   leadByEstimate: Map estimate id -> lead id
 * Returns { lead_id, estimate_id, estimateVia, leadVia }.
 */
function planRow(row, ref) {
  const out = { lead_id: null, estimate_id: null, estimateVia: null, leadVia: null };
  const ids = [...uuidsIn(row.trigger_event_id), ...uuidsIn(row.idempotency_key)];

  const viaRun = row.automation_run_id ? ref.runEstimate.get(String(row.automation_run_id)) : null;
  if (viaRun) {
    out.estimate_id = viaRun; out.estimateVia = 'automation_run';
  } else {
    const viaTrigger = ids.filter((id) => ref.estimatesById.has(id));
    if (viaTrigger.length === 1) {
      out.estimate_id = viaTrigger[0]; out.estimateVia = 'trigger_event';
    } else if (!viaTrigger.length) {
      const owners = new Set(estimateTokensIn(row.html_snapshot).flatMap((t) => ref.estimateByToken.get(t) || []));
      if (owners.size === 1) { out.estimate_id = [...owners][0]; out.estimateVia = 'estimate_link'; }
    }
  }

  const rid = String(row.recipient_id || '').toLowerCase();
  if (rid && ref.leadsById.has(rid)) {
    out.lead_id = rid; out.leadVia = 'recipient';
  } else if (out.estimate_id && ref.leadByEstimate.has(out.estimate_id)) {
    out.lead_id = ref.leadByEstimate.get(out.estimate_id); out.leadVia = 'estimate_owner';
  } else {
    const viaTrigger = ids.filter((id) => ref.leadsById.has(id));
    if (viaTrigger.length === 1) { out.lead_id = viaTrigger[0]; out.leadVia = 'trigger_event'; }
  }
  return out;
}

async function loadRefs(dbh, rows) {
  const ids = new Set();
  const tokens = new Set();
  const runIds = new Set();
  for (const r of rows) {
    for (const id of [...uuidsIn(r.trigger_event_id), ...uuidsIn(r.idempotency_key)]) ids.add(id);
    const rid = String(r.recipient_id || '').toLowerCase();
    if (/^[0-9a-f-]{36}$/.test(rid)) ids.add(rid);
    for (const t of estimateTokensIn(r.html_snapshot)) tokens.add(t);
    if (r.automation_run_id && uuidsIn(r.automation_run_id).length) runIds.add(String(r.automation_run_id).toLowerCase());
  }
  const idList = [...ids];
  const estimatesById = new Set();
  const leadsById = new Set();
  const runEstimate = new Map();
  const estimateByToken = new Map();
  if (idList.length) {
    (await dbh('estimates').whereIn('id', idList).select('id')).forEach((e) => estimatesById.add(e.id));
    (await dbh('leads').whereIn('id', idList).select('id')).forEach((l) => leadsById.add(l.id));
  }
  if (runIds.size) {
    const runs = await dbh('email_template_automation_runs').whereIn('id', [...runIds])
      .where({ entity_type: 'estimate' }).select('id', 'entity_id');
    for (const r of runs) if (uuidsIn(r.entity_id).length) runEstimate.set(r.id, r.entity_id.toLowerCase());
  }
  if (tokens.size) {
    const ests = await dbh('estimates').whereIn('token', [...tokens]).select('id', 'token');
    for (const e of ests) estimateByToken.set(e.token, [...(estimateByToken.get(e.token) || []), e.id]);
  }
  // leads that own an estimate found by any route above
  const estimateIds = new Set([...estimatesById, ...runEstimate.values(), ...[...estimateByToken.values()].flat()]);
  const leadByEstimate = new Map();
  if (estimateIds.size) {
    const owners = await dbh('leads').whereIn('estimate_id', [...estimateIds]).whereNull('deleted_at')
      .orderBy('created_at', 'asc').select('id', 'estimate_id');
    for (const l of owners) leadByEstimate.set(l.estimate_id, l.id); // newest wins (asc, last set)
  }
  return { estimatesById, leadsById, runEstimate, estimateByToken, leadByEstimate };
}

async function* candidateBatches(dbh, limit) {
  let after = null;
  let seen = 0;
  for (;;) {
    const take = limit ? Math.min(BATCH, limit - seen) : BATCH;
    if (take <= 0) return;
    const q = dbh('email_messages')
      .whereNull('lead_id').whereNull('estimate_id')
      .whereRaw("COALESCE(recipient_type, '') IN ('', 'lead')")
      .orderBy('id', 'asc').limit(take)
      .select('id', 'template_key', 'recipient_id', 'trigger_event_id', 'idempotency_key', 'automation_run_id', 'html_snapshot');
    if (after) q.where('id', '>', after);
    const rows = await q;
    if (!rows.length) return;
    seen += rows.length;
    after = rows[rows.length - 1].id;
    yield rows;
  }
}

function bump(map, key, field) {
  const e = map.get(key) || { rows: 0, lead: 0, estimate: 0, none: 0 };
  e.rows += 1;
  if (field) e[field] += 1;
  map.set(key, e);
}

async function run({ execute = false, limit = null, samples = 5, dbh, log = console.log } = {}) {
  const started = Date.now();
  const totals = { candidates: 0, linked: 0, unresolved: 0 };
  const byTemplate = new Map();
  const viaEstimate = {};
  const viaLead = {};
  const sample = { linked: [], unresolved: [] };
  const updates = [];
  const leadIds = new Set();
  const estimateIds = new Set();

  await dbh.transaction(async (trx) => {
    if (!execute) await trx.raw('SET TRANSACTION READ ONLY');
    for await (const rows of candidateBatches(trx, limit)) {
      const ref = await loadRefs(trx, rows);
      for (const row of rows) {
        totals.candidates += 1;
        const plan = planRow(row, ref);
        const tpl = row.template_key || '(none)';
        if (!plan.lead_id && !plan.estimate_id) {
          totals.unresolved += 1;
          bump(byTemplate, tpl, 'none');
          if (sample.unresolved.length < samples) sample.unresolved.push(row.id);
          continue;
        }
        totals.linked += 1;
        bump(byTemplate, tpl, plan.lead_id ? 'lead' : null);
        if (plan.estimate_id) byTemplate.get(tpl).estimate += 1;
        if (plan.estimateVia) viaEstimate[plan.estimateVia] = (viaEstimate[plan.estimateVia] || 0) + 1;
        if (plan.leadVia) viaLead[plan.leadVia] = (viaLead[plan.leadVia] || 0) + 1;
        if (plan.lead_id) leadIds.add(plan.lead_id);
        if (plan.estimate_id) estimateIds.add(plan.estimate_id);
        if (sample.linked.length < samples) sample.linked.push(row.id);
        updates.push({ id: row.id, lead_id: plan.lead_id, estimate_id: plan.estimate_id });
      }
    }

    // Customers that gain timeline rows once GATE_LEAD_EMAIL_LINKS is on.
    const customers = new Set();
    if (leadIds.size) {
      (await trx('leads').whereIn('id', [...leadIds]).whereNotNull('customer_id').select('customer_id'))
        .forEach((l) => customers.add(l.customer_id));
    }
    if (estimateIds.size) {
      (await trx('estimates').whereIn('id', [...estimateIds]).whereNotNull('customer_id').select('customer_id'))
        .forEach((e) => customers.add(e.customer_id));
    }

    let written = 0;
    if (execute) {
      for (let i = 0; i < updates.length; i += BATCH) {
        const chunk = updates.slice(i, i + BATCH);
        const values = chunk.map(() => '(?::uuid, ?::uuid, ?::uuid)').join(', ');
        const bindings = chunk.flatMap((u) => [u.id, u.lead_id, u.estimate_id]);
        // The NULL guards make a re-run (or a send that linked itself meanwhile) a no-op.
        const res = await trx.raw(
          `UPDATE email_messages em SET lead_id = v.lead_id, estimate_id = v.estimate_id
             FROM (VALUES ${values}) AS v(id, lead_id, estimate_id)
            WHERE em.id = v.id AND em.lead_id IS NULL AND em.estimate_id IS NULL`,
          bindings,
        );
        written += res.rowCount || 0;
      }
    }

    log(`${execute ? 'EXECUTE' : 'DRY RUN (no writes)'}: ${totals.candidates} candidate rows`);
    log(`  would link / linked: ${totals.linked}   no evidence (left as is): ${totals.unresolved}`);
    log(`  estimate found via: ${JSON.stringify(viaEstimate)}`);
    log(`  lead found via:     ${JSON.stringify(viaLead)}`);
    log(`  customers who gain timeline rows (lead/estimate already converted): ${customers.size}`);
    log('  by template (rows / with lead / with estimate / unresolved):');
    [...byTemplate.entries()].sort((a, b) => b[1].rows - a[1].rows)
      .forEach(([k, v]) => log(`    ${k}: ${v.rows} / ${v.lead} / ${v.estimate} / ${v.none}`));
    log(`  sample linked ids: ${sample.linked.join(', ') || '-'}`);
    log(`  sample unresolved ids: ${sample.unresolved.join(', ') || '-'}`);
    if (execute) log(`  rows updated: ${written}`);
    else log('  Nothing was written. Re-run with --execute after owner approval.');
    totals.written = written;
  });
  totals.ms = Date.now() - started;
  return { totals, byTemplate, viaEstimate, viaLead, updates };
}

function parseArgs(argv) {
  const num = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number.parseInt(argv[i + 1], 10) : null;
  };
  return { execute: argv.includes('--execute'), limit: num('--limit') || null, samples: num('--samples') || 5 };
}

module.exports = { planRow, uuidsIn, estimateTokensIn, run, parseArgs };

if (require.main === module) {
  const db = require('../server/models/db');
  const opts = parseArgs(process.argv.slice(2));
  run({ ...opts, dbh: db })
    .then(() => db.destroy())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(`backfill failed (code ${err?.code || 'n/a'}): ${String(err?.message || err).split('\n')[0].slice(0, 200)}`);
      process.exit(1);
    });
}
