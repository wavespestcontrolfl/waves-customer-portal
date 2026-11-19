jest.mock('../models/db', () => jest.fn());

const { loadWeeklyCallOutcomes, formatWeeklyCallOutcomes, NO_PROSPECT_OUTCOMES } = require('../services/csr/weekly-call-outcomes');
const { callStartedAtSql } = require('../services/sms-pending-conversations');

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
  test('counts new-customer callers, the booked share among known outcomes and estimates asked for, for the last 7 ET days', async () => {
    const conn = fakeConn({ total: 40, known: 30, booked: 6, estimates: 20 });
    const now = new Date('2026-11-20T13:00:00Z'); // Friday 8 AM ET
    const out = await loadWeeklyCallOutcomes({ now, conn });
    expect(out).toMatchObject({ newCustomerCallers: 40, callersWithOutcome: 30, bookedOnCall: 6, bookedPct: 20, estimateRequestedOrPromised: 20 });
    // Window opens at ET midnight six days back (Sat Nov 14), so seven calendar days end today.
    expect(out.from.toISOString()).toBe('2026-11-14T05:00:00.000Z');
    const wheres = conn.calls.filter(([m]) => m === 'whereRaw').map(([, sql]) => sql);
    expect(wheres).toContain("cl.direction LIKE 'inbound%'");
    expect(wheres).toContain("cl.ai_extraction_enriched->>'call_nature' = 'new_lead'");
    // Only a valid extraction classes a call: a payload that failed validation can still carry call_nature.
    expect(conn.calls).toContainEqual(['where', 'cl.v2_extraction_status', 'valid']);
    // The AI's 'booked' and the staff tag 'new_lead_booked' are both booked on the call.
    const selects = conn.calls.filter(([m]) => m === 'select').flatMap(([, ...cols]) => cols).filter((c) => c && c.sql);
    expect(selects.map((c) => c.sql)).toContain('bool_or(cl.disposition IS NOT NULL) AS known');
    expect(selects.filter((c) => c.bindings).map((c) => [c.sql, c.bindings])).toEqual([
      ['bool_or(cl.disposition IN (?, ?)) AS booked', ['booked', 'new_lead_booked']],
      ['bool_or(cl.disposition = ?) AS estimate', ['estimate_send']],
    ]);
  });

  test('the week is by when the call started, not when its row was written', async () => {
    const conn = fakeConn({ total: 1, known: 1, booked: 1, estimates: 0 });
    const now = new Date('2026-11-20T13:00:00Z');
    const out = await loadWeeklyCallOutcomes({ now, conn });
    const started = callStartedAtSql('cl');
    const bounds = conn.calls.filter(([m, sql]) => m === 'whereRaw' && sql.startsWith(started)).map(([, sql, bindings]) => [sql.slice(started.length), bindings]);
    expect(bounds).toEqual([[' >= ?', [out.from]], [' <= ?', [now]]]);
    // A row is never written before its call starts, so created_at only narrows the scan from below.
    expect(conn.calls).toContainEqual(['where', 'cl.created_at', '>=', out.from]);
    expect(conn.calls.some(([m, col, op]) => m === 'where' && col === 'cl.created_at' && op === '<=')).toBe(false);
  });

  test('a call whose outcome says it was no prospect is not a new-customer call (staff tags count too)', async () => {
    const conn = fakeConn({ total: 0, known: 0, booked: 0, estimates: 0 });
    await loadWeeklyCallOutcomes({ now: new Date('2026-11-20T13:00:00Z'), conn });
    expect(NO_PROSPECT_OUTCOMES).toEqual(expect.arrayContaining(['existing_customer_routed', 'existing_service_q', 'existing_complaint', 'spam_discarded', 'wrong_number_closed']));
    const grouped = conn.calls.find(([m, arg]) => m === 'where' && typeof arg === 'function');
    const seen = [];
    const recorder = new Proxy({}, { get: (_t, m) => (...args) => { seen.push([m, ...args]); return recorder; } });
    grouped[1](recorder);
    // No outcome yet still counts; any outcome but these counts.
    expect(seen).toEqual([['whereNull', 'cl.disposition'], ['orWhereNotIn', 'cl.disposition', NO_PROSPECT_OUTCOMES]]);
  });

  test('a quiet week reads zero, not NaN', async () => {
    const out = await loadWeeklyCallOutcomes({ now: new Date('2026-11-20T13:00:00Z'), conn: fakeConn({ total: 0, known: 0, booked: 0, estimates: 0 }) });
    expect(out).toMatchObject({ newCustomerCallers: 0, callersWithOutcome: 0, bookedOnCall: 0, bookedPct: null, estimateRequestedOrPromised: 0 });
    expect(formatWeeklyCallOutcomes(out)).toBe('New-customer callers: 0. Booked on the call: 0. Estimate requested or promised: 0.');
  });

  test('callers with no recorded outcome give no booking rate, not 0%', async () => {
    const out = await loadWeeklyCallOutcomes({ now: new Date('2026-11-20T13:00:00Z'), conn: fakeConn({ total: 12, known: 0, booked: 0, estimates: 0 }) });
    expect(out.bookedPct).toBeNull();
    expect(formatWeeklyCallOutcomes(out)).toBe('New-customer callers: 12. No call outcomes recorded yet, so no booking rate.');
  });
});

describe('formatWeeklyCallOutcomes', () => {
  test('reads as the one-line summary the Friday tip and the overview show', () => {
    expect(formatWeeklyCallOutcomes({ newCustomerCallers: 40, callersWithOutcome: 30, bookedOnCall: 6, bookedPct: 20, estimateRequestedOrPromised: 20 }))
      .toBe('New-customer callers: 40. Outcome known for 30. Booked on the call: 6 of 30 (20%). Estimate requested or promised: 20.');
  });
});
