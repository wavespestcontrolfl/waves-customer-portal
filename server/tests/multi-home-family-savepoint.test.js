// familyMultiHomeEligible inside a caller's transaction reads under a
// savepoint, so a failed lookup never aborts the caller's transaction (the
// locked discount recheck must still be able to answer with its refusal).

jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { familyMultiHomeEligible } = require('../services/multi-home-family');

function failingQuery() {
  const err = new Error('lookup failed');
  const chain = {
    where: () => chain,
    first: () => Promise.reject(err),
  };
  return chain;
}

describe('familyMultiHomeEligible savepoint', () => {
  test('a lookup failure inside a transaction runs under a savepoint and answers false', async () => {
    const savepointConn = jest.fn(() => failingQuery());
    const trx = jest.fn(() => { throw new Error('the caller transaction must not run the lookup itself'); });
    trx.isTransaction = true;
    trx.transaction = jest.fn((work) => work(savepointConn));

    await expect(familyMultiHomeEligible(trx, '11111111-2222-4333-8444-555555555555')).resolves.toBe(false);
    expect(trx.transaction).toHaveBeenCalledTimes(1);
    expect(trx).not.toHaveBeenCalled();
    expect(savepointConn).toHaveBeenCalledWith('multi_home_family_members');
  });

  test('outside a transaction it reads directly, with the id in lower case', async () => {
    const wheres = [];
    const conn = jest.fn(() => {
      const chain = {
        where: (clause) => { wheres.push(clause); return chain; },
        first: () => Promise.resolve(null),
      };
      return chain;
    });
    await expect(familyMultiHomeEligible(conn, 'AAAAAAAA-2222-4333-8444-555555555555')).resolves.toBe(false);
    expect(wheres[0]).toEqual({ customer_id: 'aaaaaaaa-2222-4333-8444-555555555555' });
  });
});
