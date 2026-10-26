#!/usr/bin/env node
// READ-ONLY
//
// call-promise-ai-close-dryrun.js — what GATE_CALL_PROMISE_AI_CLOSE would do to
// the Waves call promises that are open right now, with NO writes. It loads the
// open party='waves' promises (the nightly watchdog's own candidate query,
// call-promise-ai-close.js listCandidates) and judges each one with the REAL
// checker (judgeCandidate: loadSmsFulfillmentEvidence + verifySmsFulfillment +
// the later-thread check, live LLM calls) but never stores a verdict, never
// closes a promise, never touches a notification and sends nothing to anyone.
//
// Per promise it prints: id prefix, kind, age in days, the verdict, and — for
// a promise it would close — the proof record type and a short quote. The
// output names no customer; the quotes are the customer-facing words the
// verdict rests on, so keep the output out of the repo and out of PR bodies.
//
// Two independent layers keep it read-only, both set before any server module
// loads (the shape inventory-agent-replay.js proved):
//   1. PGOPTIONS='-c default_transaction_read_only=on' — node-postgres sends it
//      as the startup option on EVERY connection this process opens, the
//      shared server/models/db pool included.
//   2. The LLM ledger / trace / dispatch-metrics gates are forced off, so the
//      telemetry writers are never reached.
// assertReadOnly() then PROVES layer 1 with a real zero-row write attempt: the
// script refuses to run unless Postgres itself rejects it.
process.env.PGOPTIONS = '-c default_transaction_read_only=on';
// The shared pool reads DATABASE_URL; under `railway run` that is Railway's
// internal address, unreachable from a laptop. The public proxy needs TLS.
if (process.env.DATABASE_PUBLIC_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_PUBLIC_URL;
  if (!/sslmode=/.test(process.env.DATABASE_URL) && !process.env.PGSSLMODE) process.env.PGSSLMODE = 'no-verify';
}
process.env.GATE_LLM_CALL_LEDGER = 'false';
process.env.GATE_LLM_DISPATCH_METRICS = 'false';
//
// Needs the portal's API keys and gates, and the Postgres public URL:
//
//   railway run --service waves-customer-portal -- railway run --service Postgres -- node ops/agents/call-promise-ai-close-dryrun.js
//   ... node ops/agents/call-promise-ai-close-dryrun.js --limit=60      # cap model calls (default 150)
//   ... node ops/agents/call-promise-ai-close-dryrun.js --json          # the rows and the tally as JSON
//
// --limit caps model calls (the record check and the thread check each count
// one); promises past the cap print as "deferred". Repeated checks of an
// unchanged promise are free in the real job (the verdict cache); this dry run
// never writes the cache, so every promise is judged fresh.
const path = require('path');

const server = (relative) => path.join(__dirname, '..', '..', 'server', relative);

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function parseLimit(raw) {
  if (raw == null) return 150;
  if (!/^\d+$/.test(raw)) throw new Error(`--limit=${raw} is not a whole number of model calls`);
  return Number(raw);
}

// Wrapped BEFORE the checker modules load (they destructure it at require
// time), so every model call this run makes is counted with its tokens.
const llm = require(server('services/llm/call'));
const realDispatch = llm.dispatchWithFallback;
const spend = [];
llm.dispatchWithFallback = async (policy, payload, options) => {
  const result = await realDispatch(policy, payload, options);
  spend.push({ lane: payload.laneId, ok: result.ok === true, reason: result.reason || null, provider: result.provider || null,
    model: result.model || null, input_tokens: Number(result.usage?.input_tokens) || 0, output_tokens: Number(result.usage?.output_tokens) || 0 });
  return result;
};

const sharedDb = require(server('models/db'));
const { listCandidates, judgeCandidate, MAX_MODEL_CALLS, CANDIDATE_LIMIT } = require(server('services/call-promise-ai-close'));

