// findCustomersAtAddress — the one "who else is at this address" query behind
// the estimate builder's link suggestions, the Customer 360 "Others at this
// address" block, and the save-time member-linkage warning. Unit-aware via the
// canonical street comparator: a typed unit excludes other units at the same
// building; a typed address with no unit still matches every unit there.
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { findCustomersAtAddress } = require('../services/customer-address-match');

const ROW = (id, line1, line2 = null, extra = {}) => ({
  id, account_id: null, first_name: `F${id}`, last_name: 'Doe', phone: null, email: null,
  address_line1: line1, address_line2: line2, city: 'Venice', state: 'FL', zip: '34285',
  waveguard_tier: null, monthly_rate: 0, pipeline_stage: 'lead', ...extra,
});

// Minimal knex stand-in: every chain method returns the builder; awaiting it
// yields the rows registered for the table name. `propertyError` makes the
// customer_properties leg reject the way a missing table would.
function fakeDb({ customers = [], properties = [], propertyError = null } = {}) {
  const calls = [];
  const db = (table) => {
    calls.push(table);
    const isProperty = String(table).startsWith('customer_properties');
    const builder = {};
    for (const m of ['where', 'whereNull', 'orWhereNull', 'join', 'orderBy', 'limit', 'select']) {
      builder[m] = () => builder;
    }
    builder.then = (resolve, reject) => {
      if (isProperty && propertyError) return Promise.reject(propertyError).then(resolve, reject);
      return Promise.resolve(isProperty ? properties : customers).then(resolve, reject);
    };
    return builder;
  };
  db.calls = calls;
  return db;
}

describe('findCustomersAtAddress', () => {
  it('a typed unit keeps that unit and no-unit rows, and drops other units at the building', async () => {
    const db = fakeDb({ customers: [
      ROW('u4', '123 Palm Ave', '#4'),
      ROW('u7', '123 Palm Ave', 'Apt 7'),
      ROW('bldg', '123 Palm Ave'),
      ROW('other', '125 Palm Ave'),
    ] });
    const ids = (await findCustomersAtAddress(db, '123 Palm Ave Unit 4, Venice, FL 34285')).map((r) => r.id);
    expect(ids).toEqual(['u4', 'bldg']);
  });

  it('a typed address with no unit matches every unit at the building', async () => {
    const db = fakeDb({ customers: [
      ROW('u4', '123 Palm Ave', '#4'),
      ROW('u7', '123 Palm Ave', 'Apt 7'),
      ROW('other', '9 Oak St'),
    ] });
    const ids = (await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285')).map((r) => r.id);
    expect(ids).toEqual(['u4', 'u7']);
  });

  it('dedupes a customer seen on both legs and tags where each match came from', async () => {
    const db = fakeDb({
      customers: [ROW('a', '123 Palm Ave')],
      properties: [ROW('a', '123 Palm Ave'), ROW('b', '123 Palm Avenue')],
    });
    const rows = await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285');
    expect(rows.map((r) => [r.id, r.matchedVia])).toEqual([['a', 'primary'], ['b', 'property']]);
  });

  it('honours excludeCustomerId (the 360 never lists the customer being viewed)', async () => {
    const db = fakeDb({ customers: [ROW('self', '123 Palm Ave'), ROW('spouse', '123 Palm Ave')] });
    const ids = (await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285', { excludeCustomerId: 'self' })).map((r) => r.id);
    expect(ids).toEqual(['spouse']);
  });

  it('a failing property leg is skipped, not fatal', async () => {
    const db = fakeDb({ customers: [ROW('a', '123 Palm Ave')], propertyError: new Error('relation "customer_properties" does not exist') });
    const ids = (await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285')).map((r) => r.id);
    expect(ids).toEqual(['a']);
  });

  it('returns nothing without a house number and never touches the database', async () => {
    const db = fakeDb({ customers: [ROW('a', '123 Palm Ave')] });
    expect(await findCustomersAtAddress(db, 'Palm Ave, Venice')).toEqual([]);
    expect(await findCustomersAtAddress(db, '')).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});
