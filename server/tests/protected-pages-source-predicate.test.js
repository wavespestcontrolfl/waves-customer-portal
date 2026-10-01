jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
const { protectedSourcePredicate } = require('../services/content/protected-pages');

test('screens money-page patterns and registry rows in one read', async () => {
  const db = jest.fn(() => ({ select: jest.fn(async () => [{ page_url: 'https://www.wavespestcontrol.com/rodent-control-sarasota-fl/' }]) }));
  const isProtected = await protectedSourcePredicate({ db });
  expect(isProtected('/pest-control-sarasota-fl/')).toBe(true); // pattern
  expect(isProtected('/rodent-control-sarasota-fl/')).toBe(true); // registry
  expect(isProtected('/garden-pests/')).toBe(false);
  expect(db).toHaveBeenCalledTimes(1);
});

test('an unreadable registry throws a retryable outage instead of a predicate', async () => {
  const db = jest.fn(() => ({ select: jest.fn(async () => { throw new Error('db down'); }) }));
  await expect(protectedSourcePredicate({ db })).rejects.toMatchObject({ code: 'PROTECTED_REGISTRY_UNAVAILABLE' });
});
