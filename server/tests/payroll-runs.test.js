// Unit tests for the pay run service that need no database: pay date and week
// rules, the blocked reasons, the review token, the CSV, and the proof that a
// refused input never reaches the connection. Names are synthetic.
jest.mock('../models/db', () => ({}));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));

const {
  defaultPayDate, validateWeek, resolvePayDate, centsText, buildCheck, tokenOf, checksToCsv,
  draftRun, finalizeRun, voidRun, setCheckNumber, getRun, PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY,
} = require('../services/payroll-runs');

const RUN_ID = '33333333-3333-4333-8333-333333333333';
const TECH_ID = '11111111-1111-4111-8111-111111111111';
const W4 = {
  id: '44444444-4444-4444-8444-444444444444', formYear: 2026, filingStatus: 'single', step2Checkbox: false,
  step3Amount: '0.00', step4aOtherIncome: '0.00', step4bDeductions: '0.00', step4cExtraWithholding: '0.00', exempt: false,
};
const tech = (patch = {}) => ({
  technician_id: TECH_ID, name: 'Sample Alpha', pay_rate: '22.00', pay_method: 'check',
  regular_minutes: '2400.00', overtime_minutes: '0.00', ...patch,
});

const untouched = Object.assign(() => { throw new Error('connection used'); }, {
  transaction: () => { throw new Error('connection used'); },
  raw: () => { throw new Error('connection used'); },
});

