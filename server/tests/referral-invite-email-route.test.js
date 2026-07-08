process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

// Rate limiter → passthrough so the test can fire several requests.
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

// Inject a customer identity (the route mounts `authenticate`).
jest.mock('../middleware/auth', () => ({
  authenticate: (req, res, next) => { req.customerId = 'cust-1'; next(); },
}));

jest.mock('../models/db', () => jest.fn());

jest.mock('../services/referral-engine', () => ({
  enrollPromoter: jest.fn(async () => ({ promoter: { id: 'promoter-1', first_name: 'Taylor', customer_email: 'taylor@waves.test' } })),
  getSettings: jest.fn(async () => ({ referee_discount_cents: 2500 })),
  getPromoterReferralLink: jest.fn(() => 'https://portal.wavespestcontrol.com/r/WAVES-J4KM'),
  buildRefereeOfferLine: jest.fn(() => 'Book your first service through their referral link and you’ll get $25 off — our way of saying welcome.'),
}));

jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(),
  redactEmailAddresses: (s) => String(s || ''),
}));

// Loaded transitively by the router; stub so import doesn't need real deps.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderRequiredSmsTemplate: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const referralsRouter = require('../routes/referrals-v2');

// Chainable knex-ish stub. `firstResult` drives the cooldown lookup; inserts
// and updates resolve. Records referral_invites inserts for assertions.
let recordedInserts = [];
function installDb({ firstResult = null } = {}) {
  recordedInserts = [];
  db.mockImplementation((table) => {
    const chain = {
      _table: table,
      where() { return chain; },
      whereRaw() { return chain; },
      first() { return Promise.resolve(firstResult); },
      insert(row) { recordedInserts.push({ table, row }); return Promise.resolve([1]); },
      update() { return Promise.resolve(1); },
    };
    return chain;
  });
  return { inserts: recordedInserts };
}

// No supertest in this repo — run the real router on an ephemeral port.
let server;
let base;

beforeAll(async () => {
  const a = express();
  a.use(express.json());
  a.use('/api/referrals', referralsRouter);
  server = a.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => jest.clearAllMocks());

function post(path, body) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/referrals/invite-email — atomic dedupe', () => {
  test('sends with a deterministic per-day idempotency key and logs the cooldown row', async () => {
    installDb({ firstResult: null });
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    const res = await post('/api/referrals/invite-email', { email: 'Friend@Example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('referral.friend_invite');
    expect(call.to).toBe('friend@example.com'); // normalized
    // Idempotency key is stable per promoter+email+UTC-day — the atomic guard.
    const day = new Date().toISOString().slice(0, 10);
    expect(call.idempotencyKey).toBe(`referral.friend_invite:promoter-1:friend@example.com:${day}`);
    // Cooldown fast-path row was written for a real (non-deduped) send.
    expect(recordedInserts.some((i) => i.table === 'referral_invites' && i.row.email === 'friend@example.com')).toBe(true);
  });

  test('a concurrent in-flight collision is a deduped success, not a double-send', async () => {
    installDb({ firstResult: null });
    const collision = new Error('email send already in progress');
    collision.code = 'EMAIL_SEND_IN_PROGRESS';
    collision.status = 409;
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(collision);

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: true });
    // No cooldown row written — the winning request owns the send + the log.
    expect(recordedInserts.some((i) => i.table === 'referral_invites')).toBe(false);
  });

  test('a library-level dedupe does not refresh the cooldown window', async () => {
    installDb({ firstResult: null });
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, deduped: true });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(recordedInserts.some((i) => i.table === 'referral_invites')).toBe(false);
  });

  test('rolling 24h cooldown short-circuits before hitting the mailer', async () => {
    installDb({ firstResult: { id: 'inv-1' } });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: true });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('refuses to email the promoter’s own address', async () => {
    installDb({ firstResult: null });

    const res = await post('/api/referrals/invite-email', { email: 'taylor@waves.test' });
    expect(res.status).toBe(400);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });
});
