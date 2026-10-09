/**
 * Last-name SUGGESTION for a phone caller who gave only a first name.
 *
 * The module never writes customers.last_name. Pins: the gate (off = no
 * reads), the eligibility facts re-read from the DB, all four sources run and
 * are collected (county owner record only for an owner caller, our own
 * records, a first.last email, the Twilio caller name), ONE admin
 * notification grouped by surname, no customers write of any kind, and the
 * never-throws / no-PII-in-logs contract.
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
// The pipeline's own contact-phone resolver; this stand-in keeps its two plain cases.
jest.mock('../services/call-recording-processor', () => ({
  resolveCallContactPhone: jest.fn((call) => (String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone)),
}));
jest.mock('../services/outbound-call-reason', () => ({ nanpStoredPhoneClause: (col) => `PHONE_MATCH(${col}) = ?` }));
// The real composer validates every spec against docs/admin-notifications.md
// (it throws under NODE_ENV=test); only the notifyAdmin leg is replaced.
jest.mock('../services/admin-alert-compose', () => {
  const actual = jest.requireActual('../services/admin-alert-compose');
  return { ...actual, raiseAdminAlert: jest.fn(async (category, spec) => { actual.composeAdminAlert(spec); return { id: 'note-1' }; }) };
});

const db = require('../models/db');
const logger = require('../services/logger');
const { lookupCountyParcelByPoint } = require('../services/property-lookup/county-parcel-gis');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
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
  for (const m of ['where', 'whereNot', 'whereNull', 'whereRaw', 'orWhereRaw', 'forUpdate', 'select', 'first', 'update', 'insert', 'del']) {
    b[m] = jest.fn((...args) => {
      if (record) record.push([m, ...args]);
      if (m === 'where' && typeof args[0] === 'function') args[0](b);
      return b;
    });
  }
  b.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return b;
}

// opts: call, customer (eligibility read), customers (own-records rows),
// leads (own-records rows), recheck (the pre-post last_name read).
function setupDb(opts = {}) {
  const records = [];
  const tables = {
    call_log: [opts.call === undefined ? CALL : opts.call],
    customers: [
      opts.customer === undefined ? CUSTOMER : opts.customer,
      opts.customers || [],
      opts.recheck === undefined ? { ...(opts.customer === undefined ? CUSTOMER : opts.customer), last_name: null } : opts.recheck,
    ],
    leads: [opts.leads || []],
    notifications: [opts.standing === undefined ? null : opts.standing],
  };
  const seen = {};
  db.mockImplementation((table) => {
    seen[table] = (seen[table] || 0) + 1;
    return builder(tables[table][seen[table] - 1], records);
  });
  return { records };
}

// The module must never change customers: no write verb on any builder, no transaction.
function expectNoWrites(records) {
  expect(records.filter(([verb]) => ['update', 'insert', 'del'].includes(verb))).toEqual([]);
  expect(db.transaction).not.toHaveBeenCalled();
}

const inbound = (overrides = {}) => ({ ...CALL, ...overrides });
const withExtraction = (caller) => inbound({ ai_extraction_enriched: { caller: { first_name: 'Pat', last_name: null, relationship_to_property: 'owner', ...caller } } });
const tenant = () => withExtraction({ relationship_to_property: 'tenant' });

const twilioAnswers = (name, callerType = 'CONSUMER') => jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ caller_name: { caller_name: name, caller_type: callerType, error_code: null } }),
});

const realFetch = global.fetch;
beforeEach(() => {
  process.env.GATE_CALL_LAST_NAME_LOOKUP = 'true';
  process.env.TWILIO_ACCOUNT_SID = 'ACtest';
  process.env.TWILIO_AUTH_TOKEN = 'tokentest';
  lookupCountyParcelByPoint.mockResolvedValue(PARCEL);
  // resetAllMocks (afterEach) clears implementations: restore the resolver stand-in every test.
  require('../services/call-recording-processor').resolveCallContactPhone
    .mockImplementation((call) => (String(call.direction || '').startsWith('outbound') ? call.to_phone : call.from_phone));
  global.fetch = twilioAnswers(null);
  raiseAdminAlert.mockImplementation(async (category, spec) => {
    jest.requireActual('../services/admin-alert-compose').composeAdminAlert(spec);
    return { id: 'note-1' };
  });
});

afterEach(() => {
  delete process.env.GATE_CALL_LAST_NAME_LOOKUP;
  delete process.env.TWILIO_ACCOUNT_SID;
  delete process.env.TWILIO_AUTH_TOKEN;
  global.fetch = realFetch;
  jest.resetAllMocks();
});

const run = () => runCallLastNameLookup({ callLogId: 'call-1', customerId: 'cust-1' });
const posted = () => {
  expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
  return { category, spec, opts };
};

describe('gate', () => {
  test('off: run skips before any read, enqueue schedules nothing', async () => {
    delete process.env.GATE_CALL_LAST_NAME_LOOKUP;
    setupDb();
    expect(await run()).toEqual({ skipped: 'gated' });
    enqueueCallLastNameLookup({ callLogId: 'call-1', customerId: 'cust-1' });
    await flushImmediates();
    expect(db).not.toHaveBeenCalled();
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('anything but exactly "true" is off', async () => {
    process.env.GATE_CALL_LAST_NAME_LOOKUP = '1';
    setupDb();
    expect(await run()).toEqual({ skipped: 'gated' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('missing ids skip without a read', async () => {
    setupDb();
    expect(await runCallLastNameLookup({ callLogId: 'call-1' })).toEqual({ skipped: 'missing_ids' });
    expect(db).not.toHaveBeenCalled();
  });
});

describe('the notification', () => {
  test('one source (county): title, why, link, dedupe key, metadata, detail, bell', async () => {
    const { records } = setupDb();
    expect(await run()).toEqual({ suggested: true, outcome: 'posted', sources: ['county'] });
    const { category, spec, opts } = posted();
    expect(category).toBe('customer');
    expect(spec).toMatchObject({
      area: 'Customers',
      action: 'review a last name for Pat',
      why: 'Pat may be Pat Example, per county record; open the customer to save it.',
      severity: 'needs-you',
      link: '/admin/customers?customerId=cust-1',
      subject: { type: 'customer', id: 'cust-1' },
      doneWhen: 'last_name_saved',
      who: 'person',
    });
    expect(opts).toEqual({
      bell: true,
      dedupeKey: 'call-last-name-suggestion:cust-1',
      detail: 'Pat Example: county record\nOpen the customer to save the last name.',
      metadata: { customerId: 'cust-1', callLogId: 'call-1', suggestions: [{ surname: 'Example', sources: ['county'] }] },
    });
    expectNoWrites(records);
  });

  test('two agreeing sources: one surname, both labels', async () => {
    global.fetch = twilioAnswers('EXAMPLE,PAT');
    const { records } = setupDb();
    expect(await run()).toEqual({ suggested: true, outcome: 'posted', sources: ['county', 'twilio'] });
    const { spec, opts } = posted();
    expect(spec.why).toBe('Pat may be Pat Example, per county record + Twilio caller name; open the customer to save it.');
    expect(opts.detail).toBe('Pat Example: county record + Twilio caller name\nOpen the customer to save the last name.');
    expect(opts.metadata.suggestions).toEqual([{ surname: 'Example', sources: ['county', 'twilio'] }]);
    expectNoWrites(records);
  });

  test('the same surname in different case is one group', async () => {
    global.fetch = twilioAnswers('example pat');
    setupDb();
    await run();
    expect(posted().opts.metadata.suggestions).toHaveLength(1);
  });

  test('two disagreeing sources: the body picks none, the full text lists both', async () => {
    global.fetch = twilioAnswers('SAMPLETON PAT');
    const { records } = setupDb();
    await run();
    const { spec, opts } = posted();
    expect(spec.why).toBe('2 different answers for Pat; open the full text and the customer.');
    expect(spec.why).not.toMatch(/Example|Sampleton/);
    expect(opts.detail).toBe([
      'Different answers for Pat\'s last name (none is picked):',
      'Pat Example: county record',
      'Pat Sampleton: Twilio caller name',
      'Open the customer and save the right one, or none.',
    ].join('\n'));
    expect(opts.metadata.suggestions).toEqual([
      { surname: 'Example', sources: ['county'] },
      { surname: 'Sampleton', sources: ['twilio'] },
    ]);
    expectNoWrites(records);
  });

  test('each source alone is labelled with its own name', async () => {
    setupDb({ call: tenant(), customers: [{ first_name: 'Pat', last_name: 'Sampleton' }] });
    await run();
    expect(posted().spec.why).toContain('per our records;');
    raiseAdminAlert.mockClear();
    setupDb({ call: tenant(), customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' } });
    await run();
    expect(posted().spec.why).toContain('per email address;');
  });

  test('the headline stays inside 60 characters for a long first name', async () => {
    setupDb({ call: withExtraction({ first_name: 'Pat'.repeat(12) }), customer: { ...CUSTOMER, first_name: 'Pat'.repeat(12) } });
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: [`EXAMPLE, ${'PAT'.repeat(12)}`] });
    await run();
    const { spec } = posted();
    expect(`Customers — ${spec.action}`.length).toBeLessThanOrEqual(60);
  });

  test('a notification that was not stored (deduped) is not reported as posted', async () => {
    raiseAdminAlert.mockResolvedValue({ id: null, suppressed: true });
    setupDb();
    expect(await run()).toEqual({ suggested: false, outcome: 'not_posted', sources: ['county'] });
  });

  test('no source answers: nothing is posted', async () => {
    lookupCountyParcelByPoint.mockResolvedValue(null);
    const { records } = setupDb();
    expect(await run()).toEqual({ suggested: false, outcome: 'no_answer' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expectNoWrites(records);
  });

  test('the last name appeared meanwhile: nothing is posted', async () => {
    setupDb({ recheck: { id: 'cust-1', last_name: 'Landed' } });
    expect(await run()).toEqual({ suggested: false, outcome: 'last_name_appeared' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('the customer was deleted meanwhile: nothing is posted', async () => {
    setupDb({ recheck: null });
    expect(await run()).toEqual({ suggested: false, outcome: 'last_name_appeared' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a notification failure never throws out and is logged as a code', async () => {
    raiseAdminAlert.mockRejectedValue(Object.assign(new Error('boom for Pat Example'), { code: 'XX001' }));
    setupDb();
    await expect(run()).resolves.toEqual({ suggested: false, outcome: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { callLogId: 'call-1', customerId: 'cust-1', error: 'XX001' });
  });
});

describe('county owner record', () => {
  test('asks for owner names with the customer coordinates', async () => {
    setupDb();
    await run();
    expect(lookupCountyParcelByPoint).toHaveBeenCalledWith(27.4, -82.4, expect.objectContaining({ includeOwners: true }));
  });

  test('an unknown relationship may read the county record', async () => {
    setupDb({ call: withExtraction({ relationship_to_property: 'unknown' }) });
    await run();
    expect(lookupCountyParcelByPoint).toHaveBeenCalled();
    expect(posted().opts.metadata.suggestions[0].surname).toBe('Example');
  });

  test.each(['real_estate_agent', 'tenant', 'home_buyer', 'family_member', 'property_manager', 'spouse_partner', 'other', ''])(
    'relationship %p never calls the county lookup, but the other sources still run',
    async (relationship) => {
      global.fetch = twilioAnswers('SAMPLETON PAT');
      setupDb({ call: withExtraction({ relationship_to_property: relationship }), customers: [{ first_name: 'Pat', last_name: 'Sampleton' }] });
      await run();
      expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(posted().opts.metadata.suggestions).toEqual([{ surname: 'Sampleton', sources: ['records', 'twilio'] }]);
    },
  );

  test('a parcel whose house number is not the customer\'s is not used', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, situsAddress: '102 SAMPLE AVE' });
    setupDb();
    expect(await run()).toEqual({ suggested: false, outcome: 'no_answer' });
  });

  test('no coordinates, no parcel, or no owner names: no county answer', async () => {
    setupDb({ customer: { ...CUSTOMER, latitude: null, longitude: null } });
    await run();
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();

    lookupCountyParcelByPoint.mockResolvedValue(null);
    setupDb();
    await run();
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: [] });
    setupDb();
    await run();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('two owners with the caller first name and different surnames, or an entity owner: no county answer', async () => {
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE, PAT Q', 'SAMPLE, PAT'] });
    setupDb();
    await run();
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE PAT HOLDINGS LLC'] });
    setupDb();
    await run();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a thrown county lookup contributes nothing; the other sources still answer', async () => {
    lookupCountyParcelByPoint.mockRejectedValue(Object.assign(new Error('boom 100 Sample Ave'), { code: 'ETIMEDOUT' }));
    setupDb({ customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' } });
    await expect(run()).resolves.toEqual({ suggested: true, outcome: 'posted', sources: ['email'] });
  });
});

describe('our own records', () => {
  test('an international number is matched on its exact digits', async () => {
    const intl = { ...CALL, from_phone: '+442079460958', ai_extraction_enriched: { caller: { first_name: 'Pat', last_name: null, relationship_to_property: 'tenant' } } };
    const { records } = setupDb({ call: intl, customer: { ...CUSTOMER, phone: '+44 20 7946 0958' }, customers: [{ first_name: 'Pat', last_name: 'Sampleton' }] });
    await run();
    expect(records).toContainEqual(['orWhereRaw', "regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') = ?", ['442079460958']]);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('the call read selects every column the run uses (the mock returns whole rows, so pin the projection)', async () => {
    const { records } = setupDb({ call: tenant(), customers: [{ first_name: 'Pat', last_name: 'Sampleton' }] });
    await run();
    const callRead = records.find(([verb, ...cols]) => verb === 'first' && cols.includes('v2_extraction_status'));
    expect(callRead).toEqual(expect.arrayContaining(['customer_id', 'direction', 'from_phone', 'to_phone', 'source', 'metadata', 'ai_extraction', 'created_at', 'v2_extraction_status', 'ai_extraction_enriched']));
  });

  test('only rows last written before the call count: the call\'s own lead write is never read back', async () => {
    const { records } = setupDb({ call: tenant(), customers: [{ first_name: 'Pat', last_name: 'Sampleton' }] });
    await run();
    const fences = records.filter(([verb, column, op]) => verb === 'where' && column === 'updated_at' && op === '<');
    expect(fences).toHaveLength(2); // the other-customers read and the leads read
    for (const fence of fences) expect(fence[3]).toBe(CALL.created_at);
  });

  test('another customer with the same contact, same first name and a last name', async () => {
    const { records } = setupDb({
      call: tenant(),
      customer: { ...CUSTOMER, email: 'Pat@Example.com' },
      customers: [{ first_name: 'Pat', last_name: 'Sampleton' }],
    });
    await run();
    expect(posted().opts.metadata.suggestions).toEqual([{ surname: 'Sampleton', sources: ['records'] }]);
    // email compared lower-cased; phone matched on the NANP identity key
    expect(records).toContainEqual(['whereRaw', 'LOWER(TRIM(email)) = ?', ['pat@example.com']]);
    expect(records).toContainEqual(['orWhereRaw', 'PHONE_MATCH(phone) = ?', ['9415550100']]);
  });

  test('a lead record counts too, and a nickname first name matches', async () => {
    setupDb({
      call: withExtraction({ relationship_to_property: 'tenant', first_name: 'Bill' }),
      customer: { ...CUSTOMER, first_name: 'Bill' },
      leads: [{ first_name: 'William', last_name: 'Sampleton' }],
    });
    await run();
    expect(posted().opts.metadata.suggestions[0].surname).toBe('Sampleton');
  });

  test('the same surname on a customer and a lead (any case) is one answer', async () => {
    setupDb({
      call: tenant(),
      customers: [{ first_name: 'Pat', last_name: 'Sampleton' }],
      leads: [{ first_name: 'Pat', last_name: 'SAMPLETON' }],
    });
    await run();
    expect(posted().opts.metadata.suggestions).toEqual([{ surname: 'Sampleton', sources: ['records'] }]);
  });

  test('two different surnames in our records: no answer', async () => {
    setupDb({
      call: tenant(),
      customers: [{ first_name: 'Pat', last_name: 'Sampleton' }],
      leads: [{ first_name: 'Pat', last_name: 'Exampleson' }],
    });
    await run();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a record with another first name, or a last name that is not a name, is ignored', async () => {
    setupDb({ call: tenant(), customers: [{ first_name: 'Robin', last_name: 'Sampleton' }, { first_name: 'Pat', last_name: '555-0100' }] });
    await run();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('caller email', () => {
  test('first.last@ gives an email answer', async () => {
    setupDb({ call: tenant(), customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' } });
    await run();
    expect(posted().opts.metadata.suggestions).toEqual([{ surname: 'Sampleton', sources: ['email'] }]);
  });

  test('a run-together address, or a business word after a separator: no answer', async () => {
    setupDb({
      call: tenant(),
      customer: { ...CUSTOMER, first_name: 'Elizabeth', email: 'elizabethrealty@example.com' },
    });
    await run();
    setupDb({ call: tenant(), customer: { ...CUSTOMER, email: 'pat.realty@example.com' } });
    await run();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('Twilio caller name', () => {
  const tenantTwilio = (name, callerType, customer = CUSTOMER) => {
    global.fetch = twilioAnswers(name, callerType);
    return setupDb({ call: tenant(), customer });
  };
  const suggested = async () => { await run(); return raiseAdminAlert.mock.calls.length === 1 ? raiseAdminAlert.mock.calls[0][2].metadata.suggestions : null; };

  test('a consumer name with the first name and one other word is an answer', async () => {
    tenantTwilio('SAMPLETON,PAT');
    expect(await suggested()).toEqual([{ surname: 'Sampleton', sources: ['twilio'] }]);
  });

  test('the request is the Lookup v2 caller_name for the +1 number, with Basic auth and a timeout signal', async () => {
    tenantTwilio('SAMPLETON PAT');
    await run();
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toBe('https://lookups.twilio.com/v2/PhoneNumbers/%2B19415550100?Fields=caller_name');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('ACtest:tokentest').toString('base64')}`);
    expect(init.signal).toBeDefined();
  });

  test.each([
    ['no name', null, 'CONSUMER'],
    ['UNKNOWN', 'UNKNOWN', 'CONSUMER'],
    ['a business', 'SAMPLETON PAT', 'BUSINESS'],
    ['a 15-character name', 'SAMPLETONXX PAT', 'CONSUMER'],
    ['no first-name token', 'SAMPLETON ROBIN', 'CONSUMER'],
    ['two leftover tokens', 'SAMPLETON EX PAT', 'CONSUMER'],
  ])('%s: no answer', async (label, name, callerType) => {
    tenantTwilio(name, callerType);
    expect(await suggested()).toBeNull();
  });

  test('a non-US or impossible number is never looked up', async () => {
    tenantTwilio('SAMPLETON PAT', 'CONSUMER', { ...CUSTOMER, phone: '+44 20 7946 0958' });
    await run();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('missing credentials: no lookup', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    tenantTwilio('SAMPLETON PAT');
    await run();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('an HTTP error or a thrown fetch contributes nothing and logs only a code', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    setupDb({ call: tenant() });
    await run();
    global.fetch = jest.fn().mockRejectedValue(Object.assign(new Error('fetch failed for https://lookups.twilio.com/v2/PhoneNumbers/%2B19415550100'), { name: 'AbortError' }));
    setupDb({ call: tenant() });
    await run();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).toContain('twilio:http_404');
    expect(logged).toContain('twilio:AbortError');
    expect(logged).not.toMatch(/lookups\.twilio|9415550100|%2B/);
  });

  test('a failing Twilio lookup does not stop the other sources', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down'));
    setupDb();
    await expect(run()).resolves.toMatchObject({ suggested: true, sources: ['county'] });
  });
});

describe('eligibility', () => {
  test('the caller\'s number comes from the pipeline\'s own resolver (a form callback\'s lead phone, not the staff leg)', async () => {
    const { resolveCallContactPhone } = require('../services/call-recording-processor');
    const bridged = { ...CALL, direction: 'outbound-api', source: 'lead-webhook-auto-bridge', from_phone: '+19415550199', to_phone: '+19415550177',
      metadata: { type: 'lead_auto_bridge', leadPhone: '+19415550100' }, ai_extraction: { phone: '+19415550100' } };
    resolveCallContactPhone.mockReturnValueOnce('+19415550100');
    setupDb({ call: bridged });
    lookupCountyParcelByPoint.mockResolvedValue(PARCEL);
    await run();
    expect(resolveCallContactPhone).toHaveBeenCalledWith(bridged, '+19415550100');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a standing suggestion for the customer: no source runs again, no paid lookup', async () => {
    const { records } = setupDb({ standing: { id: 'notif-1' } });
    global.fetch = jest.fn();
    expect(await run()).toEqual({ skipped: 'already_suggested' });
    expect(records).toContainEqual(['whereRaw', "metadata->>'dedupeKey' = ?", ['call-last-name-suggestion:cust-1']]);
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['first name', { first_name: 'Robin' }],
    ['phone', { phone: '(941) 555-0142' }],
    ['email', { email: 'other@example.com' }],
    ['address', { address_line1: '200 Sample Ave' }],
    ['coordinates', { latitude: '27.5000' }],
  ])('staff changed the %s while the lookups ran: nothing is posted', async (_label, change) => {
    setupDb({ recheck: { ...CUSTOMER, last_name: null, ...change } });
    lookupCountyParcelByPoint.mockResolvedValue(PARCEL);
    expect(await run()).toEqual({ suggested: false, outcome: 'customer_changed' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['nobody gave a first name on the call', { first_name: null }],
    ['a household member gave their own first name', { first_name: 'Robin' }],
  ])('%s: no lookup, no Twilio request, no notification', async (_label, caller) => {
    const { records } = setupDb({ call: withExtraction(caller) });
    global.fetch = jest.fn();
    expect(await run()).toEqual({ skipped: 'caller_first_name_differs' });
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expectNoWrites(records);
  });

  test('the caller\'s nickname for the customer\'s first name is the same person', async () => {
    setupDb({ call: withExtraction({ first_name: 'Bill' }), customer: { ...CUSTOMER, first_name: 'William' } });
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE, WILLIAM'] });
    await run();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a last name already on the customer: nothing runs', async () => {
    const { records } = setupDb({ customer: { ...CUSTOMER, last_name: 'Existing' } });
    expect(await run()).toEqual({ skipped: 'has_last_name' });
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expectNoWrites(records);
  });

  test('a blank (spaces) last name counts as empty', async () => {
    setupDb({ customer: { ...CUSTOMER, last_name: '   ' } });
    await run();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('no first name: skipped', async () => {
    setupDb({ customer: { ...CUSTOMER, first_name: ' ' } });
    expect(await run()).toEqual({ skipped: 'no_first_name' });
  });

  test('the caller phone is not the customer phone: nothing runs, nothing is paid for', async () => {
    setupDb({ call: inbound({ from_phone: '+19415550188' }) });
    expect(await run()).toEqual({ skipped: 'caller_not_customer' });
    expect(lookupCountyParcelByPoint).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('a customer without a phone, or a call without one: skipped', async () => {
    setupDb({ customer: { ...CUSTOMER, phone: null } });
    expect(await run()).toEqual({ skipped: 'caller_not_customer' });
    setupDb({ call: inbound({ from_phone: null }) });
    expect(await run()).toEqual({ skipped: 'caller_not_customer' });
  });

  test('an outbound call compares the dialed number', async () => {
    setupDb({ call: inbound({ direction: 'outbound-api', from_phone: '+19415550199', to_phone: '+19415550100' }) });
    await run();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('the call is linked to another customer, or is gone: skipped', async () => {
    setupDb({ call: inbound({ customer_id: 'cust-2' }) });
    expect(await run()).toEqual({ skipped: 'call_not_linked' });
    setupDb({ call: null });
    expect(await run()).toEqual({ skipped: 'call_not_linked' });
  });

  test('a soft-deleted or missing customer: skipped', async () => {
    setupDb({ customer: null });
    expect(await run()).toEqual({ skipped: 'customer_gone' });
  });

  test('the V2 caller already gave a last name: skipped', async () => {
    setupDb({ call: withExtraction({ last_name: 'Heard' }) });
    expect(await run()).toEqual({ skipped: 'caller_gave_last_name' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('an extraction that is not valid, or is missing: skipped', async () => {
    setupDb({ call: inbound({ v2_extraction_status: 'schema_invalid' }) });
    expect(await run()).toEqual({ skipped: 'no_valid_extraction' });
    setupDb({ call: inbound({ ai_extraction_enriched: null }) });
    expect(await run()).toEqual({ skipped: 'no_valid_extraction' });
  });

  test('a JSON-string extraction is read', async () => {
    setupDb({ call: inbound({ ai_extraction_enriched: JSON.stringify(CALL.ai_extraction_enriched) }) });
    await run();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });
});

describe('never throws, never logs PII', () => {
  test('a database error is swallowed into an outcome code', async () => {
    db.mockImplementation(() => { throw Object.assign(new Error('relation for pat.sampleton@example.com'), { code: 'XX000' }); });
    await expect(run()).resolves.toEqual({ suggested: false, outcome: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), { callLogId: 'call-1', customerId: 'cust-1', error: 'XX000' });
  });

  test('enqueue runs off the caller\'s tick and swallows a failure', async () => {
    setupDb();
    expect(() => enqueueCallLastNameLookup({ callLogId: 'call-1', customerId: 'cust-1' })).not.toThrow();
    expect(db).not.toHaveBeenCalled();
    await flushImmediates();
    await flushImmediates();
    expect(db).toHaveBeenCalled();
  });

  test('no log call carries a name, phone, email or address', async () => {
    global.fetch = twilioAnswers('EXAMPLE PAT');
    setupDb({ customer: { ...CUSTOMER, email: 'pat.sampleton@example.com' } });
    await run(); // posts: logs the sources
    lookupCountyParcelByPoint.mockRejectedValueOnce(Object.assign(new Error('county down for 100 Sample Ave'), { code: 'ETIMEDOUT' }));
    setupDb({ customer: { ...CUSTOMER, email: null } });
    lookupCountyParcelByPoint.mockResolvedValue({ ...PARCEL, ownerNames: ['EXAMPLE, ROBIN'] });
    global.fetch = twilioAnswers(null);
    await run(); // no answer
    db.mockImplementation(() => { throw new Error('pat.sampleton@example.com 100 Sample Ave 9415550100'); });
    await run(); // error
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).toContain('call-last-name-lookup');
    for (const secret of ['Pat', 'Example', 'Sampleton', 'Sample', '555', '941', 'example.com', 'Ave', '100']) {
      expect(logged).not.toContain(secret);
    }
  });
});
