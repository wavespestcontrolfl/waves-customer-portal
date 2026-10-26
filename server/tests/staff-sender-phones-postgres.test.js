// GATE_TECH_STAFF_GUARDS, M12 (census 2026-10-25): the active technicians' phones as staff senders.
// CI's DATABASE_URL pass runs this. Fixtures live in a unique schema holding copies of `technicians`
// and `customers`, removed after the suite. Nothing is sent.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');

let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const staffPhones = require('../services/staff-sender-phones');
const { _test: { resolveCallContactPhone } } = require('../services/call-recording-processor');

const ENV_KEYS = [
  'WAVES_FALLBACK_FORWARD_NUMBERS', 'WAVES_CSR_NUMBER_MAP', 'VIRGINIA_PHONE',
  'OWNER_PHONE', 'ADAM_PHONE', 'OFFICE_MANAGER_PHONE', 'WAVES_OFFICE_MANAGER_PHONE',
];
const HIRE = '+19415550142';       // an active technician's own cell
const FORMER = '+19415550143';     // an inactive technician's cell
const SHARED = '+19415550144';     // an active technician's cell that is ALSO a customer's phone
const SECONDARY = '+19415550145';  // an active technician's cell on a customer's secondary phone
const CUSTOMER = '+19415550177';   // an ordinary customer
const OFFICE = TWILIO_NUMBERS.locations.parrish.number; // a Waves line, as the owner's technician row holds

