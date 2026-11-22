// Tech Rewards Plan D5-5: the pure parts of the December gift, stay bonus and season bonus pay line sync (which pay date each
// is due on, what it covers, its source key) and the gate behavior that needs no database. Synthetic fixtures only.
// The sync against Postgres is in tech-rewards-pay-lines-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => 'audit-1') }));
const { recordAuditEvent } = require('../services/audit-log');

const {
  decemberGiftDate, dueInRun, lastPayDate, spanOf, sourceIdOf, syncTechRewardLines, DECEMBER_GIFT_CENTS, SOURCE_TYPE,
  FIRST_STAY_DATE, stayDueInRun, staySpanOf, FIRST_SEASON_YEAR, seasonDueInRun, seasonSpanOf,
} = require('../services/tech-rewards-pay-lines');
const { weeksOfLine } = require('../services/payroll-regular-rate');
const { techRewardsOwnKey, techRewardsOwnedSql } = require('../services/payroll-pay-lines');
const { defaultPayDate } = require('../services/payroll-runs');
const { addStaffWorkDays, staffWeekStartForWorkDate } = require('../utils/staff-time-work-date');

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
    expect(kinds('2026-06-05')).toEqual([]);
    expect(kinds('2027-12-17')).toEqual(['december_gift:2027']);
    expect(kinds('2028-01-07')).toEqual(['december_gift:2027']);
  });

  test('no year before 2026 has a gift: the plan was approved in November 2026', () => {
    // inside the 60 days after the 2025 gift date (Fri Dec 19, 2025), and on the 2024 and 2025 gift dates themselves
    for (const payDate of ['2025-12-19', '2025-12-26', '2026-01-09', '2026-02-13', '2024-12-20', '2025-01-10']) {
      expect([payDate, kinds(payDate)]).toEqual([payDate, []]);
    }
    // the 2026 gift keeps its January catch-up
    expect(kinds('2027-01-08')).toEqual(['december_gift:2026']);
  });

  test('the last pay date is 60 days after the gift date, the day the waiting note shows', () => {
    expect(lastPayDate(2026)).toBe('2027-02-16');
    expect(lastPayDate(2024)).toBe('2025-02-18');
    expect(kinds(lastPayDate(2026))).toEqual(['december_gift:2026']);
  });
});

describe('spanOf: what the gift covers (one period per technician and year, whichever run pays it)', () => {
  const period = (key, week, hire) => { const { coversFrom, coversTo } = spanOf(key, week, hire); return [coversFrom, coversTo]; };

  test('Jan 1 to the end of the gift week, the pay week whose check is dated the gift date', () => {
    expect(spanOf('2026', '2026-12-07')).toEqual({ earnedWeekStart: '2026-12-07', coversFrom: '2026-01-01', coversTo: '2026-12-13' });
    // the gift week is the week the pay run itself dates on the gift date, in any year
    for (const year of [2024, 2025, 2026, 2027, 2028]) {
      const [, coversTo] = period(String(year), '2026-12-07');
      const giftWeek = staffWeekStartForWorkDate(coversTo);
      expect(defaultPayDate(giftWeek)).toBe(decemberGiftDate(year));
      expect(coversTo).toBe(addStaffWorkDays(giftWeek, 6));
    }
  });

  test('the same period on a later run, in January too, and on a run for an earlier week (which the sync makes wait)', () => {
    for (const week of ['2026-11-02', '2026-12-07', '2026-12-14', '2026-12-28', '2027-01-04']) {
      expect(spanOf('2026', week)).toEqual({ earnedWeekStart: week, coversFrom: '2026-01-01', coversTo: '2026-12-13' });
    }
  });

  test('a technician hired during the year is covered from the hire date; one hired before it, or with none given, from Jan 1', () => {
    expect(period('2026', '2026-12-07', '2026-06-15')).toEqual(['2026-06-15', '2026-12-13']);
    expect(period('2026', '2026-12-07', '2024-01-10')).toEqual(['2026-01-01', '2026-12-13']);
    expect(period('2026', '2026-12-07', '2026-01-01')).toEqual(['2026-01-01', '2026-12-13']);
    expect(period('2026', '2026-12-07', null)).toEqual(['2026-01-01', '2026-12-13']);
    expect(period('2026', '2026-12-07', '2026-12-13')).toEqual(['2026-12-13', '2026-12-13']); // the last day of the gift week
  });

  test('a technician hired after the gift week ended, and by the gift date, is covered to the end of the week they were hired in', () => {
    for (const hired of ['2026-12-14', '2026-12-15', '2026-12-18']) {
      // the same on the gift week's own run (too early: the sync makes it wait) and on the next week's run (which writes it)
      expect(period('2026', '2026-12-07', hired)).toEqual([hired, '2026-12-20']);
      expect(period('2026', '2026-12-14', hired)).toEqual([hired, '2026-12-20']);
    }
  });

  test('the period spreads over whole workweeks for the overtime recalculation, and never ends after its own start', () => {
    // Jan 1 2026 is a Thursday: the week of Dec 29 2025 through the week of Dec 7 2026
    expect(weeksOfLine({ coversFrom: '2026-01-01', coversTo: '2026-12-13', weekStart: '2026-12-07' })).toHaveLength(50);
    expect(weeksOfLine({ coversFrom: '2026-01-01', coversTo: '2026-12-13', weekStart: '2027-01-04' })).toHaveLength(50);
    for (const hired of [null, '2026-03-02', '2026-12-13', '2026-12-14', '2026-12-18']) {
      const [coversFrom, coversTo] = period('2026', '2026-12-14', hired);
      expect(coversFrom <= coversTo).toBe(true);
    }
  });
});

