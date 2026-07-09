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

const crypto = require('crypto');
const express = require('express');
const db = require('../models/db');
const EmailTemplateLibrary = require('../services/email-template-library');
const referralsRouter = require('../routes/referrals-v2');

// Chainable knex-ish stub. `firstResults` drives per-table .first() lookups
// (customers → self-check, referral_invites → cooldown read). Records inserts,
// updates, and deletes for assertions. db.transaction hands the same chain
// factory to the callback (advisory-lock raw is a no-op).
let recordedInserts = [];
let recordedUpdates = [];
let recordedDeletes = [];
function installDb({ firstResults = {} } = {}) {
  recordedInserts = [];
  recordedUpdates = [];
  recordedDeletes = [];
  const makeChain = (table) => {
    const chain = {
      where() { return chain; },
      whereRaw() { return chain; },
      first() { return Promise.resolve(firstResults[table] ?? null); },
      insert(row) {
        recordedInserts.push({ table, row });
        const p = Promise.resolve([1]);
        p.returning = () => Promise.resolve([{ id: 'res-1' }]);
        return p;
      },
      update(row) { recordedUpdates.push({ table, row }); return Promise.resolve(1); },
      del() { recordedDeletes.push({ table }); return Promise.resolve(1); },
    };
    return chain;
  };
  db.mockImplementation(makeChain);
  db.transaction = jest.fn(async (fn) => {
    const trx = (table) => makeChain(table);
    trx.raw = jest.fn(() => Promise.resolve());
    return fn(trx);
  });
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

const emailDigest = (email) => crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);

