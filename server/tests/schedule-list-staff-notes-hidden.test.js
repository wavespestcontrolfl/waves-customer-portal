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
