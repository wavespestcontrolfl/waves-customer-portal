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
  test('counts new-customer callers, the booked-on-call share and estimates sent for the last 7 ET days', async () => {
    const conn = fakeConn({ total: 40, booked: 8, estimates: 20 });
    const now = new Date('2026-11-20T13:00:00Z'); // Friday 8 AM ET
    const out = await loadWeeklyCallOutcomes({ now, conn });
    expect(out).toMatchObject({ newCustomerCalls: 40, bookedOnCall: 8, bookedPct: 20, sentEstimate: 20 });
    // Window opens at ET midnight six days back (Sat Nov 14), so seven calendar days end today.
    expect(out.from.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    const wheres = conn.calls.filter(([m]) => m === 'whereRaw').map(([, sql]) => sql);
    expect(wheres).toContain("cl.direction LIKE 'inbound%'");
    expect(wheres).toContain("cl.ai_extraction_enriched->>'call_nature' = 'new_lead'");
    const dispositions = conn.calls.filter(([m]) => m === 'select').flatMap(([, ...cols]) => cols)
      .filter((c) => c && c.bindings).map((c) => c.bindings[0]);
    expect(dispositions).toEqual(['booked', 'estimate_send']);
  });

  test('a quiet week reads zero, not NaN', async () => {
    const out = await loadWeeklyCallOutcomes({ now: new Date('2026-11-20T13:00:00Z'), conn: fakeConn({ total: 0, booked: 0, estimates: 0 }) });
    expect(out).toMatchObject({ newCustomerCalls: 0, bookedOnCall: 0, bookedPct: 0, sentEstimate: 0 });
    expect(formatWeeklyCallOutcomes(out)).toBe('New-customer calls: 0. Booked on the call: 0. Sent an estimate: 0.');
  });
});

describe('formatWeeklyCallOutcomes', () => {
  test('reads as the one-line summary the Friday tip and the overview show', () => {
    expect(formatWeeklyCallOutcomes({ newCustomerCalls: 40, bookedOnCall: 8, bookedPct: 20, sentEstimate: 20 }))
      .toBe('New-customer calls: 40. Booked on the call: 8 (20%). Sent an estimate: 20.');
  });
});
