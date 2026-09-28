#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY replay: runs the Day-0 review-ask contextual topic classifier
 * (review-ask-topic.js) over recent completed RECURRING visits and reports
 * what topic (if any) it would have found. Evidence sources are exactly the
 * two the live path is allowed to read — the customer's inbound texts since
 * their previous completed visit and what the customer told the technician on
 * THIS visit (customerConcernText) — through the same collectTopicEvidence
 * call, anchored on that visit's own completed_at.
 *
 * This script makes no writes: no DB write, no send, no gate flip. It DOES
 * make one live LLM classification call per matched visit (the same
 * fastStructured policy the live path uses) — do not run this against a
 * large window casually.
 *
 * Usage:
 *   node server/scripts/replay-review-day0-topics.js --days 60
 *   node server/scripts/replay-review-day0-topics.js --days 14 --out /private/topics.md
 *
 * Output carries customer first names and message text: the default path is
 * the git-ignored reports/ directory at the repo root, never a tracked path.
 *
 * Requires DATABASE_URL or DATABASE_PUBLIC_URL to be set (a dev/preview DB —
 * never point this at production yourself; the owner runs that).
 */

require('../config/load-env')();

if (!process.env.DATABASE_URL && !process.env.DATABASE_PUBLIC_URL) {
  console.error('Refusing to run: set DATABASE_URL or DATABASE_PUBLIC_URL first (a dev/preview Postgres).');
  process.exit(1);
}

