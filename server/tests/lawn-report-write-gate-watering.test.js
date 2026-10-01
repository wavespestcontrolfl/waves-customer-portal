// The lawn write gate freezes the COMPLETE watering instruction (and banner)
// under structured_notes.lawnWateringFreeze, first writer wins, in a guarded
// statement of its own (GATE_LAWN_WATERING_RULE). Synthetic data only.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}' })),
  ensureReportToken: jest.fn(async () => 'c'.repeat(32)),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const INSTRUCTION = (minutes) => ({ state: 'water_in', lines: ['Water in today’s treatment by Thu 2 PM.', `Run each zone about ${minutes} minutes.`], minutes: { measured: null }, ruleSource: 'default' });

// A fake that records every statement. It applies the guarded freeze the way
// Postgres does (see the -postgres test for the real thing): the freeze
// statement lands only while lawnWateringFreeze is absent.
function fakeKnex(initialNotes = {}) {
  const state = { notes: JSON.parse(JSON.stringify(initialNotes)), statements: [] };
  const knex = () => {
    const q = { guard: null };
    q.where = () => q;
    q.whereRaw = (sql) => { q.guard = sql; return q; };
    q.first = async () => ({ structured_notes: JSON.stringify(state.notes) });
    q.update = async ({ structured_notes: raw }) => {
      const patch = JSON.parse(raw.bindings[0]);
      const isFreeze = Object.prototype.hasOwnProperty.call(patch, 'lawnWateringFreeze');
      state.statements.push({ sql: raw.sql, guard: q.guard, keys: Object.keys(patch), isFreeze });
      if (isFreeze && state.notes.lawnWateringFreeze) return 0;
      Object.assign(state.notes, patch);
      return 1;
    };
    return q;
  };
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, state };
}

function reportOnce(instruction) {
  buildReportV1Data.mockImplementationOnce(async (_record, _token, _knex, opts) => {
    if (instruction) opts.wateringInstructionOut.instruction = instruction;
    return { reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'h' }, ...(instruction ? { banner: { state: instruction.state, lines: instruction.lines } } : {}) } };
  });
}
const run = (knex) => finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });

test('the freeze is its own guarded statement; lawnReportV2 keeps its pinned write and never carries the instruction', async () => {
  reportOnce(INSTRUCTION(40));
  const { knex, state } = fakeKnex({});
  const result = await run(knex);
  expect(result.persisted).toBe(true);
  const [main, freeze] = state.statements;
  expect(main.sql).toBe("COALESCE(structured_notes::jsonb, '{}'::jsonb) || ?::jsonb");
  expect(main.keys).toEqual(['lawnReportV2']);
  expect(state.notes.lawnReportV2).toMatchObject({ smsSummary: 'sms', statusHeadline: 'h' });
  expect(state.notes.lawnReportV2).not.toHaveProperty('wateringInstruction');
  expect(state.notes.lawnReportV2).not.toHaveProperty('banner');
  expect(freeze.isFreeze).toBe(true);
  expect(freeze.guard).toBe("(structured_notes::jsonb -> 'lawnWateringFreeze') IS NULL");
  expect(state.notes.lawnWateringFreeze).toMatchObject({ wateringInstruction: INSTRUCTION(40), banner: { state: 'water_in' } });
  expect(result.wateringFreeze).toEqual(state.notes.lawnWateringFreeze);
  // The gate's own token mint is handed back so the handler can recover from a failed earlier mint.
  expect(result.reportToken).toBe('c'.repeat(32));
});

test('two writers with different instructions: the first persists whichever order they run in', async () => {
  for (const order of [[40, 15], [15, 40]]) {
    const { knex, state } = fakeKnex({});
    const results = [];
    for (const minutes of order) {
      reportOnce(INSTRUCTION(minutes));
      results.push(await run(knex));
    }
    expect(state.notes.lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(order[0]));
    // Both callers are handed what actually persisted, not what they built.
    for (const r of results) expect(r.wateringFreeze.wateringInstruction).toEqual(INSTRUCTION(order[0]));
  }
});

test('a retry after the first freeze changes nothing', async () => {
  const { knex, state } = fakeKnex({});
  reportOnce(INSTRUCTION(40)); await run(knex);
  const before = JSON.stringify(state.notes.lawnWateringFreeze);
  reportOnce(INSTRUCTION(15)); await run(knex);
  expect(JSON.stringify(state.notes.lawnWateringFreeze)).toBe(before);
});

