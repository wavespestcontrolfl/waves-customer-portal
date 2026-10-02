/**
 * Ten-workflow controlled baseline (PR 1 of the operator workflow scope).
 *
 * Runs the DEV partition (100 cases) of the committed manifests through the
 * real bearer auth, the real Intelligence Bar route, real tools and the real
 * domain executors against an isolated PostgreSQL. The model is SCRIPTED: for
 * each case the harness issues the tool calls a correct model would make for
 * that request. The baseline therefore measures the EXECUTION layer (target
 * resolution, proposal, confirmation, domain rules, receipts, recovery), not
 * language understanding. Providers (SMS, email) are stubbed.
 *
 * The suite asserts every case's outcome against the committed snapshot
 * fixtures/ib-workflow-baseline/baseline-dev.json, so a later change that fixes or
 * breaks a case fails here until the snapshot is updated deliberately
 * (UPDATE_IB_BASELINE=1 rewrites it and the detail file the report is built from).
 *
 * Held-out cases are never executed and never read for scripting here.
 */
const fs = require('fs');
const path = require('path');
const mockModel = jest.fn();
const mockSendViaTwilio = jest.fn();
// SendGrid answers only while a case asks for it (the double-opt-in confirmation a customer email change re-sends);
// otherwise it stays unconfigured exactly as before, and every submission is recorded by the stub.
const mockSendgrid = { on: false, sendOne: jest.fn() };
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: mockModel } })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/email/gmail-client', () => ({ ...jest.requireActual('../services/email/gmail-client'), sendMessage: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  ...jest.requireActual('../services/sendgrid-mail'),
  isConfigured: (...args) => (mockSendgrid.on ? true : jest.requireActual('../services/sendgrid-mail').isConfigured(...args)),
  sendOne: (...args) => mockSendgrid.sendOne(...args),
}));
jest.mock('../services/messaging/providers/twilio-sms', () => ({
  ...jest.requireActual('../services/messaging/providers/twilio-sms'),
  sendViaTwilio: (...args) => mockSendViaTwilio(...args),
}));

const { bootHarness } = require('./helpers/ib-workflow-harness');
const { Cast, sweepStale } = require('./helpers/ib-workflow-fixtures');
const { capabilityGaps } = require('./helpers/ib-workflow-capability');
const { noSends, sendState, unchangedViolations } = require('./helpers/ib-workflow-state');
const { CASES } = require('./helpers/ib-workflow-cases');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ib-workflows');
// The manifest suite requires fixtures/ib-workflows to hold exactly the ten manifests, so results live beside it.
const RESULT_DIR = path.join(__dirname, 'fixtures', 'ib-workflow-baseline');
const SNAPSHOT = path.join(RESULT_DIR, 'baseline-dev.json');
const DETAIL = path.join(RESULT_DIR, 'baseline-dev-detail.json');
const WORKFLOWS = Array.from({ length: 10 }, (_, i) => `W${i + 1}`);
const only = process.env.IB_BASELINE_ONLY ? process.env.IB_BASELINE_ONLY.split(',') : null;
// A workflow ("W1") selects its own cases ("W1-dev-01") and never another workflow's ("W10-dev-01"): match the id exactly, or as a
// prefix that ends at a dash. A longer prefix ("W1-dev-0", "W10-dev") still works, an exact case id too.
const selected = (id) => !only || only.some((p) => id === p || id.startsWith(p.includes('-') ? p : `${p}-`));

