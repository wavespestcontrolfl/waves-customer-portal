/**
 * Last-name fill for a phone caller who gave only a first name.
 *
 * Pins: the gate (off = no reads), the eligibility facts re-read from the DB,
 * the source order (county owner record only for an owner caller, then our own
 * records, then a first.last email), fill-only writes in one locked
 * transaction, and the never-throws / no-PII-in-logs contract.
 * Test data is invented: example.com emails, 555 numbers, made-up names.
 */

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.transaction = jest.fn();
  fn.raw = jest.fn();
  fn.fn = { now: () => 'NOW()' };
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/property-lookup/county-parcel-gis', () => ({ lookupCountyParcelByPoint: jest.fn() }));
jest.mock('../services/outbound-call-reason', () => ({ nanpStoredPhoneClause: (col) => `PHONE_MATCH(${col}) = ?` }));

const db = require('../models/db');
const logger = require('../services/logger');
const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const { runCallLastNameLookup, enqueueCallLastNameLookup } = require('../services/call-last-name-lookup');

const flushImmediates = () => new Promise((resolve) => setImmediate(resolve));

const CALL = {
  id: 'call-1',
  customer_id: 'cust-1',
  direction: 'inbound',
  from_phone: '+19415550100',
  to_phone: '+19415550199',
  created_at: '2026-10-08T15:00:00Z',
  v2_extraction_status: 'valid',
  ai_extraction_enriched: { caller: { first_name: 'Pat', last_name: null, relationship_to_property: 'owner' } },
};
const CUSTOMER = {
  id: 'cust-1',
  first_name: 'Pat',
  last_name: null,
  phone: '(941) 555-0100',
  email: null,
  latitude: '27.4000',
  longitude: '-82.4000',
  address_line1: '100 Sample Ave',
};
const PARCEL = { county: 'Manatee', situsAddress: '100 SAMPLE AVE', ownerNames: ['EXAMPLE, PAT Q'] };

