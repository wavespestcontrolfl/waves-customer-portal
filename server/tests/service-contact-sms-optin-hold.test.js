// The visit-complete text and the review ask go to ONE recipient: the slot-1
// on-location contact, else the account holder. A portal contact save stamps
// the account holder's attestation and opens that contact's own opt-in ask on
// the same save, so the stamp alone let these two texts reach a contact who
// had not replied YES yet, while the appointment texts held. The single
// recipient now reads the same recipient_optin hold.
const fs = require('fs');
const path = require('path');

let mockGateOn = true;
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn((key) => (key === 'recipientDoubleOptin' ? mockGateOn : false)) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());

const db = require('../models/db');
const { getServiceContactSmsRecipient } = require('../services/customer-contact');
const { optinHeldPhoneKeys, resolveServiceContactSmsRecipient } = require('../services/recipient-optin');

// A recipient_optin reader that answers the non-confirmed rows.
function optinReader(rows, { isTransaction = false, error = null } = {}) {
  const calls = [];
  const handle = jest.fn((table) => {
    const q = {
      whereIn(col, ids) { calls.push({ table, col, ids }); return q; },
      whereNot(cond) { calls.push({ whereNot: cond }); return q; },
      select() { return error ? Promise.reject(error) : Promise.resolve(rows); },
    };
    return q;
  });
  handle.isTransaction = isTransaction;
  handle.calls = calls;
  return handle;
}

const CONTACT = {
  id: 'cust-1',
  first_name: 'Dana',
  phone: '+19415550100',
  service_contact_name: 'Riley Tenant',
  service_contact_phone: '(941) 555-0123',
  service_contacts_consent_at: new Date('2026-09-30T12:00:00Z'),
};

beforeEach(() => {
  mockGateOn = true;
  db.mockReset();
});

describe('getServiceContactSmsRecipient: heldPhoneKeys', () => {
  test('a held slot-1 phone resolves to the account holder, name and phone together', () => {
    const recipient = getServiceContactSmsRecipient(CONTACT, { heldPhoneKeys: new Set(['9415550123']) });
    expect(recipient).toMatchObject({ phone: '+19415550100', name: 'Dana', role: 'primary' });
  });

  test('no held keys, or a different held key: the contact is the recipient', () => {
    expect(getServiceContactSmsRecipient(CONTACT).phone).toBe('(941) 555-0123');
    expect(getServiceContactSmsRecipient(CONTACT, { heldPhoneKeys: new Set(['9415550999']) }).phone).toBe('(941) 555-0123');
  });
});

describe('optinHeldPhoneKeys', () => {
  test('groups the non-confirmed rows by customer', async () => {
    const dbh = optinReader([
      { customer_id: 'cust-1', phone_key: '9415550123' },
      { customer_id: 'cust-2', phone_key: '9415550456' },
    ]);
    const held = await optinHeldPhoneKeys(['cust-1', 'cust-2', 'cust-1'], { dbh });
    expect(dbh.calls[0]).toEqual({ table: 'recipient_optin', col: 'customer_id', ids: ['cust-1', 'cust-2'] });
    expect(dbh.calls[1]).toEqual({ whereNot: { status: 'confirmed' } });
    expect([...held.get('cust-1')]).toEqual(['9415550123']);
    expect([...held.get('cust-2')]).toEqual(['9415550456']);
  });

  test('gate off, or no ids: nothing held and no read', async () => {
    const dbh = optinReader([{ customer_id: 'cust-1', phone_key: '9415550123' }]);
    mockGateOn = false;
    expect((await optinHeldPhoneKeys(['cust-1'], { dbh })).size).toBe(0);
    mockGateOn = true;
    expect((await optinHeldPhoneKeys([], { dbh })).size).toBe(0);
    expect(dbh).not.toHaveBeenCalled();
  });

  test('a missing table fails open; any other error throws', async () => {
    const missing = Object.assign(new Error('relation does not exist'), { code: '42P01' });
    expect((await optinHeldPhoneKeys(['cust-1'], { dbh: optinReader([], { error: missing }) })).size).toBe(0);
    await expect(optinHeldPhoneKeys(['cust-1'], { dbh: optinReader([], { error: new Error('connection reset') }) }))
      .rejects.toThrow('connection reset');
    // On a transaction the error has aborted it: never swallowed.
    await expect(optinHeldPhoneKeys(['cust-1'], { dbh: optinReader([], { error: missing, isTransaction: true }) }))
      .rejects.toThrow('relation does not exist');
  });
});

