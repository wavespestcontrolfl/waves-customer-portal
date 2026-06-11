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
    };
    expect(getAppointmentContacts(onlySlot2, {})).toEqual([
      expect.objectContaining({ phone: '+15553330000', role: 'service_contact_2' }),
    ]);
    expect(getServiceReportEmailRecipients(onlySlot2, {})).toEqual([
      expect.objectContaining({ email: 'sam@example.com', role: 'service_contact_2' }),
    ]);
  });
});
