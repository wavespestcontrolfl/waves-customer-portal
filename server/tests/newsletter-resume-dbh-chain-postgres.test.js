/**
 * B13: the first-touch resume hands its transaction to the confirmation send
 * through resumeNewsletterForCallCustomer -> subscribeNewCallCustomerToNewsletter
 * -> sendConfirmationEmail. If ANY link drops { dbh }, the send opens a fresh
 * pooled connection that blocks on the address key the caller's connection
 * already holds: a self-deadlock PostgreSQL cannot see (two connections, one
 * process). This runs the REAL exported resumeNewsletterForCallCustomer (no
 * mock of it) inside a transaction that holds the key, and fails on a timeout
 * instead of hanging if the connection is not reused.
 */
const SKIP = !process.env.DATABASE_URL;
jest.setTimeout(60000);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
const mockSendOne = jest.fn(async () => ({ messageId: 'sg-chain' }));
jest.mock('../services/sendgrid-mail', () => ({
  isConfigured: () => true,
  sendOne: (...a) => mockSendOne(...a),
}));

(SKIP ? describe.skip : describe)('first-touch resume -> confirmation send forwards its connection (B13)', () => {
  let db;
  let locks;
  let CRP;
  const made = [];

  beforeAll(() => {
    db = require('../models/db');
    locks = require('../utils/customer-comms-lock');
    CRP = require('../services/call-recording-processor');
  });
  afterAll(async () => {
    if (made.length) await db('newsletter_subscribers').whereIn('email', made).del();
    await db.destroy();
  });

  const race = (promise, ms = 8000) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('SELF-DEADLOCK: send did not reuse the caller connection')), ms)),
  ]);
  const email = () => { const e = `b13-chain-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`; made.push(e); return e; };

  test('is the real function, exported as the resume entry point', () => {
    expect(typeof CRP.resumeNewsletterForCallCustomer).toBe('function');
    expect(CRP.resumeNewsletterForCallCustomer.name).toBe('subscribeNewCallCustomerToNewsletter');
  });

  test('inside a transaction that HOLDS the address key, the resume sends on that connection (no self-deadlock)', async () => {
    const address = email();
    mockSendOne.mockClear();
    let outcome;
    await race(db.transaction(async (trx) => {
      await locks.lockCustomerEmail(trx, address);
      outcome = await CRP.resumeNewsletterForCallCustomer(
        { customerId: '00000000-0000-0000-0000-000000000001', email: address, firstName: 'Pat', lastName: 'Sample' },
        { dbh: trx },
      );
    }));
    expect(outcome).toMatchObject({ confirmationEmailSent: true });
    expect(mockSendOne).toHaveBeenCalledTimes(1);
  });

  test('control: WITHOUT the connection the same call blocks on the held key (harness detects a dropped dbh)', async () => {
    const address = email();
    mockSendOne.mockClear();
    let release;
    const held = new Promise((r) => { release = r; });
    let signal;
    const hasKey = new Promise((r) => { signal = r; });
    const holder = db.transaction(async (trx) => {
      await locks.lockCustomerEmail(trx, address);
      signal();
      await held;
    });
    await hasKey;
    const blocked = CRP.resumeNewsletterForCallCustomer(
      { customerId: '00000000-0000-0000-0000-000000000002', email: address, firstName: 'Pat', lastName: 'Sample' },
    );
    await expect(race(blocked, 1500)).rejects.toThrow('SELF-DEADLOCK');
    expect(mockSendOne).not.toHaveBeenCalled();
    release();
    await holder;
    await blocked.catch(() => {}); // completes once the key is free
  });
});