describe('resolveServiceContactSmsRecipient', () => {
  test('a contact with an unconfirmed opt-in row waits: the account holder is the recipient', async () => {
    const dbh = optinReader([{ customer_id: 'cust-1', phone_key: '9415550123' }]);
    const recipient = await resolveServiceContactSmsRecipient(CONTACT, { dbh });
    expect(recipient).toMatchObject({ phone: '+19415550100', name: 'Dana', role: 'primary' });
  });

  test('a confirmed or never-asked contact is the recipient', async () => {
    const recipient = await resolveServiceContactSmsRecipient(CONTACT, { dbh: optinReader([]) });
    expect(recipient).toMatchObject({ phone: '(941) 555-0123', name: 'Riley Tenant', role: 'service_contact' });
  });

  test('another phone held on the account does not hold slot 1', async () => {
    const dbh = optinReader([{ customer_id: 'cust-1', phone_key: '9415550777' }]);
    expect((await resolveServiceContactSmsRecipient(CONTACT, { dbh })).phone).toBe('(941) 555-0123');
  });

  test('gate off: the contact is the recipient and the table is not read', async () => {
    mockGateOn = false;
    const dbh = optinReader([{ customer_id: 'cust-1', phone_key: '9415550123' }]);
    expect((await resolveServiceContactSmsRecipient(CONTACT, { dbh })).phone).toBe('(941) 555-0123');
    expect(dbh).not.toHaveBeenCalled();
  });

  test('no slot-1 phone: the account holder, with no read', async () => {
    const dbh = optinReader([]);
    const recipient = await resolveServiceContactSmsRecipient({ id: 'cust-1', first_name: 'Dana', phone: '+19415550100' }, { dbh });
    expect(recipient.phone).toBe('+19415550100');
    expect(dbh).not.toHaveBeenCalled();
  });

  test('a lookup error holds the contact (fail closed)', async () => {
    const dbh = optinReader([], { error: new Error('connection reset') });
    const recipient = await resolveServiceContactSmsRecipient(CONTACT, { dbh });
    expect(recipient).toMatchObject({ phone: '+19415550100', role: 'primary' });
  });

  test('a lookup error on a transaction is rethrown', async () => {
    const dbh = optinReader([], { error: new Error('connection reset'), isTransaction: true });
    await expect(resolveServiceContactSmsRecipient(CONTACT, { dbh })).rejects.toThrow('connection reset');
  });

  test('a slot-1 phone that is the account holder\'s own number is never held', async () => {
    const own = { ...CONTACT, service_contact_phone: '941-555-0100' };
    const dbh = optinReader([{ customer_id: 'cust-1', phone_key: '9415550100' }]);
    expect((await resolveServiceContactSmsRecipient(own, { dbh })).phone).toBe('941-555-0100');
  });

  test('an unstamped account still resolves to the account holder', async () => {
    const recipient = await resolveServiceContactSmsRecipient({ ...CONTACT, service_contacts_consent_at: null }, { dbh: optinReader([]) });
    expect(recipient.role).toBe('primary');
  });
});

describe('send paths resolve the single recipient through the opt-in hold', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('the visit-complete text never reads the stamp-only resolver', () => {
    const source = read('services/visit-completion-summary.js');
    expect(source).not.toMatch(/getServiceContactSmsRecipient/);
    expect(source.match(/resolveServiceContactSmsRecipient\(/g).length).toBe(5);
  });

  test('the review ask uses the stamp-only resolver only to list where a past send could have gone', () => {
    const source = read('services/review-request.js');
    expect(source.match(/getServiceContactSmsRecipient\(/g).length).toBe(1);
    expect(source).toMatch(/const destinations = \[\.\.\.new Set\(\[getServiceContactSmsRecipient\(owner\)\.phone, owner\?\.phone\]/);
    expect(source.match(/await resolveServiceContactSmsRecipient\(/g).length).toBe(4);
  });

  test('the staff review-request card pins and rechecks the same recipient the sender resolves', () => {
    expect(read('routes/admin-intelligence-bar.js').match(/resolveServiceContactSmsRecipient\(/g).length).toBe(2);
    expect(read('services/intelligence-bar/review-tools.js')).toMatch(/await resolveServiceContactSmsRecipient\(customer\)/);
  });
});