async function assertReadOnly(db) {
  let rejected = false;
  try {
    await db.raw('UPDATE call_commitments SET id = id WHERE false');
  } catch (err) {
    if (!/read-only transaction/i.test(err.message)) throw new Error(`read-only self-check errored, but not with the expected read-only rejection — refusing to run: ${err.message}`);
    rejected = true;
  }
  if (!rejected) throw new Error('READ-ONLY SELF-CHECK FAILED: a write statement did not error. Refusing to run — PGOPTIONS may not be honored in this environment.');
}

const DAY = 24 * 60 * 60 * 1000;
const short = (text, n = 90) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, n);
const LEDGER_TYPE = { sms: 'text', call: 'call', visit: 'visit', estimate: 'estimate', email_reply: 'email', email_delivery: 'email', payment: 'payment' };

// One promise → { verdict, reason, proof, quote }. The same decisions the real
// job makes, minus the cache and the close.
function describeJudgment(judged) {
  if (judged.outcome === 'deferred') return { verdict: 'deferred', reason: 'model-call cap reached' };
  if (judged.outcome === 'skipped') return { verdict: 'skipped', reason: judged.reason };
  const v = judged.verdict;
  if (v.verdict === 'fulfilled') {
    const thread = v.basis === 'thread_confirmation';
    // A thread close rests on a later text: the customer's own, or a person's.
    const proof = thread ? `${v.witness === 'customer' ? 'customer' : 'staff'} text (thread)` : (LEDGER_TYPE[v.record_type] || v.record_type);
    return { verdict: 'WOULD CLOSE', proof, quote: short(v.quote), thread };
  }
  if (v.reason === 'no_witness') return { verdict: 'open', reason: 'no later record' };
  return { verdict: v.verdict, reason: v.reason || (v.verdict === 'open' ? 'nothing shows it was kept' : null) };
}

