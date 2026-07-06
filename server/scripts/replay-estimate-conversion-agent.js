#!/usr/bin/env node
/**
 * Replay recent inbound SMS through the estimate-conversion shadow agent.
 *
 * This only writes agent_decisions rows. It does not send messages, schedule
 * appointments, update estimates/leads/customers, or touch billing.
 *
 * Usage:
 *   node server/scripts/replay-estimate-conversion-agent.js --days=14 --limit=500
 *   node server/scripts/replay-estimate-conversion-agent.js --since=2026-05-01 --limit=1000
 *   node server/scripts/replay-estimate-conversion-agent.js --all --days=30 --limit=1000
 */

// Replays exercise the deterministic router only — the grounded LLM review
// draft (one FLAGSHIP verify loop per message) would turn a 500-row replay
// into 500 live Claude calls. Opt back in per-run with
// AGENT_REVIEW_LLM_DRAFTS=replay if a batch of real drafts is the goal.
if (process.env.AGENT_REVIEW_LLM_DRAFTS !== 'replay') {
  process.env.AGENT_REVIEW_LLM_DRAFTS = 'false';
}

const db = require('../models/db');
const { processInboundSms } = require('../services/estimate-conversion-agent');
const { isSmsReaction } = require('../services/sms-intent');

function parseArgs(argv) {
  return Object.fromEntries(argv.map((arg) => {
    if (!arg.startsWith('--')) return [arg, true];
    const [key, value] = arg.slice(2).split('=');
    return [key, value === undefined ? true : value];
  }));
}

function intArg(value, fallback, { min = 1, max = 5000 } = {}) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sinceDate(args) {
  if (args.since) {
    const parsed = new Date(String(args.since));
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid --since value: ${args.since}`);
    return parsed;
  }
  const days = intArg(args.days, 14, { min: 1, max: 365 });
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function tableExists(name) {
  return db.schema.hasTable(name).catch(() => false);
}

async function findCustomer(row) {
  if (row.customer_id) {
    const customer = await db('customers').where({ id: row.customer_id }).first();
    if (customer) return customer;
  }

  const from = String(row.from_phone || '').trim();
  if (!from) return null;
  return db('customers').where({ phone: from }).first();
}

async function replay({ since, limit, prefiltered }) {
  if (!(await tableExists('agent_decisions'))) {
    throw new Error('agent_decisions table does not exist');
  }

  const q = db('sms_log as s')
    .leftJoin('agent_decisions as ad', function joinAgentDecisions() {
      this.on('ad.sms_log_id', '=', 's.id')
        .andOn('ad.workflow', '=', db.raw('?', ['estimate_conversion_sms']));
    })
    .where('s.direction', 'inbound')
    .whereNotNull('s.message_body')
    .where('s.created_at', '>=', since)
    .whereNull('ad.id');

  if (prefiltered) {
    q.whereRaw(`s.message_body ~* ?`, [
      [
        'give (you|your team) a try',
        'want to start',
        'ready to start',
        "let'?s (do it|move forward|get started)",
        'go ahead',
        'sign me up',
        "i'?ll move forward",
        'i think i will',
        'start (the )?service',
        'move forward with',
        'week of',
        'next week',
        'couple weeks?',
        'do i need to be home',
        'need to be home',
        'have to be home',
        'typical visit',
        'outline of the service',
        "what'?s included",
        'does it include',
        'sweep',
        'webs?',
        'lanai',
        'cage',
      ].join('|'),
    ]);
  }

  const rows = await q.orderBy('s.created_at', 'asc')
    .limit(limit)
    .select(
      's.id',
      's.customer_id',
      's.from_phone',
      's.to_phone',
      's.message_body',
      's.twilio_sid',
      's.created_at'
    );

  const stats = {
    scanned: rows.length,
    skippedReaction: 0,
    inserted: 0,
    noDecision: 0,
    failed: 0,
  };

  for (const row of rows) {
    if (isSmsReaction(row.message_body)) {
      stats.skippedReaction += 1;
      continue;
    }

    const customer = await findCustomer(row);
    const decision = await processInboundSms({
      customer,
      from: row.from_phone,
      to: row.to_phone,
      body: row.message_body,
      smsLogId: row.id,
      sourceMessageId: row.twilio_sid || `replay:${row.id}`,
    });

    if (decision) stats.inserted += 1;
    else stats.noDecision += 1;
  }

  return stats;
}

(async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = intArg(args.limit, 500, { min: 1, max: 5000 });
  const since = sinceDate(args);

  try {
    const stats = await replay({ since, limit, prefiltered: !args.all });
    console.log(JSON.stringify({
      workflow: 'estimate_conversion_sms',
      since: since.toISOString(),
      limit,
      prefiltered: !args.all,
      ...stats,
    }, null, 2));
    await db.destroy();
  } catch (err) {
    console.error(`Replay failed: ${err.message}`);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
