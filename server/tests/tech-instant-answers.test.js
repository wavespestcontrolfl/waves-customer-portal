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

// A fake knex conn over an in-memory scheduled_services table. It evaluates
// the filters the service sends — equality, NOT NULL, NOT IN, and the shared
// live-stop groups (visit-tech-relay.js liveStops: OR'd whereNull / NOT IN /
// "> now()") — applies the day-plan sort, and records each call so a test can
// read the query it built.
const NOW_MARK = { now: true };
function cell(r, col) { return r[String(col).replace(/^[a-z_]+\./, '')]; }
function orGroup(fn) {
  const preds = [];
  const q = {
    whereNull: (col) => { preds.push((r) => cell(r, col) == null); return q; },
    orWhereNotIn: (col, vals) => { preds.push((r) => cell(r, col) != null && !vals.includes(cell(r, col))); return q; },
    orWhere: (col, op, val) => {
      preds.push((r) => {
        const v = cell(r, col);
        if (op !== '>' || v == null) return false;
        return new Date(v).getTime() > (val === NOW_MARK ? NOW.getTime() : new Date(val).getTime());
      });
      return q;
    },
  };
  fn(q);
  return (r) => preds.some((p) => p(r));
}
function fakeConn(table) {
  const calls = { where: [], whereNotNull: [], whereNotIn: [], groups: 0, orderByRaw: [] };
  const conn = (name) => {
    expect(name).toBe('scheduled_services');
    let rows = table.slice();
    const chain = {
      leftJoin: () => chain,
      where: (col, val) => {
        if (typeof col === 'function') {
          calls.groups += 1;
          const keep = orGroup(col);
          rows = rows.filter(keep);
          return chain;
        }
        calls.where.push([col, val]);
        rows = rows.filter((r) => String(cell(r, col)) === String(val));
        return chain;
      },
      whereNotNull: (col) => { calls.whereNotNull.push(col); rows = rows.filter((r) => cell(r, col) != null); return chain; },
      whereNotIn: (col, vals) => {
        calls.whereNotIn.push([col, vals]);
        rows = rows.filter((r) => cell(r, col) != null && !vals.includes(cell(r, col)));
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
  conn.fn = { now: () => NOW_MARK };
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
  test('a visit the tracker already finished is not the stop, even while its status still reads open', async () => {
    const conn = fakeConn([
      visit({ id: 'tracker-done', status: 'on_site', track_state: 'complete', route_order: 1, arrived_at: '2026-11-02T14:00:00Z' }),
      visit({ id: 'tracker-cancelled', track_state: 'cancelled', route_order: 2 }),
      visit({ id: 'still-open', track_state: 'en_route', route_order: 3 }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('still-open');
  });

  test('a slot hold never answers: an uncommitted hold has no customer, and a lapsed hold is not live', async () => {
    const conn = fakeConn([
      visit({ id: 'live-hold', customer_id: null, reservation_expires_at: '2026-11-02T16:00:00Z', route_order: 1 }),
      visit({ id: 'lapsed-hold', reservation_expires_at: '2026-11-02T14:00:00Z', route_order: 2 }),
      visit({ id: 'booked', reservation_expires_at: null, route_order: 3 }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('booked');
    expect(conn.calls.whereNotNull).toEqual(['scheduled_services.customer_id']);
    // The shared live-stop groups ran on the qualified columns: track state, hold expiry.
    expect(conn.calls.groups).toBe(2);
  });

  test('prefers the on_site stop over earlier route stops, and the newest arrival among on_site rows', async () => {
    const conn = fakeConn([
      visit({ id: 'early', route_order: 1 }),
      visit({ id: 'old-arrival', status: 'on_site', route_order: 2, arrived_at: '2026-11-02T13:00:00Z' }),
      visit({ id: 'new-arrival', status: 'on_site', route_order: 3, arrived_at: '2026-11-02T14:30:00Z' }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('new-arrival');
  });

  test('the tracker\'s on_property counts as at the stop even while the status still reads an earlier state', async () => {
    const conn = fakeConn([
      visit({ id: 'earlier-open', route_order: 1 }),
      visit({ id: 'tracker-arrived', status: 'confirmed', track_state: 'on_property', route_order: 2, arrived_at: '2026-11-02T14:40:00Z' }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('tracker-arrived');
    deterministicVisitFacts.mockResolvedValue({ access: null, last_visit: null });
    expect((await answer(conn, 'next_stop', { technicianId: 'tech-1', now: NOW })).title).toBe('Current stop');
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

  test('ended statuses never count (the shared not-a-stop list)', async () => {
    const ended = ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];
    const conn = fakeConn([
      ...ended.map((status, i) => visit({ id: `ended-${status}`, status, route_order: i + 1 })),
      visit({ id: 'open', status: 'confirmed', route_order: 9 }),
    ]);
    expect((await pickStop(conn, 'tech-1', NOW)).id).toBe('open');
    expect(conn.calls.whereNotIn).toEqual([['scheduled_services.status', ended]]);
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
    // A failed history read is "unknown", never the claim that no visit exists.
    deterministicVisitFacts.mockResolvedValueOnce({ access: null, last_visit: null, history_unavailable: true });
    expect((await answer(conn, 'last_treatment', { technicianId: 'tech-1', now: NOW })).lines)
      .toEqual(['The visit history could not be read. Check the visit brief.']);
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
