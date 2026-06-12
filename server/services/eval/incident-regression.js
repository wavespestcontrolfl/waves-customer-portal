/**
 * incident-regression.js — weekly replay of historical incidents through the
 * LIVE LLM components, so prompt/model drift gets caught by a cron instead of
 * by the next production incident.
 *
 * Why this exists when jest tests already cover these components: the unit
 * tests (fact-check-gate.test.js, email-operational-sender-guard.test.js)
 * mock the model, so they lock the CODE contract but can't see the model.
 * Both components break silently when the model side moves — the fact-check
 * gate is fail-open by design, and a classifier category drift just makes a
 * different switch branch fire. Each suite here is seeded from a real
 * incident (see fixtures/incident-eval/README.md) and replays the original
 * inputs through the real model weekly.
 *
 * Contract:
 *   - Every confirmed incident in these components gets a permanent case in
 *     server/fixtures/incident-eval/. Cases are never deleted, only added.
 *   - LLM verdicts are non-deterministic, so a failing case is retried once
 *     and only a repeated failure counts as a regression (pass-on-retry is
 *     reported as flaky, not failing).
 *   - The fact-check gate's fail-open paths (checked === false) count as
 *     INCONCLUSIVE, never as a pass — otherwise a dead API key reads as a
 *     green eval forever.
 *   - The inbox suite derives the would-be auto-action from the model's
 *     category + the shouldSkipAutoAction guard; it NEVER executes actions
 *     (classifyEmailContent is the pure classification path — no emails-row
 *     update, no executeAutoAction).
 *   - Regressions raise ONE admin notification per run; a run where every
 *     case is inconclusive raises a "could not run" notification (that's
 *     signal too — the eval silently not running is how this rots).
 */

const fs = require('fs');
const path = require('path');
const logger = require('../logger');

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'fixtures', 'incident-eval');
const DESTRUCTIVE_CATEGORIES = ['spam', 'marketing_newsletter'];

function loadSuite(name) {
  const file = path.join(FIXTURES_DIR, `${name}.json`);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (doc.schemaVersion !== 'incident-eval.v1') {
    throw new Error(`${name}.json: unsupported schemaVersion ${doc.schemaVersion}`);
  }
  if (!Array.isArray(doc.cases) || doc.cases.length === 0) {
    throw new Error(`${name}.json: no cases`);
  }
  for (const c of doc.cases) {
    if (!c.id || !c.expect) throw new Error(`${name}.json: case missing id/expect`);
    if (name === 'fact-check' && (!c.draft || !c.draft.body)) {
      throw new Error(`fact-check.json: case ${c.id} missing draft.body`);
    }
    if (name === 'inbox' && (!c.email || !c.email.from_address)) {
      throw new Error(`inbox.json: case ${c.id} missing email.from_address`);
    }
  }
  return doc;
}

/**
 * One attempt of a fact-check case. Returns {status, detail} where status is
 * 'pass' | 'fail' | 'inconclusive'.
 */
async function attemptFactCheckCase(c, evaluate) {
  let res;
  try {
    res = await evaluate(c.draft);
  } catch (err) {
    return { status: 'inconclusive', detail: `evaluate threw: ${err.message}` };
  }
  if (!res || res.checked !== true) {
    return { status: 'inconclusive', detail: `gate did not check (skipped=${res && res.skipped})` };
  }
  if (res.pass === c.expect.pass) return { status: 'pass' };
  const sevs = (res.findings || []).map((f) => f.severity).join(',') || 'none';
  return {
    status: 'fail',
    detail: `expected pass=${c.expect.pass}, got pass=${res.pass} (findings: ${sevs})`,
  };
}

/**
 * One attempt of an inbox case: classify, then derive the would-be action.
 * Destructive = the category is one executeAutoAction archives/trashes/
 * unsubscribes on AND the operational-sender guard would not skip it.
 */
