process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
// The CSR overview shows the week's new-customer call outcomes; the leaderboard does not, so it skips that
// aggregate and each dashboard load scans the week's calls once. Rows are synthetic (none).
// Each db() read is a chain that resolves to mockScoreRows (none unless a test sets them).
let mockScoreRows = [];
jest.mock('../models/db', () => jest.fn(() => {
  const chain = {};
  for (const method of ['where', 'joinRaw', 'select']) chain[method] = jest.fn(() => chain);
  chain.then = (resolve, reject) => Promise.resolve(mockScoreRows).then(resolve, reject);
  return chain;
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  ...jest.requireActual('../middleware/admin-auth'),
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; return next(); },
}));
const mockLoad = jest.fn(async () => ({
  from: new Date('2026-11-14T05:00:00Z'), to: new Date('2026-11-20T13:00:00Z'),
  newCustomerCallers: 0, callersWithOutcome: 0, bookedOnCall: 0, bookedPct: null, estimateRequestedOrPromised: 0,
}));
jest.mock('../services/csr/weekly-call-outcomes', () => ({
  ...jest.requireActual('../services/csr/weekly-call-outcomes'),
  loadWeeklyCallOutcomes: (...args) => mockLoad(...args),
}));

const CSRCoach = require('../services/csr/csr-coach');

beforeEach(() => { mockLoad.mockClear(); mockScoreRows = []; });

test('GET /overview returns the week\'s call outcomes once, with their summary line, beside the team stats', async () => {
  const express = require('express');
  const app = express();
  app.use('/api/admin/csr', require('../routes/admin-csr'));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/csr/overview?days=30`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(mockLoad).toHaveBeenCalledTimes(1);
    expect(body.weeklyCallOutcomes).toMatchObject({ newCustomerCallers: 0, text: expect.stringContaining('New-customer callers: 0.') });
    expect(body.csrStats).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failed outcomes read gives null (the overview still loads)', async () => {
  mockLoad.mockRejectedValueOnce(Object.assign(new Error('canceled'), { code: '57014' }));
  await expect(CSRCoach.loadWeeklyCallOutcomesFailSoft()).resolves.toBeNull();
});

test('getTeamOverview alone does not load them', async () => {
  const overview = await CSRCoach.getTeamOverview(30);
  expect(mockLoad).not.toHaveBeenCalled();
  expect(overview).not.toHaveProperty('weeklyCallOutcomes');
});

test('the leaderboard does not load them', async () => {
  await CSRCoach.getLeaderboard();
  expect(mockLoad).not.toHaveBeenCalled();
});

// The Friday tip reads its scored-call recommendation over the same seven completed days as its call-outcomes line, and
// places each score by the ET date its call STARTED (call_date is when scoring finished).
const PERIOD = { fromDate: '2026-11-13', toDate: '2026-11-20' }; // the tip of Friday 2026-11-20
test('a recommendation asked for a period reads scores from its first date, with each linked call\'s start', async () => {
  const db = require('../models/db');
  db.mockClear();
  await CSRCoach.generateWeeklyTeamRecommendation({ between: PERIOD });
  const reads = db.mock.calls.map(([table], i) => [table, db.mock.results[i].value]).filter(([table]) => table === 'csr_call_scores as s');
  expect(reads).toHaveLength(1);
  const read = reads[0][1];
  expect(read.where).toHaveBeenCalledWith('s.call_date', '>=', '2026-11-13');
  const [lateral, bindings] = read.joinRaw.mock.calls[0];
  expect(lateral).toContain("cl.twilio_call_sid = s.metadata->>'callSid'");
  expect(lateral).toContain(require('../services/sms-pending-conversations').callStartedAtSql('cl'));
  // A voice sandbox or tech-line row gives no start (whereNotSandboxCall's two sources), so its score keeps call_date.
  const { VOICE_RELAY_SANDBOX_SOURCE, TECH_VOICE_SOURCE } = require('../services/voice-agent/relay-protocol');
  expect(lateral).toContain("AND COALESCE(cl.source, '') <> ? AND COALESCE(cl.source, '') <> ?) call_start ON TRUE");
  expect(bindings).toEqual([VOICE_RELAY_SANDBOX_SOURCE, TECH_VOICE_SOURCE]);
});

test.each([
  ['a Thursday call scored Friday before 8 AM is Thursday\'s', { call_started_at: new Date('2026-11-19T21:30:00Z'), call_date: '2026-11-20' }, true],
  ['the last Thursday call, scored on the period\'s first Friday, is last week\'s', { call_started_at: new Date('2026-11-13T03:30:00Z'), call_date: '2026-11-13' }, false],
  ['a call that started at 11:30 PM Thursday ET is Thursday\'s', { call_started_at: new Date('2026-11-20T04:30:00Z'), call_date: '2026-11-20' }, true],
  ['a score with no linked call keeps its call_date', { call_started_at: null, call_date: '2026-11-19' }, true],
  ['an unlinked score dated the tip\'s own Friday waits for the next tip', { call_started_at: null, call_date: '2026-11-20' }, false],
])('scoreInTipPeriod: %s', (_label, score, inPeriod) => {
  expect(CSRCoach.scoreInTipPeriod(score, PERIOD)).toBe(inPeriod);
});

// Five scores are the recommendation's minimum: the Thursday call scored Friday is the fifth, so it must count.
test('the Thursday call scored Friday counts toward this Friday\'s recommendation', async () => {
  const row = (startedAt, callDate, booked) => ({
    call_started_at: startedAt ? new Date(startedAt) : null, call_date: callDate,
    call_outcome: booked ? 'booked' : 'not_booked', point_details: JSON.stringify({ greeting: booked ? 1 : 0 }),
  });
  const four = [
    row('2026-11-16T15:00:00Z', '2026-11-16', true), row('2026-11-17T15:00:00Z', '2026-11-17', true),
    row('2026-11-17T16:00:00Z', '2026-11-17', false), row(null, '2026-11-18', false),
  ];
  mockScoreRows = [...four, row('2026-11-19T21:30:00Z', '2026-11-20', true)];
  const counted = await CSRCoach.generateWeeklyTeamRecommendation({ between: PERIOD });
  expect(counted.recommendation).not.toMatch(/^Not enough data/);
  mockScoreRows = [...four, row('2026-11-13T03:30:00Z', '2026-11-13', true)];
  const lastWeek = await CSRCoach.generateWeeklyTeamRecommendation({ between: PERIOD });
  expect(lastWeek.recommendation).toMatch(/^Not enough data/);
});
