// Regression test for AUDIT r1-comms-side-effects-1.
//
// Before the fix, the lawn service-outline email leg called sendgrid.sendOne
// directly, never consulting email_suppressions or notification_prefs, so a
// do_not_email-suppressed address (or a portal opt-out) still got the packet
// email and the packet was stamped 'sent'. This is unchanged for a
// technician-role token reaching the route at all — that gap is tracked
// separately (r1-projects-docs-1) and out of scope here.
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    adminAuthenticate: (req, _res, next) => { req.techRole = 'technician'; req.technicianId = 'tech-9'; next(); },
    requireTechOrAdmin: actual.requireTechOrAdmin, // REAL guard
    requireAdmin: actual.requireAdmin,
  };
});

jest.mock('../models/db', () => {
  const mock = jest.fn();
  mock.fn = { now: jest.fn(() => 'NOW') };
  mock.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((...args) => mock(...args));
    trx.fn = mock.fn;
    return fn(trx);
  });
  return mock;
});

jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn() }));
jest.mock('../services/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const sendgrid = require('../services/sendgrid-mail');
const EmailTemplateLibrary = require('../services/email-template-library');
const router = require('../routes/admin-service-outlines');

function chain(overrides = {}) {
  return {
    where: jest.fn().mockReturnThis(),
    whereRaw: jest.fn().mockReturnThis(),
    first: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'packet-1', status: 'sent' }]),
    insert: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// An awaitable chain for tables the real EmailTemplateLibrary code reads as
// an array (email_suppressions' activeSuppressionsFor does `await db(...)
// .whereRaw(...).where(...)` and then `.filter()`s the result).
function rowsChain(rows) {
  const c = chain();
  c.where = jest.fn(() => c);
  c.whereRaw = jest.fn(() => c);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

const SUPPRESSED = 'optedout@example.com';

async function postSend() {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/service-outlines/packet-1/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'email' }),
    });
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function installDb({ suppressionRows = [], prefs = null } = {}) {
  const tablesTouched = [];
  db.mockImplementation((table) => {
    tablesTouched.push(table);
    if (table === 'service_outline_packets') {
      const packetChain = chain({
        first: jest.fn().mockResolvedValue({
          id: 'packet-1', estimate_id: 'est-1', customer_id: 'cust-1', status: 'approved',
          validation_status: 'ok', token_hash: null, revoked_at: null, expires_at: null, title: 'Program',
        }),
      });
      // Reflect the actual update() patch back out of returning(), instead of
      // a hardcoded 'sent' row — the route decides sent vs. unchanged status
      // from whether the send actually succeeded.
      packetChain.update = jest.fn((patch) => {
        packetChain.returning = jest.fn().mockResolvedValue([{ id: 'packet-1', status: 'approved', ...patch }]);
        return packetChain;
      });
      return packetChain;
    }
    if (table === 'estimates') {
      return chain({
        first: jest.fn().mockResolvedValue({ id: 'est-1', customer_id: 'cust-1', customer_email: SUPPRESSED, customer_name: 'Pat' }),
      });
    }
    if (table === 'email_suppressions') return rowsChain(suppressionRows);
    if (table === 'notification_prefs') return chain({ first: jest.fn().mockResolvedValue(prefs) });
    return chain();
  });
  return tablesTouched;
}

describe('lawn service-outline send honors suppressions and the portal opt-out', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a do_not_email-suppressed address is blocked, not sent, and the packet is not stamped sent', async () => {
    const tablesTouched = installDb({
      suppressionRows: [{ id: 's1', email: SUPPRESSED, suppression_type: 'do_not_email', status: 'active', group_key: null }],
    });
    const suppressionSpy = jest.spyOn(EmailTemplateLibrary, 'activeSuppressionFor');

    const { status, body } = await postSend();

    expect(status).toBe(200);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(suppressionSpy).toHaveBeenCalled();
    expect(tablesTouched).toContain('email_suppressions');
    expect(body.outcomes.email).toMatchObject({ blocked: true });
    expect(body.packet.status).not.toBe('sent');
  });

  test('a portal-opted-out customer (email_enabled=false) is blocked, not sent', async () => {
    const tablesTouched = installDb({ prefs: { customer_id: 'cust-1', email_enabled: false } });

    const { status, body } = await postSend();

    expect(status).toBe(200);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(tablesTouched).toContain('notification_prefs');
    expect(body.outcomes.email).toMatchObject({ blocked: true, reason: 'email_opted_out' });
    expect(body.packet.status).not.toBe('sent');
  });
});