describe('stayDueInRun: the stay bonus a run dated that day may write, by the hire date', () => {
  const keys = (payDate, hireDate) => stayDueInRun(payDate, hireDate).map((d) => `${d.kind}:${d.key}`);

  test('due from the anniversary to 60 days after it, and its key is the years of service', () => {
    const hired = '2027-01-12';
    expect(keys('2028-01-11', hired)).toEqual([]); // the day before the 1 year anniversary
    expect(keys('2028-01-12', hired)).toEqual(['stay_bonus:1']);
    expect(keys('2028-03-12', hired)).toEqual(['stay_bonus:1']); // 60 days after
    expect(keys('2028-03-13', hired)).toEqual([]);
    expect(keys('2030-01-18', hired)).toEqual(['stay_bonus:3']);
    expect(keys('2032-02-01', hired)).toEqual(['stay_bonus:5']);
    expect(keys('2029-01-12', hired)).toEqual([]); // 2 years is no milestone
    expect(keys('2034-01-12', hired)).toEqual([]); // none after 5 years
  });

  test('a Feb 29 hire has its anniversary on Mar 1 in a year with no Feb 29, as the calculator dates it', () => {
    expect(keys('2029-02-28', '2028-02-29')).toEqual([]);
    expect(keys('2029-03-01', '2028-02-29')).toEqual(['stay_bonus:1']);
  });

  test('no hire date, no anniversary: nothing is due', () => {
    expect(stayDueInRun('2028-01-12', null)).toEqual([]);
    expect(stayDueInRun('2028-01-12', undefined)).toEqual([]);
  });

  test('no anniversary before the plan was approved has a bonus', () => {
    expect(FIRST_STAY_DATE).toBe('2026-11-20');
    expect(keys('2026-11-27', '2025-11-19')).toEqual([]); // 1 year on Nov 19, 2026, the day before the plan
    expect(keys('2026-11-27', '2025-11-20')).toEqual(['stay_bonus:1']);
    expect(keys('2026-11-27', '2021-11-19')).toEqual([]); // 5 years, the day before the plan
  });
});

describe('staySpanOf: what the stay bonus covers (the 12 months before the anniversary, whichever run pays it)', () => {
  test('the same day a year before, to the day before the anniversary: the board\'s own period', () => {
    expect(staySpanOf('2028-01-12', '2028-01-17')).toEqual({ earnedWeekStart: '2028-01-17', coversFrom: '2027-01-12', coversTo: '2028-01-11' });
    expect(staySpanOf('2028-01-12', '2028-02-14')).toEqual({ earnedWeekStart: '2028-02-14', coversFrom: '2027-01-12', coversTo: '2028-01-11' });
    // a Feb 29 hire: due Mar 1, 2029, counted from Mar 1, 2028
    expect(staySpanOf('2029-03-01', '2029-03-05')).toEqual({ earnedWeekStart: '2029-03-05', coversFrom: '2028-03-01', coversTo: '2029-02-28' });
  });

  test('the period spreads over its whole workweeks, and a run for a later week can carry it', () => {
    const span = staySpanOf('2028-01-12', '2028-01-17');
    // Jan 12, 2027 is a Tuesday (the week of Jan 11) and Jan 11, 2028 a Tuesday (the week of Jan 10): 53 weeks
    expect(weeksOfLine({ coversFrom: span.coversFrom, coversTo: span.coversTo, weekStart: span.earnedWeekStart })).toHaveLength(53);
    expect(staffWeekStartForWorkDate(span.coversTo) < span.earnedWeekStart).toBe(true);
  });
});

