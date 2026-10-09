// The visit PLAN reads the account strictly (codex #6035 r46 P1): a failed account read is an
// explicit unavailable state with a warning on a step-month visit, never a silently ineligible one.
const { openPlanStep } = require('../services/lawn-bermuda-removal');
const { LAWN_V13_VERSION } = require('../services/lawn-program');

const failing = () => { throw new Error('read failed'); };
failing.raw = failing;
failing.transaction = async () => { throw new Error('read failed'); };
const service = (date) => ({ id: 'plan-visit', customer_id: 'fixture-customer', property_id: null, scheduled_date: date });
const open = (date, extra = {}) => openPlanStep(failing, { enabled: true, service: service(date), profile: { grass_type: 'st_augustine', cultivar: 'Floratam' }, calendarTrackKey: 'st_augustine', ...extra });
const resolved = async (date, month) => (await open(date)).resolve({ structuredProtocol: { version: LAWN_V13_VERSION }, trackKey: 'st_augustine', month, parseLines: () => [] });
const warningCodes = async (stage) => (await stage.project([], { enabled: true, rows: new Map(), probeLimits: async () => ({}), productOf: () => null })).warnings.map((w) => w.code);

beforeEach(() => { process.env.GATE_LAWN_V13 = 'true'; process.env.GATE_LAWN_BERMUDA_REMOVAL = 'true'; });
afterEach(() => { delete process.env.GATE_LAWN_V13; delete process.env.GATE_LAWN_BERMUDA_REMOVAL; });

test('a failed account read on a step-month visit: no step lines, and the eligibility-unavailable warning', async () => {
  const stage = await resolved('2026-04-14', 'Apr');
  expect(stage.lines).toEqual([]);
  expect(stage.field).toEqual({});
  expect(await warningCodes(stage)).toEqual(['lawn_bermuda_eligibility_unavailable']);
});

test('the same failure on a visit that carries no step (May) warns nothing', async () => {
  expect(await warningCodes(await resolved('2026-05-12', 'May'))).toEqual([]);
});

test('a strict caller gets the read error itself', async () => {
  await expect(open('2026-04-14', { strict: true })).rejects.toThrow('read failed');
});

test('gate off: the account is never read and nothing is warned', async () => {
  delete process.env.GATE_LAWN_BERMUDA_REMOVAL;
  expect(await warningCodes(await resolved('2026-04-14', 'Apr'))).toEqual([]);
});
