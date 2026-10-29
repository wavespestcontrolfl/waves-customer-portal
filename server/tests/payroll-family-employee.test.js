// The pay run's family employee read (GATE_PAYROLL_FAMILY_EMPLOYEE, owner 2026-10-29, D5 part 2),
// without a database: every payable row is read, and locked FOR SHARE when the pay run asks,
// before eligibility is judged, so a setting added while a pay run is finalized waits for it.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { familyExemptIds } = require('../services/payroll-family-employee');

const ROWS = [
  { id: 'tech-parent', family_relationship: 'parent', family_exempt_from: '2026-09-25' },
  { id: 'tech-none', family_relationship: null, family_exempt_from: null },
  { id: 'tech-later', family_relationship: 'spouse', family_exempt_from: '2026-10-01' },
];

// A query builder with only the calls the read may make; any other call throws.
function fakeConn(calls) {
  let wanted = [];
  const builder = {
    whereIn: (column, ids) => { calls.push(['whereIn', column, ids]); wanted = ids; return builder; },
    select: () => { calls.push(['select']); return builder; },
    forShare: () => { calls.push(['forShare']); return builder; },
    then: (resolve, reject) => Promise.resolve(ROWS.filter((r) => wanted.includes(r.id))).then(resolve, reject),
  };
  const conn = (table) => { calls.push(['table', table]); return builder; };
  conn.raw = (sql) => sql;
  return conn;
}

describe('familyExemptIds', () => {
  const OLD = process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
  afterEach(() => {
    if (OLD === undefined) delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE; else process.env.GATE_PAYROLL_FAMILY_EMPLOYEE = OLD;
  });

  it('locks every payable row, with or without a setting, then keeps those exempt on the pay date', async () => {
    process.env.GATE_PAYROLL_FAMILY_EMPLOYEE = 'true';
    const calls = [];
    const ids = await familyExemptIds(fakeConn(calls), ROWS.map((r) => r.id), '2026-09-25', { lock: true });
    expect([...ids]).toEqual(['tech-parent']);
    expect(calls).toEqual([
      ['table', 'technicians'],
      ['whereIn', 'id', ['tech-parent', 'tech-none', 'tech-later']],
      ['select'],
      ['forShare'],
    ]);
  });

  it('takes no lock without one asked, and reads nothing with the gate off', async () => {
    process.env.GATE_PAYROLL_FAMILY_EMPLOYEE = 'true';
    const calls = [];
    expect([...await familyExemptIds(fakeConn(calls), ['tech-later', 'tech-none'], '2026-10-02')]).toEqual(['tech-later']);
    expect(calls.map((c) => c[0])).not.toContain('forShare');
    delete process.env.GATE_PAYROLL_FAMILY_EMPLOYEE;
    const none = [];
    expect([...await familyExemptIds(fakeConn(none), ['tech-parent'], '2026-10-02', { lock: true })]).toEqual([]);
    expect(none).toEqual([]);
  });
});