describe('seasonDueInRun: the season bonus a run dated that day may write', () => {
  const keys = (payDate) => seasonDueInRun(payDate).map((d) => `${d.kind}:${d.key}`);

  test('due from the last Friday of September to 60 days after it, and its key is the season year', () => {
    expect(keys('2027-09-23')).toEqual([]); // the day before the last Friday of September 2027
    expect(keys('2027-09-24')).toEqual(['season_bonus:2027']);
    expect(keys('2027-10-08')).toEqual(['season_bonus:2027']); // a later run may write it when the first was not ready
    expect(keys('2027-11-23')).toEqual(['season_bonus:2027']); // 60 days after
    expect(keys('2027-11-24')).toEqual([]);
    expect(keys('2027-08-31')).toEqual([]); // the season's own last day
    expect(keys('2028-09-29')).toEqual(['season_bonus:2028']); // the last Friday of September 2028
    expect(keys('2028-01-07')).toEqual([]); // never over the new year: the 60 days end in November
  });

  test('no season before 2027 has a bonus: the plan was approved after the 2026 season was over', () => {
    expect(FIRST_SEASON_YEAR).toBe(2027);
    // the last Friday of September 2026 and the 60 days after it, and 2025
    for (const payDate of ['2026-09-25', '2026-10-09', '2026-11-24', '2025-09-26']) expect([payDate, keys(payDate)]).toEqual([payDate, []]);
  });

  test('the gift and the season bonus are never due on the same pay date', () => {
    for (const payDate of ['2027-09-24', '2027-11-23']) expect(dueInRun(payDate)).toEqual([]);
    for (const payDate of ['2027-12-17', '2028-02-15']) expect(seasonDueInRun(payDate)).toEqual([]);
  });
});

describe('seasonSpanOf: what the season bonus covers (the season, whichever run pays it)', () => {
  test('Mar 1 to Aug 31 of the season year, and from the hire date for a technician hired during the season', () => {
    expect(seasonSpanOf(2027, '2027-09-13', '2027-01-04')).toEqual({ earnedWeekStart: '2027-09-13', coversFrom: '2027-03-01', coversTo: '2027-08-31' });
    expect(seasonSpanOf(2027, '2027-10-04', '2025-06-02')).toEqual({ earnedWeekStart: '2027-10-04', coversFrom: '2027-03-01', coversTo: '2027-08-31' });
    expect(seasonSpanOf(2027, '2027-09-13', '2027-03-01')).toMatchObject({ coversFrom: '2027-03-01' });
    expect(seasonSpanOf(2027, '2027-09-13', '2027-05-10')).toMatchObject({ coversFrom: '2027-05-10', coversTo: '2027-08-31' });
    expect(seasonSpanOf(2027, '2027-09-13', '2027-08-31')).toMatchObject({ coversFrom: '2027-08-31', coversTo: '2027-08-31' });
  });

  test('the period spreads over its whole workweeks, and the run of the last Friday of September pays a later week', () => {
    const payDate = '2027-09-24';
    // the pay week whose default pay date is that Friday
    const weekStart = ['2027-09-06', '2027-09-13', '2027-09-20'].find((week) => defaultPayDate(week) === payDate);
    const span = seasonSpanOf(2027, weekStart, '2027-01-04');
    // Mar 1, 2027 is a Monday and Aug 31, 2027 a Tuesday (the week of Aug 30): 27 weeks
    expect(weeksOfLine({ coversFrom: span.coversFrom, coversTo: span.coversTo, weekStart: span.earnedWeekStart })).toHaveLength(27);
    expect(staffWeekStartForWorkDate(span.coversTo) < span.earnedWeekStart).toBe(true);
  });
});

describe('source key', () => {
  test('is december_gift:<technician>:<year>', () => {
    expect(sourceIdOf('december_gift', 'abc', '2026')).toBe('december_gift:abc:2026');
    expect(SOURCE_TYPE).toBe('tech_rewards');
    expect(DECEMBER_GIFT_CENTS).toBe(30000);
  });
});

