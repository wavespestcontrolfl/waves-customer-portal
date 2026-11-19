// The CSR overview shows the week's new-customer call outcomes; the leaderboard does not, so it skips that
// aggregate and each dashboard load scans the week's calls once. Rows are synthetic (none).
jest.mock('../models/db', () => jest.fn(() => ({ where: jest.fn(() => Promise.resolve([])) })));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const mockLoad = jest.fn(async () => ({
  from: new Date('2026-11-14T05:00:00Z'), to: new Date('2026-11-20T13:00:00Z'),
  newCustomerCallers: 0, callersWithOutcome: 0, bookedOnCall: 0, bookedPct: null, estimateRequestedOrPromised: 0,
}));
jest.mock('../services/csr/weekly-call-outcomes', () => ({
  ...jest.requireActual('../services/csr/weekly-call-outcomes'),
  loadWeeklyCallOutcomes: (...args) => mockLoad(...args),
}));

const CSRCoach = require('../services/csr/csr-coach');

beforeEach(() => mockLoad.mockClear());

test('the overview loads the week\'s call outcomes once, with their summary line', async () => {
  const overview = await CSRCoach.getTeamOverview(30);
  expect(mockLoad).toHaveBeenCalledTimes(1);
  expect(overview.weeklyCallOutcomes).toMatchObject({ newCustomerCallers: 0, text: expect.stringContaining('New-customer callers: 0.') });
});

test('the leaderboard does not load them', async () => {
  await CSRCoach.getLeaderboard();
  expect(mockLoad).not.toHaveBeenCalled();
});
