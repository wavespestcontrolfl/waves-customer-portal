#!/usr/bin/env node
/**
 * Auto-dispatch move proofreader — REPLAY over past moves. Moves nothing.
 *
 * Owner 2026-10-09 ("proofreader yes", step 1): run the proofreader on the
 * automatic moves of the last N days and see what it would have stopped,
 * before it is allowed near the nightly run.
 *
 * For each model arm it runs, in order:
 *   1. the hard cases (proofreader/hard-cases.js): made-up records with a
 *      known answer, so every run prints a score against a fixed key;
 *   2. every `changed` row of auto_dispatch_audit_logs in the window. The
 *      record is built AS OF the move's own time (record.js `asOf`), so the
 *      model sees only words that existed before the move. Undated notes on
 *      file are read as they are today.
 *
 * The console shows ids, verdicts and counts: never a customer name, a quote
 * or the model's own sentence (those are in the output file). It reads the
 * database and writes two files in --out. It changes no visit,
 * sends nothing, and raises no notification. The model calls are recorded
 * in the call ledger like any other call.
 *
 *   node server/scripts/auto-dispatch-proofreader-replay.js                 # 30 days, default arms
 *   node server/scripts/auto-dispatch-proofreader-replay.js --days 14 --limit 20
 *   node server/scripts/auto-dispatch-proofreader-replay.js --hard-only
 *   node server/scripts/auto-dispatch-proofreader-replay.js --models anthropic:<model>,anthropic:<model>
 *
 * Default arms: the proofreader's own route model and the flagship tier.
 * The output files hold customer words: keep --out outside the repository.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const DAYS = parseInt(valueOf('--days', '30'), 10);
const LIMIT = parseInt(valueOf('--limit', '0'), 10);
const CONCURRENCY = parseInt(valueOf('--concurrency', '4'), 10);
const OUT = valueOf('--out', path.join(os.tmpdir(), `auto-dispatch-proofreader-replay-${Date.now()}`));
const ARM_SPECS = String(valueOf('--models', '')).split(',').map((m) => m.trim()).filter(Boolean);
if (![DAYS, CONCURRENCY].every((n) => Number.isInteger(n) && n > 0) || !Number.isInteger(LIMIT) || LIMIT < 0) {
  console.error('Usage: auto-dispatch-proofreader-replay.js [--days N] [--limit N] [--concurrency N] [--out DIR] [--hard-only] [--skip-hard] [--models provider:model,...]');
  process.exit(1);
}

// Run `work` over `items`, at most `size` at a time, results in input order.
async function pool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await work(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, lane));
  return results;
}

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || null;
const tally = (rows, keyOf) => rows.reduce((acc, row) => { const key = keyOf(row); acc[key] = (acc[key] || 0) + 1; return acc; }, {});
const tokens = (rows) => rows.reduce((acc, row) => ({
  input: acc.input + ((row.usage && row.usage.input_tokens) || 0), output: acc.output + ((row.usage && row.usage.output_tokens) || 0),
}), { input: 0, output: 0 });

function resolveArms(MODELS) {
  const specs = ARM_SPECS.length
    ? ARM_SPECS
    : [...new Set([`anthropic:${MODELS.AUTO_DISPATCH_PROOFREADER}`, `anthropic:${MODELS.FLAGSHIP}`])];
  return specs.map((spec) => {
    const at = spec.indexOf(':');
    const provider = at > 0 ? spec.slice(0, at) : null;
    const model = at > 0 ? spec.slice(at + 1) : null;
    if (!['openai', 'anthropic', 'gemini'].includes(provider) || !model) {
      console.error(`Bad arm "${spec}": use provider:model (openai|anthropic|gemini).`);
      process.exit(1);
    }
    return { label: spec, route: { provider, model, ...(provider === 'anthropic' ? { effort: 'high' } : {}) } };
  });
}

async function runHardCases(arms, proofreader) {
  const { HARD_CASES, recordOf, scoreOf } = require('../services/auto-dispatch/proofreader/hard-cases');
  const rows = await pool(HARD_CASES, CONCURRENCY, async (hardCase) => {
    const record = recordOf(hardCase);
    const move = proofreader.moveFacts(hardCase.move);
    const out = { name: hardCase.name, expect: hardCase.expect, arms: {} };
    for (const arm of arms) {
      const got = await proofreader.proofreadMove({ move, record }, { route: arm.route });
      out.arms[arm.label] = { ...got, score: scoreOf(hardCase.expect, got.verdict) };
    }
    return out;
  });
  console.log(`\nHARD CASES (${rows.length}, made-up records with a known answer)`);
  for (const arm of arms) {
    const got = rows.map((row) => row.arms[arm.label]);
    console.log(`  ${arm.label}: ${JSON.stringify(tally(got, (r) => r.score))}`);
    rows.filter((row) => row.arms[arm.label].score !== 'right').forEach((row) => {
      const r = row.arms[arm.label];
      console.log(`    ${r.score}: "${row.name}" expected ${row.expect}, got ${r.verdict} (${r.why})`);
    });
  }
  return rows;
}

async function loadMoves(db) {
  const since = new Date(Date.now() - DAYS * 86400000);
  // The customer is the one frozen on the audit row at move time, never the
  // visit's owner today; a visit deleted since still replays (Codex #6258 r2).
  let query = db('auto_dispatch_audit_logs as l')
    .leftJoin('scheduled_services as s', 's.id', 'l.scheduled_service_id')
    .leftJoin('customers as c', 'c.id', 'l.customer_id')
    .leftJoin('technicians as t0', 't0.id', 'l.old_technician_id')
    .leftJoin('technicians as t1', 't1.id', 'l.new_technician_id')
    .where('l.action', 'changed')
    .whereNotNull('l.customer_id')
    .where('l.created_at', '>=', since)
    .orderBy('l.created_at', 'desc')
    .select(
      'l.id as audit_id', 'l.scheduled_service_id', 'l.customer_id', 's.service_type', 'l.created_at', 'l.reason_code',
      'l.old_scheduled_date', 'l.old_window_start', 'l.old_window_end', 'l.new_scheduled_date', 'l.new_window_start', 'l.new_window_end',
      't0.name as old_tech', 't1.name as new_tech', 'c.first_name', 'c.last_name',
      // The audit row is written after the move commits and its reminders
      // sync, so its time is later than the move. The reschedule_log row the
      // move's own transaction wrote carries the move time (Codex #6258 r6).
      db.raw(`(select max(r.created_at) from reschedule_log r where r.scheduled_service_id = l.scheduled_service_id
        and r.initiated_by = 'auto_dispatch' and r.new_date = l.new_scheduled_date
        and r.created_at <= l.created_at and r.created_at >= l.created_at - interval '1 hour') as moved_at`),
    );
  if (LIMIT) query = query.limit(LIMIT);
  return query;
}

async function replayMove(row, arms, { db, proofreader, toDateStr }) {
  const record = await proofreader.buildCustomerRecord(db, {
    customerId: row.customer_id, serviceId: row.scheduled_service_id, asOf: new Date(row.moved_at || row.created_at),
  });
  const move = proofreader.moveFacts({
    // The audit row keeps no service type: it is read from the visit as it is
    // today, every member of a grouped stop included (the whole stop moved).
    // A visit deleted since has none (the prompt then says only "recurring
    // service visit"), and its notes make the record incomplete.
    serviceType: record.serviceTypes.join(' + ') || row.service_type,
    from: { date: toDateStr(row.old_scheduled_date), windowStart: row.old_window_start, windowEnd: row.old_window_end, technician: firstName(row.old_tech) },
    to: { date: toDateStr(row.new_scheduled_date), windowStart: row.new_window_start, windowEnd: row.new_window_end, technician: firstName(row.new_tech) },
  });
  const out = {
    audit_id: row.audit_id,
    scheduled_service_id: row.scheduled_service_id,
    customer_id: row.customer_id,
    customer: [row.first_name, row.last_name ? `${String(row.last_name).trim()[0]}.` : ''].filter(Boolean).join(' '),
    moved_at: new Date(row.created_at).toISOString(),
    move_reason: row.reason_code,
    move,
    record: { entries: record.entries.length, chars: record.chars, split: record.split, unread: record.unread, too_long: record.tooLong },
    arms: {},
  };
  for (const arm of arms) {
    const got = await proofreader.proofreadMove({ move, record }, { route: arm.route });
    const quoted = got.entry_id ? record.entries.find((e) => e.id === got.entry_id) : null;
    out.arms[arm.label] = { ...got, ...(quoted ? { entry: quoted } : {}) };
  }
  return out;
}

function printMoves(rows, arms) {
  console.log(`\nPAST MOVES (${rows.length} automatic moves, last ${DAYS} days)`);
  const sizes = rows.map((row) => row.record.chars).sort((a, b) => a - b);
  console.log(`  record size: median ${sizes[Math.floor(sizes.length / 2)] || 0} characters, largest ${sizes[sizes.length - 1] || 0}; ${rows.filter((r) => r.record.unread.length).length} records incomplete`);
  for (const arm of arms) {
    const got = rows.map((row) => row.arms[arm.label]);
    const used = tokens(got);
    console.log(`  ${arm.label}: ${JSON.stringify(tally(got, (r) => r.verdict))} why ${JSON.stringify(tally(got, (r) => r.why))} tokens in ${used.input} out ${used.output}`);
  }
  if (arms.length > 1) {
    const differ = rows.filter((row) => new Set(arms.map((arm) => row.arms[arm.label].verdict)).size > 1);
    console.log(`  the arms disagree on ${differ.length} of ${rows.length} moves`);
  }
  rows.forEach((row) => {
    const stops = arms.filter((arm) => row.arms[arm.label].verdict !== 'allow');
    if (!stops.length) return;
    // Ids only on the console: the name stays in the output file (--out).
    console.log(`\n  move ${row.audit_id} · ${row.move.service} · ${row.move.from.weekday} ${row.move.from.date} ${row.move.from.arrival_window} -> ${row.move.to.weekday} ${row.move.to.date} ${row.move.to.arrival_window}`);
    arms.forEach((arm) => {
      const r = row.arms[arm.label];
      // Never the quote or the model's sentence: both can hold customer words.
      console.log(`    ${arm.label}: ${r.verdict} (${r.why})${r.entry_id ? ` entry ${r.entry_id}` : ''}`);
    });
  });
}

(async () => {
  const db = require('../models/db');
  const MODELS = require('../config/models');
  const proofreader = require('../services/auto-dispatch/proofreader');
  const { toDateStr } = require('../services/auto-dispatch/dates');
  const arms = resolveArms(MODELS);
  // Customer words are in these files: owner-only, whatever the umask.
  fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
  fs.chmodSync(OUT, 0o700);
  console.log(`Move proofreader replay · prompt ${proofreader.PROMPT_VERSION} · arms: ${arms.map((a) => a.label).join(' vs ')}\nOutput: ${OUT}`);
  try {
    const hard = flag('--skip-hard') ? [] : await runHardCases(arms, proofreader);
    fs.writeFileSync(path.join(OUT, 'hard-cases.json'), JSON.stringify(hard, null, 2), { mode: 0o600 });
    if (!flag('--hard-only')) {
      const moves = await loadMoves(db);
      let done = 0;
      const rows = await pool(moves, CONCURRENCY, async (row) => {
        const out = await replayMove(row, arms, { db, proofreader, toDateStr });
        done += 1;
        if (done % 10 === 0) console.log(`  ... ${done}/${moves.length}`);
        return out;
      });
      fs.writeFileSync(path.join(OUT, 'moves.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'), { mode: 0o600 });
      printMoves(rows, arms);
    }
  } finally {
    await db.destroy();
  }
})().catch((err) => {
  console.error(`Replay failed: ${err.message}`);
  process.exit(1);
});