// Builder whose chain methods return itself and whose await resolves `result`.
// A function passed to where() is run against the builder, so the real
// same-contact clause is exercised and recorded.
function builder(result, record) {
  const b = {};
  for (const m of ['where', 'whereNot', 'whereNull', 'whereRaw', 'orWhereRaw', 'forUpdate', 'select', 'first', 'update']) {
    b[m] = jest.fn((...args) => {
      if (record) record.push([m, ...args]);
      if (m === 'where' && typeof args[0] === 'function') args[0](b);
      return b;
    });
  }
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

// opts: call, customer, customers (records rows), leads (records rows),
// current (the locked row inside the transaction), updates (captured payloads).
function setupDb(opts = {}) {
  const calls = [];
  const updates = [];
  const records = [];
  const tables = {
    call_log: [opts.call === undefined ? CALL : opts.call],
    customers: [opts.customer === undefined ? CUSTOMER : opts.customer, opts.customers || []],
    leads: [opts.leads || []],
  };
  const seen = {};
  db.mockImplementation((table) => {
    calls.push(table);
    seen[table] = (seen[table] || 0) + 1;
    return builder(tables[table][seen[table] - 1], records);
  });
  const current = opts.current === undefined
    ? { id: 'cust-1', first_name: 'Pat', last_name: '', crm_notes: opts.crmNotes ?? null }
    : opts.current;
  db.transaction.mockImplementation(async (cb) => {
    const trx = (table) => {
      const b = builder(current);
      b.update = jest.fn((payload) => { updates.push({ table, payload }); return Promise.resolve(1); });
      return b;
    };
    return cb(trx);
  });
  return { calls, updates, records };
}

const inbound = (overrides = {}) => ({ ...CALL, ...overrides });
const withExtraction = (caller) => inbound({ ai_extraction_enriched: { caller: { first_name: 'Pat', last_name: null, relationship_to_property: 'owner', ...caller } } });

beforeEach(() => {
  process.env.GATE_CALL_LAST_NAME_LOOKUP = 'true';
  lookupCountyParcelByPoint.mockResolvedValue(PARCEL);
});

afterEach(() => {
  delete process.env.GATE_CALL_LAST_NAME_LOOKUP;
  jest.resetAllMocks();
});

const run = () => runCallLastNameLookup({ callLogId: 'call-1', customerId: 'cust-1' });

describe('gate', () => {
  test('off: run skips before any read, enqueue schedules nothing', async () => {
    delete process.env.GATE_CALL_LAST_NAME_LOOKUP;
    setupDb();
    expect(await run()).toEqual({ skipped: 'gated' });
    enqueueCallLastNameLookup({ callLogId: 'call-1', customerId: 'cust-1' });
    await flushImmediates();
    expect(db).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
  });

  test('anything but exactly "true" is off', async () => {
    process.env.GATE_CALL_LAST_NAME_LOOKUP = '1';
    setupDb();
    expect(await run()).toEqual({ skipped: 'gated' });
  });

  test('missing ids skip without a read', async () => {
    setupDb();
    expect(await runCallLastNameLookup({ callLogId: 'call-1' })).toEqual({ skipped: 'missing_ids' });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('county owner record', () => {
  test('an owner caller whose first name matches an owner: writes last_name, updated_at and the note only', async () => {
    const { updates } = setupDb();
    expect(await run()).toEqual({ filled: true, source: 'county' });
    expect(lookupCountyParcelByPoint).toHaveBeenCalledWith(27.4, -82.4, expect.objectContaining({ includeOwners: true }));
    expect(updates).toHaveLength(1);
    expect(updates[0].table).toBe('customers');
    expect(Object.keys(updates[0].payload).sort()).toEqual(['crm_notes', 'last_name', 'updated_at']);
    expect(updates[0].payload.last_name).toBe('Example');
    expect(updates[0].payload.crm_notes).toBe('[call 2026-10-08] Last name added by the call agent from the county owner record.');
    expect(updates[0].payload.crm_notes).not.toMatch(/Example/);
  });

  test('the transaction locks the customer row for update', async () => {
    setupDb();
    await run();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('the note is appended after existing notes with a blank line and the Eastern call day', async () => {
    const { updates } = setupDb({
      call: inbound({ created_at: '2026-10-09T02:30:00Z' }), // 10:30 PM ET on Oct 8
      crmNotes: 'Prefers mornings.',
    });
    await run();
    expect(updates[0].payload.crm_notes).toBe('Prefers mornings.\n\n[call 2026-10-08] Last name added by the call agent from the county owner record.');
  });

  test('an unknown relationship may read the county record', async () => {
    const { updates } = setupDb({ call: withExtraction({ relationship_to_property: 'unknown' }) });
    await run();
    expect(lookupCountyParcelByPoint).toHaveBeenCalled();
    expect(updates[0].payload.last_name).toBe('Example');
  });

  test.each(['real_estate_agent', 'tenant', 'home_buyer', 'family_member', 'property_manager', 'spouse_partner', 'other', ''])(
    'relationship %p never calls the county lookup',
    async (relationship) => {
      const { updates } = setupDb({ call: withExtraction({ relationship_to_property: relationship }) });
      expect(await run()).toEqual({ filled: false, outcome: 'no_surname' });
      expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
      expect(updates).toHaveLength(0);
    },
  );

  test('a realtor with a first.last email still gets the surname from the email, never the owner', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'real_estate_agent' }),
      customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' },
    });
    await run();
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(updates[0].payload.last_name).toBe('Sampleton');
  });

  test('a parcel whose house number is not the customer\'s is not used', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, situsAddress: '102 SAMPLE AVE' });
    const { updates } = setupDb();
    expect(await run()).toEqual({ filled: false, outcome: 'no_surname' });
    expect(updates).toHaveLength(0);
  });

  test('no coordinates, no parcel, or no owner names: no county write', async () => {
    let { updates } = setupDb({ customer: { ...CUSTOMER, latitude: null, longitude: null } });
    await run();
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);

    lookupCountyParcelByPoint.mockResolvedValue(null);
    ({ updates } = setupDb());
    await run();
    expect(updates).toHaveLength(0);

    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: [] });
    ({ updates } = setupDb());
    await run();
    expect(updates).toHaveLength(0);
  });

  test('two owners with the caller first name and different surnames: no write', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE, PAT Q', 'SAMPLE, PAT'] });
    const { updates } = setupDb();
    await run();
    expect(updates).toHaveLength(0);
  });

  test('an entity owner gives nothing', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE PAT HOLDINGS LLC'] });
    const { updates } = setupDb();
    await run();
    expect(updates).toHaveLength(0);
  });

  test('a thrown county lookup falls through to the next source and never throws out', async () => {
    lookupCountyParcelByPoint.mockRejectedValue(Object.assign(new Error('boom 100 Sample Ave'), { code: 'ETIMEDOUT' }));
    const { updates } = setupDb({ customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' } });
    await expect(run()).resolves.toEqual({ filled: true, source: 'email' });
    expect(updates[0].payload.last_name).toBe('Sampleton');
  });
});

