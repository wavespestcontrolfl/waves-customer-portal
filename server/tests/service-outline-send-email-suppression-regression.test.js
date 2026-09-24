// Regression test for AUDIT r1-comms-side-effects-1.
//
// Before the fix, the lawn service-outline email leg called sendgrid.sendOne
// directly, never consulting email_suppressions or notification_prefs, so a
// do_not_email-suppressed address (or a portal opt-out) still got the packet
// email and the packet was stamped 'sent'. The router is admin-only
// (ADMIN-BUG-R37 closed the technician-reach gap r1-projects-docs-1 tracked:
// a technician token is 403 before the send handler runs, covered in
// admin-service-outlines-tech-authz.test.js), so this suite authenticates
// as the owner and exercises the suppression path itself.
jest.mock('../middleware/admin-auth', () => {
  const actual = jest.requireActual('../middleware/admin-auth');
  return {
    adminAuthenticate: (req, _res, next) => { req.techRole = 'admin'; req.technicianId = 'admin-9'; next(); },
    requireTechOrAdmin: actual.requireTechOrAdmin,
    requireAdmin: actual.requireAdmin, // REAL guard
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
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
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

async function postSend(sendMethod = 'email') {
  const app = express();
  app.use(express.json());
  app.use('/admin/service-outlines', router);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/service-outlines/packet-1/send`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: sendMethod }),
    });
    const body = await res.json();
    return { status: res.status, body };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function installDb({ suppressionRows = [], prefs = null } = {}) {
  const tablesTouched = [];
  const outlineEvents = [];
  db.mockImplementation((table) => {
    tablesTouched.push(table);
    if (table === 'service_outline_events') {
      return chain({ insert: jest.fn(async (row) => { outlineEvents.push(row); return 1; }) });
    }
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
        first: jest.fn().mockResolvedValue({
          id: 'est-1', customer_id: 'cust-1', customer_email: SUPPRESSED, customer_name: 'Pat',
          customer_phone: '+15555550123',
        }),
      });
    }
    if (table === 'email_suppressions') return rowsChain(suppressionRows);
    if (table === 'notification_prefs') return chain({ first: jest.fn().mockResolvedValue(prefs) });
    return chain();
  });
  return { tablesTouched, outlineEvents };
}

describe('lawn service-outline send honors suppressions and the portal opt-out', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a do_not_email-suppressed address is blocked, not sent, and the packet is not stamped sent', async () => {
    const { tablesTouched, outlineEvents } = installDb({
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
    // Codex round-2 P2: the composer modal reads outcomes.email.error for
    // every blocked shape, so the reason must ride on `error` too, not only
    // `reason`, or the operator sees "Email failed: unknown".
    expect(body.outcomes.email.error).toBe(body.outcomes.email.reason);
    expect(body.outcomes.email.error).toMatch(/^Suppressed:/);
    // Codex round-2 P2: packet history must say the email was BLOCKED, not
    // "sent" — logEvent('sent_email') previously fired unconditionally.
    expect(outlineEvents.some((e) => e.event_type === 'sent_email')).toBe(false);
    expect(outlineEvents.some((e) => e.event_type === 'email_blocked')).toBe(true);
  });

  test('a portal-opted-out customer (email_enabled=false) is blocked, not sent', async () => {
    const { tablesTouched, outlineEvents } = installDb({ prefs: { customer_id: 'cust-1', email_enabled: false } });

    const { status, body } = await postSend();

    expect(status).toBe(200);
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(tablesTouched).toContain('notification_prefs');
    expect(body.outcomes.email).toMatchObject({ blocked: true, reason: 'email_opted_out', error: 'email_opted_out' });
    expect(body.packet.status).not.toBe('sent');
    expect(outlineEvents.some((e) => e.event_type === 'sent_email')).toBe(false);
    expect(outlineEvents.some((e) => e.event_type === 'email_blocked')).toBe(true);
  });

  // Codex round-3 P2: with method "both", the SMS leg used to dispatch
  // BEFORE the email suppression/prefs preflight ran, so a transient DB
  // error in that preflight surfaced as a bare 500 to the operator AFTER
  // Twilio had already accepted the SMS — a retry (the operator's only
  // recourse to a 500) sent the same SMS again. The preflight now runs
  // before either channel dispatches.
  test('method "both": an email-preflight (suppression lookup) failure sends NO SMS and no email', async () => {
    installDb({});
    jest.spyOn(EmailTemplateLibrary, 'activeSuppressionFor').mockRejectedValueOnce(new Error('connection terminated'));

    const { status, body } = await postSend('both');

    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(sendgrid.sendOne).not.toHaveBeenCalled();
    expect(status).toBe(503);
    expect(body.code).toBe('EMAIL_PREFLIGHT_UNAVAILABLE');
  });
});