const manifests = WORKFLOWS.map((id) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${id}.json`), 'utf8')));
// DEV partition only. A held-out case is filtered out before anything reads it.
const devCases = manifests.flatMap((m) => m.cases.filter((c) => c.partition === 'dev'));
const snapshot = fs.existsSync(SNAPSHOT) ? JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8')) : { cases: {} };
const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const update = process.env.UPDATE_IB_BASELINE === '1';
// Every distinct failure the case recorded, as point:code in the order first seen. The snapshot pins the whole list,
// so a later stage that starts or stops failing is a visible change, not only the first failure.
const codesOf = (failures) => [...new Set((failures || []).map((f) => `${f.point}:${f.code}`))];

suite('ten-workflow controlled baseline, dev partition (scripted model)', () => {
  let h;
  const results = {};

  beforeAll(async () => {
    const parsed = new URL(databaseUrl);
    // Always a dedicated database, in CI too: the suite changes the shared service catalog, books and cancels visits and reads account-wide lists.
    if (!/^\/waves_ib_(platform|workflow)_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database (waves_ib_platform_* or waves_ib_workflow_*) is required');
    h = await bootHarness({ databaseUrl, mockModel, providers: { sms: mockSendViaTwilio, sendgrid: mockSendgrid } });
    // The Gmail client loads the database, so it is required only after the harness has pointed the environment at the isolated one.
    h.providers.gmail = require('../services/email/gmail-client').sendMessage;
    mockSendgrid.sendOne.mockImplementation(async () => ({ messageId: 'stub-message' }));
    await sweepStale(h.db);
    mockSendViaTwilio.mockImplementation(async () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'b'.repeat(32)}` }));
  }, 90000);

  afterAll(async () => {
    if (update && !only) {
      const out = { schema_version: 1, cases: {} };
      for (const [id, r] of Object.entries(results)) out.cases[id] = { outcome: r.outcome, ...(r.point ? { point: r.point, code: r.code, failures: codesOf(r.failures) } : {}), ...(r.reasons ? { reasons: r.reasons.map((g) => g.code) } : {}), ...(r.probe ? { probe: r.probe.outcome === 'pass' ? 'pass' : `fail:${r.probe.code}`, probe_failures: codesOf(r.probe.failures) } : {}) };
      fs.writeFileSync(SNAPSHOT, `${JSON.stringify(out, null, 2)}\n`);
      fs.writeFileSync(DETAIL, `${JSON.stringify({ schema_version: 1, cases: results }, null, 2)}\n`);
    }
    if (h) await h.close();
  });

  /**
   * Structural guards, applied by the runner to every scored dev case so no case has to remember them (three review rounds in a
   * row found a case whose own check was too weak). A case may opt out of one guard with a reason: `CASES[id].optOut = { sends,
   * unchanged, refusal }`; the reason is recorded in the case's notes.
   *   sends      every step of the manifest says sends 0: nothing may go out on ANY channel over the whole case (provider stubs,
   *              accepted audit rows, outbound rows, email). Otherwise provider submissions may not exceed the declared total and
   *              no email may go out.
   *   unchanged  a table named in an "unchanged" line: no step changes it, so every seeded row keeps its complete value; or every
   *              change to it is `table[new]`, so every row that existed at the first turn keeps its complete value.
   *   refusal    a negative outcome (blocked_by_rule, unsupported, or a clarification with no card on a negative case) must have
   *              asserted HOW the bar refused through ctx.expectRefusal (the tool's code or message) or ctx.expectNoAttempt.
   */
  async function runGuards(c, ctx, cast) {
    const optOut = (CASES[c.id] && CASES[c.id].optOut) || {};
    const steps = [c, ...c.corrections].map((step) => step.expected);
    const skip = (name) => { if (optOut[name]) ctx.note(`${name} guard skipped: ${optOut[name]}`); return !!optOut[name]; };
    const declared = steps.reduce((total, e) => total + Number(e.sends || 0), 0);
    if (!skip('sends')) {
      if (declared === 0) {
        await noSends(ctx, h, cast, { what: 'a case whose manifest says sends 0', codes: { sms: 'guard_sent_a_text', smsRows: 'guard_outbound_row_added', email: 'guard_sent_an_email', emailRows: 'guard_email_row_added' } });
      } else {
        const now = await sendState(h, cast);
        ctx.check(now.sms_provider <= declared, 'side_effect', 'guard_sent_more_than_declared', `${now.sms_provider} provider submissions, the manifest declares ${declared}`);
        ctx.check(now.sendgrid_provider === 0 && now.gmail_provider === 0, 'side_effect', 'guard_sent_an_email', `SendGrid ${now.sendgrid_provider}, Gmail ${now.gmail_provider} in a text-only case`);
      }
    }
    if (!skip('unchanged') && ctx.rowBaseline) {
      const tableOf = (line) => (/^(\w+)\[/.exec(line) || [])[1];
      const unchangedLines = steps.flatMap((e) => e.unchanged || []).filter((line) => tableOf(line));
      const changes = steps.flatMap((e) => e.changes || []);
      const columnOf = (line) => (/^\w+\[[^\]]*\]\.(\w+)/.exec(line) || [])[1] || null;
      const spec = new Map();
      for (const table of new Set(unchangedLines.map(tableOf))) {
        const lines = unchangedLines.filter((line) => tableOf(line) === table);
        // `table[*].column` holds only that column; any line naming no column holds the complete row.
        const columns = lines.every(columnOf) ? new Set(lines.map(columnOf)) : null;
        const mine = changes.filter((line) => tableOf(line) === table);
        if (!mine.length) spec.set(table, { mode: 'all', columns });
        else if (mine.every((line) => new RegExp(`^${table}\\[new`).test(line))) spec.set(table, { mode: 'baseline', columns });
      }
      const bad = await unchangedViolations(h, cast, ctx.rowBaseline, spec);
      ctx.check(bad.length === 0, 'side_effect', 'guard_unchanged_rows_changed', `the manifest says these stay unchanged but a seeded row differs in: ${bad.join(', ')}`);
    }
    const negative = steps.some((e) => e.outcome === 'blocked_by_rule' || e.outcome === 'unsupported' || (c.negative === true && e.outcome === 'awaiting_operator' && e.card === false));
    if (negative && !skip('refusal')) ctx.check(ctx.refusalAsserted, 'harness', 'refusal_unspecified', 'a negative outcome finished without asserting the specific refusal (ctx.expectRefusal or ctx.expectNoAttempt)');
  }

  async function execute(c, probe) {
    const cast = new Cast(h.db);
    const ctx = h.newContext(c, cast);
    ctx.probe = probe;
    mockSendViaTwilio.mockClear();
    mockSendgrid.sendOne.mockClear();
    h.providers.gmail.mockClear();
    mockSendgrid.on = false;
    try {
      await CASES[c.id](ctx, h, cast, c);
    } catch (err) {
      ctx.fail('harness', 'case_threw', `${err.message}`.split('\n')[0]);
    }
    try {
      ctx.verifyContract();
      if (!probe) await runGuards(c, ctx, cast);
    } catch (err) {
      ctx.fail('harness', 'contract_check_threw', `${err.message}`.split('\n')[0]);
    } finally {
      // Cleanup is best-effort but never silent: a step that failed leaves rows or shared configuration for the next case.
      const leftovers = await cast.retire().catch((err) => [{ step: 'retire', error: String(err && err.message).split('\n')[0] }]);
      if (leftovers.length) ctx.fail('harness', 'cleanup_failed', leftovers.map((f) => `${f.step}: ${f.error}`).join('; '));
    }
    const first = ctx.failures[0];
    return { outcome: ctx.failures.length ? 'fail' : 'pass', ...(first ? { point: first.point, code: first.code } : {}), failures: ctx.failures, timings: ctx.timings, notes: ctx.notes, strength: ctx.strength || null, contract_calls: ctx.contract ? ctx.contract.compared : null };
  }

  // Persisted columns: every `table[row].column` the dev cases name must exist in the migrated schema (the first path segment
  // for a jsonb column), so a manifest line cannot assert a column the writer never fills.
  test('dev manifest row references name real tables and columns', async () => {
    const rows = await h.db('information_schema.columns').where({ table_schema: 'public' }).select('table_name', 'column_name');
    const columns = new Set(rows.map((r) => `${r.table_name}.${r.column_name}`));
    const tables = new Set(rows.map((r) => r.table_name));
    const bad = [];
    for (const c of devCases) {
      for (const step of [c.expected, ...c.corrections.map((x) => x.expected)]) {
        for (const line of [...(step.changes || []), ...(step.unchanged || [])]) {
          const m = /^(\w+)\[[^\]]*\](?:\.(\w+))?/.exec(line);
          if (!m) continue;
          if (!tables.has(m[1])) bad.push(`${c.id}: no table ${m[1]}`);
          else if (m[2] && !columns.has(`${m[1]}.${m[2]}`)) bad.push(`${c.id}: ${m[1]} has no column ${m[2]}`);
        }
      }
    }
    expect([...new Set(bad)]).toEqual([]);
  });

  test.each(devCases.filter((c) => selected(c.id)).map((c) => [c.id, c]))('%s', async (id, c) => {
    const gaps = capabilityGaps(c);
    let record;
    if (gaps.length) {
      record = { outcome: 'not_runnable', reasons: gaps };
      if (CASES[id]) {
        const probe = await execute(c, true);
        record.probe = probe;
      }
    } else {
      expect(CASES[id]).toBeDefined();
      record = await execute(c, false);
    }
    results[id] = record;
    if (process.env.IB_BASELINE_DEBUG) process.stdout.write(`\n[baseline] ${id} ${record.outcome} ${JSON.stringify({ failures: record.failures, reasons: record.reasons && record.reasons.map((r) => r.code), probe: record.probe && { outcome: record.probe.outcome, failures: record.probe.failures, notes: record.probe.notes }, timings: record.timings, notes: record.notes })}\n`);
    // The manifest's calls are the contract: a case whose script does not issue them is case data to fix, never a baseline row.
    const declaresCalls = [c, ...c.corrections].some((step) => [].concat(step.call || []).length > 0);
    const compared = record.contract_calls === undefined ? (record.probe && record.probe.contract_calls) : record.contract_calls;
    if (declaresCalls && !(c.requires && c.requires.length)) expect(compared).toBeGreaterThan(0);
    const contract = [...(record.failures || []), ...((record.probe && record.probe.failures) || [])].filter((f) => f.point === 'contract');
    expect(contract).toEqual([]);
    if (update) return;
    const expected = snapshot.cases[id];
    expect(expected).toBeDefined();
    expect(record.outcome).toBe(expected.outcome);
    if (record.outcome === 'fail') expect({ point: record.point, code: record.code, failures: codesOf(record.failures) }).toEqual({ point: expected.point, code: expected.code, failures: expected.failures });
    if (record.outcome === 'not_runnable') expect(record.reasons.map((g) => g.code)).toEqual(expected.reasons);
    if (record.outcome === 'not_runnable' && record.probe) expect(codesOf(record.probe.failures)).toEqual(expected.probe_failures || []);
  }, 120000);
});
