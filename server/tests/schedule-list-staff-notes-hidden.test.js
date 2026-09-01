process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Customer' };
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const scheduleRouter = require('../routes/schedule');

// Awaitable knex-style chain: every builder call returns the chain, and
// awaiting it resolves to the supplied rows.
function listChain(rows) {
  const chain = {};
  for (const method of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'leftJoin', 'select', 'orderBy']) {
    chain[method] = jest.fn(() => chain);
  }
  chain.first = jest.fn(async () => rows[0]);
  chain.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return chain;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', scheduleRouter);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('GET /schedule hides staff notes from the customer payload', () => {
  beforeEach(() => jest.clearAllMocks());

  const row = {
    id: 'svc-1',
    scheduled_date: '2099-01-05',
    window_start: '08:00:00',
    window_end: '10:00:00',
    service_type: 'Pest Control',
    status: 'confirmed',
    technician_name: 'Adam',
    customer_confirmed: true,
    confirmed_at: '2098-12-30T12:00:00Z',
    notes: 'Legacy rebooking cleanup. $67.50 per visit. route_density: moved from 08:00. No SMS sent.',
    is_recurring: true,
    is_callback: false,
    reschedule_token: 'tok-1',
  };

  test('upcoming rows carry the server-derived WaveGuard qualification that follows the live rodent flag (codex #3591 r19 P1)', async () => {
    const rodentRow = { ...row, id: 'svc-r', service_type: 'Rodent Bait Stations' };
    const trapRow = { ...row, id: 'svc-t', service_type: 'Rodent Trapping' };
    // Stale label on a row repointed to the bait program: the CATALOG
    // identity decides (codex #3591 r23 P1).
    const staleLabelRow = { ...row, id: 'svc-s', service_type: 'Rodent Trapping', catalog_service_key: 'rodent_bait_quarterly', catalog_service_name: 'Quarterly Rodent Bait Station Service' };
    // NON-bait rodent catalog identity under a canonical "Rodent Pest
    // Control" label: the combined text reads as pest_control, but the
    // non-bait guard runs first (codex #3591 r39 P2). Commercial rows too.
    const trapCatalogRow = { ...row, id: 'svc-tc', service_type: 'Rodent Pest Control', catalog_service_key: 'rodent_trapping', catalog_service_name: 'Rodent Trapping' };
    const commercialRow = { ...row, id: 'svc-c', service_type: 'Commercial Pest Control' };
    db.mockReturnValueOnce(listChain([row, rodentRow, trapRow, staleLabelRow, trapCatalogRow, commercialRow]));
    await withServer(async (baseUrl) => {
      const body = await (await fetch(`${baseUrl}/schedule`)).json();
      const byId = Object.fromEntries(body.upcoming.map((v) => [v.id, v]));
      expect(byId['svc-1'].waveguardQualifying).toBe(true);
      expect(byId['svc-r'].waveguardQualifying).toBe(true);
      expect(byId['svc-t'].waveguardQualifying).toBe(false);
      expect(byId['svc-s'].waveguardQualifying).toBe(true);
      expect(byId['svc-tc'].waveguardQualifying).toBe(false);
      expect(byId['svc-c'].waveguardQualifying).toBe(false);
      // The RESOLVED family rides the payload (codex #3591 r58 P1): the
      // stale-labeled bait row resolves rodent_bait; non-qualifying rows null.
      expect(byId['svc-s'].serviceFamily).toBe('rodent_bait');
      expect(byId['svc-1'].serviceFamily).toBe('pest_control');
      expect(byId['svc-t'].serviceFamily).toBeNull();
    });
    // Live flag off → rodent bait no longer qualifies on the portal payload.
    const constants = require('../services/pricing-engine/constants');
    const idx = constants.WAVEGUARD.qualifyingServices.indexOf('rodent_bait');
    constants.WAVEGUARD.qualifyingServices.splice(idx, 1);
    try {
      db.mockReturnValueOnce(listChain([rodentRow]));
      await withServer(async (baseUrl) => {
        const body = await (await fetch(`${baseUrl}/schedule`)).json();
        expect(body.upcoming[0].waveguardQualifying).toBe(false);
      });
    } finally {
      constants.WAVEGUARD.qualifyingServices.push('rodent_bait');
    }
  });

  test('upcoming rows omit notes entirely while keeping the visit fields', async () => {
    db.mockReturnValueOnce(listChain([row]));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.upcoming).toHaveLength(1);
      const visit = body.upcoming[0];
      expect('notes' in visit).toBe(false);
      expect(JSON.stringify(body)).not.toContain('Legacy rebooking');
      expect(visit).toMatchObject({
        id: 'svc-1',
        date: '2099-01-05',
        status: 'confirmed',
        technician: 'Adam',
        customerConfirmed: true,
        rescheduleUrl: '/reschedule/tok-1',
      });
    });
  });

  test('the next-visit endpoint stays notes-free too', async () => {
    db.mockReturnValueOnce(listChain([row]));

    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/schedule/next`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect('notes' in body.next).toBe(false);
      expect(JSON.stringify(body)).not.toContain('Legacy rebooking');
    });
  });
});

test('a chained grouped stop keeps its calendar link past an early member\'s own window — expiry is the STOP\'s (local audit r35)', async () => {
  const rows = [{ id: 'svc-g', scheduled_date: '2099-01-15', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', reschedule_token: 'tok-g', visit_id: 'visit-1' }];
  const listChainRows = listChain(rows);
  const countChain = { where: jest.fn(() => countChain), whereNotIn: jest.fn(() => countChain), count: jest.fn(() => countChain), first: jest.fn(async () => ({ n: 2 })) };
  const membersChain = { where: jest.fn(() => membersChain), whereNotIn: jest.fn(() => membersChain), select: jest.fn(async () => [
    { id: 'svc-g', status: 'confirmed', scheduled_date: '2099-01-15', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
    { id: 'svc-s', status: 'pending', scheduled_date: '2099-01-15', window_start: '10:00', window_end: '12:00', technician_id: 't1' },
  ]) };
  let calls = 0;
  db.mockImplementation(() => { calls += 1; return calls === 1 ? listChainRows : calls === 2 ? countChain : membersChain; });
  const prevGate = process.env.GATE_APPOINTMENT_PAGE;
  process.env.GATE_APPOINTMENT_PAGE = 'true';
  try {
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/schedule`)).json();
      const g = body.upcoming[0];
      expect(g.calendarUrl).toBe('/api/public/appointment/tok-g/calendar.ics');
      // the STOP's expiry: latest member end (12:00 ET) beats the earliest start's 09:00+2h promise
      expect(g.calendarExpiresAt).toMatch(/^2099-01-15T17:00:00/); // 12:00 ET = 17:00Z (EST)
    });
  } finally {
    if (prevGate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevGate;
  }
});