describe('ownership: the sync owns a line only by its whole source key, compared exactly', () => {
  const TECH = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const OTHER = '9a8b7c6d-5e4f-4d3c-2b1a-0f9e8d7c6b5a';
  const row = (patch) => ({ technician_id: TECH, kind: 'december_gift', source_type: 'tech_rewards', source_id: `december_gift:${TECH}:2026`, ...patch });

  const stay = (key, patch) => row({ kind: 'stay_bonus', source_id: `stay_bonus:${TECH}:${key}`, ...patch });

  test('the line the sync writes is its own', () => {
    expect(techRewardsOwnKey(row())).toEqual({ kind: 'december_gift', key: '2026' });
    expect(techRewardsOwnKey(row({ source_id: sourceIdOf('december_gift', TECH, '2031') }))).toEqual({ kind: 'december_gift', key: '2031' });
  });

  test('a stay bonus line is keyed by its years of service: 1, 3 or 5', () => {
    for (const key of ['1', '3', '5']) expect(techRewardsOwnKey(stay(key))).toEqual({ kind: 'stay_bonus', key });
    expect(techRewardsOwnKey(row({ kind: 'stay_bonus', source_id: sourceIdOf('stay_bonus', TECH, '3') }))).toEqual({ kind: 'stay_bonus', key: '3' });
  });

  test('a season bonus line is keyed by its season year, 4 digits', () => {
    const season = (key, patch) => row({ kind: 'season_bonus', source_id: `season_bonus:${TECH}:${key}`, ...patch });
    expect(techRewardsOwnKey(season('2027'))).toEqual({ kind: 'season_bonus', key: '2027' });
    expect(techRewardsOwnKey(row({ kind: 'season_bonus', source_id: sourceIdOf('season_bonus', TECH, '2031') }))).toEqual({ kind: 'season_bonus', key: '2031' });
    for (const line of [season('27'), season('12027'), season('2027 '), season('1'), season('2027', { source_id: `season_bonus:${OTHER}:2027` }),
      season('2027', { source_id: `december_gift:${TECH}:2027` }), season('2027', { source_type: null, source_id: null }),
      season('2027', { source_type: 'commission_payment' })]) {
      expect([line.source_id, techRewardsOwnKey(line)]).toEqual([line.source_id, null]);
    }
  });

  test('a season bonus row keyed for a season before the first one (2027) is not the sync\'s: it is a hand-made line, never moved or removed', () => {
    const season = (year) => row({ kind: 'season_bonus', source_id: `season_bonus:${TECH}:${year}` });
    expect(techRewardsOwnKey(season(FIRST_SEASON_YEAR - 1))).toBeNull(); // 2026: the season that ended before the plan was approved
    expect(techRewardsOwnKey(season(FIRST_SEASON_YEAR))).toEqual({ kind: 'season_bonus', key: '2027' });
    // every 4-digit year: the sync's own from the first season on, and never before it
    const wrong = [];
    for (let year = 1000; year <= 9999; year += 1) {
      if (Boolean(techRewardsOwnKey(season(year))) !== (year >= FIRST_SEASON_YEAR)) wrong.push(year);
    }
    expect(wrong).toEqual([]);
    // the SQL form carries the same bound (one pattern for both)
    expect(techRewardsOwnedSql()).toContain("kind = 'season_bonus' AND right(source_id, 4) ~ '^(202[7-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})$'");
  });

  test.each([
    ['2 years, which is no milestone', stay('2')],
    ['a year in place of the years of service', stay('2028')],
    ['two digits', stay('11')],
    ['an anniversary date', stay('2028-01-12')],
    ['text after the key', stay('1 ')],
    ['another technician\'s id', stay('1', { source_id: `stay_bonus:${OTHER}:1` })],
    ['the gift\'s kind in the id', stay('1', { source_id: `december_gift:${TECH}:1` })],
    ['no source', stay('1', { source_type: null, source_id: null })],
    ['another source type', stay('1', { source_type: 'commission_payment' })],
  ])('a stay bonus row with %s is not the sync\'s', (_, line) => {
    expect(techRewardsOwnKey(line)).toBeNull();
  });

  test.each([
    ['no source', { source_type: null, source_id: null }],
    ['another source type', { source_type: 'commission_payment' }],
    ['the id in capitals', { source_id: `december_gift:${TECH.toUpperCase()}:2026` }],
    ['the kind in capitals', { source_id: `DECEMBER_GIFT:${TECH}:2026` }],
    ['another technician\'s id', { source_id: `december_gift:${OTHER}:2026` }],
    ['no year', { source_id: `december_gift:${TECH}:gift` }],
    ['a year of 5 digits', { source_id: `december_gift:${TECH}:12026` }],
    ['a year of 2 digits', { source_id: `december_gift:${TECH}:26` }],
    ['text after the year', { source_id: `december_gift:${TECH}:2026 ` }],
    ['text before the kind', { source_id: ` december_gift:${TECH}:2026` }],
    ['another kind in the id', { source_id: `stay_bonus:${TECH}:2026` }],
    ['a kind the sync does not write', { kind: 'review_bonus', source_id: `review_bonus:${TECH}:2026` }],
    ['a manual kind', { kind: 'commission', source_id: `commission:${TECH}:2026` }],
    ['an empty id', { source_id: '' }],
  ])('a row with %s is not the sync\'s', (_, patch) => {
    expect(techRewardsOwnKey(row(patch))).toBeNull();
  });

  test('the SQL form names only constants and columns, and is never null for a row with no source', () => {
    expect(techRewardsOwnedSql()).toBe("(source_type IS NOT NULL AND source_type = 'tech_rewards' AND ("
      + "(kind = 'december_gift' AND right(source_id, 4) ~ '^[0-9]{4}$' AND source_id = kind || ':' || technician_id::text || ':' || right(source_id, 4))"
      + " OR (kind = 'season_bonus' AND right(source_id, 4) ~ '^(202[7-9]|20[3-9][0-9]|2[1-9][0-9]{2}|[3-9][0-9]{3})$' AND source_id = kind || ':' || technician_id::text || ':' || right(source_id, 4))"
      + " OR (kind = 'stay_bonus' AND right(source_id, 1) ~ '^[135]$' AND source_id = kind || ':' || technician_id::text || ':' || right(source_id, 1))))");
    expect(techRewardsOwnedSql('l')).toContain("l.source_id = l.kind || ':' || l.technician_id::text || ':' || right(l.source_id, 4)");
    expect(techRewardsOwnedSql('l')).toContain("l.kind = 'stay_bonus' AND right(l.source_id, 1) ~ '^[135]$'");
    expect(techRewardsOwnedSql()).not.toContain('?');
  });
});

