// The refresh-vs-freeze rule for send-window-deferred rows lives in ONE
// place (deferred-recipient-identity). These pins hold the r24 contract:
// a read account phone decides refresh (match) or freeze (differ/missing
// customer), but a TRANSIENT lookup failure stamps neither — it defers the
// decision to replay, where only a live match may send.

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const {
  recipientRefreshStamp,
  resolveUnverifiedRecipient,
} = require('../services/messaging/deferred-recipient-identity');

function firstChain(row) {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => row) };
  return q;
}
function throwChain() {
  const q = { where: jest.fn(() => q), first: jest.fn(async () => { throw new Error('db down'); }) };
  return q;
}

afterEach(() => jest.clearAllMocks());

describe('recipientRefreshStamp', () => {
  test('snapshot matches the account phone (formatting aside) → refresh', async () => {
    db.mockReturnValueOnce(firstChain({ phone: '+1 (941) 555-1234' }));
    expect(await recipientRefreshStamp({ customerId: 'c1', recipientPhone: '9415551234' }))
      .toEqual({ refresh_customer_phone: true });
  });

  test('snapshot differs from a READ account phone → freeze (explicit alternate)', async () => {
    db.mockReturnValueOnce(firstChain({ phone: '+19415550000' }));
    expect(await recipientRefreshStamp({ customerId: 'c1', recipientPhone: '+19415551234' }))
      .toEqual({ explicit_recipient: true });
  });

  test('customer row gone → freeze (a deterministic fact, not a blip)', async () => {
    db.mockReturnValueOnce(firstChain(undefined));
    expect(await recipientRefreshStamp({ customerId: 'c1', recipientPhone: '+19415551234' }))
      .toEqual({ explicit_recipient: true });
  });

  test('pre-fetched customerRow skips the read', async () => {
    expect(await recipientRefreshStamp({
      customerId: 'c1',
      recipientPhone: '+19415551234',
      customerRow: { phone: '941-555-1234' },
    })).toEqual({ refresh_customer_phone: true });
    expect(db).not.toHaveBeenCalled();
  });

  test('transient lookup failure → recipient_identity_unverified, never a freeze guess (r24)', async () => {
    db.mockReturnValueOnce(throwChain());
    expect(await recipientRefreshStamp({ customerId: 'c1', recipientPhone: '+19415551234' }))
      .toEqual({ recipient_identity_unverified: true });
  });
});

describe('resolveUnverifiedRecipient', () => {
  test('live account phone matches the snapshot → send to the LIVE number (refresh semantics)', async () => {
    db.mockReturnValueOnce(firstChain({ phone: '+19415551234' }));
    expect(await resolveUnverifiedRecipient({ customerId: 'c1', snapshotPhone: '941-555-1234' }))
      .toEqual({ phone: '+19415551234' });
  });

  test('live phone differs → do NOT send: ambiguity between a changed phone and an intentional alternate can misdeliver a bearer link', async () => {
    db.mockReturnValueOnce(firstChain({ phone: '+19415550000' }));
    expect(await resolveUnverifiedRecipient({ customerId: 'c1', snapshotPhone: '+19415551234' }))
      .toEqual({ phone: null, reason: 'identity-unresolved' });
  });

  test('lookup failure again → hold for retry', async () => {
    db.mockReturnValueOnce(throwChain());
    expect(await resolveUnverifiedRecipient({ customerId: 'c1', snapshotPhone: '+19415551234' }))
      .toEqual({ phone: null, reason: 'lookup-failed' });
  });
});