const describeDb = SKIP ? describe.skip : describe;
describeDb('staff-sender-phones (Postgres)', () => {
  const schema = `staff_sender_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  let database;
  let saved;
  let prevGate;

  beforeAll(async () => {
    const admin = knex({ client: 'pg', connection: process.env.DATABASE_URL });
    await admin.raw('CREATE SCHEMA ??', [schema]);
    for (const table of ['technicians', 'customers']) {
      await admin.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    }
    await admin.destroy();
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema, 'public'] });
    mockConn = database;
  });
  afterAll(async () => {
    const admin = knex({ client: 'pg', connection: process.env.DATABASE_URL });
    await admin.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await admin.destroy();
    await database.destroy();
  });

  beforeEach(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    ENV_KEYS.forEach((k) => { delete process.env[k]; });
    prevGate = process.env.GATE_TECH_STAFF_GUARDS;
    process.env.GATE_TECH_STAFF_GUARDS = 'true';
    staffPhones.resetForTests();
    jest.clearAllMocks();
    const tech = (name, phone, employment_status) => ({ id: randomUUID(), name, phone, employment_status });
    await database('technicians').insert([
      tech('Synthetic Hire', '(941) 555-0142', 'active'),
      tech('Synthetic Former', FORMER, 'inactive'),
      tech('Synthetic Shared', SHARED, 'active'),
      tech('Synthetic Secondary', SECONDARY, 'active'),
      tech('Synthetic Owner', OFFICE, 'active'),
      tech('Synthetic NoPhone', null, 'active'),
    ]);
    await database('customers').insert([
      { id: randomUUID(), first_name: 'Synthetic', last_name: 'Shared', phone: SHARED },
      { id: randomUUID(), first_name: 'Synthetic', last_name: 'Second', phone: CUSTOMER, secondary_phone: SECONDARY },
    ]);
  });
  afterEach(async () => {
    ENV_KEYS.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
    if (prevGate === undefined) delete process.env.GATE_TECH_STAFF_GUARDS;
    else process.env.GATE_TECH_STAFF_GUARDS = prevGate;
    await database('technicians').del();
    await database('customers').del();
  });

  test('an active technician\'s phone is a staff sender, in any format', async () => {
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone(HIRE)).toBe(true);
    expect(staffPhones.isStaffTechPhone('9415550142')).toBe(true);
    expect(staffPhones.isStaffTechPhone('(941) 555-0142')).toBe(true);
    expect(await staffPhones.isStaffTechSender(HIRE)).toBe(true);
  });

  test('an inactive technician, an ordinary customer and a stranger are not', async () => {
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone(FORMER)).toBe(false);
    expect(staffPhones.isStaffTechPhone(CUSTOMER)).toBe(false);
    expect(staffPhones.isStaffTechPhone('+19415550999')).toBe(false);
    expect(staffPhones.isStaffTechPhone(null)).toBe(false);
    expect(staffPhones.isStaffTechPhone('')).toBe(false);
  });

  test('a number that is also on a customer record stays a customer, and is logged without a name or number', async () => {
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone(SHARED)).toBe(false);      // customers.phone
    expect(staffPhones.isStaffTechPhone(SECONDARY)).toBe(false);   // customers.secondary_phone
    const lines = logger.info.mock.calls.map((c) => String(c[0]));
    const shared = lines.filter((l) => l.includes('stay customers'));
    expect(shared).toHaveLength(1);
    expect(shared[0]).toContain('2 active technician phone(s)');
    expect(shared[0]).not.toMatch(/5550144|5550145|Synthetic/);
  });

  test('the owner\'s technician row holds a Waves line: it is never a staff SENDER through this set', async () => {
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone(OFFICE)).toBe(false);
    // …and it stays internal through the existing registry, which is what the call pipeline asks first.
    expect(TWILIO_NUMBERS.isInternalNumber(OFFICE)).toBe(true);
  });

  test('gate off: nothing is read and every answer is false', async () => {
    delete process.env.GATE_TECH_STAFF_GUARDS;
    let queries = 0;
    const count = () => { queries += 1; };
    database.on('query', count);
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone(HIRE)).toBe(false);
    expect(await staffPhones.isStaffTechSender(HIRE)).toBe(false);
    database.removeListener('query', count);
    expect(queries).toBe(0);
    // Turning it on later loads the set.
    process.env.GATE_TECH_STAFF_GUARDS = 'true';
    expect(await staffPhones.isStaffTechSender(HIRE)).toBe(true);
    // …and turning it off again answers false at once, even with the set cached.
    delete process.env.GATE_TECH_STAFF_GUARDS;
    expect(staffPhones.isStaffTechPhone(HIRE)).toBe(false);
  });

  test('the set is cached for 60 seconds, then re-read', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone('+19415550150')).toBe(false);
    await database('technicians').insert({ id: randomUUID(), name: 'Synthetic Late', phone: '+19415550150', employment_status: 'active' });
    now.mockReturnValue(1_000_000 + 59_000);
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone('+19415550150')).toBe(false);
    now.mockReturnValue(1_000_000 + 61_000);
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone('+19415550150')).toBe(true);
    now.mockRestore();
  });

  test('a failed load keeps the last set and never throws', async () => {
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValue(2_000_000);
    await staffPhones.refresh();
    expect(staffPhones.isStaffTechPhone(HIRE)).toBe(true);
    const original = mockConn;
    mockConn = () => { throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' }); };
    now.mockReturnValue(2_000_000 + 61_000);
    await expect(staffPhones.refresh()).resolves.toBeUndefined();
    expect(staffPhones.isStaffTechPhone(HIRE)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('technician phone load failed: ECONNREFUSED'));
    mockConn = original;
    now.mockRestore();
  });

  describe('the call pipeline reads it', () => {
    const inbound = (from) => ({ direction: 'inbound', from_phone: from, to_phone: OFFICE });

    test('a call from an active technician\'s phone keys no customer (same as an env staff phone)', async () => {
      await staffPhones.refresh();
      expect(resolveCallContactPhone(inbound(HIRE))).toBeNull();
      expect(resolveCallContactPhone(inbound(CUSTOMER))).toBe(CUSTOMER);
      expect(resolveCallContactPhone(inbound(FORMER))).toBe(FORMER);   // inactive: a customer, as today
      expect(resolveCallContactPhone(inbound(SHARED))).toBe(SHARED);   // shared with a customer: as today
    });

    test('gate off: the same call keys the caller, as today', async () => {
      await staffPhones.refresh();
      delete process.env.GATE_TECH_STAFF_GUARDS;
      expect(resolveCallContactPhone(inbound(HIRE))).toBe(HIRE);
    });

    test('an outbound customer call is unchanged', async () => {
      await staffPhones.refresh();
      expect(resolveCallContactPhone({ direction: 'outbound', from_phone: OFFICE, to_phone: CUSTOMER })).toBe(CUSTOMER);
    });

    test('the env staff list still works beside it', async () => {
      process.env.WAVES_FALLBACK_FORWARD_NUMBERS = '+19415550000';
      await staffPhones.refresh();
      expect(resolveCallContactPhone(inbound('+19415550000'))).toBeNull();
    });
  });

  test('outbound sends are untouched: the owner phone set and the registry ignore technician phones', async () => {
    await staffPhones.refresh();
    const TwilioService = require('../services/twilio');
    expect(TwilioService.isKnownOwnerPhone(HIRE)).toBe(false);
    expect(TWILIO_NUMBERS.isInternalNumber(HIRE)).toBe(false);
    expect(TWILIO_NUMBERS.isStaffForwardNumber(HIRE)).toBe(false);
  });
});