test('gate off: the freeze statement is never issued, and an existing snapshot is untouched byte for byte', async () => {
  const existing = { wateringInstruction: INSTRUCTION(40), banner: { state: 'water_in', lines: INSTRUCTION(40).lines }, frozenAt: '2026-09-30T18:41:00.000Z' };
  const { knex, state } = fakeKnex({ lawnReportV2: { smsSummary: 'old' }, lawnWateringFreeze: existing });
  reportOnce(null);
  const result = await run(knex);
  expect(state.statements.map((s) => s.keys)).toEqual([['lawnReportV2']]);
  expect(JSON.stringify(state.notes.lawnWateringFreeze)).toBe(JSON.stringify(existing));
  expect(result.wateringFreeze).toBeNull();
  // Nothing frozen yet + gate off: no freeze key is created.
  const fresh = fakeKnex({});
  reportOnce(null);
  await run(fresh.knex);
  expect(fresh.state.notes).not.toHaveProperty('lawnWateringFreeze');
});

test('a no-claim (state null) instruction, or one built while the products could not be read, is never frozen', async () => {
  for (const [, instruction, productsLoadFailed] of [
    ['state null', { ...INSTRUCTION(40), state: null, lines: [] }, false],
    ['products read failed', INSTRUCTION(40), true],
  ]) {
    buildReportV1Data.mockImplementationOnce(async (_r, _t, _k, opts) => {
      opts.wateringInstructionOut.instruction = instruction;
      opts.wateringInstructionOut.productsLoadFailed = productsLoadFailed;
      return { reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'h' } } };
    });
    const { knex, state } = fakeKnex({});
    const result = await run(knex);
    expect(result.persisted).toBe(true);
    expect(state.statements.map((x) => x.keys)).toEqual([['lawnReportV2']]);
    expect(state.notes).not.toHaveProperty('lawnWateringFreeze');
    expect(result.wateringFreeze).toBeNull();
  }
  // A later clean run with a real claim does freeze.
  reportOnce(INSTRUCTION(40));
  const { knex, state } = fakeKnex({});
  await run(knex);
  expect(state.notes.lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
});

test('a state-null instruction is never frozen, even with a label mow hold (regenerated from the frozen product facts)', async () => {
  const mowHold = { days: 2, untilAt: '2026-10-02T19:00:00.000Z', untilDate: '2026-10-02', untilLabel: 'Fri 3 PM', line: 'Mowing: hold off until Fri 3 PM, 2 days after today\'s treatment.' };
  const instruction = { ...INSTRUCTION(40), state: null, lines: [], mowHold };
  buildReportV1Data.mockImplementationOnce(async (_r, _t, _k, opts) => {
    opts.wateringInstructionOut.instruction = instruction;
    opts.wateringInstructionOut.productsLoadFailed = false;
    return { reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'h' }, banner: { state: null, lines: [], mowHold } } };
  });
  const { knex, state } = fakeKnex({});
  await run(knex);
  expect(state.notes).not.toHaveProperty('lawnWateringFreeze');
});

test('gate back on after a rollback: the original instruction is what persists', async () => {
  const existing = { wateringInstruction: INSTRUCTION(40), banner: null };
  const { knex, state } = fakeKnex({ lawnWateringFreeze: existing });
  reportOnce(INSTRUCTION(15));
  const result = await run(knex);
  expect(state.notes.lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
  expect(result.wateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
});

describe('the completion path freezes independently of completion-text delivery', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');

  test('exactly one call site, in the common path ahead of both delivery branches', () => {
    expect((source.match(/finalizeLawnReportSynthesis\(/g) || []).length).toBe(1);
    const call = source.indexOf('finalizeLawnReportSynthesis({');
    // Gated on the report lane only: not on the completion-text toggle, a phone, or the text-handled flags.
    const guard = source.slice(source.lastIndexOf('if (', call), call);
    expect(guard).toContain("serviceReportV1Delivery && typedDeliveryMode === 'auto_send'");
    expect(guard).not.toMatch(/effectiveSendCompletionSms|cust_phone|completionSmsAlreadyHandled/);
    // Ahead of the token-withheld text branch and the text-send branch...
    const firstTextBranch = source.indexOf('if (effectiveSendCompletionSms && svc.cust_phone');
    expect(firstTextBranch).toBeGreaterThan(0);
    expect(call).toBeLessThan(firstTextBranch);
    // ...and ahead of the first email queue call, after the email helper is defined.
    expect(source.indexOf('const queueServiceReportEmailIfEligible')).toBeLessThan(call);
    expect(call).toBeLessThan(source.indexOf('await queueServiceReportEmailIfEligible();'));
    // Its fold-in of the frozen keys stays with it.
    expect(source.slice(call, call + 1200)).toContain('recordStructuredNotes.lawnReportV2 = gate.frozen');
    expect(source.slice(call, call + 1200)).toContain('recordStructuredNotes.lawnWateringFreeze = gate.wateringFreeze');
  });

  test('the gate itself takes no delivery-channel input', async () => {
    reportOnce(INSTRUCTION(40));
    const { knex, state } = fakeKnex({});
    // An email-only customer: no phone, no text — the gate is called with the record alone.
    const result = await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn', cust_phone: null }, knex });
    expect(result.persisted).toBe(true);
    expect(state.notes.lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
  });
});
