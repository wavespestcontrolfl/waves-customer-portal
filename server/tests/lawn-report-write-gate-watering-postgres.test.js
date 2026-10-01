// The watering-instruction freeze against REAL Postgres: the guarded UPDATE is
// the whole first-writer-wins guarantee, so its SQL is executed, not simulated.
// Runs in a private throwaway schema; skipped without DATABASE_URL (CI has it).
// Synthetic data only.

jest.mock('../services/service-report/pdf-queue', () => ({
  loadServiceRecordForPdf: jest.fn(async (id) => ({ id, service_line: 'lawn', structured_notes: '{}' })),
  ensureReportToken: jest.fn(async () => 'token-1'),
}));
jest.mock('../services/service-report/report-data', () => ({ buildReportV1Data: jest.fn() }));
jest.mock('../services/service-report/report-consistency', () => ({ reconcileLawnReport: jest.fn(() => ({ warnings: [] })) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { buildReportV1Data } = require('../services/service-report/report-data');
const { finalizeLawnReportSynthesis } = require('../services/service-report/lawn-report-write-gate');

const URL = process.env.LAWN_GATE_TEST_DATABASE_URL || process.env.DATABASE_URL;
const describeIfDb = URL ? describe : describe.skip;

const INSTRUCTION = (minutes) => ({ state: 'water_in', lines: ['Water in today’s treatment by Thu 2 PM.', `Run each zone about ${minutes} minutes.`], minutes: { measured: null }, ruleSource: 'default' });
const build = (instruction) => buildReportV1Data.mockImplementationOnce(async (_r, _t, _k, opts) => {
  if (instruction) opts.wateringInstructionOut.instruction = instruction;
  return { reportV2: { smsSummary: 'sms', snapshot: { statusHeadline: 'h' }, ...(instruction ? { banner: { state: instruction.state, lines: instruction.lines } } : {}) } };
});

describeIfDb('lawn write gate freeze (postgres)', () => {
  let knex; let schema;
  const notes = async () => (await knex('service_records').where({ id: 's1' }).first('structured_notes')).structured_notes;
  const run = (k = knex) => finalizeLawnReportSynthesis({ service: { id: 's1', service_line: 'lawn' }, knex: k });

  beforeAll(async () => {
    schema = `lawn_gate_test_${Math.random().toString(36).slice(2, 10)}`;
    const setup = require('knex')({ client: 'pg', connection: URL, pool: { min: 1, max: 1 } });
    await setup.raw(`CREATE SCHEMA ${schema}`);
    await setup.destroy();
    knex = require('knex')({
      client: 'pg',
      connection: URL,
      pool: { min: 0, max: 4, afterCreate: (conn, done) => conn.query(`SET search_path TO ${schema}`, (err) => done(err, conn)) },
    });
    await knex.raw('CREATE TABLE service_records (id text PRIMARY KEY, structured_notes jsonb)');
  });
  afterAll(async () => {
    if (!knex) return;
    await knex.raw(`DROP SCHEMA ${schema} CASCADE`);
    await knex.destroy();
  });
  beforeEach(async () => {
    buildReportV1Data.mockReset();
    await knex('service_records').del();
    await knex('service_records').insert({ id: 's1', structured_notes: JSON.stringify({ timeOnSiteAdjusted: true }) });
  });

  test('first writer persists in either order, and unrelated keys survive', async () => {
    for (const order of [[40, 15], [15, 40]]) {
      await knex('service_records').where({ id: 's1' }).update({ structured_notes: JSON.stringify({ timeOnSiteAdjusted: true }) });
      for (const minutes of order) { build(INSTRUCTION(minutes)); await run(); }
      const n = await notes();
      expect(n.lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(order[0]));
      expect(n.lawnWateringFreeze.banner.state).toBe('water_in');
      expect(n.timeOnSiteAdjusted).toBe(true);
      expect(n.lawnReportV2).toMatchObject({ smsSummary: 'sms' });
      expect(n.lawnReportV2).not.toHaveProperty('wateringInstruction');
    }
  });

  test('two truly concurrent writers: the second blocks on the row lock, re-checks the guard, and writes nothing', async () => {
    const trx = await knex.transaction();
    build(INSTRUCTION(40));
    await run(trx); // holds the row lock, uncommitted
    build(INSTRUCTION(15));
    const second = run(knex); // blocks behind the first's lock
    await new Promise((resolve) => setTimeout(resolve, 300));
    await trx.commit();
    const result = await second;
    expect((await notes()).lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
    expect(result.wateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
  });

  test('a retry, and a gate-off write, leave the frozen snapshot byte for byte', async () => {
    build(INSTRUCTION(40)); await run();
    const frozen = JSON.stringify((await notes()).lawnWateringFreeze);
    build(INSTRUCTION(15)); await run(); // retry
    build(null); await run(); // gate rolled back: nothing built
    expect(JSON.stringify((await notes()).lawnWateringFreeze)).toBe(frozen);
    build(INSTRUCTION(15)); await run(); // gate back on
    expect((await notes()).lawnWateringFreeze.wateringInstruction).toEqual(INSTRUCTION(40));
  });

  test('gate off with nothing frozen creates no freeze key', async () => {
    build(null); await run();
    expect(await notes()).not.toHaveProperty('lawnWateringFreeze');
  });
});
