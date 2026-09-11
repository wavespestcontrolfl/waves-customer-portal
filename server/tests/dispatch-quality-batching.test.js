// emitDispatchJobUpdate carries the post-change route refresh. A caller that
// mutates a BATCH of rows hands it one Set and flushes once at the end, so a
// 100-id bulk action runs a single route pass instead of 100 near-duplicate
// ones after its rows have already committed (codex #4295 r1 P2).
jest.mock('../models/db', () => jest.fn());
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/stamped-address', () => ({
  stampedDivergesSql: () => 'FALSE',
  stampedLine2Sql: () => 'NULL',
}));
jest.mock('../services/scheduling/quality-after-change', () => ({
  refreshScheduleQualityAfterChange: jest.fn(async () => ({ status: 'gate_off' })),
}));

const db = require('../models/db');
const { emitDispatchJobUpdate, flushDispatchQualityDates } = require('../services/dispatch-assignment');
const { refreshScheduleQualityAfterChange } = require('../services/scheduling/quality-after-change');

function primeJobs(byId) {
  db.mockImplementation(() => {
    const chain = {
      leftJoin: () => chain,
      where: (_col, id) => { chain.id = id; return chain; },
      first: async () => byId[chain.id] || null,
    };
    return chain;
  });
  db.raw = (sql) => sql;
}

beforeEach(() => {
  jest.clearAllMocks();
  primeJobs({
    'job-1': { job_id: 'job-1', status: 'scheduled', scheduled_date: '2040-09-11' },
    'job-2': { job_id: 'job-2', status: 'scheduled', scheduled_date: '2040-09-12' },
  });
});

test('a batch caller collects both days per row and triggers no refresh of its own', async () => {
  const qualityDates = new Set();
  await emitDispatchJobUpdate({ jobId: 'job-1', previousDate: '2040-09-10', qualityDates });
  await emitDispatchJobUpdate({ jobId: 'job-2', previousDate: '2040-09-10', qualityDates });
  expect([...qualityDates].sort()).toEqual(['2040-09-10', '2040-09-11', '2040-09-12']);
  expect(refreshScheduleQualityAfterChange).not.toHaveBeenCalled();

  await flushDispatchQualityDates(qualityDates);
  expect(refreshScheduleQualityAfterChange).toHaveBeenCalledTimes(1);
  expect(refreshScheduleQualityAfterChange.mock.calls[0][0].dates.sort())
    .toEqual(['2040-09-10', '2040-09-11', '2040-09-12']);
  // A flushed set is spent: a request that shares one Set between the
  // rebooker, a series-effects pass and its own final flush refreshes each
  // date once (codex #4295 r2 P2).
  expect(qualityDates.size).toBe(0);
  expect(await flushDispatchQualityDates(qualityDates)).toBeNull();
  expect(refreshScheduleQualityAfterChange).toHaveBeenCalledTimes(1);
});

test('a single-row caller still refreshes inline', async () => {
  await emitDispatchJobUpdate({ jobId: 'job-1', previousDate: '2040-09-10' });
  expect(refreshScheduleQualityAfterChange).toHaveBeenCalledWith({
    jobId: 'job-1', dates: ['2040-09-10', '2040-09-11'],
  });
});

test('an empty or absent batch does no database work', async () => {
  expect(await flushDispatchQualityDates(new Set())).toBeNull();
  expect(await flushDispatchQualityDates(null)).toBeNull();
  expect(refreshScheduleQualityAfterChange).not.toHaveBeenCalled();
});

test('a job that no longer exists neither broadcasts nor contributes a date', async () => {
  const qualityDates = new Set();
  expect(await emitDispatchJobUpdate({ jobId: 'gone', previousDate: '2040-09-10', qualityDates })).toBeNull();
  expect(qualityDates.size).toBe(0);
});
