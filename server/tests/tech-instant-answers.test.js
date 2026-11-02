/**
 * Tech instant answers — next stop, access notes, last treatment. The pick
 * must prefer the stop the tech is AT, then follow the day-plan order; the
 * visit filter is always the technician id passed in (an admin actor too);
 * no phone number and no access code may ever reach a line.
 */
jest.mock('../services/previsit-brief', () => ({ deterministicVisitFacts: jest.fn() }));

const { deterministicVisitFacts } = require('../services/previsit-brief');
const { etDateString } = require('../utils/datetime-et');
const { INSTANT_ANSWER_KINDS, pickStop, answer, _test } = require('../services/tech-instant-answers');

const NOW = new Date('2026-11-02T15:00:00Z');
const TODAY = etDateString(NOW);

// A fake knex conn over an in-memory scheduled_services table. It applies the
// filters the service sends (equality, the NOT IN status clause) and the
// day-plan sort, and records every call so a test can read the SQL it built.
function fakeConn(table) {
  const calls = { where: [], whereRaw: [], orderByRaw: [] };
  const conn = (name) => {
    expect(name).toBe('scheduled_services');
    let rows = table.slice();
    const bare = (col) => String(col).replace(/^[a-z_]+\./, '');
    const chain = {
      leftJoin: () => chain,
      where: (col, val) => {
        calls.where.push([col, val]);
        rows = rows.filter((r) => String(r[bare(col)]) === String(val));
        return chain;
      },
      whereRaw: (sql, bindings) => {
        calls.whereRaw.push([sql, bindings]);
        rows = rows.filter((r) => !bindings.includes(r.status || 'pending'));
        return chain;
      },
      orderByRaw: (sql) => {
        calls.orderByRaw.push(sql);
        rows = rows.slice().sort((a, b) => (
          (a.route_order ?? 999) - (b.route_order ?? 999)
          || String(a.window_start || '23:59').localeCompare(String(b.window_start || '23:59'))
          || String(a.id).localeCompare(String(b.id))
        ));
        return chain;
      },
      select: async () => rows,
    };
    return chain;
  };
  conn.raw = (sql) => sql;
  conn.calls = calls;
  return conn;
}

let seq = 0;
function visit(over = {}) {
  seq += 1;
  return {
    id: `v${seq}`,
    customer_id: `c${seq}`,
    technician_id: 'tech-1',
    scheduled_date: TODAY,
    status: 'confirmed',
    service_type: 'Quarterly Pest Control Service',
    window_start: '09:00:00',
    window_end: '11:00:00',
    route_order: null,
    arrived_at: null,
    first_name: 'Pat',
    last_name: 'Sample',
    address_line1: '12 Example Way',
    city: 'Venice',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  seq = 0;
});

