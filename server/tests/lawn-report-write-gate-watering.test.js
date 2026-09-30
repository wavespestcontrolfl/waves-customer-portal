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

test('gate off: nothing built, no key written, no extra read', async () => {
  reportOnce(null);
  const { knex, updates } = fakeKnex(JSON.stringify({ lawnReportV2: { wateringInstruction: INSTRUCTION(40) } }));
  await finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex });
  const frozen = frozenOf(updates);
  expect(frozen).not.toHaveProperty('wateringInstruction');
  expect(frozen).not.toHaveProperty('banner');
});
