/**
 * Estimate greeting first name. A customer can exist with a blank first_name
 * and a populated last_name (call booker last-name-only path); the composed
 * estimate customer_name is then just the surname and must never be greeted
 * as a first name.
 */

const {
  greetingFirstToken,
  greetingFirstName,
  loadGreetingCustomer,
  estimateGreetingFirstToken,
  estimateGreetingFirstName,
} = require('../utils/greeting-first-name');

function fakeDb(rows, { throws = false } = {}) {
  const calls = [];
  const database = (table) => {
    calls.push(table);
    const chain = {
      where: (cond) => { chain.cond = cond; return chain; },
      first: async () => {
        if (throws) throw new Error('db down');
        return rows[chain.cond.id] || null;
      },
    };
    return chain;
  };
  database.calls = calls;
  return database;
}

describe('greetingFirstToken / greetingFirstName', () => {
  test('no customer row: first token of customer_name, as before', () => {
    expect(greetingFirstToken({ customerName: 'Sample Example' })).toBe('Sample');
    expect(greetingFirstName({ customerName: '  Sample   Example ' })).toBe('Sample');
    expect(greetingFirstName({ customerName: '' })).toBe('there');
    expect(greetingFirstName({ customerName: null })).toBe('there');
    expect(greetingFirstName({})).toBe('there');
    expect(greetingFirstName()).toBe('there');
  });

  test('customer with a first name keeps the estimate name token', () => {
    const customer = { first_name: 'Sample', last_name: 'Example' };
    expect(greetingFirstName({ customerName: 'Sample Example', customer })).toBe('Sample');
  });

  test('blank first_name + surname-only customer_name greets "there", not the surname', () => {
    for (const first_name of ['', null, undefined, '   ']) {
      const customer = { first_name, last_name: 'Example' };
      expect(greetingFirstToken({ customerName: 'Example', customer })).toBe('');
      expect(greetingFirstName({ customerName: 'Example', customer })).toBe('there');
    }
  });

  test('surname match is case/space-insensitive and handles multi-word surnames', () => {
    expect(greetingFirstName({
      customerName: 'van  der Sample',
      customer: { first_name: '', last_name: 'Van Der Sample' },
    })).toBe('there');
    expect(greetingFirstName({
      customerName: 'EXAMPLE',
      customer: { first_name: null, last_name: 'Example' },
    })).toBe('there');
  });

  test('blank first_name but the estimate name was typed with a different leading word keeps it', () => {
    const customer = { first_name: '', last_name: 'Example' };
    expect(greetingFirstName({ customerName: 'Sample Example', customer })).toBe('Sample');
  });

  test('blank first_name, surname not on the row: a one-word name is the surname', () => {
    expect(greetingFirstName({ customerName: 'Example', customer: { first_name: '' } })).toBe('there');
    expect(greetingFirstName({ customerName: 'Sample Example', customer: { first_name: '' } })).toBe('Sample');
  });
});

describe('loadGreetingCustomer / estimateGreeting*', () => {
  const rows = {
    'cust-blank': { first_name: '', last_name: 'Example' },
    'cust-full': { first_name: 'Sample', last_name: 'Example' },
  };

  test('no customer_id: no query, legacy token', async () => {
    const database = fakeDb(rows);
    expect(await loadGreetingCustomer(database, null)).toBeNull();
    expect(await estimateGreetingFirstName(database, { customer_name: 'Sample Example' })).toBe('Sample');
    expect(database.calls).toEqual([]);
  });

  test('linked blank-first-name customer greets "there"', async () => {
    const database = fakeDb(rows);
    expect(await estimateGreetingFirstName(database, { customer_id: 'cust-blank', customer_name: 'Example' })).toBe('there');
    expect(await estimateGreetingFirstToken(database, { customer_id: 'cust-blank', customer_name: 'Example' })).toBe('');
  });

  test('linked customer with a first name greets by it', async () => {
    const database = fakeDb(rows);
    expect(await estimateGreetingFirstName(database, { customer_id: 'cust-full', customer_name: 'Sample Example' })).toBe('Sample');
  });

  test('lookup failure or missing row falls back to the legacy token, never throws', async () => {
    expect(await estimateGreetingFirstName(fakeDb(rows, { throws: true }), { customer_id: 'cust-blank', customer_name: 'Example' })).toBe('Example');
    expect(await estimateGreetingFirstName(fakeDb(rows), { customer_id: 'gone', customer_name: 'Sample Example' })).toBe('Sample');
    expect(await estimateGreetingFirstName(undefined, { customer_id: 'cust-blank', customer_name: 'Sample Example' })).toBe('Sample');
  });

  test('a customer row already in hand skips the query', async () => {
    const database = fakeDb(rows);
    const out = await estimateGreetingFirstName(database, { customer_id: 'cust-blank', customer_name: 'Example' }, {
      customer: { first_name: '', last_name: 'Example' },
    });
    expect(out).toBe('there');
    expect(database.calls).toEqual([]);
  });
});