async function attemptInboxCase(c, classify, shouldSkipAutoAction) {
  let res;
  try {
    res = await classify(c.email);
  } catch (err) {
    return { status: 'inconclusive', detail: `classify threw: ${err.message}` };
  }
  if (!res || !res.category) {
    return { status: 'inconclusive', detail: 'classifier returned unparseable/empty result' };
  }

  const failures = [];
  if (Array.isArray(c.expect.category_any) && !c.expect.category_any.includes(res.category)) {
    failures.push(`category=${res.category}, expected one of [${c.expect.category_any.join(', ')}]`);
  }
  if (typeof c.expect.no_destructive_action === 'boolean') {
    const destructive = DESTRUCTIVE_CATEGORIES.includes(res.category)
      && !shouldSkipAutoAction(res.category, c.email.from_address);
    if (c.expect.no_destructive_action && destructive) {
      failures.push(`destructive auto-action would fire (category=${res.category}, guard did not skip)`);
    }
    if (!c.expect.no_destructive_action && !destructive) {
      failures.push(`destructive auto-action would NOT fire (category=${res.category}) — inbox stops cleaning itself`);
    }
  }
  if (failures.length) return { status: 'fail', detail: failures.join('; ') };
  return { status: 'pass' };
}

/** Retry-once wrapper: only a repeated failure counts as a regression. */
async function runCase(attempt) {
  const first = await attempt();
  if (first.status !== 'fail') return { ...first, flaky: false };
  const second = await attempt();
  if (second.status === 'pass') {
    return { status: 'pass', flaky: true, detail: `flaky (first attempt: ${first.detail})` };
  }
  return { ...second, flaky: false, detail: second.detail || first.detail };
}

async function defaultNotify(row) {
  const db = require('../../models/db');
  await db('notifications').insert(row);
}

/**
 * Run the suites and notify on regression.
 * opts.evaluate / opts.classify / opts.shouldSkip / opts.notify are
 * injectable for tests; defaults are the real components. opts.suites
 * narrows which suites run (default: all).
 */
async function runIncidentEval(opts = {}) {
  const evaluate = opts.evaluate
    || require('../content/fact-check-gate').evaluate;
  const classify = opts.classify
    || require('../email/email-classifier').classifyEmailContent;
  const shouldSkip = opts.shouldSkip
    || require('../email/email-actions').shouldSkipAutoAction;
  const notify = opts.notify || defaultNotify;

  const suites = [
    { name: 'fact-check', attempt: (c) => attemptFactCheckCase(c, evaluate) },
    { name: 'inbox', attempt: (c) => attemptInboxCase(c, classify, shouldSkip) },
  ].filter((s) => !opts.suites || opts.suites.includes(s.name))
    .map((s) => ({ ...s, doc: loadSuite(s.name) }));
  if (suites.length === 0) throw new Error(`no suites match ${JSON.stringify(opts.suites)}`);

  const results = [];
  for (const suite of suites) {
    for (const c of suite.doc.cases) {
      const r = await runCase(() => suite.attempt(c));
      results.push({ suite: suite.name, id: c.id, ...r });
      logger.info(`[incident-eval] ${suite.name}/${c.id}: ${r.status}${r.flaky ? ' (flaky)' : ''}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }

  const summary = {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail').length,
    inconclusive: results.filter((r) => r.status === 'inconclusive').length,
    flaky: results.filter((r) => r.flaky).length,
    results,
  };

  const failures = results.filter((r) => r.status === 'fail');
  if (failures.length > 0) {
    const lines = failures.map((f) => `${f.suite}/${f.id}: ${f.detail}`);
    await notify({
      recipient_type: 'admin',
      category: 'eval_regression',
      title: `Incident eval: ${failures.length} regression(s) in LLM gates`,
      body: `${lines.join('\n').slice(0, 1500)}\n\nRe-run manually: node server/scripts/run-incident-eval.js`,
      icon: '🧪',
      link: '/admin/dashboard',
      metadata: JSON.stringify({ summary: { total: summary.total, passed: summary.passed, failed: summary.failed, inconclusive: summary.inconclusive }, failures: lines }),
    });
  } else if (summary.inconclusive === summary.total) {
    await notify({
      recipient_type: 'admin',
      category: 'eval_regression',
      title: 'Incident eval could not run (all cases inconclusive)',
      body: 'Every case came back inconclusive — likely API key/model availability. The eval did NOT verify anything this week.',
      icon: '🧪',
      link: '/admin/dashboard',
      metadata: JSON.stringify({ summary: { total: summary.total, inconclusive: summary.inconclusive } }),
    });
  }

  logger.info(`[incident-eval] done: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.inconclusive} inconclusive${summary.flaky ? `, ${summary.flaky} flaky` : ''}`);
  return summary;
}

module.exports = {
  runIncidentEval,
  _internals: { loadSuite, attemptFactCheckCase, attemptInboxCase, runCase, DESTRUCTIVE_CATEGORIES },
};
