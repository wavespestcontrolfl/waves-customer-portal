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
const { CASES } = require('./helpers/ib-workflow-cases');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'ib-workflows');
// The manifest suite requires fixtures/ib-workflows to hold exactly the ten manifests, so results live beside it.
const RESULT_DIR = path.join(__dirname, 'fixtures', 'ib-workflow-baseline');
const SNAPSHOT = path.join(RESULT_DIR, 'baseline-dev.json');
const DETAIL = path.join(RESULT_DIR, 'baseline-dev-detail.json');
const WORKFLOWS = Array.from({ length: 10 }, (_, i) => `W${i + 1}`);
const only = process.env.IB_BASELINE_ONLY ? process.env.IB_BASELINE_ONLY.split(',') : null;

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

  test.each(devCases.filter((c) => !only || only.some((p) => c.id.startsWith(p))).map((c) => [c.id, c]))('%s', async (id, c) => {
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
