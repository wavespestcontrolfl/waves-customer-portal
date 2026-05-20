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
});
