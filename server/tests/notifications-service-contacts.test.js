jest.mock('../middleware/auth', () => ({ authenticate: (req, res, next) => next() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/account-membership-email', () => ({ sendAccountUpdated: jest.fn(() => Promise.resolve()) }));

const router = require('../routes/notifications');

const {
  serviceContactPayload,
  serviceContactsPayload,
  serviceContactSlotUpdates,
  normalizeContactInput,
  preferenceChangeItems,
} = router._private;

describe('on-location contact slot helpers', () => {
  test('serviceContactsPayload returns only filled slots in order', () => {
    const row = {
      service_contact_name: 'Terry Tenant',
      service_contact_phone: '+15552220000',
      service_contact_email: 'terry@example.com',
      service_contact2_name: '',
      service_contact2_phone: null,
      service_contact2_email: null,
      service_contact3_name: 'Pat Manager',
      service_contact3_phone: '+15554440000',
      service_contact3_email: '',
    };
    expect(serviceContactsPayload(row)).toEqual([
      expect.objectContaining({ firstName: 'Terry', lastName: 'Tenant', phone: '+15552220000', email: 'terry@example.com' }),
      expect.objectContaining({ firstName: 'Pat', lastName: 'Manager', phone: '+15554440000', email: '' }),
    ]);
  });

  test('serviceContactSlotUpdates compacts the list and nulls trailing slots', () => {
    const updates = serviceContactSlotUpdates([
      { name: 'Sam Spouse', phone: '+15553330000', email: 'sam@example.com' },
    ]);
    expect(updates).toEqual({
      service_contact_name: 'Sam Spouse',
      service_contact_phone: '+15553330000',
      service_contact_email: 'sam@example.com',
      service_contact2_name: null,
      service_contact2_phone: null,
      service_contact2_email: null,
      service_contact3_name: null,
      service_contact3_phone: null,
      service_contact3_email: null,
      service_contact_role: null,
      service_contact2_role: null,
      service_contact3_role: null,
    });
  });

  test('serviceContactSlotUpdates clears every slot for an empty list', () => {
    const updates = serviceContactSlotUpdates([]);
    expect(Object.values(updates).every((v) => v === null)).toBe(true);
    expect(Object.keys(updates)).toHaveLength(12);
  });

  test('serviceContactSlotUpdates always clears the role columns — a replaced slot must not hand its old role to the new person', () => {
    const updates = serviceContactSlotUpdates([
      { name: 'New Realtor', phone: '+15556660000', email: '' },
    ]);
    expect(updates.service_contact_role).toBeNull();
    expect(updates.service_contact2_role).toBeNull();
    expect(updates.service_contact3_role).toBeNull();
  });

  test('normalizeContactInput joins and trims the name parts', () => {
    expect(normalizeContactInput({ firstName: '  Sam ', lastName: ' Spouse ', phone: ' +15553330000 ', email: ' sam@example.com ' }))
      .toEqual({ name: 'Sam Spouse', phone: '+15553330000', email: 'sam@example.com' });
    expect(normalizeContactInput({})).toEqual({ name: '', phone: '', email: '' });
  });

  test('serviceContactPayload splits name into first/last', () => {
    expect(serviceContactPayload({ name: 'Pat Van Der Berg', phone: '1', email: 'p@e.com' }))
      .toEqual({ name: 'Pat Van Der Berg', firstName: 'Pat', lastName: 'Van Der Berg', phone: '1', email: 'p@e.com' });
  });

  test('preferenceChangeItems reports a contacts change for serviceContacts saves', () => {
    const items = preferenceChangeItems({ serviceContacts: [{ firstName: 'Sam' }] }, {}, {}, { scope: 'Property' });
    expect(items).toEqual([
      expect.objectContaining({ key: 'serviceContact', label: 'On-location Contacts', scope: 'Property' }),
    ]);
  });
});
