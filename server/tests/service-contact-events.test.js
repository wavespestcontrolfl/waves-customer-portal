// Service-contact changes were the one customer-editable surface with no
// audit trail: the account.updated "was this you?" email is skipped for
// self-initiated portal saves by design, so a family member added in the
// portal left no record of who added them, when, or how. These events land
// in activity_log, which the Customer 360 timeline already renders.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const {
  recordServiceContactChanges,
  diffServiceContacts,
} = require('../services/service-contact-events');

function mockInsert(result) {
  const insert = jest.fn(() => (
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result ?? [])
  ));
  db.mockImplementation(() => ({ insert }));
  return insert;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('diffServiceContacts', () => {
  const jane = {
    service_contact_name: 'Jane Smith',
    service_contact_phone: '+15551231234',
    service_contact_email: 'jane@example.com',
    service_contact_role: 'spouse',
  };

  test('a genuinely new person is an add', () => {
    const events = diffServiceContacts({}, jane);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'service_contact_added',
        person: expect.objectContaining({ slot: 1, name: 'Jane Smith', phone: '+15551231234', role: 'spouse' }),
      }),
    ]);
  });

  test('a person gone from every slot is a remove', () => {
    const events = diffServiceContacts(jane, {});
    expect(events).toEqual([
      expect.objectContaining({
        action: 'service_contact_removed',
        person: expect.objectContaining({ name: 'Jane Smith' }),
      }),
    ]);
  });

  test('same person (matched by phone) with a new email is an update, not remove+add', () => {
    const events = diffServiceContacts(jane, {
      ...jane,
      service_contact_email: 'jane.smith@example.com',
    });
    expect(events).toEqual([
      expect.objectContaining({
        action: 'service_contact_updated',
        changed: ['email'],
      }),
    ]);
  });

  test('same person (matched by email) with a new phone is an update flagged on phone', () => {
    const events = diffServiceContacts(jane, {
      ...jane,
      service_contact_phone: '+15559998888',
    });
    expect(events).toEqual([
      expect.objectContaining({ action: 'service_contact_updated', changed: ['phone'] }),
    ]);
  });

  test('slot compaction is not a change — deleting slot 1 only removes that person', () => {
    const before = {
      ...jane,
      service_contact2_name: 'Bob Neighbor',
      service_contact2_phone: '+15557775555',
      service_contact2_email: '',
    };
    // Portal delete of Jane compacts Bob 2→1.
    const after = {
      service_contact_name: 'Bob Neighbor',
      service_contact_phone: '+15557775555',
      service_contact_email: '',
    };
    const events = diffServiceContacts(before, after);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'service_contact_removed',
        person: expect.objectContaining({ name: 'Jane Smith' }),
      }),
    ]);
  });

  test('a role-only change is an update flagged on role', () => {
    const events = diffServiceContacts(jane, {
      ...jane,
      service_contact_role: 'tenant',
    });
    expect(events).toEqual([
      expect.objectContaining({ action: 'service_contact_updated', changed: ['role'] }),
    ]);
  });

  test('an unchanged echo save produces no events', () => {
    expect(diffServiceContacts(jane, { ...jane })).toEqual([]);
  });
});

describe('recordServiceContactChanges', () => {
  const beforeRow = {
    service_contact_name: 'Jane Smith',
    service_contact_phone: '+15551231234',
    service_contact_email: 'jane@example.com',
    service_contact_role: 'spouse',
  };

  test('writes one activity_log row per event with masked description and full metadata', async () => {
    const insert = mockInsert();
    const events = await recordServiceContactChanges({
      customerId: 'cust-1',
      before: {},
      after: { ...beforeRow, service_contacts_consent_text_version: 'portal-2026-07-22' },
      source: 'portal',
      actorCustomerId: 'cust-primary',
    });

    expect(events).toHaveLength(1);
    expect(insert).toHaveBeenCalledTimes(1);
    const rows = insert.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      customer_id: 'cust-1',
      admin_user_id: null,
      action: 'service_contact_added',
      description: 'Jane S. (…1234) added as on-location contact — customer portal',
    }));
    // Neither the full phone nor the full name/email ever appears in the
    // visible description — it rides the global recent-activity feed…
    expect(rows[0].description).not.toContain('5551231234');
    expect(rows[0].description).not.toContain('Smith');
    expect(rows[0].description).not.toContain('jane@example.com');
    // …but metadata carries the complete contact for the People panel.
    expect(JSON.parse(rows[0].metadata)).toEqual(expect.objectContaining({
      slot: 1,
      name: 'Jane Smith',
      phone: '+15551231234',
      email: 'jane@example.com',
      role: 'spouse',
      source: 'portal',
      actor_customer_id: 'cust-primary',
      consent_text_version: 'portal-2026-07-22',
      changed_fields: [],
    }));
  });

  test('admin saves stamp admin_user_id and the admin source label', async () => {
    const insert = mockInsert();
    await recordServiceContactChanges({
      customerId: 'cust-1',
      before: beforeRow,
      after: {},
      source: 'admin',
      adminUserId: 'tech-1',
    });
    const rows = insert.mock.calls[0][0];
    expect(rows[0]).toEqual(expect.objectContaining({
      admin_user_id: 'tech-1',
      action: 'service_contact_removed',
      description: 'Jane S. removed as on-location contact — admin',
    }));
    expect(JSON.parse(rows[0].metadata)).toEqual(expect.objectContaining({
      source: 'admin',
      admin_user_id: 'tech-1',
    }));
  });

  test('no events means no insert at all', async () => {
    const insert = mockInsert();
    const events = await recordServiceContactChanges({
      customerId: 'cust-1',
      before: beforeRow,
      after: { ...beforeRow },
      source: 'portal',
    });
    expect(events).toEqual([]);
    expect(insert).not.toHaveBeenCalled();
  });

  test('an insert failure warns and resolves — it never fails the save', async () => {
    mockInsert(new Error('connection reset'));
    const events = await recordServiceContactChanges({
      customerId: 'cust-1',
      before: {},
      after: beforeRow,
      source: 'portal',
    });
    expect(events).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('activity_log insert failed'));
  });
});