describe('weeks and pay dates', () => {
  it('defaults the pay date to the Friday after the week ends', () => {
    expect(defaultPayDate('2026-10-12')).toBe('2026-10-23');
    // Across a month and a year end.
    expect(defaultPayDate('2026-12-28')).toBe('2027-01-08');
    expect(defaultPayDate('2026-10-26')).toBe('2026-11-06');
  });

  it('accepts a finished Monday week and returns its Sunday', () => {
    expect(validateWeek('2026-10-12', '2026-10-25')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
    // The Monday after the week ends is the first day it counts as finished.
    expect(validateWeek('2026-10-12', '2026-10-19')).toEqual({ start: '2026-10-12', end: '2026-10-18' });
  });

  it.each([
    ['a Tuesday', '2026-10-13', '2026-10-25', 400, /Monday/],
    ['an impossible date', '2026-02-31', '2026-10-25', 400, /real date/],
    ['text', 'last week', '2026-10-25', 400, /real date/],
    ['a week still running', '2026-10-19', '2026-10-25', 409, /not finished/],
    ['a week ending today', '2026-10-12', '2026-10-18', 409, /not finished/],
  ])('refuses %s', (_name, week, today, status, message) => {
    expect(() => validateWeek(week, today)).toThrow(expect.objectContaining({ status, message: expect.stringMatching(message) }));
  });

  it('takes a typed pay date only after the week ends', () => {
    expect(resolvePayDate('2026-10-12', '2026-10-18')).toBe('2026-10-23');
    expect(resolvePayDate('2026-10-12', '2026-10-18', '2026-10-19')).toBe('2026-10-19');
    expect(() => resolvePayDate('2026-10-12', '2026-10-18', '2026-10-18')).toThrow(/after the week ends/);
    expect(() => resolvePayDate('2026-10-12', '2026-10-18', '2026-13-01')).toThrow(/real date/);
  });
});

describe('centsText', () => {
  it('writes integer cents as dollars with two decimals', () => {
    expect(centsText(0)).toBe('0.00');
    expect(centsText(5)).toBe('0.05');
    expect(centsText(88000)).toBe('880.00');
    expect(centsText(123456789)).toBe('1234567.89');
  });
});

describe('buildCheck', () => {
  const base = (patch = {}) => buildCheck({
    tech: tech(patch.tech), payDate: patch.payDate || '2026-10-23', weekStart: '2026-10-12', w4: 'w4' in patch ? patch.w4 : W4,
    ytdGrossCents: patch.ytd || 0,
  });

  it('works out the 4x10 week: 40 regular hours at $22.00', () => {
    const { check } = base();
    expect(check).toMatchObject({
      technician_id: TECH_ID, employee_name: 'Sample Alpha', gross_cents: 88000, regular_pay_cents: 88000,
      overtime_pay_cents: 0, social_security_cents: 5456, medicare_cents: 1276, net_cents: expect.any(Number),
      ytd_gross_before_cents: 0, w4_election_id: W4.id, pay_method: 'check', status: 'draft',
    });
    expect(check.net_cents).toBe(88000 - check.federal_income_tax_cents - 5456 - 1276);
    expect(JSON.parse(check.calc_snapshot).withholdingWorksheet).toBeTruthy();
  });

  it('feeds year-to-date gross into the Social Security cap and FUTA cap', () => {
    // $184,000 already paid: only $500 of this $880 check is under the $184,500 base.
    const high = base({ ytd: 18400000 }).check;
    expect(high.social_security_cents).toBe(3100);
    expect(high.futa_cents).toBe(0);
    expect(high.fl_reemployment_cents).toBe(0);
    // $6,600 paid: $400 of this check is under the $7,000 FUTA and Florida base.
    const early = base({ ytd: 660000 }).check;
    expect(early.futa_cents).toBe(240);
    expect(early.fl_reemployment_cents).toBe(1080);
  });

  it('pays overtime at 1.5 times and keeps the premium', () => {
    const { check } = base({ tech: { regular_minutes: '2400.00', overtime_minutes: '120.00' } });
    expect(check.overtime_pay_cents).toBe(6600);
    expect(check.overtime_premium_cents).toBe(2200);
    expect(check.gross_cents).toBe(88000 + 6600);
  });

  it.each([
    ['no W-4 on file', { w4: null }, /No Form W-4 on file/],
    ['no pay rate', { tech: { pay_rate: null } }, /No pay rate set/],
    ['a pay rate of zero', { tech: { pay_rate: '0.00' } }, /No pay rate set/],
    ['a pay date in a year with no tables', { payDate: '2027-01-08' }, /No federal withholding tables for 2027/],
    ['a W-4 from before 2020', { w4: { ...W4, formYear: 2019 } }, /2020 or later/],
  ])('lists %s as blocked with a plain reason', (_name, patch, reason) => {
    const result = base(patch);
    expect(result.check).toBeUndefined();
    expect(result.blocked).toMatch(reason);
  });
});

describe('review token', () => {
  const run = { week_start: '2026-10-12', pay_date: '2026-10-23' };
  const row = (patch = {}) => ({ ...buildCheck({ tech: tech(patch.tech), payDate: '2026-10-23', weekStart: '2026-10-12', w4: W4, ytdGrossCents: 0 }).check });

  it('is the same for stored strings and fresh numbers, whatever the order', () => {
    const a = row();
    const b = row({ tech: { technician_id: '55555555-5555-4555-8555-555555555555', name: 'Sample Beta' } });
    const stored = (r) => ({ ...r, hourly_rate: '22.00', regular_minutes: '2400.00', overtime_minutes: '0.00', gross_cents: String(r.gross_cents), net_cents: String(r.net_cents) });
    expect(tokenOf(run, [a, b])).toBe(tokenOf(run, [stored(b), stored(a)]));
  });

  it('changes when hours, rate, pay date, pay method or the W-4 change', () => {
    const base = tokenOf(run, [row()]);
    expect(tokenOf(run, [row({ tech: { regular_minutes: '2460.00' } })])).not.toBe(base);
    expect(tokenOf(run, [row({ tech: { pay_rate: '23.00' } })])).not.toBe(base);
    expect(tokenOf(run, [row({ tech: { pay_method: 'bank_transfer' } })])).not.toBe(base);
    expect(tokenOf({ ...run, pay_date: '2026-10-24' }, [row()])).not.toBe(base);
    expect(tokenOf(run, [{ ...row(), w4_election_id: '66666666-6666-4666-8666-666666666666' }])).not.toBe(base);
    expect(tokenOf(run, [])).not.toBe(base);
  });
});

describe('checksToCsv', () => {
  const stored = (patch = {}) => ({
    ...buildCheck({ tech: tech(patch), payDate: '2026-10-23', weekStart: '2026-10-12', w4: W4, ytdGrossCents: 0 }).check,
    id: 'c1', check_number: patch.check_number || null,
  });

  it('writes one row per check with money in dollars and no cell that can run as a formula', () => {
    const lines = checksToCsv([
      stored({ name: '=HYPERLINK("http://example.invalid")', check_number: '+1001' }),
      stored({ name: '@SUM(A1)' }),
      stored({ name: '-2+3', pay_method: 'bank_transfer' }),
      stored({ name: 'Sample, Comma "Quote"' }),
    ]).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('Employee,Regular Hours,Overtime Hours,Hourly Rate,Gross Pay,Federal Income Tax,Social Security,Medicare,Additional Medicare,Net Pay,Employer Social Security,Employer Medicare,FUTA,FL Reemployment Tax,Pay Method,Check Number');
    expect(lines[1].startsWith('"\'=HYPERLINK(""http://example.invalid"")"')).toBe(true);
    expect(lines[1]).toContain(',40.00,0.00,22.00,880.00,');
    expect(lines[1].endsWith(",Paper check,'+1001")).toBe(true);
    expect(lines[2].startsWith("'@SUM(A1),")).toBe(true);
    expect(lines[3].startsWith("'-2+3,")).toBe(true);
    expect(lines[3]).toContain(',Bank transfer,');
    expect(lines[4].startsWith('"Sample, Comma ""Quote""",')).toBe(true);
    for (const line of lines.slice(1)) expect(line.split(',').every((cell) => !/^[=+\-@]/.test(cell.replace(/^"/, '')))).toBe(true);
  });
});

describe('input checks stop before the connection is used', () => {
  it('refuses a bad run input', async () => {
    await expect(draftRun({}, TECH_ID, untouched)).rejects.toMatchObject({ status: 400, message: 'Pick a week' });
    await expect(draftRun({ weekStart: '2026-10-13' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Monday/) });
    await expect(draftRun({ weekStart: '2026-10-12', extra: 1 }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(draftRun({ weekStart: '2099-01-05' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 409 });
  });

  it('needs a token to finalize, a reason to void and a real check number', async () => {
    await expect(finalizeRun(RUN_ID, {}, TECH_ID, untouched)).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/Reload/) });
    await expect(voidRun(RUN_ID, { reason: '  ' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400, message: 'Give a reason for the void' });
    await expect(voidRun(RUN_ID, { reason: 'x'.repeat(501) }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(setCheckNumber(RUN_ID, { checkNumber: 'x'.repeat(31) }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(setCheckNumber(RUN_ID, { checkNumber: 'a\u0000b' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
    await expect(setCheckNumber(RUN_ID, {}, TECH_ID, untouched)).rejects.toMatchObject({ status: 400 });
  });

  it('answers 404 for an id that is not a UUID', async () => {
    await expect(getRun('nope', untouched)).rejects.toMatchObject({ status: 404 });
    await expect(finalizeRun('nope', { token: 'x' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 404 });
    await expect(voidRun('nope', { reason: 'x' }, TECH_ID, untouched)).rejects.toMatchObject({ status: 404 });
  });
});

describe('payroll mutation lock', () => {
  // A fake connection that records the order of calls and stops at the first read.
  const fakeConnection = () => {
    const events = [];
    const stop = new Error('stopped at first read');
    const chain = () => new Proxy(() => {}, {
      get: (_t, key) => (key === 'then' ? undefined : (...args) => {
        if (key === 'first' || key === 'select' || key === 'del' || key === 'update') { events.push(`read:${key}`); return Promise.reject(stop); }
        return chain();
      }),
    });
    const trx = (table) => { events.push(`table:${table}`); return chain(); };
    trx.raw = jest.fn(async (sql, bindings) => {
      if (/pg_advisory_xact_lock/.test(sql)) { events.push('lock'); trx.lockArgs = [sql, bindings]; return { rows: [] }; }
      return sql;
    });
    trx.fn = { now: () => 'now' };
    return { events, stop, trx, conn: { transaction: (callback) => callback(trx) } };
  };

  it.each([
    ['finalizeRun', (conn) => finalizeRun(RUN_ID, { token: 'x' }, TECH_ID, conn)],
    ['voidRun', (conn) => voidRun(RUN_ID, { reason: 'Redo' }, TECH_ID, conn)],
  ])('%s takes the payroll lock before any table is read', async (_name, call) => {
    const { events, stop, trx, conn } = fakeConnection();
    await expect(call(conn)).rejects.toBe(stop);
    expect(events[0]).toBe('lock');
    expect(events.slice(1).every((event) => /^(table|read):/.test(event))).toBe(true);
    expect(events.filter((event) => event === 'lock')).toHaveLength(1);
    expect(trx.lockArgs[0]).toBe('SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))');
    expect(trx.lockArgs[1]).toEqual([PAYROLL_LOCK_NS, PAYROLL_LOCK_KEY]);
  });
});

describe('GATE_PAYROLL_TIME_OFF', () => {
  const OLD_GATE = process.env.GATE_PAYROLL_TIME_OFF;
  const run = { week_start: '2026-10-12', pay_date: '2026-10-23' };
  const build = (patch = {}) => buildCheck({
    tech: tech(patch), payDate: '2026-10-23', weekStart: '2026-10-12', w4: W4, ytdGrossCents: 0,
  }).check;
  afterEach(() => {
    if (OLD_GATE === undefined) delete process.env.GATE_PAYROLL_TIME_OFF;
    else process.env.GATE_PAYROLL_TIME_OFF = OLD_GATE;
  });

  describe('off (unset, or anything but the exact string true)', () => {
    it.each([undefined, 'false', 'TRUE', '1', ''])('is byte for byte today with the gate %p, even when the row carries time off', (value) => {
      if (value === undefined) delete process.env.GATE_PAYROLL_TIME_OFF;
      else process.env.GATE_PAYROLL_TIME_OFF = value;
      const plain = build();
      const withMinutes = build({ pto_minutes: '600.00', holiday_minutes: '480.00' });
      // Same row, same calc_snapshot JSON, no new keys, same token.
      expect(withMinutes).toEqual(plain);
      expect(Object.keys(plain)).not.toEqual(expect.arrayContaining(['pto_minutes']));
      expect(Object.keys(JSON.parse(plain.calc_snapshot))).not.toContain('ptoPayCents');
      expect(tokenOf(run, [withMinutes])).toBe(tokenOf(run, [plain]));
      // The token is still the hash of exactly the old parts (no time-off values in it).
      const oldParts = [[
        plain.technician_id, '22.00', '2400.00', '0.00', 'check', plain.w4_election_id, 0,
        ...['gross_cents', 'regular_pay_cents', 'overtime_pay_cents', 'overtime_premium_cents', 'federal_income_tax_cents',
          'social_security_cents', 'medicare_cents', 'additional_medicare_cents', 'net_cents', 'employer_social_security_cents',
          'employer_medicare_cents', 'futa_cents', 'fl_reemployment_cents'].map((key) => plain[key]),
      ]];
      const expected = require('crypto').createHash('sha256')
        .update(JSON.stringify([run.week_start, run.pay_date, oldParts])).digest('hex').slice(0, 32);
      expect(tokenOf(run, [plain])).toBe(expected);
    });

    it('writes the same CSV header and columns as before', () => {
      delete process.env.GATE_PAYROLL_TIME_OFF;
      const lines = checksToCsv([{ ...build(), id: 'c1', check_number: null }]).split('\n');
      expect(lines[0].endsWith('Pay Method,Check Number')).toBe(true);
      expect(lines[1].split(',')).toHaveLength(16);
    });
  });

  describe('on', () => {
    beforeEach(() => { process.env.GATE_PAYROLL_TIME_OFF = 'true'; });

    it('adds time off and holiday pay at the straight rate to a worked week', () => {
      const check = build({ regular_minutes: '1800.00', pto_minutes: '600.00', holiday_minutes: '480.00' });
      expect(check).toMatchObject({
        pto_minutes: '600.00', holiday_minutes: '480.00', pto_pay_cents: 22000, holiday_pay_cents: 17600,
        regular_pay_cents: 66000, gross_cents: 66000 + 22000 + 17600,
      });
      expect(JSON.parse(check.calc_snapshot)).toMatchObject({ ptoPayCents: 22000, holidayPayCents: 17600 });
    });

    it('makes a check for a week of time off alone', () => {
      const check = build({ regular_minutes: 0, overtime_minutes: 0, pto_minutes: 2400 });
      expect(check).toMatchObject({ regular_minutes: 0, gross_cents: 88000, pto_pay_cents: 88000, holiday_pay_cents: 0 });
    });

    it('does not turn 40 hours worked plus a 10 hour holiday into overtime', () => {
      const check = build({ regular_minutes: '2400.00', overtime_minutes: '0.00', holiday_minutes: '600.00' });
      expect(check.overtime_pay_cents).toBe(0);
      expect(check.overtime_premium_cents).toBe(0);
      expect(check.holiday_pay_cents).toBe(22000);
      expect(check.gross_cents).toBe(88000 + 22000);
    });

    it('treats a row with no time-off figures as zero time off', () => {
      const check = build();
      expect(check).toMatchObject({ pto_minutes: 0, holiday_minutes: 0, pto_pay_cents: 0, holiday_pay_cents: 0, gross_cents: 88000 });
    });

    it('changes the review token when time off changes, for stored strings and fresh numbers alike', () => {
      const base = build({ pto_minutes: '600.00' });
      expect(tokenOf(run, [build({ pto_minutes: '660.00' })])).not.toBe(tokenOf(run, [base]));
      expect(tokenOf(run, [build({ holiday_minutes: '60.00' })])).not.toBe(tokenOf(run, [build()]));
      const stored = { ...base, pto_minutes: '600.00', holiday_minutes: '0.00', pto_pay_cents: String(base.pto_pay_cents), holiday_pay_cents: '0' };
      expect(tokenOf(run, [stored])).toBe(tokenOf(run, [base]));
    });

    it('changes the token from the gate-off value', () => {
      const row = build({ pto_minutes: '600.00' });
      const on = tokenOf(run, [row]);
      delete process.env.GATE_PAYROLL_TIME_OFF;
      expect(tokenOf(run, [row])).not.toBe(on);
    });

    it('appends the four time-off columns at the end of the CSV', () => {
      const lines = checksToCsv([{ ...build({ regular_minutes: '1800.00', pto_minutes: '600.00', holiday_minutes: '480.00' }), id: 'c1', check_number: null }]).split('\n');
      expect(lines[0].endsWith('Pay Method,Check Number,PTO Hours,PTO Pay,Holiday Hours,Holiday Pay')).toBe(true);
      expect(lines[1].endsWith(',Paper check,,10.00,220.00,8.00,176.00')).toBe(true);
    });

    it('keeps a feature-gates mock without the reader working (off)', () => {
      jest.isolateModules(() => {
        jest.doMock('../config/feature-gates', () => ({ shiftCloseReviewLive: () => false }));
        jest.doMock('../models/db', () => ({}));
        jest.doMock('../services/audit-log', () => ({ recordAuditEvent: jest.fn() }));
        const isolated = require('../services/payroll-runs');
        const check = isolated.buildCheck({ tech: tech({ pto_minutes: '600.00' }), payDate: '2026-10-23', weekStart: '2026-10-12', w4: W4, ytdGrossCents: 0 }).check;
        expect(check).not.toHaveProperty('pto_minutes');
        expect(check.gross_cents).toBe(88000);
      });
    });
  });
});
