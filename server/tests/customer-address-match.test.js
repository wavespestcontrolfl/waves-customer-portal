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
    for (const m of ['where', 'whereNull', 'orWhereNull', 'orWhere', 'join', 'orderBy', 'limit', 'select']) {
      builder[m] = () => builder;
    }
    // A where(fn) group runs fn on the builder, so the filters it adds are recorded.
    builder.where = (arg, ...rest) => {
      if (typeof arg === 'function') arg(builder);
      else calls.push(['where', table, arg, ...rest]);
      return builder;
    };
    builder.whereRaw = (sql, bindings) => { calls.push(['whereRaw', table, sql, bindings]); return builder; };
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

  it('strict: a failing property leg throws, so a partial list never reads as nobody else here', async () => {
    const db = fakeDb({ customers: [ROW('a', '123 Palm Ave')], propertyError: new Error('connection reset') });
    await expect(findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285', { strict: true })).rejects.toThrow('connection reset');
  });

  it('strict: a leg that fills its row cap throws, so a member past the cap is never read as no member', async () => {
    const many = Array.from({ length: 2000 }, (_, i) => ROW(`r${i}`, '123 Other St'));
    await expect(findCustomersAtAddress(fakeDb({ customers: many }), '123 Palm Ave, Venice, FL 34285', { strict: true }))
      .rejects.toMatchObject({ code: 'ADDRESS_UNCHECKABLE', message: expect.stringContaining('the primary leg filled its 2000-row cap') });
    await expect(findCustomersAtAddress(fakeDb({ customers: [], properties: many }), '123 Palm Ave, Venice, FL 34285', { strict: true }))
      .rejects.toThrow('the property-address leg filled its 2000-row cap');
    // Not strict: the old fail-soft read, no throw.
    await expect(findCustomersAtAddress(fakeDb({ customers: many }), '123 Palm Ave, Venice, FL 34285')).resolves.toEqual([]);
  });

  it('strict: an address with no readable house number throws ADDRESS_UNCHECKABLE and reads nothing', async () => {
    const db = fakeDb({ customers: [ROW('a', '123 Palm Ave')] });
    await expect(findCustomersAtAddress(db, 'Lot 12 Palm Ave, Venice, FL 34285', { strict: true })).rejects.toMatchObject({ code: 'ADDRESS_UNCHECKABLE' });
    expect(db.calls).toEqual([]);
    await expect(findCustomersAtAddress(db, 'Lot 12 Palm Ave, Venice, FL 34285')).resolves.toEqual([]);
  });

  it('strict: the leading house digits are a whole digit run anywhere in the line, on both legs; default keeps the prefix', async () => {
    const strictDb = fakeDb();
    await findCustomersAtAddress(strictDb, '123-125 Palm Ave, Venice, FL 34285', { strict: true, zip: '34285' });
    const raws = strictDb.calls.filter((c) => Array.isArray(c) && c[0] === 'whereRaw');
    expect(raws.map((c) => c[3])).toEqual([
      ['address_line1', 'address_line2', '(^|[^0-9])123([^0-9]|$)'],
      ['cp.address_line1', 'cp.address_line2', '(^|[^0-9])123([^0-9]|$)'],
    ]);
    const plainDb = fakeDb();
    await findCustomersAtAddress(plainDb, '123 Palm Ave, Venice, FL 34285');
    expect(plainDb.calls.filter((c) => Array.isArray(c) && c[0] === 'whereRaw')).toEqual([]);
    expect(plainDb.calls).toContainEqual(['where', 'customers', 'address_line1', 'ilike', '123 %']);
  });

  it('strict: a member on file through the property leg with a tab after the house number is an exact match', async () => {
    const db = fakeDb({ properties: [ROW('member', '123\tPalm Ave', null, { waveguard_tier: 'Gold' })] });
    const rows = await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285', { strict: true, zip: '34285' });
    expect(rows.map((r) => [r.id, r.exactMatch])).toEqual([['member', true]]);
  });

  it('strict with a zip: a row the comparator rejects but with the same digits and zip (or no zip) is a near row', async () => {
    const db = fakeDb({
      customers: [ROW('exact', '123 Palm Ave')],
      properties: [
        ROW('unit-in-line2', '123 Palm Ave', '4'),
        ROW('slash', '123/2 Palm Ave'),
        ROW('no-zip', '123 Other St', null, { zip: null }),
        ROW('other-zip', '123 Palm Ave', null, { zip: '34292', city: 'Venice' }),
        ROW('route-number', '900 County Road 123'),
        ROW('unit-first', 'Unit 7', '123 Palm Ave'),
      ],
    });
    const rows = await findCustomersAtAddress(db, '123-2 Palm Ave, Venice, FL 34285', { strict: true, zip: '34285' });
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.exactMatch]));
    expect(byId['other-zip']).toBeUndefined();
    // 123 is the route's number there, not its house number: not near.
    expect(byId['route-number']).toBeUndefined();
    // The street number in line 2 of a unit-first line 1 is read.
    expect(byId['unit-first'] === true || byId['unit-first'] === false).toBe(true);
    expect(byId['no-zip']).toBe(false);
    expect(byId.slash === true || byId.slash === false).toBe(true);
    expect(byId['unit-in-line2'] === true || byId['unit-in-line2'] === false).toBe(true);
    // Without strict nothing is marked and no near row is added.
    const plain = await findCustomersAtAddress(db, '123-2 Palm Ave, Venice, FL 34285');
    expect(plain.every((r) => !('exactMatch' in r))).toBe(true);
    expect(plain.map((r) => r.id)).not.toContain('no-zip');
  });

  it('strict with a zip: only that zip or no zip is read; a street only in line 2 is compared', async () => {
    const db = fakeDb({ properties: [ROW('line2-only', null, '123 Palm Ave', { waveguard_tier: 'Gold' })] });
    const rows = await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285', { strict: true, zip: '34285' });
    expect(rows.map((r) => r.id)).toEqual(['line2-only']);
    // Default: a row with no line 1 is skipped, as before.
    expect(await findCustomersAtAddress(db, '123 Palm Ave, Venice, FL 34285')).toEqual([]);
    // Each leg's zip group (fakeDb records the inner where calls).
    expect(db.calls).toContainEqual(['where', 'customers', 'zip', 'like', '34285%']);
    expect(db.calls).toContainEqual(['where', 'customer_properties as cp', 'cp.zip', 'like', '34285%']);
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
      ROW('amy', '123 Palm Ave', null, { phone: '+19415550101', email: 'amy@example.com' }),
      ROW('tom', '123 Palm Ave', null, { phone: '+19415550102', email: 'tom@example.com' }),
    ];
    it('puts the phone match first, tagged, and leaves the rest in query order', () => {
      const out = rankByContact(rows, { phone: '(941) 555-0102' });
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