async function main() {
  const limit = parseLimit(arg('limit'));
  const json = process.argv.includes('--json');
  await assertReadOnly(sharedDb);
  const now = new Date();
  const [counts] = (await sharedDb.raw(`
    SELECT count(*) AS open_total,
           count(*) FILTER (WHERE cc.human_state IS NOT NULL) AS staff_touched,
           count(*) FILTER (WHERE cc.human_state IS NULL AND cl.customer_id IS NULL) AS no_customer
      FROM call_commitments cc JOIN call_log cl ON cl.id = cc.call_log_id
     WHERE cc.party = 'waves' AND cc.status = 'open'
       AND NOT (cc.human_state IS NULL AND cc.source = 'ai' AND cc.last_seen_generation IS NOT NULL
         AND cc.last_seen_generation < (SELECT MAX(l.last_seen_generation) FROM call_commitments l WHERE l.call_log_id = cc.call_log_id))`)).rows;
  // Every page, as the live job walks them (200 a page, oldest first).
  const rows = [];
  for (let cursor = null; ;) {
    const page = await listCandidates(sharedDb, { cursor });
    rows.push(...page);
    if (page.length < CANDIDATE_LIMIT) break;
    cursor = { at: page[page.length - 1].cursor_at, id: page[page.length - 1].id };
  }
  const budget = { left: limit };
  const results = new Array(rows.length);
  // Four at a time: a model call is seconds; the budget is spent synchronously
  // before each await, so the cap holds under concurrency.
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next; next += 1;
      if (i >= rows.length) return;
      const row = rows[i];
      try {
        results[i] = describeJudgment(await judgeCandidate(sharedDb, row, { now, budget }));
      } catch (err) {
        results[i] = { verdict: 'error', reason: err.code || err.name };
      }
      // Progress only (stderr): the report prints once, at the end.
      if (!json) process.stderr.write(`[${i + 1}/${rows.length}] ${row.id.slice(0, 8)} ${row.kind} -> ${results[i].verdict}\n`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  const lines = rows.map((row, i) => ({ id: row.id.slice(0, 8), kind: row.kind, age_days: Math.max(0, Math.floor((now - new Date(row.call_created_at)) / DAY)), ...results[i] }));
  const tally = {
    open_total: Number(counts.open_total), staff_touched: Number(counts.staff_touched), no_customer: Number(counts.no_customer), candidates: rows.length,
    would_close: lines.filter((l) => l.verdict === 'WOULD CLOSE').length,
    by_kind: {}, by_proof: {}, stays_open: {},
    model_calls: spend.length, failed_calls: spend.filter((s) => !s.ok).length,
  };
  const bump = (bucket, key) => { bucket[key] = (bucket[key] ?? 0) + 1; };
  for (const l of lines) {
    if (l.verdict === 'WOULD CLOSE') { bump(tally.by_kind, l.kind); bump(tally.by_proof, l.proof); }
    else bump(tally.stays_open, `${l.verdict}: ${l.reason ?? '-'}`);
  }
  // Estimated cost: tokens × today's list price (llm_model_prices, read-only),
  // the model the provider reported; a model with no listed price is unpriced.
  let cost = 0;
  const unpriced = new Set();
  try {
    const { loadPrices, priceFor } = require(server('services/llm-cost'));
    const { map } = await loadPrices(sharedDb);
    for (const s of spend) {
      const p = s.model ? priceFor(map, s.model) : null;
      if (p && p.input != null && p.output != null) cost += (s.input_tokens * p.input + s.output_tokens * p.output) / 1e6;
      else if (s.input_tokens || s.output_tokens) unpriced.add(s.model || 'unknown');
    }
  } catch { unpriced.add('price table unreadable'); }
  tally.tokens = { input: spend.reduce((n, s) => n + s.input_tokens, 0), output: spend.reduce((n, s) => n + s.output_tokens, 0) };
  tally.estimated_cost_usd = Math.round(cost * 100) / 100;
  tally.unpriced_models = [...unpriced];
  tally.nightly_cap = MAX_MODEL_CALLS;

  if (json) { console.log(JSON.stringify({ lines, tally }, null, 2)); return; }
  console.log(`call-promise-ai-close dry run — ${now.toISOString()} — NO WRITES`);
  console.log(`open Waves call promises: ${tally.open_total} (staff-touched, skipped: ${tally.staff_touched}; call has no customer, skipped: ${tally.no_customer}; judged: ${tally.candidates})`);
  console.log('id       | kind                          | age_d | verdict      | proof / reason');
  for (const l of lines) {
    const tail = l.verdict === 'WOULD CLOSE' ? `${l.proof}  "${l.quote}"` : (l.reason || '');
    console.log(`${l.id} | ${String(l.kind).padEnd(29)} | ${String(l.age_days).padStart(5)} | ${String(l.verdict).padEnd(12)} | ${tail}`);
  }
  console.log(`\nwould close: ${tally.would_close} of ${tally.candidates} judged`);
  console.log(`  by kind:  ${JSON.stringify(tally.by_kind)}`);
  console.log(`  by proof: ${JSON.stringify(tally.by_proof)}`);
  console.log(`stays open (verdict: reason): ${JSON.stringify(tally.stays_open)}`);
  console.log(`model calls this run: ${tally.model_calls} (${tally.failed_calls} failed); tokens in/out: ${tally.tokens.input}/${tally.tokens.output}; est. cost $${tally.estimated_cost_usd}${tally.unpriced_models.length ? ` (unpriced: ${tally.unpriced_models.join(', ')})` : ''}`);
}

if (require.main === module) {
  if (!process.env.DATABASE_PUBLIC_URL) {
    console.error('DATABASE_PUBLIC_URL is not set — run via: railway run --service waves-customer-portal -- railway run --service Postgres -- node ops/agents/call-promise-ai-close-dryrun.js');
    process.exit(2);
  }
  main().then(() => sharedDb.destroy()).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { assertReadOnly, describeJudgment, parseLimit };
