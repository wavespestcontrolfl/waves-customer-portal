// findCustomersAtAddress — the one "who else is at this address" query behind
// the estimate builder's link suggestions, the Customer 360 "Others at this
// address" block, and the save-time member-linkage warning. Unit-aware via the
// canonical street comparator: a typed unit excludes other units at the same
// building; a typed address with no unit still matches every unit there.
jest.mock('../services/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));

const { findCustomersAtAddress, rankByContact, _private } = require('../services/customer-address-match');

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

  it('keeps the complete house-number token, including leading-unit inputs', () => {
    expect(_private.houseNumberOf('123 Main St, Venice')).toBe('123');
    expect(_private.houseNumberOf('123A Main St')).toBe('123A');
    expect(_private.houseNumberOf('123-125 Main St')).toBe('123-125');
    expect(_private.houseNumberOf('123/2 Main St')).toBe('123/2');
    expect(_private.houseNumberOf('Unit 7, 123 Main St, Venice')).toBe('123');
    expect(_private.houseNumberOf('Apt 4 at 123 Main St')).toBe('123');
    expect(_private.houseNumberOf('PO Box 12, Venice')).toBeNull();
  });

  it('a leading-unit input still finds the building', async () => {
    const db = fakeDb({ customers: [ROW('u7', '123 Main St', 'Apt 7'), ROW('u9', '123 Main St', 'Apt 9')] });
    const ids = (await findCustomersAtAddress(db, 'Unit 7, 123 Main St, Venice, FL 34285')).map((r) => r.id);
    expect(ids).toEqual(['u7']);
  });

  it('returns nothing without a house number and never touches the database', async () => {
    const db = fakeDb({ customers: [ROW('a', '123 Palm Ave')] });
    expect(await findCustomersAtAddress(db, 'Palm Ave, Venice')).toEqual([]);
    expect(await findCustomersAtAddress(db, '')).toEqual([]);
    expect(db.calls).toEqual([]);
  });

  describe('rankByContact', () => {
    const rows = [
      ROW('amy', '4315 Fence Row Ct', null, { phone: '+13168210389', email: 'amy@example.com' }),
      ROW('tom', '4315 Fence Row Ct', null, { phone: '+13169905400', email: 'tom@example.com' }),
    ];
    it('puts the phone match first, tagged, and leaves the rest in query order', () => {
      const out = rankByContact(rows, { phone: '(316) 990-5400' });
      expect(out.map((r) => [r.id, r.contactMatch])).toEqual([['tom', 'phone'], ['amy', null]]);
    });
    it('falls back to an exact email match', () => {
      const out = rankByContact(rows, { email: ' TOM@example.com ' });
      expect(out.map((r) => [r.id, r.contactMatch])).toEqual([['tom', 'email'], ['amy', null]]);
    });
    it('with nothing typed, nobody is tagged and order is unchanged', () => {
      const out = rankByContact(rows, {});
      expect(out.map((r) => [r.id, r.contactMatch])).toEqual([['amy', null], ['tom', null]]);
    });
    it('a partial phone never matches', () => {
      expect(rankByContact(rows, { phone: '5400' }).every((r) => r.contactMatch === null)).toBe(true);
    });
  });
});