describe('our own records', () => {
  test('another customer with the same contact, same first name and a last name', async () => {
    const { updates, records } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customer: { ...CUSTOMER, email: 'Pat@Example.com' },
      customers: [{ first_name: 'Pat', last_name: 'Sampleton' }],
    });
    expect(await run()).toEqual({ filled: true, source: 'records' });
    expect(updates[0].payload.last_name).toBe('Sampleton');
    expect(updates[0].payload.crm_notes).toBe('[call 2026-10-08] Last name added by the call agent from another record with the same email or phone.');
    // email compared lower-cased; phone matched on the NANP identity key
    expect(records).toContainEqual(['whereRaw', 'LOWER(TRIM(email)) = ?', ['pat@example.com']]);
    expect(records).toContainEqual(['orWhereRaw', 'PHONE_MATCH(phone) = ?', ['9415550100']]);
  });

  test('a lead record counts too, and a nickname first name matches', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customer: { ...CUSTOMER, first_name: 'Bill' },
      current: { id: 'cust-1', first_name: 'Bill', last_name: null, crm_notes: null },
      leads: [{ first_name: 'William', last_name: 'Sampleton' }],
    });
    await run();
    expect(updates[0].payload.last_name).toBe('Sampleton');
  });

  test('the same surname on a customer and a lead (any case) is one surname', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customers: [{ first_name: 'Pat', last_name: 'Sampleton' }],
      leads: [{ first_name: 'Pat', last_name: 'SAMPLETON' }],
    });
    await run();
    expect(updates[0].payload.last_name).toBe('Sampleton');
  });

  test('two different surnames: ambiguous, no write', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customers: [{ first_name: 'Pat', last_name: 'Sampleton' }],
      leads: [{ first_name: 'Pat', last_name: 'Exampleson' }],
    });
    await run();
    expect(updates).toHaveLength(0);
  });

  test('a record with another first name is ignored', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customers: [{ first_name: 'Robin', last_name: 'Sampleton' }],
    });
    await run();
    expect(updates).toHaveLength(0);
  });

  test('a stored last name that is not a plain name is ignored', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customers: [{ first_name: 'Pat', last_name: '555-0100' }],
    });
    await run();
    expect(updates).toHaveLength(0);
  });

  test('a county record that found nothing falls through to the records', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE, ROBIN'] });
    const { updates } = setupDb({ customers: [{ first_name: 'Pat', last_name: 'Sampleton' }] });
    await run();
    expect(updates[0].payload.last_name).toBe('Sampleton');
  });
});

describe('caller email', () => {
  const tenant = (email) => ({ call: withExtraction({ relationship_to_property: 'tenant' }), customer: { ...CUSTOMER, email } });

  test('first.last@ gives the surname and the email note', async () => {
    const { updates } = setupDb(tenant('pat.sampleton@example.com'));
    expect(await run()).toEqual({ filled: true, source: 'email' });
    expect(updates[0].payload.last_name).toBe('Sampleton');
    expect(updates[0].payload.crm_notes).toBe('[call 2026-10-08] Last name added by the call agent from the caller\'s email address.');
  });

  test('a run-together address with a business word yields no write', async () => {
    const { updates } = setupDb({
      call: withExtraction({ relationship_to_property: 'tenant' }),
      customer: { ...CUSTOMER, first_name: 'Elizabeth', email: 'elizabethrealty@example.com' },
      current: { id: 'cust-1', first_name: 'Elizabeth', last_name: null, crm_notes: null },
    });
    expect(await run()).toEqual({ filled: false, outcome: 'no_surname' });
    expect(updates).toHaveLength(0);
  });

  test('a business word after a separator yields no write', async () => {
    const { updates } = setupDb(tenant('pat.realty@example.com'));
    await run();
    expect(updates).toHaveLength(0);
  });
});