describe('the gates', () => {
  const NAMES = ['GATE_PAYROLL_PAY_LINES', 'GATE_TECH_REWARDS_PAY_LINES', 'GATE_TECH_REWARDS_STAY_BONUS', 'GATE_TECH_REWARDS_SEASON_BONUS'];
  const OLD = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  beforeEach(() => {
    recordAuditEvent.mockClear();
    delete process.env.GATE_TECH_REWARDS_STAY_BONUS;
    delete process.env.GATE_TECH_REWARDS_SEASON_BONUS;
  });
  afterEach(() => {
    for (const name of NAMES) {
      if (OLD[name] === undefined) delete process.env[name]; else process.env[name] = OLD[name];
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
        whereRaw: jest.fn((sql) => { calls.push(['whereRaw', table, sql]); return chain; }),
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

  test('rewards gate off: the stored waits are cleared and only the open lines the sync owns come off (paid lines are never selected)', async () => {
    process.env.GATE_PAYROLL_PAY_LINES = 'true';
    delete process.env.GATE_TECH_REWARDS_PAY_LINES;
    const { trx, calls } = recorder();
    const result = await syncTechRewardLines(run, trx, { lock: false });
    expect(result.removed).toBe(1);
    expect(calls.slice(0, 3)).toEqual(CLEAR_WAITS);
    expect(calls).toContainEqual(['where', 'payroll_pay_lines', { source_type: 'tech_rewards', status: 'open' }]);
    expect(calls).toContainEqual(['whereIn', 'payroll_pay_lines', ['december_gift', 'stay_bonus', 'season_bonus']]); // every kind's gate is off
    expect(calls).toContainEqual(['whereRaw', 'payroll_pay_lines', techRewardsOwnedSql()]); // only the lines the sync owns
    expect(calls).toContainEqual(['del', 'payroll_pay_lines']);
    expect(calls.filter(([method, table]) => method === 'update' && table !== 'payroll_runs')).toEqual([]);
    expect(recordAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'payroll.tech_rewards_lines_synced', metadata: expect.objectContaining({ gate: 'off', removed_line_ids: ['line-1'] }),
    }));
  });
});
