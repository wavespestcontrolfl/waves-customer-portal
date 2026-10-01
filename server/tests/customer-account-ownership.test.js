const {
  canonicalCustomerAccountId,
  sameCustomerAccount,
  estimateOwnershipMatchesLockedRows,
} = require('../services/customer-account-ownership');

describe('canonical customer-account ownership', () => {
  test('estimate-first writers fence the expected owner and reject drift before returning the locked row', () => {
    const src = require('fs').readFileSync(require.resolve('../services/customer-account-ownership'), 'utf8');
    const start = src.indexOf('async function lockEstimateOwnerForUpdate');
    const block = src.slice(start, start + 1200);
    const fence = block.indexOf('await lockCustomerComms(trx, expectedOwnerId)');
    const estimateLock = block.indexOf("trx('estimates')");
    const ownerRecheck = block.indexOf("String(lockedEstimate.customer_id || '') !== String(expectedOwnerId || '')");
    expect(fence).toBeGreaterThan(0);
    expect(estimateLock).toBeGreaterThan(fence);
    expect(ownerRecheck).toBeGreaterThan(estimateLock);
  });

  test('a primary row without account_id and its sibling share the primary id', () => {
    const primary = { id: 'primary', account_id: null };
    const sibling = { id: 'sibling', account_id: 'primary' };
    expect(canonicalCustomerAccountId(primary)).toBe('primary');
    expect(canonicalCustomerAccountId(sibling)).toBe('primary');
    expect(sameCustomerAccount(primary, sibling)).toBe(true);
  });

  test('two sibling properties with the same explicit account remain related', () => {
    expect(sameCustomerAccount(
      { id: 'property-a', account_id: 'account-1' },
      { id: 'property-b', account_id: 'account-1' },
    )).toBe(true);
  });

  test('a moved primary owner does not match a stale sibling reference to its id', () => {
    expect(sameCustomerAccount(
      { id: 'sibling', account_id: 'primary' },
      { id: 'primary', account_id: 'different-account' },
    )).toBe(false);
  });

  test('matching row ids do not hide an explicit account move', () => {
    expect(sameCustomerAccount(
      { id: 'primary', account_id: 'account-before' },
      { id: 'primary', account_id: 'account-after' },
    )).toBe(false);
  });

  test('a locked sibling draft is rejected after its owner leaves the booked account', () => {
    const snapshot = { id: 'estimate-1', exists: true, customerId: 'sibling' };
    const estimate = { id: 'estimate-1', customer_id: 'sibling' };
    expect(estimateOwnershipMatchesLockedRows(snapshot, estimate, 'primary', [
      { id: 'sibling', account_id: 'different-account' },
      { id: 'primary', account_id: 'primary' },
    ])).toBe(false);
  });
});