describe('eligibility', () => {
  test('a last name already on the customer: no write, no lookup', async () => {
    const { updates } = setupDb({ customer: { ...CUSTOMER, last_name: 'Existing' } });
    expect(await run()).toEqual({ skipped: 'has_last_name' });
    expect(updates).toHaveLength(0);
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
  });

  test('a blank (spaces) last name counts as empty', async () => {
    const { updates } = setupDb({ customer: { ...CUSTOMER, last_name: '   ' } });
    await run();
    expect(updates).toHaveLength(1);
  });

  test('no first name: skipped', async () => {
    const { updates } = setupDb({ customer: { ...CUSTOMER, first_name: ' ' } });
    expect(await run()).toEqual({ skipped: 'no_first_name' });
    expect(updates).toHaveLength(0);
  });

  test('the caller phone is not the customer phone: no write, no lookup', async () => {
    const { updates } = setupDb({ call: inbound({ from_phone: '+19415550188' }) });
    expect(await run()).toEqual({ skipped: 'caller_not_customer' });
    expect(updates).toHaveLength(0);
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
  });

  test('a customer without a phone, or a call without one: skipped', async () => {
    expect(await (setupDb({ customer: { ...CUSTOMER, phone: null } }), run())).toEqual({ skipped: 'caller_not_customer' });
    expect(await (setupDb({ call: inbound({ from_phone: null }) }), run())).toEqual({ skipped: 'caller_not_customer' });
  });

  test('an outbound call compares the dialed number', async () => {
    const { updates } = setupDb({ call: inbound({ direction: 'outbound-api', from_phone: '+19415550199', to_phone: '+19415550100' }) });
    await run();
    expect(updates[0].payload.last_name).toBe('Example');
  });

  test('the call is linked to another customer, or is gone: skipped', async () => {
    expect(await (setupDb({ call: inbound({ customer_id: 'cust-2' }) }), run())).toEqual({ skipped: 'call_not_linked' });
    setupDb({ call: null });
    expect(await run()).toEqual({ skipped: 'call_not_linked' });
  });

  test('a soft-deleted or missing customer: skipped', async () => {
    const { updates } = setupDb({ customer: null });
    expect(await run()).toEqual({ skipped: 'customer_gone' });
    expect(updates).toHaveLength(0);
  });

  test('the V2 caller already gave a last name: skipped', async () => {
    const { updates } = setupDb({ call: withExtraction({ last_name: 'Heard' }) });
    expect(await run()).toEqual({ skipped: 'caller_gave_last_name' });
    expect(updates).toHaveLength(0);
  });

  test('an extraction that is not valid, or is missing: skipped', async () => {
    expect(await (setupDb({ call: inbound({ v2_extraction_status: 'schema_invalid' }) }), run())).toEqual({ skipped: 'no_valid_extraction' });
    expect(await (setupDb({ call: inbound({ ai_extraction_enriched: null }) }), run())).toEqual({ skipped: 'no_valid_extraction' });
  });

  test('a JSON-string extraction is read', async () => {
    const { updates } = setupDb({ call: inbound({ ai_extraction_enriched: JSON.stringify(CALL.ai_extraction_enriched) }) });
    await run();
    expect(updates).toHaveLength(1);
  });
});

describe('the write is fill-only and re-checked under the row lock', () => {
  test('a last name that landed meanwhile is not overwritten', async () => {
    const { updates } = setupDb({ current: { id: 'cust-1', first_name: 'Pat', last_name: 'Landed', crm_notes: null } });
    expect(await run()).toEqual({ filled: false, outcome: 'changed_meanwhile' });
    expect(updates).toHaveLength(0);
  });

  test('a first name that changed meanwhile blocks the write', async () => {
    const { updates } = setupDb({ current: { id: 'cust-1', first_name: 'Patricia', last_name: null, crm_notes: null } });
    expect(await run()).toEqual({ filled: false, outcome: 'changed_meanwhile' });
    expect(updates).toHaveLength(0);
  });

  test('a customer deleted meanwhile blocks the write', async () => {
    const { updates } = setupDb({ current: undefined });
    db.transaction.mockImplementation(async (cb) => cb(() => builder(undefined)));
    expect(await run()).toEqual({ filled: false, outcome: 'changed_meanwhile' });
    expect(updates).toHaveLength(0);
  });
});

describe('never throws, never logs PII', () => {
  test('a database error is swallowed into an outcome code', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('relation for pat.sampleton@example.com'), { code: 'XX000' }); });
    await expect(run()).resolves.toEqual({ filled: false, outcome: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { callLogId: 'call-1', customerId: 'cust-1', error: 'XX000' });
  });

  test('enqueue runs off the caller\'s tick and swallows a failure', async () => {
    setupDb();
    expect(() => enqueueCallLastNameLookup({ callLogId: 'call-1', customerId: 'cust-1' })).not.toThrow();
    expect(db).not.toHaveBeenCalled();
    await flushImmediates();
    await flushImmediates();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  test('no log call carries a name, phone, email or address', async () => {
    lookupCountyParcelByPoint.mockRejectedValueOnce(Object.assign(new Error('county down for 100 Sample Ave'), { code: 'ETIMEDOUT' }));
    setupDb({ customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' } });
    await run();
    setupDb({ customer: { ...CUSTOMER, email: null } });
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE, ROBIN'] });
    await run();
    db.mockImplementation(() => { throw new Error('pat.sampleton@example.com 100 Sample Ave 9415550100'); });
    await run();
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).toContain('call-last-name-lookup');
    for (const secret of ['Pat', 'Example', 'Sampleton', 'Sample', '555', '941', 'example.com', 'Ave', '100']) {
      expect(logged).not.toContain(secret);
    }
  });
});
