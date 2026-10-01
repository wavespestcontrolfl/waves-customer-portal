// "Property: Primary" bug: customers.profile_label is a nickname (1,483
// customers carry the generic "Primary"), and appointment emails that led
// with it showed the nickname instead of where the visit is. The Property row
// must always be the street address when one exists.

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/street-level-hold', () => ({ ...jest.requireActual('../services/street-level-hold'), isStreetLevelHoldVisit: jest.fn(async () => false) })); // hold lookup: none of these fixtures is a hold
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-06-16T00:00:00.000Z' } })),
}));

const db = require('../models/db');
const EmailTemplates = require('../services/email-template-library');
const AppointmentEmail = require('../services/appointment-email');
const AccountMembershipEmail = require('../services/account-membership-email');
const { propertyDisplayLabel, propertyStreetAddress } = require('../utils/property-display');

const ADDRESS = '4410 Synthetic Palm Way, Bradenton, FL 34205';

const customerRow = (overrides = {}) => ({
  id: 'cust-1', account_id: 'acct-1', is_primary_profile: true,
  first_name: 'Rowan', last_name: 'Testcase', email: 'rowan@example.com', phone: '+19415550100',
  address_line1: '4410 Synthetic Palm Way', city: 'Bradenton', state: 'FL', zip: '34205',
  profile_label: 'Primary',
  ...overrides,
});

function mockDb({ customer, stamped = null }) {
  db.mockImplementation((table) => {
    if (table === 'customers') {
      const qb = { where: () => qb, select: () => qb, whereNull: () => qb, first: async () => customer };
      return qb;
    }
    if (table === 'notification_prefs') return { where: () => ({ first: async () => null }) };
    if (table === 'customer_interactions') return { insert: async () => [1] };
    if (table === 'appointment_reminders') return { where: () => ({ first: async () => null }) };
    if (table === 'scheduled_services') return { where: () => ({ first: async () => stamped || { scheduled_date: '2026-06-22', window_start: '10:00' } }) };
    throw new Error(`unexpected db table ${table}`);
  });
}

const sentPayload = () => EmailTemplates.sendTemplate.mock.calls[0][0].payload;
const when = '2026-06-22T14:00:00.000Z';

beforeEach(() => jest.clearAllMocks());

describe('appointment email Property row', () => {
  test.each(['Primary', 'Other property', 'Additional property', 'Rental', 'Home'])(
    'confirmation shows the address, not the "%s" nickname',
    async (label) => {
      mockDb({ customer: customerRow({ profile_label: label }) });
      await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: when, serviceLabel: 'Pest Control' });
      expect(sentPayload().property_label).toBe(ADDRESS);
    },
  );

  test.each(['72h', '24h'])('%s reminder shows the address for a "Primary" customer', async (kind) => {
    mockDb({ customer: customerRow() });
    await AppointmentEmail.sendAppointmentReminderEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: when, serviceLabel: 'Pest Control', kind });
    expect(EmailTemplates.sendTemplate.mock.calls[0][0].templateKey).toBe(`appointment.reminder_${kind}`);
    expect(sentPayload().property_label).toBe(ADDRESS);
  });

  test('tech arrived / en route show the address for a "Primary" customer', async () => {
    mockDb({ customer: customerRow() });
    await AppointmentEmail.sendTechArrivedEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', techName: 'Sam' });
    await AppointmentEmail.sendTechEnRouteEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', techName: 'Sam', etaMinutes: 10 });
    for (const call of EmailTemplates.sendTemplate.mock.calls) {
      expect(call[0].payload.property_label).toBe(ADDRESS);
    }
  });

  test('a stamped visit address still wins over the customer row', async () => {
    mockDb({
      customer: customerRow(),
      stamped: { scheduled_date: '2026-06-22', window_start: '10:00', service_address_line1: '9 Rental Ln', service_address_city: 'Ellenton', service_address_state: 'FL', service_address_zip: '34222' },
    });
    await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: when, serviceLabel: 'Pest Control' });
    expect(sentPayload().property_label).toBe('9 Rental Ln, Ellenton, FL 34222');
  });

  test('falls back to the nickname, then "Service property", only when there is no address', async () => {
    mockDb({ customer: customerRow({ address_line1: null, city: null, state: null, zip: null, profile_label: 'Rental' }) });
    await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: when, serviceLabel: 'Pest Control' });
    expect(sentPayload().property_label).toBe('Rental');

    jest.clearAllMocks();
    mockDb({ customer: customerRow({ address_line1: null, city: null, state: null, zip: null, profile_label: null }) });
    await AppointmentEmail.sendAppointmentConfirmationEmail({ customerId: 'cust-1', scheduledServiceId: 'ss1', appointmentTime: when, serviceLabel: 'Pest Control' });
    expect(sentPayload().property_label).toBe('Service property');
  });
});

describe('shared property display helper', () => {
  test('address wins over profile_label and includes unit, state and zip', () => {
    expect(propertyDisplayLabel({ profile_label: 'Primary', address_line1: '12 Oak Ct', address_line2: 'Unit 4', city: 'Venice', state: 'FL', zip: '34285' }))
      .toBe('12 Oak Ct Unit 4, Venice, FL 34285');
  });
  test('saved-property rows use `label` only when there is no address', () => {
    expect(propertyDisplayLabel({ label: 'Rental', address_line1: '12 Oak Ct', city: 'Venice' })).toBe('12 Oak Ct, Venice');
    expect(propertyDisplayLabel({ profile_label: 'Primary', city: 'Venice', state: 'FL', zip: '34285' })).toBe('Venice, FL 34285');
    expect(propertyDisplayLabel({ label: 'Rental' })).toBe('Rental');
    expect(propertyDisplayLabel({})).toBe('Service property');
    expect(propertyStreetAddress({ city: 'Venice' })).toBeNull();
  });
});

describe('account/membership email Property row', () => {
  test('shows the full address for a "Primary" customer', () => {
    expect(AccountMembershipEmail._private.propertyLabel(customerRow())).toBe(ADDRESS);
  });
});