describe('POST /api/referrals/invite-email — atomic dedupe', () => {
  test('reserves the cooldown pre-send and sends with a digest-scoped per-day idempotency key', async () => {
    installDb();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    const res = await post('/api/referrals/invite-email', { email: 'Friend@Example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.templateKey).toBe('referral.friend_invite');
    expect(call.to).toBe('friend@example.com'); // normalized
    // Key embeds a digest of the address (never the raw email — a 254-char
    // address would overflow email_messages.idempotency_key varchar(260)).
    const day = new Date().toISOString().slice(0, 10);
    expect(call.idempotencyKey).toBe(`referral.friend_invite:promoter-1:${emailDigest('friend@example.com')}:${day}`);
    // Reservation row was written BEFORE the send and kept on success.
    expect(recordedInserts.some((i) => i.table === 'referral_invites' && i.row.email === 'friend@example.com')).toBe(true);
    expect(recordedDeletes).toHaveLength(0);
    // Successful real send bumps the share timestamp.
    expect(recordedUpdates.some((u) => u.table === 'referral_promoters')).toBe(true);
  });

  test('idempotency key stays within varchar(260) even for a maximum-length address', async () => {
    installDb();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    // RFC-shaped 254-char address (64-char local part, 63-char labels) — the
    // longest thing Joi's .email().max(254) lets through.
    const longEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`;
    const res = await post('/api/referrals/invite-email', { email: longEmail });
    expect(res.status).toBe(200);
    const call = EmailTemplateLibrary.sendTemplate.mock.calls[0][0];
    expect(call.idempotencyKey.length).toBeLessThanOrEqual(260);
  });

  test('a concurrent in-flight collision is a deduped success and releases the reservation', async () => {
    installDb();
    const collision = new Error('email send already in progress');
    collision.code = 'EMAIL_SEND_IN_PROGRESS';
    collision.status = 409;
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(collision);

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: true });
    // Reservation released — if the in-flight winner crashes, a retry must
    // re-resolve against its email_messages row, not a 24h cooldown.
    expect(recordedDeletes.some((d) => d.table === 'referral_invites')).toBe(true);
  });

  test('other 409s (EMAIL_TEMPLATE_DISABLED) are NOT swallowed as success', async () => {
    installDb();
    const disabled = new Error('email template referral.friend_invite is paused');
    disabled.code = 'EMAIL_TEMPLATE_DISABLED';
    disabled.status = 409;
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(disabled);

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com' });
    expect(res.status).toBe(500);
    // Reservation released so the send can be retried once the template is fixed.
    expect(recordedDeletes.some((d) => d.table === 'referral_invites')).toBe(true);
  });

  test('a deduped-but-blocked prior send reports failure, not success', async () => {
    installDb();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, blocked: true, deduped: true, reason: 'Email suppressed' });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com' });
    expect(res.status).toBe(422);
    expect(recordedDeletes.some((d) => d.table === 'referral_invites')).toBe(true);
    expect(recordedUpdates.some((u) => u.table === 'referral_promoters')).toBe(false);
  });

  test('a deduped successful prior send does not refresh the share timestamp', async () => {
    installDb();
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true, deduped: true });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(recordedUpdates.some((u) => u.table === 'referral_promoters')).toBe(false);
    expect(recordedDeletes).toHaveLength(0);
  });

  test('rolling 24h cooldown short-circuits before hitting the mailer (row past the in-flight window)', async () => {
    installDb({ firstResults: { referral_invites: { id: 'inv-1', sent_at: new Date(Date.now() - 10 * 60 * 1000).toISOString() } } });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com', friendName: 'Jordan' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: true });
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('a young reservation (first request possibly mid-send) defers to the mailer instead of reporting success', async () => {
    // The other request's reservation is 30s old — its send is unproven. This
    // request must resolve at the email_messages layer, not off the row.
    installDb({ firstResults: { referral_invites: { id: 'inv-1', sent_at: new Date(Date.now() - 30 * 1000).toISOString() } } });
    const collision = new Error('email send already in progress');
    collision.code = 'EMAIL_SEND_IN_PROGRESS';
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(collision);

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, deduped: true });
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalled();
    // Passthrough never inserted a reservation of its own inside the txn.
    expect(recordedInserts.filter((i) => i.table === 'referral_invites')).toHaveLength(0);
  });

  test('a young reservation whose send was blocked surfaces the failure to the second tap', async () => {
    // The exact race Codex flagged: first request's send got suppressed —
    // the second tap must NOT be told success off the reservation row.
    installDb({ firstResults: { referral_invites: { id: 'inv-1', sent_at: new Date(Date.now() - 30 * 1000).toISOString() } } });
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: false, blocked: true, deduped: true, reason: 'Email suppressed' });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com' });
    expect(res.status).toBe(422);
    // Not our reservation — nothing to release.
    expect(recordedDeletes).toHaveLength(0);
  });

  test('a young reservation whose send failed lets this request send for real and log its own cooldown row', async () => {
    installDb({ firstResults: { referral_invites: { id: 'inv-1', sent_at: new Date(Date.now() - 30 * 1000).toISOString() } } });
    // Library found the prior attempt failed terminally and retried → real send.
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });

    const res = await post('/api/referrals/invite-email', { email: 'friend@example.com' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    // Wrote the cooldown row it never reserved, and bumped the share timestamp.
    expect(recordedInserts.some((i) => i.table === 'referral_invites' && i.row.email === 'friend@example.com')).toBe(true);
    expect(recordedUpdates.some((u) => u.table === 'referral_promoters')).toBe(true);
  });

  test('refuses to email the promoter’s own address (enrollment snapshot)', async () => {
    installDb();

    const res = await post('/api/referrals/invite-email', { email: 'taylor@waves.test' });
    expect(res.status).toBe(400);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('refuses the customer’s CURRENT email even when the promoter snapshot is stale', async () => {
    // Promoter enrolled as taylor@waves.test, later changed account email.
    installDb({ firstResults: { customers: { id: 'cust-1', email: 'Taylor.New@waves.test' } } });

    const res = await post('/api/referrals/invite-email', { email: 'taylor.new@waves.test' });
    expect(res.status).toBe(400);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });
});
