jest.mock('../models/db', () => jest.fn());

const { loadWeeklyCallOutcomes, formatWeeklyCallOutcomes } = require('../services/csr/weekly-call-outcomes');

// Chainable knex stand-in: records every builder call, `first` resolves the aggregate row.
function fakeConn(row) {
  const calls = [];
  const builder = new Proxy({}, {
    get: (_t, prop) => (...args) => {
      calls.push([prop, ...args]);
      return prop === 'first' ? Promise.resolve(row) : builder;
    },
  });
  const conn = () => builder;
  conn.raw = (sql, bindings) => ({ sql, bindings });
  conn.from = (sub) => { calls.push(['from', sub]); return builder; };
  conn.calls = calls;
  return conn;
}

describe('loadWeeklyCallOutcomes', () => {
  test('counts new-customer callers, the booked share among known outcomes and estimates promised for the last 7 ET days', async () => {
    const conn = fakeConn({ total: 40, known: 30, booked: 6, estimates: 20 });
    const now = new Date('2026-11-20T13:00:00Z'); // Friday 8 AM ET
    const out = await loadWeeklyCallOutcomes({ now, conn });
    expect(out).toMatchObject({ newCustomerCallers: 40, callersWithOutcome: 30, bookedOnCall: 6, bookedPct: 20, estimatePromised: 20 });
    // Window opens at ET midnight six days back (Sat Nov 14), so seven calendar days end today.
    expect(out.from.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    const wheres = conn.calls.filter(([m]) => m === 'whereRaw').map(([, sql]) => sql);
    expect(wheres).toContain("cl.direction LIKE 'inbound%'");
    expect(wheres).toContain("cl.ai_extraction_enriched->>'call_nature' = 'new_lead'");
    const selects = conn.calls.filter(([m]) => m === 'select').flatMap(([, ...cols]) => cols).filter((c) => c && c.sql);
    expect(selects.map((c) => c.sql)).toContain('bool_or(cl.disposition IS NOT NULL) AS known');
    expect(selects.filter((c) => c.bindings).map((c) => c.bindings[0])).toEqual(['booked', 'estimate_send']);
  });

  test('a quiet week reads zero, not NaN', async () => {
    const out = await loadWeeklyCallOutcomes({ now: new Date('2026-11-20T13:00:00Z'), conn: fakeConn({ total: 0, known: 0, booked: 0, estimates: 0 }) });
    expect(out).toMatchObject({ newCustomerCallers: 0, callersWithOutcome: 0, bookedOnCall: 0, bookedPct: null, estimatePromised: 0 });
    expect(formatWeeklyCallOutcomes(out)).toBe('New-customer callers: 0. Booked on the call: 0. Estimate promised: 0.');
  });

  test('callers with no recorded outcome give no booking rate, not 0%', async () => {
    const out = await loadWeeklyCallOutcomes({ now: new Date('2026-11-20T13:00:00Z'), conn: fakeConn({ total: 12, known: 0, booked: 0, estimates: 0 }) });
    expect(out.bookedPct).toBeNull();
    expect(formatWeeklyCallOutcomes(out)).toBe('New-customer callers: 12. No call outcomes recorded yet, so no booking rate.');
  });
});

describe('formatWeeklyCallOutcomes', () => {
  test('reads as the one-line summary the Friday tip and the overview show', () => {
    expect(formatWeeklyCallOutcomes({ newCustomerCallers: 40, callersWithOutcome: 30, bookedOnCall: 6, bookedPct: 20, estimatePromised: 20 }))
      .toBe('New-customer callers: 40. Outcome known for 30. Booked on the call: 6 of 30 (20%). Estimate promised: 20.');
  });
});
