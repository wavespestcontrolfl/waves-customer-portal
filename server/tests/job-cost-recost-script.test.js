// L11b: server/scripts/job-cost-recost.js. Dry run by default; --write needs GATE_TECH_COST_RATES; 400 days at most.
const mockRecostVisits = jest.fn();
jest.mock('../services/job-cost-recost', () => ({ recostVisits: (...a) => mockRecostVisits(...a) }));

const { run, parseArgs, checkRange } = require('../scripts/job-cost-recost');

function fakeConn(ids) {
  const seen = [];
  const conn = (table) => {
    seen.push(table);
    const chain = {};
    for (const m of ['where', 'whereNotNull', 'orderBy']) chain[m] = (...args) => { seen.push([m, ...args]); return chain; };
    chain.pluck = () => Promise.resolve(ids);
    return chain;
  };
  conn.seen = seen;
  return conn;
}

beforeEach(() => {
  mockRecostVisits.mockReset();
  mockRecostVisits.mockImplementation(async (conn, ids, { dryRun }) => ({ recosted: dryRun ? ids.length - 1 : ids.length, skipped: dryRun ? 1 : 0, failed: 0 }));
});

describe('job-cost-recost script', () => {
  test('dry run by default: counts, costs nothing, needs no gate', async () => {
    const log = jest.fn();
    const out = await run(['--from', '2026-10-01', '--to', '2026-10-25'], { conn: fakeConn(['a', 'b', 'c']), log, gateOn: () => false });
    expect(mockRecostVisits).toHaveBeenCalledWith(expect.anything(), ['a', 'b', 'c'], { dryRun: true });
    expect(out).toEqual({ visits: 3, recosted: 2, skipped: 1, failed: 0 });
    expect(log.mock.calls[0][0]).toMatch(/DRY RUN \(nothing written\), would re-cost 2 of 3/);
  });

  test('--write re-costs the visits when the gate is on', async () => {
    const out = await run(['--from', '2026-10-01', '--to', '2026-10-25', '--write'], { conn: fakeConn(['a', 'b']), log: jest.fn(), gateOn: () => true });
    expect(mockRecostVisits).toHaveBeenCalledWith(expect.anything(), ['a', 'b'], { dryRun: false });
    expect(out.recosted).toBe(2);
  });

  test('--write refuses when GATE_TECH_COST_RATES is not on, and costs nothing', async () => {
    await expect(run(['--from', '2026-10-01', '--to', '2026-10-25', '--write'], { conn: fakeConn(['a']), log: jest.fn(), gateOn: () => false }))
      .rejects.toThrow('GATE_TECH_COST_RATES is not "true"');
    expect(mockRecostVisits).not.toHaveBeenCalled();
  });

  test('a failed visit makes the run fail', async () => {
    mockRecostVisits.mockResolvedValue({ recosted: 1, skipped: 0, failed: 1 });
    await expect(run(['--from', '2026-10-01', '--to', '2026-10-02'], { conn: fakeConn(['a', 'b']), log: jest.fn() })).rejects.toThrow('1 visit(s) failed');
  });

  test('the range: real dates, in order, at most 400 days', () => {
    expect(checkRange('2025-09-23', '2026-10-27')).toBe(400);
    expect(() => checkRange('2025-09-22', '2026-10-27')).toThrow('at most 400 days (got 401)');
    expect(() => checkRange('2026-10-27', '2026-10-01')).toThrow('--from must not be after --to');
    expect(() => checkRange('2026-02-30', '2026-03-01')).toThrow('YYYY-MM-DD');
    expect(() => checkRange(null, '2026-03-01')).toThrow('YYYY-MM-DD');
  });

  test('an unknown flag is refused', () => {
    expect(() => parseArgs(['--from', '2026-10-01', '--force'])).toThrow('Unknown argument: --force');
  });
});
