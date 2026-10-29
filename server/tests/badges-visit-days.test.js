// Badge visit counts are completed service DAYS, not records: a pest + lawn
// stop, or two completion records for one appointment, is one visit — the
// same rule as the portal's visit counts (#7022).
jest.mock('../models/db', () => jest.fn());
jest.mock('../middleware/auth', () => ({ authenticate: (req, _res, next) => { req.customerId = 'customer-1'; next(); } }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
}));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/badges');

const RECORDS = [
  // Day 1: lawn + pest on one stop, plus a sibling lawn record.
  { service_date: '2026-03-02', service_type: 'Lawn Care', status: 'completed' },
  { service_date: '2026-03-02', service_type: 'Lawn Care', status: 'completed' },
  { service_date: '2026-03-02', service_type: 'Pest Control', status: 'completed' },
  // Day 2: lawn only.
  { service_date: '2026-06-01', service_type: 'Lawn Care', status: 'completed' },
];

beforeEach(() => {
  db.mockImplementation((table) => {
    const rows = table === 'service_records' ? RECORDS : [];
    const q = {};
    q.where = jest.fn(() => q);
    q.orderBy = jest.fn(() => q);
    q.catch = jest.fn(() => Promise.resolve(rows));
    q.first = jest.fn(async () => (table === 'customers' ? { id: 'customer-1', member_since: '2026-01-01' } : null));
    q.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
    return q;
  });
});

test('two service days with four records read as two visits and two lawn visits', async () => {
  const app = express();
  app.use('/badges', router);
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise((resolve) => (server.listening ? resolve() : server.once('listening', resolve)));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/badges/admin/customer/customer-1`);
    const body = await res.json();
    const label = (type) => body.progress.find((b) => b.type === type)?.progressLabel;
    expect(label('visit_25')).toBe('2/25 visits');
    expect(label('green_thumb')).toBe('2/4 lawn visits');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
