// Tech Rewards Plan D5-5: the pure parts of the December gift pay line sync (which pay date it is due on, what it covers, its
// source key) and the gate behavior that needs no database. Synthetic fixtures only.
// The sync against Postgres is in tech-rewards-pay-lines-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));
const { recordAuditEvent } = require('../services/audit-log');

const {
  decemberGiftDate, dueInRun, lastPayDate, spanOf, sourceIdOf, syncTechRewardLines, DECEMBER_GIFT_CENTS, SOURCE_TYPE,
} = require('../services/tech-rewards-pay-lines');
const { weeksOfLine } = require('../services/payroll-regular-rate');

describe('decemberGiftDate: the last Friday on or before Dec 20', () => {
  test.each([
    [2026, '2026-12-18'], // Dec 20 is a Sunday
    [2027, '2027-12-17'], // Dec 20 is a Monday
    [2028, '2028-12-15'], // Dec 20 is a Wednesday
    [2024, '2024-12-20'], // Dec 20 is itself a Friday
    [2025, '2025-12-19'], // a Saturday
  ])('%s -> %s', (year, expected) => {
    expect(decemberGiftDate(year)).toBe(expected);
    expect(new Date(`${expected}T12:00:00Z`).getUTCDay()).toBe(5);
  });
});

describe('dueInRun: which lines a run dated that day may write (from the due date, up to 60 days after it)', () => {
  const kinds = (payDate) => dueInRun(payDate).map((d) => `${d.kind}:${d.key}`);

  test('the December gift is due its Friday and may be written until 60 days after, over the new year too', () => {
    expect(kinds('2026-12-18')).toEqual(['december_gift:2026']);
    expect(kinds('2026-12-11')).toEqual([]); // before the due date
    expect(kinds('2026-12-25')).toEqual(['december_gift:2026']); // a later run may write it when the first was not ready
    expect(kinds('2027-02-16')).toEqual(['december_gift:2026']); // 60 days
    expect(kinds('2027-02-17')).toEqual([]);
    expect(kinds('2024-12-20')).toEqual(['december_gift:2024']);
    expect(kinds('2026-06-05')).toEqual([]);
  });

  test('the last pay date is 60 days after the gift date, the day the waiting note shows', () => {
    expect(lastPayDate(2026)).toBe('2027-02-16');
    expect(lastPayDate(2024)).toBe('2025-02-18');
    expect(kinds(lastPayDate(2026))).toEqual(['december_gift:2026']);
  });
});

describe('spanOf: what the gift covers (it must stay inside what payroll_pay_lines allows)', () => {
  test('Jan 1 to the end of the pay week, never after the week that pays it', () => {
    expect(spanOf('2026', '2026-12-07')).toEqual({ earnedWeekStart: '2026-12-07', coversFrom: '2026-01-01', coversTo: '2026-12-13' });
  });

  test('a run after the year ends covers the whole year, to Dec 31', () => {
    expect(spanOf('2026', '2026-12-28')).toEqual({ earnedWeekStart: '2026-12-28', coversFrom: '2026-01-01', coversTo: '2026-12-31' });
    expect(spanOf('2026', '2027-01-04')).toEqual({ earnedWeekStart: '2027-01-04', coversFrom: '2026-01-01', coversTo: '2026-12-31' });
  });

  test('the span ends in or before its pay week and spreads over whole workweeks for the overtime recalculation', () => {
    for (const week of ['2026-12-07', '2026-12-28', '2027-01-04']) {
      const span = spanOf('2026', week);
      const weeks = weeksOfLine({ coversFrom: span.coversFrom, coversTo: span.coversTo, weekStart: week });
      expect(weeks.at(-1) <= week).toBe(true);
      expect(span.coversFrom <= span.coversTo).toBe(true);
    }
    // Jan 1 2026 is a Thursday: the week of Dec 29 2025 through the week of Dec 7 2026
    expect(weeksOfLine({ coversFrom: '2026-01-01', coversTo: '2026-12-13', weekStart: '2026-12-07' })).toHaveLength(50);
  });
});

describe('source key', () => {
  test('is december_gift:<technician>:<year>', () => {
    expect(sourceIdOf('december_gift', 'abc', '2026')).toBe('december_gift:abc:2026');
    expect(SOURCE_TYPE).toBe('tech_rewards');
    expect(DECEMBER_GIFT_CENTS).toBe(30000);
  });
});

describe('the gates', () => {
  const OLD = { pay: process.env.GATE_PAYROLL_PAY_LINES, rewards: process.env.GATE_TECH_REWARDS_PAY_LINES };
  beforeEach(() => recordAuditEvent.mockClear());
  afterEach(() => {
    for (const [name, value] of [['GATE_PAYROLL_PAY_LINES', OLD.pay], ['GATE_TECH_REWARDS_PAY_LINES', OLD.rewards]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const run = { id: 'run-1', week_start: '2026-12-07', pay_date: '2026-12-18' };
  // A knex stand-in that records each call as [method, table, argument].
  const recorder = () => {
    const calls = [];
    const trx = jest.fn((table) => {
      const chain = {
        where: jest.fn((where) => { calls.push(['where', table, where]); return chain; }),
        whereNotNull: jest.fn((column) => { calls.push(['whereNotNull', table, column]); return chain; }),
        whereIn: jest.fn((column, ids) => { calls.push(['whereIn', table, ids]); return chain; }),
        select: jest.fn(async () => { calls.push(['select', table]); return [{ id: 'line-1' }]; }),
        update: jest.fn(async (patch) => { calls.push(['update', table, patch]); return 0; }),
        del: jest.fn(async () => { calls.push(['del', table]); return 1; }),
        forUpdate: jest.fn(() => chain),
      };
      return chain;
    });
    trx.fn = { now: jest.fn() };
    return { trx, calls };
  };
  // the one statement a sync runs on the run row with a gate off: the stored waits of this draft are cleared
  const CLEAR_WAITS = [
    ['where', 'payroll_runs', { id: 'run-1', status: 'draft' }],
    ['whereNotNull', 'payroll_runs', 'tech_rewards_waits'],
    ['update', 'payroll_runs', { tech_rewards_waits: null }],
  ];

  test('pay lines off: no pay line is read or written, whatever the rewards gate says; the stored waits are cleared', async () => {
    delete process.env.GATE_PAYROLL_PAY_LINES;
    process.env.GATE_TECH_REWARDS_PAY_LINES = 'true';
    const { trx, calls } = recorder();
    await expect(syncTechRewardLines(run, trx)).resolves.toEqual({ added: 0, updated: 0, removed: 0, skipped: [], waits: [] });
    expect(calls).toEqual(CLEAR_WAITS);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  test('rewards gate off: the stored waits are cleared and only the open Tech Rewards lines come off (paid lines are never selected)', async () => {
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    delete process.env.GATE_TECH_REWARDS_PAY_LINES;
    const { trx, calls } = recorder();
    const result = await syncTechRewardLines(run, trx, { lock: false });
    expect(result.removed).toBe(1);
    expect(calls.slice(0, 3)).toEqual(CLEAR_WAITS);
    expect(calls).toContainEqual(['where', 'payroll_pay_lines', { source_type: 'tech_rewards', status: 'open' }]);
    expect(calls).toContainEqual(['del', 'payroll_pay_lines']);
    expect(calls.filter(([method, table]) => method === 'update' && table !== 'payroll_runs')).toEqual([]);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'payroll.tech_rewards_lines_synced', metadata: expect.objectContaining({ gate: 'off', removed_line_ids: ['line-1'] }),
    }));
  });
});
