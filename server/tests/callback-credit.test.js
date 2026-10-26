/**
 * GATE_CALLBACK_SOURCE_TECH (census M9, second technician): which technician a
 * callback counts against. The SQL returns each callback with its earlier
 * candidates, newest first; this pins the choice made from those rows. The SQL
 * itself runs against real Postgres in callback-credit-postgres.test.js.
 */
const { callbackCreditByTechnician, LOOKBACK_DAYS } = require('../services/callback-credit');

function connReturning(rows) {
  const conn = { raw: jest.fn(async () => ({ rows })) };
  return conn;
}

describe('callbackCreditByTechnician', () => {
  test('a pest re-service counts against the technician of the earlier pest visit, not the one who did it', async () => {
    const conn = connReturning([
      { callback_id: 'cb-1', callback_type: 'Pest Control Re-Service', callback_tech_id: 'owner', source_tech_id: 'hire', source_type: 'Quarterly Pest Control' },
    ]);

    const counts = await callbackCreditByTechnician(conn, { start: '2027-03-01', endDate: '2027-03-31' });

    expect([...counts]).toEqual([['hire', 1]]);
    expect(conn.raw).toHaveBeenCalledWith(expect.any(String), [LOOKBACK_DAYS, '2027-03-01', '2027-03-31']);
  });

  test('the newest candidate in the SAME category wins: a lawn re-service skips a later pest visit', async () => {
    const conn = connReturning([
      // Newest first, as the SQL orders them.
      { callback_id: 'cb-1', callback_type: 'Lawn Care Re-Service', callback_tech_id: 'owner', source_tech_id: 'hire', source_type: 'Quarterly Pest Control' },
      { callback_id: 'cb-1', callback_type: 'Lawn Care Re-Service', callback_tech_id: 'owner', source_tech_id: 'lawn-tech', source_type: 'Lawn Fertilization' },
      { callback_id: 'cb-1', callback_type: 'Lawn Care Re-Service', callback_tech_id: 'owner', source_tech_id: 'older-lawn-tech', source_type: 'Lawn Fertilization' },
    ]);

    const counts = await callbackCreditByTechnician(conn, { start: '2027-03-01', endDate: '2027-03-31' });

    expect([...counts]).toEqual([['lawn-tech', 1]]);
  });

  test('no earlier visit in the category: the callback stays with its own technician, as today', async () => {
    const conn = connReturning([
      { callback_id: 'cb-1', callback_type: 'Lawn Care Re-Service', callback_tech_id: 'owner', source_tech_id: 'hire', source_type: 'Quarterly Pest Control' },
      { callback_id: 'cb-2', callback_type: 'Pest Control Re-Service', callback_tech_id: 'owner', source_tech_id: null, source_type: null },
    ]);

    const counts = await callbackCreditByTechnician(conn, { start: '2027-03-01', endDate: '2027-03-31' });

    expect([...counts]).toEqual([['owner', 2]]);
  });

  test('a callback with no technician and no source counts under null (the Unassigned row)', async () => {
    const conn = connReturning([
      { callback_id: 'cb-1', callback_type: 'Pest Control Re-Service', callback_tech_id: null, source_tech_id: null, source_type: null },
      { callback_id: 'cb-2', callback_type: 'Pest Control Re-Service', callback_tech_id: null, source_tech_id: 'hire', source_type: 'Quarterly Pest Control' },
    ]);

    const counts = await callbackCreditByTechnician(conn, { start: '2027-03-01', endDate: '2027-03-31' });

    expect(counts.get(null)).toBe(1);
    expect(counts.get('hire')).toBe(1);
  });

  test('no callbacks: an empty map', async () => {
    const counts = await callbackCreditByTechnician(connReturning([]), { start: '2027-03-01', endDate: '2027-03-31' });
    expect(counts.size).toBe(0);
  });
});