describe('pickStop', () => {
  test('prefers the on_site stop over earlier route stops, and the newest arrival among on_site rows', async () => {
    const conn = fakeConn([
      visit({ id: 'early', route_order: 1 }),
      visit({ id: 'old-arrival', status: 'on_site', route_order: 2, arrived_at: '2026-11-02T13:00:00Z' }),
      visit({ id: 'new-arrival', status: 'on_site', route_order: 3, arrived_at: '2026-11-02T14:30:00Z' }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('new-arrival');
  });

  test('without an on_site stop, takes the first stop in day-plan order', async () => {
    const conn = fakeConn([
      visit({ id: 'late-window', window_start: '13:00:00' }),
      visit({ id: 'numbered-second', route_order: 2, window_start: '08:00:00' }),
      visit({ id: 'numbered-first', route_order: 1, window_start: '14:00:00' }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('numbered-first');
    expect(conn.calls.orderByRaw[0]).toBe(_test.DAY_PLAN_ORDER);
    expect(_test.DAY_PLAN_ORDER).toMatch(/^COALESCE\(scheduled_services\.route_order, 999\), COALESCE\(scheduled_services\.window_start, '23:59'\)/);
  });

  test('ended statuses never count, and a null status reads as pending', async () => {
    const ended = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];
    const conn = fakeConn([
      ...ended.map((status, i) => visit({ id: `ended-${status}`, status, route_order: i + 1 })),
      visit({ id: 'open-null-status', status: null, route_order: 9 }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('open-null-status');
    const [sql, bindings] = conn.calls.whereRaw[0];
    expect(sql).toContain("COALESCE(scheduled_services.status, 'pending') NOT IN");
    expect(bindings).toEqual(ended);
  });

  test('filters to the technician id and to today in ET, for an admin technician too', async () => {
    const conn = fakeConn([
      visit({ id: 'other-tech', technician_id: 'tech-2', route_order: 1 }),
      visit({ id: 'tomorrow', scheduled_date: '2026-11-03', route_order: 1 }),
      visit({ id: 'mine', technician_id: 'admin-tech', route_order: 5 }),
    ]);
    expect((await pickStop(conn, 'admin-tech', NOW)).id).toBe('mine');
    expect(conn.calls.where).toEqual([
      ['scheduled_services.technician_id', 'admin-tech'],
      ['scheduled_services.scheduled_date', TODAY],
    ]);
  });

  test('no technician id, or no open stop, gives null without a query', async () => {
    const conn = jest.fn();
    expect(await pickStop(conn, null, NOW)).toBeNull();
    expect(conn).not.toHaveBeenCalled();
    expect(await pickStop(fakeConn([]), 'tech-1', NOW)).toBeNull();
  });
});

describe('answer', () => {
  test('exports the three kinds with labels', () => {
    expect(INSTANT_ANSWER_KINDS).toEqual({
      next_stop: 'Next stop',
      access_notes: 'Access notes',
      last_treatment: 'Last treatment',
    });
  });

  test('next_stop: customer, address, window, service; Next stop title; never a phone number', async () => {
    const conn = fakeConn([visit({ id: 'v-next', phone: '(941) 555-0100', customer_phone: '+19415550100' })]);
    const out = await answer(conn, 'next_stop', { technicianId: 'tech-1', now: NOW });
    expect(out).toEqual({
      kind: 'next_stop',
      title: 'Next stop',
      visitId: 'v-next',
      lines: [
        'Customer: Pat Sample',
        'Address: 12 Example Way, Venice',
        'Window: 9:00 AM–11:00 AM',
        'Service: Quarterly Pest Control Service',
      ],
    });
    expect(out.lines.join('\n')).not.toMatch(/\d{3}[)\s.-]*\d{3}[\s.-]*\d{4}/);
    expect(deterministicVisitFacts).not.toHaveBeenCalled();
  });

  test('next_stop: title is Current stop when on_site; a missing window line is dropped', async () => {
    const conn = fakeConn([visit({ status: 'on_site', arrived_at: '2026-11-02T14:00:00Z', window_start: null, window_end: null })]);
    const out = await answer(conn, 'next_stop', { technicianId: 'tech-1', now: NOW });
    expect(out.title).toBe('Current stop');
    expect(out.lines.some((l) => l.startsWith('Window:'))).toBe(false);
  });

  test('access_notes: pets, sensitivities, access and parking; every code is dropped', async () => {
    deterministicVisitFacts.mockResolvedValue({
      access: {
        codes: { neighborhoodGate: '4545', propertyGate: '7788', garage: '1357', lockbox: '2468' },
        pets: 'Two small dogs',
        chemicalSensitivities: 'Asthma in the home',
        accessNotes: 'Side gate is the front door. Gate code 9911.',
        parkingNotes: 'Park on the street',
        specialInstructions: 'Lockbox 8642',
      },
      last_visit: null,
    });
    const conn = fakeConn([visit({ id: 'v-access' })]);
    const out = await answer(conn, 'access_notes', { technicianId: 'tech-1', now: NOW });
    expect(out.title).toBe('Access notes');
    expect(out.visitId).toBe('v-access');
    expect(out.lines).toEqual(expect.arrayContaining([
      'Pets: Two small dogs',
      'Chemical sensitivities: Asthma in the home',
      'Parking: Park on the street',
    ]));
    const text = out.lines.join('\n');
    for (const code of ['4545', '7788', '1357', '2468', '9911', '8642']) expect(text).not.toContain(code);
    expect(deterministicVisitFacts).toHaveBeenCalledWith(expect.objectContaining({ id: 'v-access' }), expect.anything());
  });

  test('access_notes: unreadable access says so; an empty block says none on file', async () => {
    const conn = fakeConn([visit()]);
    deterministicVisitFacts.mockResolvedValueOnce({ access: null, last_visit: null });
    expect((await answer(conn, 'access_notes', { technicianId: 'tech-1', now: NOW })).lines)
      .toEqual(['The access notes could not be read. Check the visit brief.']);
    deterministicVisitFacts.mockResolvedValueOnce({
      access: { codes: { garage: '1234' }, pets: null, chemicalSensitivities: null, accessNotes: null, parkingNotes: null },
      last_visit: null,
    });
    expect((await answer(conn, 'access_notes', { technicianId: 'tech-1', now: NOW })).lines)
      .toEqual(['No access notes on file.']);
  });

  test('last_treatment: date, type and product names; none says no earlier visit', async () => {
    const conn = fakeConn([visit({ id: 'v-last' })]);
    deterministicVisitFacts.mockResolvedValueOnce({
      access: null,
      last_visit: { date: '2026-08-04', type: 'Quarterly Pest Control Service', products: [{ name: 'Product A' }, { name: 'Product B' }] },
    });
    const out = await answer(conn, 'last_treatment', { technicianId: 'tech-1', now: NOW });
    expect(out).toEqual({
      kind: 'last_treatment',
      title: 'Last treatment',
      visitId: 'v-last',
      lines: ['Last visit: 2026-08-04 — Quarterly Pest Control Service', 'Products: Product A, Product B'],
    });
    deterministicVisitFacts.mockResolvedValueOnce({ access: null, last_visit: null });
    expect((await answer(conn, 'last_treatment', { technicianId: 'tech-1', now: NOW })).lines)
      .toEqual(['No earlier visit on this service line.']);
    deterministicVisitFacts.mockResolvedValueOnce({ access: null, last_visit: { date: '2026-08-04', type: 'Lawn Care', products: [] } });
    expect((await answer(conn, 'last_treatment', { technicianId: 'tech-1', now: NOW })).lines)
      .toEqual(['Last visit: 2026-08-04 — Lawn Care']);
  });

  test('no stop today: every kind answers No stop with a null visit id and reads no facts', async () => {
    for (const kind of Object.keys(INSTANT_ANSWER_KINDS)) {
      const out = await answer(fakeConn([visit({ status: 'completed' })]), kind, { technicianId: 'tech-1', now: NOW });
      expect(out).toEqual({ kind, title: 'No stop', lines: ['No more stops on your route today.'], visitId: null });
    }
    expect(deterministicVisitFacts).not.toHaveBeenCalled();
  });

  test('an unknown kind throws', async () => {
    await expect(answer(fakeConn([]), 'nope', { technicianId: 'tech-1', now: NOW })).rejects.toThrow('Unknown instant answer kind');
  });
});