test('a GROUPED upcoming visit carries no rescheduleUrl (the self-serve page would refuse it, codex #3609 r25 P2); an ungrouped row keeps its link', async () => {
  const rows = [
    { id: 'svc-g', scheduled_date: '2099-01-15', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', reschedule_token: 'tok-g', visit_id: 'visit-1' },
    { id: 'svc-u', scheduled_date: '2099-01-16', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', reschedule_token: 'tok-u', visit_id: null },
  ];
  const listChainRows = listChain(rows);
  const countChain = { where: jest.fn(() => countChain), whereNotIn: jest.fn(() => countChain), count: jest.fn(() => countChain), first: jest.fn(async () => ({ n: 2 })) };
  // openMembers (groupedCalendarBlocked): members on SPLIT DATES (a partially
  // committed unit move) ⇒ the ICS route would 404 ⇒ no calendar link either
  const membersChain = { where: jest.fn(() => membersChain), whereNotIn: jest.fn(() => membersChain), select: jest.fn(async () => [
    { id: 'svc-g', status: 'confirmed', scheduled_date: '2099-01-15', window_start: '09:00', window_end: '10:00', technician_id: 't1' },
    { id: 'svc-s', status: 'pending', scheduled_date: '2099-01-16', window_start: '10:00', window_end: '11:00', technician_id: 't1' },
  ]) };
  let calls = 0;
  db.mockImplementation(() => { calls += 1; return calls === 1 ? listChainRows : calls === 2 ? countChain : membersChain; });
  const prevGate = process.env.GATE_APPOINTMENT_PAGE;
  process.env.GATE_APPOINTMENT_PAGE = 'true';
  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/schedule`);
      const body = await res.json();
      expect(res.status).toBe(200);
      const g = body.upcoming.find((v) => v.id === 'svc-g');
      const u = body.upcoming.find((v) => v.id === 'svc-u');
      expect(g.rescheduleUrl).toBe(null);
      expect(g.calendarUrl).toBe(null);
      expect(g.calendarExpiresAt).toBe(null);
      expect(u.rescheduleUrl).toBe('/reschedule/tok-u');
      expect(u.calendarUrl).toBe('/api/public/appointment/tok-u/calendar.ics');
    });
  } finally {
    if (prevGate === undefined) delete process.env.GATE_APPOINTMENT_PAGE; else process.env.GATE_APPOINTMENT_PAGE = prevGate;
  }
});
