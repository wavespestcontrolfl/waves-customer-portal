const {
  getAppointmentContacts,
  getBillingContact,
  getInvoiceEmailRecipients,
  getServiceReportEmailRecipients,
} = require('../services/customer-contact');

const customer = {
  id: 'cust-1',
  first_name: 'Lana',
  last_name: 'Owner',
  phone: '+15551110000',
  email: 'lana@example.com',
  service_contact_name: 'Terry Tenant',
  service_contact_phone: '+15552220000',
  service_contact_email: 'terry@example.com',
  // SMS fanout to service contacts requires the consent artifact (#2948).
  service_contacts_consent_at: '2026-07-22T00:00:00Z',
};

describe('customer contact recipient routing', () => {
  test('routes billing email to billing_email when configured', () => {
    const contact = getBillingContact(customer, {
      billing_contact_name: 'Accounts Payable',
      billing_email: 'ap@example.com',
    });

    expect(contact).toEqual(expect.objectContaining({
      name: 'Accounts Payable',
      email: 'ap@example.com',
      phone: '+15551110000',
      role: 'billing_contact',
    }));
    expect(getInvoiceEmailRecipients(customer, { billing_email: 'ap@example.com' }))
      .toEqual([expect.objectContaining({ email: 'ap@example.com' })]);
  });

  test('ignores stale billing contact name when billing email is cleared', () => {
    const contact = getBillingContact(customer, {
      billing_contact_name: 'Old Accounts Payable',
      billing_email: null,
    });

    expect(contact).toEqual(expect.objectContaining({
      email: 'lana@example.com',
      name: 'Lana',
      role: 'primary',
    }));
  });

  test('routes service reports to distinct service contact unless owner copy is enabled', () => {
    expect(getServiceReportEmailRecipients(customer, {})).toEqual([
      expect.objectContaining({
        email: 'terry@example.com',
        role: 'service_contact',
      }),
    ]);

    expect(getServiceReportEmailRecipients(customer, { service_report_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
        expect.objectContaining({ email: 'lana@example.com', role: 'primary' }),
      ]);
  });

  test('copies the billing recipient on service reports when enabled', () => {
    const prefs = {
      billing_contact_name: 'Christine Landlord',
      billing_email: 'christine@example.com',
      service_report_notify_billing: true,
    };

    // Account under the occupant, no service contacts: report goes to the
    // primary plus the billing recipient.
    const occupantOnly = {
      id: 'cust-3',
      first_name: 'Gideon',
      phone: '+15556660000',
      email: 'gideon@example.com',
    };
    expect(getServiceReportEmailRecipients(occupantOnly, prefs)).toEqual([
      expect.objectContaining({ email: 'gideon@example.com', role: 'primary' }),
      expect.objectContaining({
        email: 'christine@example.com',
        name: 'Christine Landlord',
        role: 'billing_contact',
      }),
    ]);

    // With a distinct service contact and owner copy off, the billing
    // recipient is still appended.
    expect(getServiceReportEmailRecipients(customer, prefs)).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      expect.objectContaining({ email: 'christine@example.com', role: 'billing_contact' }),
    ]);
  });

  test('billing report copy is a no-op without a billing email or when it duplicates a recipient', () => {
    // Toggle on but no billing_email set: the payer IS the primary, which the
    // notify-primary toggle already covers.
    expect(getServiceReportEmailRecipients(customer, { service_report_notify_billing: true }))
      .toEqual([
        expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      ]);

    // Billing email matching an existing recipient is deduped.
    expect(getServiceReportEmailRecipients(customer, {
      billing_email: 'Terry@example.com',
      service_report_notify_billing: true,
    })).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
    ]);
  });

  test('appointment contacts keep service contact primary unless owner SMS copy is enabled', () => {
    expect(getAppointmentContacts(customer, {})).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
    ]);

    expect(getAppointmentContacts(customer, { appointment_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
        expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
      ]);
  });

  const multiContactCustomer = {
    ...customer,
    service_contact2_name: 'Sam Spouse',
    service_contact2_phone: '+15553330000',
    service_contact2_email: 'sam@example.com',
    service_contact3_name: 'Pat Manager',
    service_contact3_phone: '+15554440000',
    service_contact3_email: 'pat@example.com',
  };

  test('appointment contacts fan out across all distinct service contact slots', () => {
    expect(getAppointmentContacts(multiContactCustomer, {})).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
      expect.objectContaining({ phone: '+15554440000', role: 'service_contact_3' }),
    ]);

    expect(getAppointmentContacts(multiContactCustomer, { appointment_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
        expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
        expect.objectContaining({ phone: '+15554440000', role: 'service_contact_3' }),
        expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
      ]);
  });

  test('appointment contacts skip slots that duplicate the primary or an earlier slot', () => {
    const withDupes = {
      ...customer,
      service_contact2_name: 'Dup Of Owner',
      service_contact2_phone: '+15551110000',
      service_contact3_name: 'Dup Of Tenant',
      service_contact3_phone: '+15552220000',
    };
    expect(getAppointmentContacts(withDupes, {})).toEqual([
      expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
    ]);
  });

  test('service reports fan out across all distinct service contact emails', () => {
    expect(getServiceReportEmailRecipients(multiContactCustomer, {})).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
      expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
      expect.objectContaining({ email: 'pat@example.com', role: 'service_contact_3' }),
    ]);

    expect(getServiceReportEmailRecipients(multiContactCustomer, { service_report_notify_primary: true }))
      .toEqual([
        expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
        expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
        expect.objectContaining({ email: 'pat@example.com', role: 'service_contact_3' }),
        expect.objectContaining({ email: 'lana@example.com', role: 'primary' }),
      ]);
  });

  test('a slot-2 contact still routes when slot 1 is empty', () => {
    const onlySlot2 = {
      id: 'cust-2',
      first_name: 'Lana',
      phone: '+15551110000',
      email: 'lana@example.com',
      service_contact2_name: 'Sam Spouse',
      service_contact2_phone: '+15553330000',
      service_contact2_email: 'sam@example.com',
      service_contacts_consent_at: '2026-07-22T00:00:00Z',
    };
    expect(getAppointmentContacts(onlySlot2, {})).toEqual([
      expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
    ]);
    expect(getServiceReportEmailRecipients(onlySlot2, {})).toEqual([
      expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
    ]);
  });

  test('SMS fanout skips service contacts when the consent artifact is missing (#2948 gate)', () => {
    const unstamped = { ...customer, service_contacts_consent_at: null };
    // Service-contact texting targets drop; the primary still gets texts.
    expect(getAppointmentContacts(unstamped, {})).toEqual([
      expect.objectContaining({ phone: '+15551110000', role: 'primary' }),
    ]);
    // Email routing is NOT part of the SMS consent gate.
    expect(getServiceReportEmailRecipients(unstamped, {})).toEqual([
      expect.objectContaining({ email: 'terry@example.com', role: 'service_contact' }),
    ]);
  });

  test('DISABLE_CONTACT_CONSENT_GATE=1 restores ungated fanout (kill switch)', () => {
    const unstamped = { ...customer, service_contacts_consent_at: null };
    process.env.DISABLE_CONTACT_CONSENT_GATE = '1';
    try {
      expect(getAppointmentContacts(unstamped, {})).toEqual([
        expect.objectContaining({ phone: '+15552220000', role: 'service_contact' }),
      ]);
    } finally {
      delete process.env.DISABLE_CONTACT_CONSENT_GATE;
    }
  });
});
