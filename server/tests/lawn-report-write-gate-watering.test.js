// The lawn write gate freezes the COMPLETE watering instruction beside
// smsSummary, first writer wins (GATE_LAWN_WATERING_RULE). Synthetic data only.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}' })),
  ensureReportToken: jest.fn(async () => 'token-1'),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const INSTRUCTION = (minutes) => ({ state: 'water_in', lines: ['Water in today’s treatment by Thu 2 PM.', `Run each zone about ${minutes} minutes.`], minutes: { measured: null }, ruleSource: 'default' });

function fakeKnex(structuredNotes) {
  const updates = [];
  const knex = () => ({
    where: () => ({
      first: async () => ({ structured_notes: structuredNotes }),
      update: async (patch) => { updates.push(patch); },
    }),
  });
  knex.raw = (sql, bindings) => ({ sql, bindings });
  return { knex, updates };
}

function reportOnce(instruction) {
  buildReportV1Data.mockImplementationOnce(async (_record, _token, _knex, opts) => {
    if (instruction) opts.wateringInstructionOut.instruction = instruction;
    return { reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'h' }, ...(instruction ? { banner: { state: instruction.state, lines: instruction.lines } } : {}) } };
  });
}
const frozenOf = (updates) => JSON.parse(updates[0].structured_notes.bindings[0]).lawnReportV2;

test('freezes the complete instruction beside the banner and smsSummary', async () => {
  reportOnce(INSTRUCTION(40));
  const { knex, updates } = fakeKnex('{}');
  const result = await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  expect(result.persisted).toBe(true);
  expect(frozenOf(updates)).toMatchObject({ smsSummary: 'sms', banner: { state: 'water_in' }, wateringInstruction: INSTRUCTION(40) });
});

test('first writer wins: an instruction already frozen is carried over, never replaced', async () => {
  reportOnce(INSTRUCTION(15)); // a later run built from edited sprinkler entries
  const { knex, updates } = fakeKnex(JSON.stringify({ lawnReportV2: { wateringInstruction: INSTRUCTION(40) } }));
  await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  expect(frozenOf(updates).wateringInstruction).toEqual(INSTRUCTION(40));
});

test('gate off, nothing frozen yet: no instruction or banner key is created', async () => {
  reportOnce(null);
  const { knex, updates } = fakeKnex('{}');
  await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  const frozen = frozenOf(updates);
  expect(frozen).not.toHaveProperty('wateringInstruction');
  expect(frozen).not.toHaveProperty('banner');
});

test('gate off + an existing frozen snapshot + a retry write: the frozen keys survive byte for byte', async () => {
  const existing = { banner: { state: 'water_in', lines: INSTRUCTION(40).lines, expiresAt: '2026-10-01T18:00:00.000Z' }, wateringInstruction: INSTRUCTION(40) };
  const notes = JSON.stringify({ lawnReportV2: { smsSummary: 'old', ...existing } });
  reportOnce(null); // gate rolled back: the build produces no instruction and no banner
  const { knex, updates } = fakeKnex(notes);
  await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  const frozen = frozenOf(updates);
  expect(JSON.stringify(frozen.wateringInstruction)).toBe(JSON.stringify(existing.wateringInstruction));
  expect(JSON.stringify(frozen.banner)).toBe(JSON.stringify(existing.banner));
  // The keys the gate does own are refreshed as before.
  expect(frozen.smsSummary).toBe('sms');
});

test('gate back on after a rollback: the write keeps the ORIGINAL instruction, not the regenerated one', async () => {
  const notes = JSON.stringify({ lawnReportV2: { banner: { state: 'water_in', lines: INSTRUCTION(40).lines }, wateringInstruction: INSTRUCTION(40) } });
  reportOnce(INSTRUCTION(15));
  const { knex, updates } = fakeKnex(notes);
  await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  const frozen = frozenOf(updates);
  expect(frozen.wateringInstruction).toEqual(INSTRUCTION(40));
  expect(frozen.banner.lines[1]).toBe('Run each zone about 40 minutes.');
});

test('a failed read of the record aborts the write instead of risking the snapshot', async () => {
  reportOnce(INSTRUCTION(15));
  const updates = [];
  const knex = () => ({ where: () => ({ first: async () => { throw new Error('db blip'); }, update: async (p) => { updates.push(p); } }) });
  knex.raw = (sql, bindings) => ({ sql, bindings });
  const result = await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  expect(result.persisted).toBe(false);
  expect(updates).toEqual([]);
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
    expect(source.slice(call, call + 900)).toContain('recordStructuredNotes.lawnReportV2 = gate.frozen');
  });

  test('the gate itself takes no delivery-channel input', async () => {
    reportOnce(INSTRUCTION(40));
    const { knex, updates } = fakeKnex('{}');
    // An email-only customer: no phone, no text — the gate is called with the record alone.
    const result = await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn', cust_phone: null }, knex });
    expect(result.persisted).toBe(true);
    expect(frozenOf(updates).wateringInstruction).toEqual(INSTRUCTION(40));
  });
});
