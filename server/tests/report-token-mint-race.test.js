/**
 * Report-link minting converges on ONE token under a concurrent mint
 * (completion + an IB closeout repair): the write is conditional on the
 * token still being empty, and the loser returns the winner's persisted
 * token — never its own unpersisted one, which would strand a queued email.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');

// One service_records row shared by both writers. Both first() reads happen
// before either write, so both see an empty token — the race.
function racingKnex(row) {
  const reads = [];
  const knex = jest.fn(() => {
    const filters = { nullToken: false };
    const chain = {
      where: () => chain,
      whereNull: (col) => { if (col === 'report_view_token') filters.nullToken = true; return chain; },
      first: async () => {
        reads.push(row.report_view_token);
        return { ...row };
      },
      update: async (patch) => {
        if (filters.nullToken && row.report_view_token) return 0;
        Object.assign(row, patch);
        return 1;
      },
    };
    return chain;
  });
  knex.fn = { now: () => 'now()' };
  return { knex, reads };
}

test('pdf-queue ensureReportToken: the second concurrent mint returns the first token', async () => {
  const { ensureReportToken } = require('../services/service-report/pdf-queue');
  const row = { id: 'rec-1', report_view_token: null };
  const { knex } = racingKnex(row);
  const [a, b] = await Promise.all([ensureReportToken('rec-1', knex), ensureReportToken('rec-1', knex)]);
  expect(a).toMatch(/^[a-f0-9]{32}$/);
  expect(b).toBe(a);
  expect(row.report_view_token).toBe(a);
});

test('reports-public ensureReportToken (completion path): same convergence', async () => {
  const row = { id: 'rec-2', report_view_token: null };
  const { knex } = racingKnex(row);
  db.mockImplementation(knex);
  db.fn = knex.fn;
  const { ensureReportToken } = require('../routes/reports-public');
  const [a, b] = await Promise.all([ensureReportToken('rec-2'), ensureReportToken('rec-2')]);
  expect(a).toMatch(/^[a-f0-9]{32}$/);
  expect(b).toBe(a);
  expect(row.report_view_token).toBe(a);
});