const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const { readTopicEvidence, classifyTopic } = require('../services/review-ask-topic');
const { runAsReplay } = require('../services/llm-dispatch-metrics');
const { redactAccessCodes } = require('../services/context-aggregator');
const { formatETDate } = require('../utils/datetime-et');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.match(/^--(days|out)=(.+)$/);
    if (eq) { args[eq[1]] = eq[2]; continue; }
    if (arg === '--days' || arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      args[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') { args.help = true; continue; }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return 'Usage: node server/scripts/replay-review-day0-topics.js [--days 60] [--out <path.md>]';
}

function snippet(evidence) {
  const c = evidence?.completion || {};
  const parts = [c.concernText, ...(Array.isArray(evidence?.texts) ? evidence.texts.map((t) => t.body) : [])].filter(Boolean);
  const joined = redactAccessCodes(parts.join(' | '));
  return joined.length > 160 ? `${joined.slice(0, 157)}...` : joined;
}

function hasCustomerTexts(evidence) {
  return Array.isArray(evidence?.texts) && evidence.texts.length > 0;
}

function mdEscape(value) {
  return String(value == null ? '' : value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function fetchCompletedRecurringVisits(since, now) {
  return db('scheduled_services as ss')
    .join('service_records as sr', 'sr.scheduled_service_id', 'ss.id')
    .leftJoin('customers as c', 'c.id', 'ss.customer_id')
    .where('ss.is_recurring', true)
    .where('ss.status', 'completed')
    .where('ss.completed_at', '>=', since)
    .where('ss.completed_at', '<=', now)
    .select(
      'ss.id as visit_id', 'ss.completed_at', 'ss.customer_id',
      'sr.id as service_record_id', 'sr.service_type',
      'c.first_name as customer_first_name',
    )
    .orderBy('ss.completed_at', 'asc');
}

// One visit -> one evidence-gather + classification, guarded so a single bad
// row never aborts the run. Uses the throwing variants (not the live path's
// fail-soft ones) so a lookup or provider failure is reported as an error,
// never counted as "no topic".
async function classifyVisit(visit) {
  const completedAt = new Date(visit.completed_at);
  let evidence = null;
  let outcome = null;
  let error = null;
  try {
    evidence = await readTopicEvidence({
      customerId: visit.customer_id,
      serviceRecordId: visit.service_record_id,
      scheduledServiceId: visit.visit_id,
      completedAt,
    });
    outcome = await classifyTopic(evidence);
    if (outcome.status === 'failed') error = `classifier_failed:${outcome.reason}`;
  } catch (err) {
    error = err.message;
  }
  const topic = outcome?.topic || null;
  return {
    visitId: visit.visit_id,
    customerId: visit.customer_id,
    completedAt: completedAt.toISOString(),
    serviceType: visit.service_type || null,
    evidence: evidence || { completion: { concernText: null }, texts: [] },
    evidenceRead: !!evidence,
    // The model's own answer before the confidence/grounding checks.
    rawKind: outcome?.raw?.kind || null,
    topic,
    wouldFire: !!topic,
    error,
  };
}

// `summary` counts the model's own kinds (before the checks); `rejected` is a
// service_concern/question the confidence or grounding check refused;
// `no_evidence` never reached the model; `failed` is a lookup or provider
// error, kept out of every other count.
function summarize(results) {
  const summary = { service_concern: 0, question: 0, logistics: 0, praise: 0, none: 0, rejected: 0, no_evidence: 0, failed: 0 };
  let wouldFireCount = 0;
  let withTextsCount = 0;
  let withTextsFiredCount = 0;
  for (const r of results) {
    if (r.error) { summary.failed += 1; continue; }
    if (r.wouldFire) wouldFireCount += 1;
    if (!r.rawKind) summary.no_evidence += 1;
    else summary[r.rawKind] = (summary[r.rawKind] || 0) + 1;
    if (!r.topic && (r.rawKind === 'service_concern' || r.rawKind === 'question')) summary.rejected += 1;
    if (hasCustomerTexts(r.evidence)) {
      withTextsCount += 1;
      if (r.wouldFire) withTextsFiredCount += 1;
    }
  }
  return { summary, wouldFireCount, withTextsCount, withTextsFiredCount };
}

function renderMarkdownRow(result, customerFirstName) {
  const cols = [
    mdEscape(formatETDate(new Date(result.completedAt))),
    mdEscape(result.serviceType || ''),
    mdEscape(customerFirstName || ''),
    mdEscape(result.error ? 'error' : (result.rawKind || 'no evidence')),
    mdEscape(result.topic?.topic || ''),
    mdEscape(result.topic?.source || ''),
    result.topic ? result.topic.confidence.toFixed(2) : '',
    mdEscape(snippet(result.evidence)),
    result.wouldFire ? 'yes' : 'no',
  ];
  return `| ${cols.join(' | ')} |`;
}

function renderMarkdown({ days, since, now, visits, results, summary, wouldFireCount, withTextsCount, withTextsFiredCount }) {
  const lines = [
    `# Review Day-0 context topics — replay (${days}-day window)`,
    '',
    `Window: ${formatETDate(since)} – ${formatETDate(now)}. ${visits.length} completed recurring visit(s) scanned.`,
    '',
    'This is a READ-ONLY replay for review. No sends, no writes, no gate flip.',
    '',
    '| Visit date | Service type | Customer | Kind | Topic | Source | Confidence | Evidence snippet | Would fire? |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((r, i) => renderMarkdownRow(r, visits[i].customer_first_name)),
    '',
    '## Summary by kind (the model\'s own answer, before the checks)',
    '',
    `- service_concern: ${summary.service_concern}`,
    `- question: ${summary.question}`,
    `- logistics: ${summary.logistics}`,
    `- praise: ${summary.praise}`,
    `- none: ${summary.none}`,
    `- service_concern/question refused by the confidence or grounding check: ${summary.rejected}`,
    `- no evidence (never sent to the model): ${summary.no_evidence}`,
    `- failed (lookup or provider error — not counted anywhere else): ${summary.failed}`,
    `- would fire (topic stored): ${wouldFireCount} / ${visits.length}`,
    `- visits with any customer texts in the evidence window: ${withTextsCount} / ${visits.length}`,
    `- of those, would fire (real customer-texts hit rate): ${withTextsFiredCount} / ${withTextsCount}`,
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); return; }

  const days = Math.max(1, Number.parseInt(args.days, 10) || 60);
  const today = new Date().toISOString().slice(0, 10);
  const outPath = args.out || path.join(__dirname, '..', '..', 'reports', `review-day0-topics-${today}.md`);
  const jsonlPath = outPath.replace(/\.md$/i, '') + '.jsonl';
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  console.log(`[replay] scanning completed recurring visits from ${since.toISOString()} to ${now.toISOString()}`);
  const visits = await fetchCompletedRecurringVisits(since, now);
  console.log(`[replay] ${visits.length} completed recurring visit(s) with a service record in window`);

  // Recorded as replay workload (`<policy>:replay`), never as live
  // review_topic traffic in the dispatch metrics or the call ledger.
  const results = await runAsReplay(async () => {
    const out = [];
    for (const visit of visits) out.push(await classifyVisit(visit));
    return out;
  }, 'review_topic');

  fs.writeFileSync(jsonlPath, results.map((r) => JSON.stringify(r)).join('\n') + (results.length ? '\n' : ''));

  const { summary, wouldFireCount, withTextsCount, withTextsFiredCount } = summarize(results);
  fs.writeFileSync(outPath, renderMarkdown({ days, since, now, visits, results, summary, wouldFireCount, withTextsCount, withTextsFiredCount }));

  console.log(`[replay] wrote ${outPath}`);
  console.log(`[replay] wrote ${jsonlPath}`);
  console.log('[replay] summary by kind:', summary);
  console.log(`[replay] would fire (topic stored): ${wouldFireCount} / ${visits.length}`);
  console.log(`[replay] visits with any customer texts: ${withTextsCount} / ${visits.length}`);
  console.log(`[replay] of those, would fire (real hit rate): ${withTextsFiredCount} / ${withTextsCount}`);
}

main()
  .then(() => db.destroy())
  .catch(async (err) => {
    console.error(err);
    await db.destroy();
    process.exit(1);
  });
