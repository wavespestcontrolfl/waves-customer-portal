/**
 * lockCustomerEstimatesForEstimate: a reopen site's estimate may have no customer_id, or one that differs from
 * the customer the accept would land on. Both customers' estimate locks are taken, in sorted order.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const RecurringCof = require('../services/recurring-card-on-file');
const { lockCustomerEstimatesForEstimate } = require('../utils/customer-estimate-lock');

const keys = (trx) => trx.raw.mock.calls.map((c) => c[1][0]);
// The customer row share (FOR KEY SHARE) comes first, then the advisory lock; `rows` records the customer rows locked.
const makeTrx = () => {
  const rows = [];
  const trx = jest.fn((table) => ({ where: ({ id }) => ({ forKeyShare: () => ({ first: async () => { rows.push(`${table}:${id}`); return { id }; } }) }) }));
  trx.raw = jest.fn(async () => ({}));
  trx.rows = rows;
  return trx;
};

afterEach(() => jest.restoreAllMocks());

test('an unlinked estimate locks the customer the accept resolves to', async () => {
  const trx = makeTrx();
  const resolver = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: 'cust-b', lookupFailed: false });
  await lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: null, customer_phone: '(941) 555-0123' });
  expect(keys(trx)).toEqual(['customer-estimates:cust-b']);
  expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ id: 'e1', customer_id: null }), trx, { authoritative: true });
});

test('a linked estimate whose prospective owner differs locks both, in sorted order', async () => {
  const trx = makeTrx();
  const resolver = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: 'cust-a', lookupFailed: false });
  await lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: 'cust-z', customer_phone: '(941) 555-0123' });
  expect(keys(trx)).toEqual(['customer-estimates:cust-a', 'customer-estimates:cust-z']);
  // The resolver sees the row as unlinked, so it reports the prospective owner even for a linked row.
  expect(resolver.mock.calls[0][0].customer_id).toBeNull();
});

test('the same customer is locked once', async () => {
  const trx = makeTrx();
  jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: 'cust-a', lookupFailed: false });
  await lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: 'cust-a' });
  expect(keys(trx)).toEqual(['customer-estimates:cust-a']);
});

test('a failed lookup still locks the linked customer; no owner and no link locks nothing', async () => {
  const trx = makeTrx();
  jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockRejectedValue(new Error('db down'));
  await lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: 'cust-a' });
  expect(keys(trx)).toEqual(['customer-estimates:cust-a']);
  const empty = makeTrx();
  RecurringCof.resolveProspectiveAcceptCustomer.mockResolvedValue({ customerId: null, lookupFailed: false });
  await lockCustomerEstimatesForEstimate(empty, { id: 'e2', customer_id: null });
  expect(empty.raw).not.toHaveBeenCalled();
});

test('a failed lookup (a throw or lookupFailed) locks the known linked owner and does not abort; an ownerless estimate fails closed', async () => {
  const linked = makeTrx();
  const resolver = jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: null, lookupFailed: true });
  await lockCustomerEstimatesForEstimate(linked, { id: 'e1', customer_id: 'cust-a' });
  expect(keys(linked)).toEqual(['customer-estimates:cust-a']);
  const ownerless = makeTrx();
  await expect(lockCustomerEstimatesForEstimate(ownerless, { id: 'e2', customer_id: null })).rejects.toMatchObject({ code: 'ESTIMATE_OWNER_UNVERIFIED', statusCode: 503 });
  resolver.mockRejectedValue(new Error('db down'));
  await expect(lockCustomerEstimatesForEstimate(makeTrx(), { id: 'e3' })).rejects.toMatchObject({ code: 'ESTIMATE_OWNER_UNVERIFIED' });
  expect(ownerless.raw).not.toHaveBeenCalled();
});

test('every customer row is share-locked before any advisory lock, rows and locks both in sorted order', async () => {
  const trx = makeTrx();
  const order = [];
  trx.mockImplementation((table) => ({ where: ({ id }) => ({ forKeyShare: () => ({ first: async () => { order.push(`row:${id}`); return { id }; } }) }) }));
  trx.raw.mockImplementation(async (_sql, [key]) => { order.push(`adv:${key.split(':')[1]}`); });
  jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: 'cust-a', lookupFailed: false });
  await lockCustomerEstimatesForEstimate(trx, { id: 'e1', customer_id: 'cust-z' });
  expect(order).toEqual(['row:cust-a', 'row:cust-z', 'adv:cust-a', 'adv:cust-z']);
});

// Round 18: an engine draft with an ambiguous or failed profile match is inserted unlinked, and the open-estimate reader
// counts it for whichever customer the accept's phone match lands on. Every candidate customer is locked before the insert.
describe('lockCustomerEstimatesForContact', () => {
  const { lockCustomerEstimatesForContact } = require('../utils/customer-estimate-lock');
  const contactTrx = (phoneRows, emailRows = []) => {
    const rows = [];
    let selects = 0;
    const trx = jest.fn((table) => {
      const b = {
        whereNull: () => b,
        whereRaw: () => b,
        select: async () => (selects++ === 0 ? phoneRows : emailRows),
        where: ({ id }) => ({ forKeyShare: () => ({ first: async () => { rows.push(`${table}:${id}`); return { id }; } }) }),
      };
      return b;
    });
    trx.raw = jest.fn(async () => ({}));
    trx.rows = rows;
    return trx;
  };

  test('an ambiguous shared phone locks every candidate customer row, then the advisory locks, in sorted order', async () => {
    const trx = contactTrx([{ id: 'cust-b' }, { id: 'cust-a' }], [{ id: 'cust-c' }]);
    jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: null, lookupFailed: false });
    await lockCustomerEstimatesForContact(trx, { customerId: null, phone: '(941) 555-0123', email: 'A@Example.com' });
    expect(trx.rows).toEqual(['customers:cust-a', 'customers:cust-b', 'customers:cust-c']);
    expect(keys(trx)).toEqual(['customer-estimates:cust-a', 'customer-estimates:cust-b', 'customer-estimates:cust-c']);
  });

  test('the known customer and the resolved owner are included once', async () => {
    const trx = contactTrx([{ id: 'cust-a' }]);
    jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: 'cust-a', lookupFailed: false });
    await lockCustomerEstimatesForContact(trx, { customerId: 'cust-a', phone: '9415550123' });
    expect(keys(trx)).toEqual(['customer-estimates:cust-a']);
  });

  test('a failed owner lookup with no candidate fails closed (503); with a candidate it locks it', async () => {
    jest.spyOn(RecurringCof, 'resolveProspectiveAcceptCustomer').mockResolvedValue({ customerId: null, lookupFailed: true });
    const none = contactTrx([]);
    await expect(lockCustomerEstimatesForContact(none, { phone: '9415550123' })).rejects.toMatchObject({ code: 'ESTIMATE_OWNER_UNVERIFIED', statusCode: 503 });
    expect(none.raw).not.toHaveBeenCalled();
    const some = contactTrx([{ id: 'cust-a' }]);
    await lockCustomerEstimatesForContact(some, { phone: '9415550123' });
    expect(keys(some)).toEqual(['customer-estimates:cust-a']);
  });

  test('the draft builder locks the contact candidates (not a null customer) right before the unlinked insert', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../services/estimator-engine/draft-builder.js'), 'utf8');
    const lock = src.indexOf('lockCustomerEstimatesForContact(trx, {');
    expect(lock).toBeGreaterThan(-1);
    expect(src.slice(lock, lock + 400)).toContain('phone: customerPhone');
    expect(src.indexOf("trx('estimates').insert({", lock)).toBeGreaterThan(lock);
    expect(src.indexOf("trx('estimates').insert({", lock) - lock).toBeLessThan(900);
  });
});
